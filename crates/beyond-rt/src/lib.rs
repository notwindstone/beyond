//! Beyond's native core, linked into each program: the event loop and the
//! timers. As Bun's, the loop waits on uSockets' (epoll) until the next
//! timer is due, and timers live here rather than in the kernel; between
//! callbacks into JavaScript, the jobs they queued (promise reactions) run.
//! Also the parts of the web APIs that are best native (`encoding`).

mod encoding;

/// Bun's bundled root certificates (Mozilla's, for TLS servers), which
/// fetch() trusts by default: client.c reads them.
const ROOT_CERTS: &[u8] = include_bytes!("../../../vendor/bun-usockets/root_certs.der");
#[unsafe(no_mangle)]
pub static BEYOND_ROOT_CERTS: [u8; ROOT_CERTS.len()] = *include_bytes!("../../../vendor/bun-usockets/root_certs.der");
#[unsafe(no_mangle)]
pub static BEYOND_ROOT_CERTS_LEN: usize = ROOT_CERTS.len();

use std::cell::RefCell;
use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap};
use std::ffi::{c_int, c_void};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

#[repr(C)]
struct Timespec {
    tv_sec: i64,
    tv_nsec: i64,
}

unsafe extern "C" {
    fn uws_get_loop() -> *mut c_void;
    fn us_loop_run_bun_tick(loop_: *mut c_void, timeout: *const Timespec, now_ns: u64);
    fn beyond_loop_num_polls(loop_: *mut c_void) -> c_int;
    fn beyond_client_idle_count() -> c_int;
    fn beyond_js_run_jobs() -> c_int;
    fn beyond_js_fire_timer(id: u32) -> c_int;
    fn beyond_js_uncaught() -> c_int;
    fn beyond_flush_stdout();
    fn beyond_server_after_tick();
}

/// Nanoseconds since the program started.
fn now_ns() -> u64 {
    static START: OnceLock<Instant> = OnceLock::new();
    START.get_or_init(Instant::now).elapsed().as_nanos() as u64
}

struct Timer {
    /// Which scheduling of the timer the heap entries stand for.
    seq: u64,
    repeat_ns: Option<u64>,
    /// Whether it keeps the program alive.
    refd: bool,
}

#[derive(Default)]
struct Timers {
    /// (deadline, scheduling, id): the earliest first, then in the order
    /// they were set.
    heap: BinaryHeap<Reverse<(u64, u64, u32)>>,
    timers: HashMap<u32, Timer>,
    seq: u64,
}

impl Timers {
    fn schedule(&mut self, id: u32, deadline: u64) -> u64 {
        self.seq += 1;
        self.heap.push(Reverse((deadline, self.seq, id)));
        self.seq
    }

    fn refd(&self) -> bool {
        self.timers.values().any(|t| t.refd)
    }

    /// The next timer that is still set (dropping the stale entries).
    fn next(&mut self) -> Option<(u64, u64, u32)> {
        while let Some(&Reverse((deadline, seq, id))) = self.heap.peek() {
            if self.timers.get(&id).is_some_and(|t| t.seq == seq) {
                return Some((deadline, seq, id));
            }
            self.heap.pop();
        }
        None
    }
}

thread_local! {
    static TIMERS: RefCell<Timers> = RefCell::new(Timers::default());
}

/// A delay as timers take it: at least 1 ms (as Node's and Bun's).
fn delay_ns(ms: f64) -> u64 {
    let ms = if ms.is_finite() && ms >= 1.0 { ms.min(2_147_483_647.0) } else { 1.0 };
    (ms * 1e6) as u64
}

#[unsafe(no_mangle)]
pub extern "C" fn beyond_rt_timer_set(id: u32, ms: f64, repeat: c_int) {
    let ns = delay_ns(ms);
    TIMERS.with_borrow_mut(|t| {
        let seq = t.schedule(id, now_ns() + ns);
        let refd = t.timers.get(&id).is_none_or(|old| old.refd);
        t.timers.insert(id, Timer { seq, repeat_ns: (repeat != 0).then_some(ns), refd });
    });
}

#[unsafe(no_mangle)]
pub extern "C" fn beyond_rt_timer_clear(id: u32) {
    TIMERS.with_borrow_mut(|t| {
        t.timers.remove(&id);
    });
}

#[unsafe(no_mangle)]
pub extern "C" fn beyond_rt_timer_ref(id: u32, refd: c_int) {
    TIMERS.with_borrow_mut(|t| {
        if let Some(timer) = t.timers.get_mut(&id) {
            timer.refd = refd != 0;
        }
    });
}

#[unsafe(no_mangle)]
pub extern "C" fn beyond_rt_now_ms() -> f64 {
    now_ns() as f64 / 1e6
}

/// Runs the program's event loop until nothing keeps it alive (no timer
/// that is referenced, no socket): 0, or nonzero when a callback threw (the
/// exception is pending) or reportError reported an error.
#[unsafe(no_mangle)]
pub extern "C" fn beyond_rt_loop() -> c_int {
    // SAFETY: uWebSockets' loop of this thread, created on first use.
    let uloop = unsafe { uws_get_loop() };
    loop {
        // SAFETY: the context was set up by beyond_init.
        if unsafe { beyond_js_run_jobs() } < 0 || unsafe { beyond_js_uncaught() } != 0 {
            return 1;
        }
        // The timers that are due, in order (a callback may set or clear
        // others).
        let now = now_ns();
        loop {
            let due = TIMERS.with_borrow_mut(|t| {
                let (deadline, _, id) = t.next()?;
                if deadline > now {
                    return None;
                }
                t.heap.pop();
                let repeat = t.timers.get(&id).and_then(|timer| timer.repeat_ns);
                match repeat {
                    Some(ns) => {
                        let seq = t.schedule(id, now + ns);
                        t.timers.get_mut(&id).unwrap().seq = seq;
                    }
                    None => {
                        t.timers.remove(&id);
                    }
                }
                Some(id)
            });
            let Some(id) = due else { break };
            // SAFETY: as above.
            if unsafe { beyond_js_fire_timer(id) } < 0 || unsafe { beyond_js_uncaught() } != 0 {
                return 1;
            }
        }
        // SAFETY: the loop is live.
        // (Idle keep-alive connections of fetch() do not keep it alive.)
        let polls = unsafe { beyond_loop_num_polls(uloop) - beyond_client_idle_count() };
        let (refd, next) = TIMERS.with_borrow_mut(|t| (t.refd(), t.next().map(|n| n.0)));
        if polls == 0 && !refd {
            return 0;
        }
        // (What the console wrote, before waiting.)
        // SAFETY: plain C stdio.
        unsafe { beyond_flush_stdout() };
        let now = now_ns();
        let wait = next.map(|d| d.saturating_sub(now));
        if polls == 0 {
            // Only timers: sleep until the next.
            std::thread::sleep(Duration::from_nanos(wait.unwrap_or(0)));
            continue;
        }
        let ts = wait.map(|ns| Timespec { tv_sec: (ns / 1_000_000_000) as i64, tv_nsec: (ns % 1_000_000_000) as i64 });
        // SAFETY: as above; `ts` outlives the call.
        unsafe { us_loop_run_bun_tick(uloop, ts.as_ref().map_or(std::ptr::null(), |t| t as *const Timespec), now) };
        // (Requests whose body is still coming: their handlers.)
        // SAFETY: as above.
        unsafe { beyond_server_after_tick() };
    }
}
