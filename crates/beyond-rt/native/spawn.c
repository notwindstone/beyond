// Child processes (Bun.spawn and Bun.spawnSync, which node:child_process is
// built on), started as Bun starts them (src/jsc/bindings/bun-spawn.cpp):
// vfork, then in the child its stdio descriptors, directory, session and
// ids, and exec; an exec that fails is reported through memory the child
// shares with the parent until then. A child's exit is watched through a
// pidfd, and its pipes through non-blocking descriptors, in uSockets' loop
// (polls of the callback kind, which the loop hands to on_ready). What
// happens is handed to the JavaScript handler spawnInit set, with the
// watch's handle: (EXIT, code, signal, rusage), (DATA, Uint8Array), (EOF),
// (ERROR, errno) or (WRITABLE). spawnSync waits in a poll(2) loop of its
// own instead: the program's loop (its timers, sockets) is left as it is.

#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <poll.h>
#include <pthread.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#include "libusockets.h"
#include "internal/internal.h"
#include "quickjs.h"

int beyond_js_run_jobs(void);
JSContext *beyond_js_context(void);
void beyond_js_report(void);
struct us_loop_t *uws_get_loop(void);

extern char **environ;

#ifndef CLOSE_RANGE_CLOEXEC
#define CLOSE_RANGE_CLOEXEC (1U << 2)
#endif
#ifndef SYS_pidfd_open
#define SYS_pidfd_open 434
#endif
#ifndef SYS_close_range
#define SYS_close_range 436
#endif

enum { W_EXIT = 1, W_READ = 2, W_WRITE = 3 };
enum { EV_EXIT = 1, EV_DATA = 2, EV_EOF = 3, EV_ERROR = 4, EV_WRITABLE = 5 };

// What a stdio slot of the child is (spawnProcess's `stdio`, as numbers).
enum { IO_INHERIT = -1, IO_IGNORE = -2, IO_PIPE = -3, IO_SOCKET = -4 };

#define MAX_SLOTS 64
// (A read takes what the pipe holds, at least this much room.)
#define READ_MIN (64 * 1024)
#define READ_MAX (4 * 1024 * 1024)
// (A pipe the parent reads holds this much, where the system allows.)
#define PIPE_SIZE (1024 * 1024)

// ---- Errors as Node's (libuv's names and messages) ----

static const struct {
    int no;
    const char *code, *message;
} errnos[] = {
    {ENOENT, "ENOENT", "no such file or directory"},
    {EACCES, "EACCES", "permission denied"},
    {EPERM, "EPERM", "operation not permitted"},
    {EAGAIN, "EAGAIN", "resource temporarily unavailable"},
    {EMFILE, "EMFILE", "too many open files"},
    {ENFILE, "ENFILE", "file table overflow"},
    {ENOMEM, "ENOMEM", "not enough memory"},
    {E2BIG, "E2BIG", "argument list too long"},
    {ENOEXEC, "ENOEXEC", "exec format error"},
    {EISDIR, "EISDIR", "illegal operation on a directory"},
    {ENOTDIR, "ENOTDIR", "not a directory"},
    {EINVAL, "EINVAL", "invalid argument"},
    {ESRCH, "ESRCH", "no such process"},
    {EPIPE, "EPIPE", "broken pipe"},
    {EBADF, "EBADF", "bad file descriptor"},
    {ELOOP, "ELOOP", "too many symbolic links encountered"},
    {ENAMETOOLONG, "ENAMETOOLONG", "name too long"},
    {ETXTBSY, "ETXTBSY", "text file is busy"},
    {ECHILD, "ECHILD", "no child processes"},
    {ENOSYS, "ENOSYS", "function not implemented"},
    {ECONNRESET, "ECONNRESET", "connection reset by peer"},
    {EIO, "EIO", "i/o error"},
};

// `<CODE>: <message>, <syscall> '<path>'` (or as `message` says), with
// errno (negative, as libuv's), code, syscall and path.
static JSValue sys_error(JSContext *c, int no, const char *syscall, const char *path, const char *message) {
    const char *code = "UNKNOWN", *text = strerror(no);
    for (size_t i = 0; i < sizeof errnos / sizeof *errnos; i++) {
        if (errnos[i].no == no) {
            code = errnos[i].code;
            text = errnos[i].message;
        }
    }
    char buf[PATH_MAX + 256];
    if (message)
        snprintf(buf, sizeof buf, "%s", message);
    else if (path)
        snprintf(buf, sizeof buf, "%s: %s, %s '%s'", code, text, syscall, path);
    else
        snprintf(buf, sizeof buf, "%s: %s, %s", code, text, syscall);
    JSValue e = JS_NewError(c);
    JS_DefinePropertyValueStr(c, e, "message", JS_NewString(c, buf), JS_PROP_WRITABLE | JS_PROP_CONFIGURABLE);
    JS_SetPropertyStr(c, e, "code", JS_NewString(c, code));
    if (path)
        JS_SetPropertyStr(c, e, "path", JS_NewString(c, path));
    if (syscall)
        JS_SetPropertyStr(c, e, "syscall", JS_NewString(c, syscall));
    JS_SetPropertyStr(c, e, "errno", JS_NewInt32(c, -no));
    return e;
}

// ---- Watches: a child's exit, or a pipe ----

typedef struct {
    // (First: the poll uSockets dispatches to on_ready.)
    struct us_internal_callback_t cb;
    uint32_t index, gen;
    bool live;
    int kind;
    int fd;
    pid_t pid;
    // In the loop's epoll set (and counted in its polls), and whether it
    // keeps the program alive then.
    bool polling, refd;
    uint32_t next_free;
} Watch;

static Watch **watches;
static uint32_t nwatches, cap_watches, free_head = UINT32_MAX;
// Watches polling that do not keep the program alive (the loop leaves
// them out of what does: src/lib.rs).
static int unrefd;

int beyond_spawn_unrefd(void) { return unrefd; }

static JSValue handler = JS_UNDEFINED;
static JSValue buffer_proto = JS_UNDEFINED;

void beyond_spawn_mark(JSRuntime *rt, JS_MarkFunc *mark_func) {
    JS_MarkValue(rt, handler, mark_func);
    JS_MarkValue(rt, buffer_proto, mark_func);
}

static double handle_of(uint32_t i) { return (double)i + (double)(watches[i]->gen & 0x1FFFFFFF) * 16777216.0; }

static Watch *watch_of(JSContext *c, JSValueConst v, uint32_t *index) {
    double h;
    if (JS_ToFloat64(c, &h, v) || !(h >= 0))
        return NULL;
    uint64_t u = (uint64_t)h;
    uint32_t i = (uint32_t)(u & 0xFFFFFF), gen = (uint32_t)(u >> 24);
    if (i >= nwatches || !watches[i]->live || (watches[i]->gen & 0x1FFFFFFF) != gen)
        return NULL;
    if (index)
        *index = i;
    return watches[i];
}

static void on_ready(struct us_internal_callback_t *cb);

static uint32_t watch_new(int kind, int fd, pid_t pid) {
    uint32_t i;
    if (free_head != UINT32_MAX) {
        i = free_head;
        free_head = watches[i]->next_free;
    } else {
        if (nwatches == cap_watches) {
            cap_watches = cap_watches ? cap_watches * 2 : 64;
            watches = realloc(watches, cap_watches * sizeof *watches);
        }
        i = nwatches++;
        // (Never freed: uSockets may still hold the poll of a watch that
        // ended during the loop's turn.)
        watches[i] = calloc(1, sizeof(Watch));
    }
    Watch *w = watches[i];
    uint32_t gen = w->gen;
    memset(w, 0, sizeof *w);
    w->index = i;
    w->gen = gen;
    w->live = true;
    w->kind = kind;
    w->fd = fd;
    w->pid = pid;
    w->refd = true;
    us_poll_init(&w->cb.p, fd, POLL_TYPE_CALLBACK);
    w->cb.loop = uws_get_loop();
    w->cb.cb_expects_the_loop = 0;
    // (The loop is not to read the descriptor: on_ready does.)
    w->cb.leave_poll_ready = 1;
    w->cb.cb = on_ready;
    return i;
}

// Starts or stops polling the watch's descriptor.
static int watch_poll(Watch *w, bool on) {
    struct us_loop_t *loop = w->cb.loop;
    if (on == w->polling)
        return 0;
    if (on) {
        int events = w->kind == W_WRITE ? LIBUS_SOCKET_WRITABLE : LIBUS_SOCKET_READABLE;
        if (us_poll_start_rc(&w->cb.p, loop, events) != 0)
            return -errno;
        loop->num_polls++;
        if (!w->refd)
            unrefd++;
    } else {
        us_poll_stop(&w->cb.p, loop);
        loop->num_polls--;
        if (!w->refd)
            unrefd--;
    }
    w->polling = on;
    return 0;
}

static void watch_ref(Watch *w, bool refd) {
    if (refd == w->refd)
        return;
    if (w->polling)
        unrefd += refd ? -1 : 1;
    w->refd = refd;
}

// Ends the watch (and closes its descriptor if `close_fd`).
static void watch_free(uint32_t i, bool close_fd) {
    Watch *w = watches[i];
    if (!w->live)
        return;
    watch_poll(w, false);
    if (close_fd && w->fd >= 0)
        close(w->fd);
    w->fd = -1;
    w->live = false;
    w->gen++;
    w->next_free = free_head;
    free_head = i;
}

// Calls the handler: (handle, kind, a, b, c); then the jobs it queued.
static void emit(double h, int kind, JSValue a, JSValue b, JSValue c) {
    JSContext *ctx = beyond_js_context();
    JSValue argv[5] = {JS_NewFloat64(ctx, h), JS_NewInt32(ctx, kind), a, b, c};
    JSValue r = JS_Call(ctx, handler, JS_UNDEFINED, 5, argv);
    if (JS_IsException(r))
        beyond_js_report();
    if (beyond_js_run_jobs() < 0)
        beyond_js_report();
}

static void *realloc_ab(JSRuntime *rt, void *opaque, void *ptr, size_t size) {
    (void)opaque;
    if (size == 0) {
        js_free_rt(rt, ptr);
        return NULL;
    }
    return js_realloc_rt(rt, ptr, size);
}

// A Uint8Array of `len` bytes at `data` (js_malloc'd, taken); a Buffer if
// `as_buffer`.
static JSValue bytes_value(JSContext *c, uint8_t *data, size_t len, bool as_buffer) {
    JSValue u8 = JS_NewUint8Array(c, data, len, realloc_ab, NULL, false);
    if (as_buffer && !JS_IsException(u8) && JS_IsObject(buffer_proto))
        JS_SetPrototype(c, u8, buffer_proto);
    return u8;
}

// A child's resource usage, as Bun's resourceUsage() has it: [user µs,
// system µs, maxRSS bytes, shared memory, swaps, blocks in, blocks out,
// messages sent, received, signals, voluntary and involuntary context
// switches].
static JSValue rusage_value(JSContext *c, const struct rusage *ru) {
    double v[12] = {
        (double)ru->ru_utime.tv_sec * 1e6 + ru->ru_utime.tv_usec,
        (double)ru->ru_stime.tv_sec * 1e6 + ru->ru_stime.tv_usec,
        (double)ru->ru_maxrss * 1024,
        (double)ru->ru_ixrss,
        (double)ru->ru_nswap,
        (double)ru->ru_inblock,
        (double)ru->ru_oublock,
        (double)ru->ru_msgsnd,
        (double)ru->ru_msgrcv,
        (double)ru->ru_nsignals,
        (double)ru->ru_nvcsw,
        (double)ru->ru_nivcsw,
    };
    JSValue a = JS_NewArray(c);
    for (uint32_t i = 0; i < 12; i++)
        JS_SetPropertyUint32(c, a, i, JS_NewFloat64(c, v[i]));
    return a;
}

// Whether the child has exited (reaped now): its exit code (-1 if it was
// signaled) and signal.
static bool reap(pid_t pid, bool block, int *code, int *sig, struct rusage *ru) {
    int status = 0;
    pid_t r;
    do
        r = wait4(pid, &status, block ? 0 : WNOHANG, ru);
    while (r < 0 && errno == EINTR);
    if (r == 0)
        return false;
    if (r < 0) {
        // (Reaped by someone else: its status is lost.)
        memset(ru, 0, sizeof *ru);
        *code = 0;
        *sig = 0;
        return true;
    }
    if (WIFSIGNALED(status)) {
        *code = -1;
        *sig = WTERMSIG(status);
    } else {
        *code = WEXITSTATUS(status);
        *sig = 0;
    }
    return true;
}

// A pipe has bytes (or its end): as much as it holds, read.
static void on_readable(uint32_t i) {
    JSContext *ctx = beyond_js_context();
    JSRuntime *rt = JS_GetRuntime(ctx);
    Watch *w = watches[i];
    int avail = 0;
    if (ioctl(w->fd, FIONREAD, &avail) < 0 || avail < READ_MIN)
        avail = READ_MIN;
    if (avail > READ_MAX)
        avail = READ_MAX;
    uint8_t *buf = js_malloc_rt(rt, avail);
    if (!buf)
        return;
    ssize_t n;
    do
        n = read(w->fd, buf, avail);
    while (n < 0 && errno == EINTR);
    if (n > 0) {
        if (n < avail) {
            uint8_t *b = js_realloc_rt(rt, buf, n);
            if (b)
                buf = b;
        }
        emit(handle_of(i), EV_DATA, bytes_value(ctx, buf, n, false), JS_UNDEFINED, JS_UNDEFINED);
        return;
    }
    js_free_rt(rt, buf);
    if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK))
        return;
    int no = n < 0 ? errno : 0;
    double h = handle_of(i);
    watch_free(i, true);
    if (no)
        emit(h, EV_ERROR, JS_NewInt32(ctx, no), JS_UNDEFINED, JS_UNDEFINED);
    else
        emit(h, EV_EOF, JS_UNDEFINED, JS_UNDEFINED, JS_UNDEFINED);
}

static void on_ready(struct us_internal_callback_t *cb) {
    Watch *w = (Watch *)cb;
    uint32_t i = w->index;
    if (!w->live)
        return;
    JSContext *ctx = beyond_js_context();
    switch (w->kind) {
    case W_EXIT: {
        int code, sig;
        struct rusage ru;
        if (!reap(w->pid, false, &code, &sig, &ru))
            return;
        double h = handle_of(i);
        watch_free(i, true);
        emit(h, EV_EXIT, JS_NewInt32(ctx, code), JS_NewInt32(ctx, sig), rusage_value(ctx, &ru));
        break;
    }
    case W_READ:
        on_readable(i);
        break;
    case W_WRITE:
        // (Once: polled again when more is to be written.)
        watch_poll(w, false);
        emit(handle_of(i), EV_WRITABLE, JS_UNDEFINED, JS_UNDEFINED, JS_UNDEFINED);
        break;
    }
}

// ---- Starting a child ----

typedef struct {
    const char *path;
    char *const *argv, *const *envp;
    const char *cwd;
    // What each slot of the child gets: a descriptor to duplicate there
    // (one above all slots), -1 to leave it, -2 to close it.
    int src[MAX_SLOTS];
    int nslots;
    bool detached;
    bool set_uid, set_gid;
    uid_t uid;
    gid_t gid;
    sigset_t mask;
    volatile int err;
} Child;

// In the child (vfork's: the parent's memory, and stack below its frame):
// no allocation, and no return.
__attribute__((noinline, noreturn)) static void child_run(Child *ch) {
    struct sigaction sa;
    memset(&sa, 0, sizeof sa);
    sa.sa_handler = SIG_DFL;
    for (int s = 1; s < 32; s++) {
        if (s != SIGKILL && s != SIGSTOP)
            sigaction(s, &sa, NULL);
    }
    if (ch->detached)
        setsid();
    if (ch->cwd && chdir(ch->cwd) != 0)
        goto fail;
    for (int i = 0; i < ch->nslots; i++) {
        int s = ch->src[i];
        if (s >= 0) {
            if (dup2(s, i) < 0)
                goto fail;
        } else if (s == -2) {
            close(i);
        } else if (i > 2) {
            // (Inherited: kept across exec.)
            int fl = fcntl(i, F_GETFD);
            if (fl >= 0 && (fl & FD_CLOEXEC))
                fcntl(i, F_SETFD, fl & ~FD_CLOEXEC);
        }
    }
    // (Raw system calls: glibc's would signal the parent's threads.)
    if (ch->set_uid || ch->set_gid)
        syscall(SYS_setgroups, 0, NULL);
    if (ch->set_gid && syscall(SYS_setgid, ch->gid) != 0)
        goto fail;
    if (ch->set_uid && syscall(SYS_setuid, ch->uid) != 0)
        goto fail;
    // Nothing else of the parent's past exec.
    syscall(SYS_close_range, (unsigned)ch->nslots, ~0U, CLOSE_RANGE_CLOEXEC);
    sigprocmask(SIG_SETMASK, &ch->mask, NULL);
    execve(ch->path, ch->argv, ch->envp);
fail:
    ch->err = errno ? errno : EINVAL;
    syscall(SYS_exit_group, 127);
    __builtin_unreachable();
}

// Starts the child: its pid, or -errno (it did not run).
static pid_t start_child(Child *ch) {
    sigset_t all;
    sigfillset(&all);
    pthread_sigmask(SIG_SETMASK, &all, &ch->mask);
    ch->err = 0;
    pid_t pid = vfork();
    if (pid == 0)
        child_run(ch);
    int no = pid < 0 ? errno : ch->err;
    pthread_sigmask(SIG_SETMASK, &ch->mask, NULL);
    if (pid > 0 && no) {
        int status;
        while (waitpid(pid, &status, 0) < 0 && errno == EINTR)
            ;
    }
    return no ? -no : pid;
}

// The executable `file` names: itself if it has a slash, else the first
// executable file of that name in `path`'s directories (relative ones in
// `cwd`).
static bool which(const char *file, const char *path, const char *cwd, char *out, size_t cap) {
    if (strchr(file, '/')) {
        snprintf(out, cap, "%s", file);
        return true;
    }
    if (!*file)
        return false;
    const char *p = path;
    for (;;) {
        const char *end = strchr(p, ':');
        size_t n = end ? (size_t)(end - p) : strlen(p);
        int len;
        if (n == 0)
            len = snprintf(out, cap, "%s%s%s", cwd ? cwd : ".", "/", file);
        else if (p[0] != '/' && cwd)
            len = snprintf(out, cap, "%s/%.*s/%s", cwd, (int)n, p, file);
        else
            len = snprintf(out, cap, "%.*s/%s", (int)n, p, file);
        struct stat st;
        if (len > 0 && (size_t)len < cap && stat(out, &st) == 0 && S_ISREG(st.st_mode) && access(out, X_OK) == 0)
            return true;
        if (!end)
            return false;
        p = end + 1;
    }
}

static int dev_null = -1;

// What a spawn's arguments hold, prepared: the strings the child gets
// (one block), and the descriptors it is to have.
typedef struct {
    char *strings;
    char **argv, **envp;
    char path[PATH_MAX];
    const char *cwd_c, *file_c, *argv0_c;
    Child ch;
    // Per slot: the parent's end of a pipe (or -1), and descriptors to
    // close in the parent once the child runs.
    int parent[MAX_SLOTS];
    int temp[MAX_SLOTS * 2];
    int ntemp;
    // A memfd's or pipe's bytes for stdin (spawnSync's fallback writes them).
    const uint8_t *input;
    size_t input_len;
    bool input_pipe;
} Prep;

static void prep_free(JSContext *c, Prep *p, bool failed) {
    for (int i = 0; i < p->ntemp; i++)
        close(p->temp[i]);
    p->ntemp = 0;
    if (failed) {
        for (int i = 0; i < MAX_SLOTS; i++) {
            if (p->parent[i] >= 0)
                close(p->parent[i]);
            p->parent[i] = -1;
        }
    }
    free(p->strings);
    free(p->argv);
    p->strings = NULL;
    p->argv = NULL;
    if (p->cwd_c)
        JS_FreeCString(c, p->cwd_c);
    if (p->file_c)
        JS_FreeCString(c, p->file_c);
    if (p->argv0_c)
        JS_FreeCString(c, p->argv0_c);
    p->cwd_c = p->file_c = p->argv0_c = NULL;
}

// A descriptor to duplicate into one of the `nslots` slots: `fd` itself if
// it is above them all (no slot set up before it can replace it), else a
// duplicate that is; -3 if there can be none.
static int above(Prep *p, int fd, int nslots) {
    if (fd >= nslots)
        return fd;
    int d = fcntl(fd, F_DUPFD_CLOEXEC, nslots);
    if (d < 0)
        return -3;
    p->temp[p->ntemp++] = d;
    return d;
}

// Appends `s` (and its NUL) to the block; the offset it is at.
static bool append(char **buf, size_t *len, size_t *cap, const char *s, size_t n) {
    if (*len + n + 1 > *cap) {
        size_t c = *cap ? *cap * 2 : 4096;
        while (c < *len + n + 1)
            c *= 2;
        char *b = realloc(*buf, c);
        if (!b)
            return false;
        *buf = b;
        *cap = c;
    }
    memcpy(*buf + *len, s, n);
    (*buf)[*len + n] = 0;
    *len += n + 1;
    return true;
}

// Reads the spawn's arguments (file, argv, env, PATH, cwd, stdio, flags,
// uid, gid) and prepares the child: -1 with an exception thrown.
// `sync`: pipes the parent reads are blocking, and stdin's bytes may need
// writing (a pipe, if no memfd).
static int prep(JSContext *c, Prep *p, int argc, JSValueConst *argv, bool sync) {
    memset(p, 0, sizeof *p);
    for (int i = 0; i < MAX_SLOTS; i++)
        p->parent[i] = -1;
    char *buf = NULL;
    size_t len = 0, cap = 0;
    // (Offsets into the block, made pointers once it is whole.)
    size_t *offs = NULL;
    int64_t nargs = 0;
    uint32_t nenv = 0;
    int ret = -1;

    p->file_c = JS_ToCString(c, argv[0]);
    if (!p->file_c)
        goto out;
    if (JS_GetLength(c, argv[1], &nargs) || nargs < 1)
        goto out;
    JSPropertyEnum *props = NULL;
    uint32_t nprops = 0;
    bool has_env = JS_IsObject(argv[2]);
    if (has_env && JS_GetOwnPropertyNames(c, &props, &nprops, argv[2], JS_GPN_STRING_MASK | JS_GPN_ENUM_ONLY))
        goto out;
    offs = malloc((nargs + nprops + 2) * sizeof *offs);
    for (int64_t i = 0; i < nargs; i++) {
        JSValue v = JS_GetPropertyInt64(c, argv[1], i);
        size_t n;
        const char *s = JS_ToCStringLen(c, &n, v);
        if (!s)
            goto out_props;
        offs[i] = len;
        bool ok = append(&buf, &len, &cap, s, n);
        JS_FreeCString(c, s);
        if (!ok)
            goto oom;
    }
    for (uint32_t i = 0; i < nprops; i++) {
        JSValue v = JS_GetProperty(c, argv[2], props[i].atom);
        if (JS_IsException(v))
            goto out_props;
        if (JS_IsUndefined(v))
            continue;
        size_t kn, vn;
        const char *k = JS_AtomToCStringLen(c, &kn, props[i].atom);
        const char *s = k ? JS_ToCStringLen(c, &vn, v) : NULL;
        if (!s) {
            if (k)
                JS_FreeCString(c, k);
            goto out_props;
        }
        offs[nargs + nenv++] = len;
        bool ok = append(&buf, &len, &cap, k, kn);
        if (ok) {
            buf[len - 1] = '=';
            len--;
            ok = append(&buf, &len, &cap, s, vn);
        }
        JS_FreeCString(c, k);
        JS_FreeCString(c, s);
        if (!ok)
            goto oom;
    }
    if (props)
        JS_FreePropertyEnum(c, props, nprops);
    props = NULL;
    p->strings = buf;
    buf = NULL;
    p->argv = malloc((nargs + 1 + nenv + 1) * sizeof(char *));
    for (int64_t i = 0; i < nargs; i++)
        p->argv[i] = p->strings + offs[i];
    p->argv[nargs] = NULL;
    p->envp = p->argv + nargs + 1;
    for (uint32_t i = 0; i < nenv; i++)
        p->envp[i] = p->strings + offs[nargs + i];
    p->envp[nenv] = NULL;
    p->ch.argv = p->argv;
    p->ch.envp = has_env ? p->envp : environ;

    if (!JS_IsUndefined(argv[4]) && !JS_IsNull(argv[4])) {
        p->cwd_c = JS_ToCString(c, argv[4]);
        if (!p->cwd_c)
            goto out;
        p->ch.cwd = p->cwd_c;
    }
    {
        const char *path = NULL;
        if (JS_IsString(argv[3]))
            path = JS_ToCString(c, argv[3]);
        bool found = which(p->file_c, path && *path ? path : "/usr/bin:/bin", p->ch.cwd, p->path, sizeof p->path);
        if (path)
            JS_FreeCString(c, path);
        if (!found) {
            char msg[PATH_MAX + 64];
            snprintf(msg, sizeof msg, "Executable not found in $PATH: \"%s\"", p->file_c);
            JS_Throw(c, sys_error(c, ENOENT, NULL, p->file_c, msg));
            goto out;
        }
        p->ch.path = p->path;
    }

    int32_t flags = 0, uid = -1, gid = -1;
    JS_ToInt32(c, &flags, argv[6]);
    if (argc > 7 && !JS_IsUndefined(argv[7]) && !JS_IsNull(argv[7])) {
        JS_ToInt32(c, &uid, argv[7]);
        p->ch.set_uid = true;
        p->ch.uid = (uid_t)uid;
    }
    if (argc > 8 && !JS_IsUndefined(argv[8]) && !JS_IsNull(argv[8])) {
        JS_ToInt32(c, &gid, argv[8]);
        p->ch.set_gid = true;
        p->ch.gid = (gid_t)gid;
    }
    p->ch.detached = flags & 1;

    // The stdio slots.
    int64_t nslots = 0;
    if (JS_GetLength(c, argv[5], &nslots))
        goto out;
    if (nslots < 3)
        nslots = 3;
    if (nslots > MAX_SLOTS) {
        JS_Throw(c, sys_error(c, EMFILE, "posix_spawn", NULL, NULL));
        goto out;
    }
    p->ch.nslots = (int)nslots;
    for (int i = 0; i < nslots; i++) {
        JSValue v = JS_GetPropertyInt64(c, argv[5], i);
        int no = 0;
        int src = -1;
        if (JS_IsString(v)) {
            // A file: read for stdin, written for the others (made if it
            // is not there).
            const char *f = JS_ToCString(c, v);
            if (!f)
                goto out;
            int oflags = (i == 0 ? O_RDONLY : i < 3 ? O_WRONLY : O_RDWR) | O_CREAT | O_CLOEXEC;
            int fd = open(f, oflags, 0664);
            if (fd < 0) {
                JS_Throw(c, sys_error(c, errno, "open", f, NULL));
                JS_FreeCString(c, f);
                goto out;
            }
            JS_FreeCString(c, f);
            p->temp[p->ntemp++] = fd;
            src = above(p, fd, nslots);
        } else if (JS_GetTypedArrayType(v) >= 0) {
            // Bytes for stdin: a memfd holding them (else a pipe, written
            // by the caller).
            size_t n;
            uint8_t *data = JS_GetUint8Array(c, &n, v);
            int fd = memfd_create("spawn_stdio_stdin", MFD_CLOEXEC);
            if (fd >= 0) {
                size_t off = 0;
                while (off < n) {
                    ssize_t w = write(fd, data + off, n - off);
                    if (w < 0 && errno == EINTR)
                        continue;
                    if (w <= 0)
                        break;
                    off += w;
                }
                if (off < n) {
                    close(fd);
                    fd = -1;
                } else {
                    lseek(fd, 0, SEEK_SET);
                }
            }
            if (fd >= 0) {
                p->temp[p->ntemp++] = fd;
                src = above(p, fd, nslots);
            } else {
                int fds[2];
                if (pipe2(fds, O_CLOEXEC) < 0) {
                    no = errno;
                } else {
                    p->temp[p->ntemp++] = fds[0];
                    p->parent[i] = fds[1];
                    fcntl(fds[1], F_SETFL, O_NONBLOCK);
                    src = above(p, fds[0], nslots);
                    p->input = data;
                    p->input_len = n;
                    p->input_pipe = true;
                }
            }
        } else {
            int32_t kind;
            if (JS_ToInt32(c, &kind, v))
                goto out;
            if (kind >= 0) {
                // (Its own slot: left as it is, but kept across exec.)
                src = kind == i ? -1 : above(p, kind, nslots);
            } else if (kind == IO_INHERIT) {
                src = -1;
            } else if (kind == IO_IGNORE) {
                if (i > 2) {
                    src = -2;
                } else {
                    if (dev_null < 0)
                        dev_null = open("/dev/null", O_RDWR | O_CLOEXEC);
                    src = dev_null < 0 ? -2 : above(p, dev_null, nslots);
                }
            } else if (kind == IO_PIPE && i < 3) {
                int fds[2];
                if (pipe2(fds, O_CLOEXEC) < 0) {
                    no = errno;
                } else {
                    // stdin: the child reads; stdout, stderr: it writes.
                    int mine = i == 0 ? fds[1] : fds[0], theirs = i == 0 ? fds[0] : fds[1];
                    p->temp[p->ntemp++] = theirs;
                    p->parent[i] = mine;
                    if (!sync || i > 0)
                        fcntl(mine, F_SETFL, O_NONBLOCK);
                    if (i > 0)
                        fcntl(mine, F_SETPIPE_SZ, PIPE_SIZE);
                    src = above(p, theirs, nslots);
                }
            } else if (kind == IO_PIPE || kind == IO_SOCKET) {
                int fds[2];
                if (socketpair(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0, fds) < 0) {
                    no = errno;
                } else {
                    p->temp[p->ntemp++] = fds[1];
                    p->parent[i] = fds[0];
                    fcntl(fds[0], F_SETFL, O_NONBLOCK);
                    src = above(p, fds[1], nslots);
                }
            }
        }
        if (no || src < -2) {
            JS_Throw(c, sys_error(c, no ? no : errno, "posix_spawn", NULL, NULL));
            goto out;
        }
        p->ch.src[i] = src;
    }
    ret = 0;
    goto out;
oom:
    JS_ThrowOutOfMemory(c);
out_props:
    if (props)
        JS_FreePropertyEnum(c, props, nprops);
out:
    free(buf);
    free(offs);
    return ret;
}

// The error of a child that did not run, as Bun's: with its executable as
// given (argv[0]).
static JSValue throw_spawn_error(JSContext *c, Prep *p, int no) {
    const char *shown = p->argv && p->argv[0] && *p->argv[0] ? p->argv[0] : p->file_c;
    return JS_Throw(c, sys_error(c, no, "posix_spawn", shown, NULL));
}

// spawnProcess(file, argv, env, PATH, cwd, stdio, flags, uid, gid): starts
// the child; [exit watch (0 if its exit cannot be watched), pid, the
// parent's end of each slot's pipe (or -1)...].
static JSValue js_spawn_process(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    Prep p;
    if (prep(c, &p, argc, argv, false) < 0) {
        prep_free(c, &p, true);
        return JS_EXCEPTION;
    }
    pid_t pid = start_child(&p.ch);
    if (pid < 0) {
        JSValue r = throw_spawn_error(c, &p, -pid);
        prep_free(c, &p, true);
        return r;
    }
    int nslots = p.ch.nslots;
    // (The input a memfd could not hold: written by the caller.)
    prep_free(c, &p, false);
    double h = 0;
    int pidfd = (int)syscall(SYS_pidfd_open, pid, 0);
    if (pidfd >= 0) {
        fcntl(pidfd, F_SETFD, FD_CLOEXEC);
        uint32_t i = watch_new(W_EXIT, pidfd, pid);
        if (watch_poll(watches[i], true) == 0)
            h = handle_of(i);
        else
            watch_free(i, true);
    }
    JSValue r = JS_NewArray(c);
    JS_SetPropertyUint32(c, r, 0, JS_NewFloat64(c, h));
    JS_SetPropertyUint32(c, r, 1, JS_NewInt32(c, pid));
    for (int i = 0; i < nslots; i++)
        JS_SetPropertyUint32(c, r, i + 2, JS_NewInt32(c, p.parent[i]));
    return r;
}

// spawnReap(pid): [code, signal, rusage] once the child has exited (for a
// child whose exit could not be watched), else undefined.
static JSValue js_spawn_reap(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    int32_t pid;
    if (JS_ToInt32(c, &pid, argv[0]))
        return JS_EXCEPTION;
    int code, sig;
    struct rusage ru;
    if (!reap(pid, false, &code, &sig, &ru))
        return JS_UNDEFINED;
    JSValue r = JS_NewArray(c);
    JS_SetPropertyUint32(c, r, 0, JS_NewInt32(c, code));
    JS_SetPropertyUint32(c, r, 1, JS_NewInt32(c, sig));
    JS_SetPropertyUint32(c, r, 2, rusage_value(c, &ru));
    return r;
}

// ---- spawnSync ----

typedef struct {
    int fd;
    uint8_t *buf;
    size_t len, cap;
} Out;

static int64_t now_ms(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (int64_t)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

// Reads what the pipe holds into `o`: false at its end (or an error).
static bool sync_read(JSRuntime *rt, Out *o) {
    for (;;) {
        if (o->cap - o->len < READ_MIN) {
            size_t cap = o->cap ? o->cap * 2 : READ_MIN * 2;
            uint8_t *b = js_realloc_rt(rt, o->buf, cap);
            if (!b)
                return false;
            o->buf = b;
            o->cap = cap;
        }
        ssize_t n = read(o->fd, o->buf + o->len, o->cap - o->len);
        if (n > 0) {
            o->len += n;
            continue;
        }
        if (n < 0 && errno == EINTR)
            continue;
        return n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK);
    }
}

// spawnSync(file, argv, env, PATH, cwd, stdio, flags, uid, gid, timeout,
// maxBuffer, killSignal): runs the child to its end; [code (-1 if
// signaled), signal, stdout, stderr (Buffers of the pipes, else
// undefined), pid, timed out, maxBuffer exceeded, rusage].
static JSValue js_spawn_sync(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    JSRuntime *rt = JS_GetRuntime(c);
    Prep p;
    if (prep(c, &p, argc, argv, true) < 0) {
        prep_free(c, &p, true);
        return JS_EXCEPTION;
    }
    double timeout = 0, max_buffer = 0;
    int32_t kill_sig = SIGTERM;
    JS_ToFloat64(c, &timeout, argv[9]);
    JS_ToFloat64(c, &max_buffer, argv[10]);
    JS_ToInt32(c, &kill_sig, argv[11]);
    pid_t pid = start_child(&p.ch);
    if (pid < 0) {
        JSValue r = throw_spawn_error(c, &p, -pid);
        prep_free(c, &p, true);
        return r;
    }
    const uint8_t *input = p.input;
    size_t input_len = p.input_len, input_off = 0;
    int in_fd = p.input_pipe ? p.parent[0] : -1;
    Out outs[2] = {{p.parent[1], NULL, 0, 0}, {p.parent[2], NULL, 0, 0}};
    // (A pipe to stdin with no bytes for it: the child reads its end now.)
    if (!p.input_pipe && p.parent[0] >= 0)
        close(p.parent[0]);
    for (int i = 3; i < p.ch.nslots; i++) {
        if (p.parent[i] >= 0)
            close(p.parent[i]);
    }
    prep_free(c, &p, false);

    int code = 0, sig = 0;
    struct rusage ru;
    memset(&ru, 0, sizeof ru);
    bool exited = false, timed_out = false, over = false;
    if (outs[0].fd < 0 && outs[1].fd < 0 && in_fd < 0 && !(timeout > 0)) {
        // Nothing to read or write, no time limit: the child's end, blocked on.
        exited = reap(pid, true, &code, &sig, &ru);
    } else {
        int pidfd = (int)syscall(SYS_pidfd_open, pid, 0);
        int64_t deadline = timeout > 0 ? now_ms() + (int64_t)timeout : 0;
        for (;;) {
            struct pollfd fds[4];
            int n = 0, at_pid = -1, at_out[2] = {-1, -1}, at_in = -1;
            if (!exited && pidfd >= 0) {
                at_pid = n;
                fds[n++] = (struct pollfd){pidfd, POLLIN, 0};
            }
            for (int k = 0; k < 2; k++) {
                if (outs[k].fd >= 0) {
                    at_out[k] = n;
                    fds[n++] = (struct pollfd){outs[k].fd, POLLIN, 0};
                }
            }
            if (in_fd >= 0) {
                at_in = n;
                fds[n++] = (struct pollfd){in_fd, POLLOUT, 0};
            }
            if (exited && n == 0)
                break;
            int wait = -1;
            if (deadline) {
                int64_t left = deadline - now_ms();
                wait = left > 0 ? (int)left : 0;
            }
            // (No pidfd: the child's exit is looked for now and then.)
            if (!exited && pidfd < 0 && (wait < 0 || wait > 10))
                wait = 10;
            int r = poll(fds, n, wait);
            if (r < 0 && errno != EINTR)
                break;
            if (deadline && now_ms() >= deadline && !exited) {
                kill(pid, kill_sig);
                timed_out = true;
                deadline = 0;
            }
            if (!exited && (at_pid < 0 || (r > 0 && fds[at_pid].revents)))
                exited = reap(pid, false, &code, &sig, &ru);
            for (int k = 0; k < 2; k++) {
                if (at_out[k] >= 0 && r > 0 && fds[at_out[k]].revents) {
                    if (!sync_read(rt, &outs[k])) {
                        close(outs[k].fd);
                        outs[k].fd = -1;
                    }
                    if (max_buffer > 0 && (double)outs[k].len > max_buffer && !over && !exited) {
                        kill(pid, kill_sig);
                        over = true;
                    }
                }
            }
            if (at_in >= 0 && r > 0 && fds[at_in].revents) {
                for (;;) {
                    ssize_t w = write(in_fd, input + input_off, input_len - input_off);
                    if (w > 0)
                        input_off += w;
                    if (w < 0 && errno == EINTR)
                        continue;
                    if (w <= 0 || input_off == input_len)
                        break;
                }
                if (input_off == input_len || (errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR)) {
                    close(in_fd);
                    in_fd = -1;
                }
            }
            // Killed here: the output so far, not what a descendant still
            // holding the pipes might write (as Node's).
            if (exited && (timed_out || over)) {
                for (int k = 0; k < 2; k++) {
                    if (outs[k].fd >= 0) {
                        sync_read(rt, &outs[k]);
                        close(outs[k].fd);
                        outs[k].fd = -1;
                    }
                }
                if (in_fd >= 0) {
                    close(in_fd);
                    in_fd = -1;
                }
            }
        }
        if (pidfd >= 0)
            close(pidfd);
        for (int k = 0; k < 2; k++) {
            if (outs[k].fd >= 0)
                close(outs[k].fd);
        }
        if (in_fd >= 0)
            close(in_fd);
        if (!exited)
            exited = reap(pid, true, &code, &sig, &ru);
    }

    JSValue r = JS_NewArray(c);
    JS_SetPropertyUint32(c, r, 0, JS_NewInt32(c, code));
    JS_SetPropertyUint32(c, r, 1, JS_NewInt32(c, sig));
    for (int k = 0; k < 2; k++) {
        JSValue v = JS_UNDEFINED;
        if (outs[k].buf || p.parent[k + 1] >= 0) {
            uint8_t *b = outs[k].buf;
            if (!b)
                b = js_malloc_rt(rt, 1);
            else if (outs[k].len < outs[k].cap && outs[k].len > 0) {
                uint8_t *s = js_realloc_rt(rt, b, outs[k].len);
                if (s)
                    b = s;
            }
            v = bytes_value(c, b, outs[k].len, true);
        }
        JS_SetPropertyUint32(c, r, 2 + k, v);
    }
    JS_SetPropertyUint32(c, r, 4, JS_NewInt32(c, pid));
    JS_SetPropertyUint32(c, r, 5, JS_NewBool(c, timed_out));
    JS_SetPropertyUint32(c, r, 6, JS_NewBool(c, over));
    JS_SetPropertyUint32(c, r, 7, rusage_value(c, &ru));
    return r;
}

// ---- Watches, from JavaScript ----

// spawnInit(handler, Buffer.prototype): the handler of every watch's events.
static JSValue js_spawn_init(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    handler = JS_DupValue(c, argv[0]);
    buffer_proto = JS_DupValue(c, argv[1]);
    // (Writing to a pipe whose reader is gone fails with EPIPE rather than
    // ending the program, as in Node; children get the default back.)
    signal(SIGPIPE, SIG_IGN);
    return JS_UNDEFINED;
}

// spawnWatch(fd, write): a watch of a pipe (not polling yet): its handle.
static JSValue js_spawn_watch(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    int32_t fd;
    if (JS_ToInt32(c, &fd, argv[0]))
        return JS_EXCEPTION;
    uint32_t i = watch_new(JS_ToBool(c, argv[1]) ? W_WRITE : W_READ, fd, 0);
    return JS_NewFloat64(c, handle_of(i));
}

// spawnWatchPoll(watch, on): polls its descriptor (reads it, or waits for
// it to take more), or stops; 0 or -errno.
static JSValue js_spawn_watch_poll(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    Watch *w = watch_of(c, argv[0], NULL);
    if (!w)
        return JS_NewInt32(c, -EBADF);
    return JS_NewInt32(c, watch_poll(w, JS_ToBool(c, argv[1])));
}

// spawnWatchRef(watch, refd): whether it keeps the program alive.
static JSValue js_spawn_watch_ref(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    Watch *w = watch_of(c, argv[0], NULL);
    if (w)
        watch_ref(w, JS_ToBool(c, argv[1]));
    return JS_UNDEFINED;
}

// spawnWatchClose(watch, closeFd): ends it.
static JSValue js_spawn_watch_close(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    uint32_t i;
    if (watch_of(c, argv[0], &i))
        watch_free(i, JS_ToBool(c, argv[1]));
    return JS_UNDEFINED;
}

// spawnWrite(fd, bytes, offset): writes what the descriptor takes of
// bytes[offset..]: how much, or -errno if none.
static JSValue js_spawn_write(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    int32_t fd;
    double off = 0;
    if (JS_ToInt32(c, &fd, argv[0]) || JS_ToFloat64(c, &off, argv[2]))
        return JS_EXCEPTION;
    size_t n;
    uint8_t *data = JS_GetUint8Array(c, &n, argv[1]);
    if (!data && n != 0)
        return JS_EXCEPTION;
    size_t done = off > 0 ? (size_t)off : 0;
    size_t start = done;
    while (done < n) {
        ssize_t w = write(fd, data + done, n - done);
        if (w > 0) {
            done += w;
            continue;
        }
        if (w < 0 && errno == EINTR)
            continue;
        if (done > start || (w < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)))
            break;
        return JS_NewInt32(c, -errno);
    }
    return JS_NewFloat64(c, (double)(done - start));
}

// spawnClose(fd).
static JSValue js_spawn_close(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    int32_t fd;
    if (JS_ToInt32(c, &fd, argv[0]))
        return JS_EXCEPTION;
    if (fd >= 0)
        close(fd);
    return JS_UNDEFINED;
}

// spawnDup(fd): a duplicate (close-on-exec), or -errno.
static JSValue js_spawn_dup(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    int32_t fd;
    if (JS_ToInt32(c, &fd, argv[0]))
        return JS_EXCEPTION;
    int d = fcntl(fd, F_DUPFD_CLOEXEC, 3);
    return JS_NewInt32(c, d < 0 ? -errno : d);
}

// spawnKill(pid, signal): 0 or -errno.
static JSValue js_spawn_kill(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    int32_t pid, sig;
    if (JS_ToInt32(c, &pid, argv[0]) || JS_ToInt32(c, &sig, argv[1]))
        return JS_EXCEPTION;
    return JS_NewInt32(c, kill(pid, sig) == 0 ? 0 : -errno);
}

// spawnError(errno, syscall, path?): a Node system error.
static JSValue js_spawn_error(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    int32_t no;
    if (JS_ToInt32(c, &no, argv[0]))
        return JS_EXCEPTION;
    const char *sc = JS_ToCString(c, argv[1]);
    const char *path = argc > 2 && JS_IsString(argv[2]) ? JS_ToCString(c, argv[2]) : NULL;
    JSValue e = sys_error(c, no < 0 ? -no : no, sc, path, NULL);
    if (sc)
        JS_FreeCString(c, sc);
    if (path)
        JS_FreeCString(c, path);
    return e;
}

const JSCFunctionListEntry beyond_spawn_functions[] = {
    JS_CFUNC_DEF("spawnInit", 2, js_spawn_init),
    JS_CFUNC_DEF("spawnProcess", 9, js_spawn_process),
    JS_CFUNC_DEF("spawnSync", 12, js_spawn_sync),
    JS_CFUNC_DEF("spawnReap", 1, js_spawn_reap),
    JS_CFUNC_DEF("spawnWatch", 2, js_spawn_watch),
    JS_CFUNC_DEF("spawnWatchPoll", 2, js_spawn_watch_poll),
    JS_CFUNC_DEF("spawnWatchRef", 2, js_spawn_watch_ref),
    JS_CFUNC_DEF("spawnWatchClose", 2, js_spawn_watch_close),
    JS_CFUNC_DEF("spawnWrite", 3, js_spawn_write),
    JS_CFUNC_DEF("spawnClose", 1, js_spawn_close),
    JS_CFUNC_DEF("spawnDup", 1, js_spawn_dup),
    JS_CFUNC_DEF("spawnKill", 2, js_spawn_kill),
    JS_CFUNC_DEF("spawnError", 3, js_spawn_error),
};
const int beyond_spawn_function_count = sizeof beyond_spawn_functions / sizeof *beyond_spawn_functions;
