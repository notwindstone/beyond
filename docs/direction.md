# Direction: closing the gap to Bun on untyped JavaScript

October 2026. This document replaces profile-driven small optimizations
with a plan built from two things: a per-request map of where Beyond and
Bun spend their instructions, and a study of how JavaScriptCore (WebKit)
and Bun are built. Its purpose is to pick two or three large, designed
changes. Nothing in it is implemented yet.

The studies are in [study/](study/): JavaScriptCore's object model and
inline caches (A), its allocation and collector (B), its fast paths in
builtins (C), Bun's architecture and history (D), and making
ahead-of-time compiled untyped JavaScript fast (E). Each cites the WebKit
and Bun sources by file and line. The scripts that made the gap map are in
[../bench/gap/](../bench/gap/).

## 1. Where the instructions go

Instructions per request under callgrind, at steady state (30,000
warm-up requests, then 10,000 measured, 4 connections). Beyond was built
with the LLVM backend (`--march x86-64-v3`). Bun is 1.4.3's symbolized
profile build, with `BUN_OPTIONS` cleared. After only 2,000 warm-up
requests, Bun's profile still counted 18.9k instructions per request of
DFG/FTL compilation, done on background threads; after 30,000 it was
about zero.

| Workload | Beyond | Bun | Ratio |
|---|---:|---:|---:|
| Hono, `GET /users/42` | 83,454 | 43,802 | 1.91× |
| Elysia (AOT bundle), `GET /users/42` | 50,825 | 33,183 | 1.53× |

Hono, Beyond, exclusive instructions per request by feature:

| Feature | Instr. | | Feature | Instr. |
|---|---:|---|---|---:|
| compiled code | 13,530 | | arrays | 3,558 |
| GC, allocation, freeing | 9,622 | | promises, async | 3,533 |
| object creation | 8,352 | | instanceof | 2,199 |
| HTTP server (uWS, Beyond) | 7,861 | | regexp | 2,046 |
| property get (generic, IC misses) | 7,530 | | property set | 1,713 |
| memset (uWS request zeroing) | 6,604 | | arithmetic, conversions | 1,508 |
| strings and atoms | 5,181 | | interpreter | 1,201 |
| calls into C builtins | 4,928 | | JSON, for-in, typed arrays, libc, other | 4,089 |

Hono, Bun: runtime (uWS, WebCore, Rust: Request, Response, Headers)
15,521; JSC C++ runtime and LLInt 8,047; memset 6,616 (the same uWS
zeroing); GC and allocation 6,232 (2,930 of it `sanitizeStackForVMImpl`,
which clears dead stack); JIT-compiled code 3,508; malloc, libc, other
3,873.

What the map says:

- **The gap is the untyped JavaScript.** Framework code from
  `node_modules` has no TypeScript types. Without the HTTP server and the
  memset, Beyond spends ~69k instructions per request on it and Bun
  ~21.6k (3.2×). In Elysia, compiled code alone is 9.6k against JSC's
  1.7k (5.7×).
- **The server side is already ours.** Beyond's HTTP work is 7.9k per
  request against Bun's 15.5k. Study D finds nothing in Bun's request
  path that we lack, apart from laziness (below). Our vendored uWS already
  has Bun's September 2026 fix for pipelined responses
  (`uncorkCompletedResponse`), and Beyond already drains microtasks right
  after the handler.
- **Typed code is fine.** On the Luminous benchmarks (typed TypeScript)
  we run at 0.47–1.25× Bun's time.
- **An interpreter tier would not help.** The interpreter is 1.4% of
  instructions; almost everything already runs as native code. The cost
  is in what that native code calls: generic C paths for property
  lookups, object creation, `instanceof` and builtins.

## 2. How JSC and Bun are built: the principles that matter here

1. **JSC's fast inline-cache hits are not where it wins.** Its
   interpreter (LLInt) and Baseline JIT use data-only caches, and their
   hit paths are about as long as ours (an own-property hit is ~10–14
   instructions in Baseline, ~12–13 in Luminous). JSC wins in its
   optimizing tiers (DFG/FTL). There, profiles feed inlining
   (including getters and up to 5 callees per site), turn caches into a
   shape check plus a load at a known offset, fold prototype lookups to
   constants, and remove repeated checks (A §2.3, E §1).
2. **Misses are cheap too.** A site that sees many shapes falls back to a
   VM-wide (shape, name) → (holder, offset) cache costing about 25
   instructions, not to a full lookup. Adding a property is a cached
   transition (old shape → new shape, offset) of 10–15 instructions
   (A §1.4, §2.4). We fall back to `JS_GetProperty`, and never cache
   additions.
3. **Validity is watched, not checked.** Prototype-chain facts are kept
   by watchpoints on the objects they depend on. They are adaptive: an
   unrelated change re-installs them, and a real change clears only the
   caches that relied on it. A hit pays nothing for them (A §3). We have
   one global epoch, bumped by any change to any watched object,
   including writes of values.
4. **Builtins have one "still the original" bit per feature.** For example: "RegExp.prototype's
   `exec`, `flags`, flag getters and symbol methods are the originals",
   "Promise.prototype.then is the original and Object.prototype has no
   `then`", "Array species is the original". With the bit set and the
   receiver still in its original shape, a builtin skips the spec's
   observable lookups and reads internal state directly (C §0, §6). This
   is spec-exact: when nobody has changed anything, those lookups have
   no observable effect.
5. **Objects are born with their final shape.** Each allocation site
   carries a predicted (size class, shape) pair, from a static count of
   `this.x =` and literal properties plus run-time heuristics. Objects the
   runtime makes itself (iterator results, match arrays, route
   parameters) have premade shapes. Creating `{}` in optimized code is
   ~15 instructions with no call (B §1).
6. **GC cost follows what survives.** Sweeping walks mark bits lazily
   at allocation. Plain objects, arrays and their storage have no
   destructor, so a dead one costs nothing (B §2).
7. **Bun's runtime is lazy.** It builds URL and headers on first use and
   caches them in hidden slots. It prebuilds shapes for the objects it
   creates and interns the property names it reads. Its review rules
   require before/after numbers for every input class, forbid any
   measured regression, and say "the common case pays zero for rare
   features" (D §4).
8. **What only a JIT can do:** recompiling after a speculation fails, and
   inlining callees first seen at run time. Everything else above is
   runtime data structures plus fixed code. JSC's interpreter uses most of
   it with no JIT. The checks-that-never-merge-back that make speculation
   pay can be built ahead of time: a failed check jumps into a generic
   copy of the same function (E §1.5). Our conservative stack scanning
   and lack of interpreter frames make that easier than it is in JSC.
9. **Prior art agrees on the route** (E §2). SpiderMonkey's Warp dropped
   global type inference and compiled from IC state alone: +10–12%
   Speedometer, +20% Google Docs load. Static Hermes shows the other
   route: untyped code compiled to native without speculation runs at
   about interpreter speed. And removing memory accesses from IC hits gave
   no measurable speedup on modern CPUs (Poirier, Rohou and Serrano,
   2025). So we should remove work (calls, lookups, allocations, boxing),
   not shave hit paths.

## 3. Candidates

Gains are estimates per Hono request (83.5k) unless measured. They overlap
somewhat; section 4 counts each item once.

### Quick wins (days, outside the engine's semantics)

| Change | Gain | Cost / risk | Notes |
|---|---|---|---|
| Stop zero-initializing uWS `HttpRequest` (200 headers × 32 bytes, `HttpParser.h:1598`) | −6.6k (measured memset) | ½ day / low | Bun pays the same; check how the parser marks the end of headers first |
| LLVM as the default backend of `beyond build` | +10–15% Hono throughput (measured) | ½ day / low | Builds are slower; Cranelift stays available |
| Lazy request headers and URL in `server.c`; predefined atoms; write header strings without converting them to C strings | −1 to −2k | 1–2 days / low | `add_header`, `JS_NewStringLen`, `JS_ToCStringLen2` in `write_head` (C §2.2, D §2.2) |

### Bet A: builtins that skip the spec's observable steps when nothing changed

One mechanism (C §6, "W1"): one "still the original" bit per feature in
the context. It is cleared only when a specific watched property (or a
watched absence) changes, through the existing `is_watched` hook plus a
small atom-to-bit table per watched object. Then applied to:

| Application | Gain | Notes |
|---|---|---|
| RegExp: `match`, `replace`, `split`, `search`, `test`, `exec` | −5.9k (one `str.match` is 7.3k today) | guard: `shape == ctx->regexp_shape`, bit set, integer `lastIndex`; flags read from the bytecode; capture buffer on the stack; result array filled directly |
| Array species in `slice`, `splice`, `concat`, `map`/`filter` | −4.3k | species lookup is 2.5k of two `slice` calls |
| Promises and `await`: per-shape "not thenable" bit, settle without resolving functions, first reaction stored inline | −2.5k | microtask order must stay exact; test262 and Node's ordering tests |
| `Object.keys` and for-in key cache per shape | −1k | |
| Atom lookups: reuse cached string hash, small key→atom cache, no `JS_GetPropertyStr` in hot builtins | −0.4k | |

Total about −14k. Cost about 1–1.5 weeks. Risk: low to medium. It is
engine C only, every fast path is guarded, and test262 covers these
builtins heavily. The main risk is a mutation path that skips the hook.

### Bet B: an object model that pays at creation, not at use

| Application | Gain | Notes |
|---|---|---|
| Final-shape allocation: per-site `new F()` cache {F, F.prototype, shape, size} sized from a static count of `this.x =`; premade shapes for runtime-created objects (promises, iterator results, Beyond's request objects); empty shape cached per prototype; a slimmer C allocation path | −5 to −6k | object creation is 8.4k; `JS_NewObjectProtoClass` is 155–250 instructions per object (B §6) |
| Closure boxes as one cell per scope, not a JS object plus a traced cell per variable | −2 to −3k | 13 boxes per request at ~390 instructions each, plus their finalizers |
| `instanceof` cache (constructor, its shape, `prototype` slot), then an inline walk of the chain | −1.9k | today ~180 instructions, 14 times per request |
| Put-transition cache {old shape, new shape, slot} and a per-shape last-transition slot ahead of `find_hashed_shape_prop` | −1.4k | adds after creation are ~210 instructions each |
| VM-wide (shape, atom) → (holder, slot, kind) cache for misses and C builtins; split the prototype epoch into structural changes versus value writes | −2 to −4k | first measure epoch bumps and refreshes per request (A §3.3) |
| Array, property and promise storage traced by its owner, with no finalizer | −1 to −2k | finalizing is 2.1k of the 9.6k GC bucket |

Total about −12 to −17k. Cost about 2–3 weeks. Risk: medium. Shapes
must stay alive while caches point at them, and watched objects must stay
out of the transition cache.

### Bet C: profile-guided compilation of untyped code

A training run at build time (E §4, P1): an instrumented build records
what each property cache and call site saw. Shapes are keyed by a
descriptor (prototype or allocation site, plus key order), because
pointers mean nothing in the next process. The rebuild feeds that into
the passes Luminous already has for typed code:

- shape-checked loads at constant offsets;
- predicted and inlined callees and getters;
- direct calls with arguments in registers;
- specialized `instanceof`.

Today's code stays as the fallback, so a stale profile costs only a
guard.

| Step | Gain | Cost / risk |
|---|---|---|
| Census: dump cache states after a Hono and an Elysia run (single-shape / few / many sites) | sizes the bet | 1 day / none |
| P1, profile-fed specialization | −10 to −15k beyond A and B (E estimates 15–25k on its own) | 2–3 weeks / low correctness risk, more code |
| P2, two versions of hot functions; a failed check jumps into the generic copy, so typed values never merge back | plausibly half of the remaining compiled code (13.5k in Hono, 9.6k in Elysia) | weeks / high: needs a fuzzer that forces exits |

Bet C is the only one that attacks compiled code itself, and Elysia's gap
is mostly there. It is also the only one that changes the product: the
build gains a training step (the app's own benchmark or tests), or a
profile written by a previous run.

### Later, for memory

- Report per-request native memory to the collector. When Bun dropped
  this, its RSS plateau rose 15–20 MB (D §6).
- `MADV_NOHUGEPAGE` on our arenas. Transparent huge pages cost Bun's
  hello server 22 MB.
- An idle-time collection timer.
- A smaller object header: 32-bit shape reference, no `ref_count`, no
  `prop` for objects with inline properties. About 25% less memory on
  small objects; high cost.
- Precise stack maps for compiled frames, to end the retention by stale
  spill slots that conservative scanning causes.

### Not doing, and why

- **An interpreter tier:** the interpreter is 1.4% of instructions.
- **Run-time code generation (a JIT):** out of scope. Everything we need
  besides recompilation works ahead of time.
- **Whole-program type inference** as the main engine: Warp's experience
  says the gain is lower than its cost. Kept as a cheap local supplement
  (E §4, P4).
- **Copying JSC's stack clearing on every slow path:** that is Bun's
  2.9k. Clearing once per event-loop turn would cost almost nothing.
- **Tuning IC hit paths:** see Poirier et al. above.
- **Inline properties without the `p->prop` indirection:** high risk to a
  QuickJS invariant, ~0.3k.

## 4. Recommendation

| Order | Work | Hono after (estimate) |
|---|---|---:|
| now | | 83.5k |
| 1 | Quick wins | ~75k |
| 2 | Bet A, builtins | ~61k |
| 3 | Bet B, object model | ~46–49k |
| 4 | Bet C, profile-guided compilation (census first) | ~33–39k |
| | Bun 1.4.3 | 43.8k |

A and B both act inside the engine and its runtime, with guards and spec
rules JSC has already worked out. Each is one mechanism applied to many
sites, which is the kind of change this plan was meant to produce. Done
together they should bring Hono within 5–10% of Bun's instruction count.
Beyond's cheaper server side should then carry throughput past Bun's;
that needs measuring. Elysia's gap sits
mostly in compiled code, so it needs C as well. The census, a day's work,
can run in parallel to size C before we commit to it.

Decisions for you:

1. Which bets, and in which order (the recommendation is A, then B, then
   C)?
2. Is a training step in `beyond build` acceptable for C? The other
   options are a profile file left by a previous run of the app, or
   static inference only (a smaller gain).
3. Should the quick wins go first, independently of the bets?

## 5. How the work is done

- **The gap map is the scoreboard.** Each change is measured before and
  after, per workload, by feature (`bench/gap/`). Instruction counts are
  deterministic, unlike this VM's wall time, which drifts 40–60% in a
  day. Changes to code shape are also checked with wall time, because
  instruction counts overstate gains from removing loads.
- **Design first, from the reference.** Each bet starts by reading the
  JSC or Bun code its study cites. Its guards, invalidation and spec
  rules are written down before any code. Then one mechanism, many
  applications.
- **A stronger safety net before measuring:**
  - test262 (identical failures before and after);
  - the Luminous and Beyond suites;
  - adversarial tests for every fast path: patch prototypes, species,
    `then` and flag getters in the middle of a run;
  - for Bet C, a fuzzer that forces exits.
- **Bun's rule:** no measured case may regress.

## 6. Progress

Done (October 2026): the quick wins, Bet A and Bet B. Instructions per
request under callgrind, steady state, LLVM backend:

| | Hono | Elysia |
|---|---:|---:|
| before | 83,454 | 50,825 |
| uWS request no longer zeroed; request fields one string, split on use | 76,077 | |
| Bet A (`0012`), with the above | 67,008 | 43,215 |
| Bet B (`0014`–`0016`, Luminous), with the above | 52,818 | 35,820 |
| Bun 1.4.3 | 43,802 | 33,183 |

In requests a second (`bench/run.sh`, ratios to Bun): Hono 89–108% of
Bun's after Bet B (`/users/:id` 89–94%), 77–84% after Bet A, from 61–75%;
Elysia 95–108% after Bet B, 88–93% after Bet A, from 78–85%. The plain servers answer 26–35%
more than Bun, from 16–17%.

- **Quick wins** (−7.4k on Hono). The uWS zeroing went from 6.6k to 0.2k.
  `beyond build` now uses LLVM when clang is present; Luminous splits a
  large program's IR so clang compiles the parts in parallel (Hono: 1 min
  34 s instead of 4 min 19 s, the same instructions per request).
  `beyond run` and the tests keep Cranelift. Writing response strings
  without converting them was left: it is already zero-copy for ASCII,
  with only ~300 instructions left.
- **Bet A** (−9.1k on Hono). The existing per-context "original" bits
  (`js_pristine`, re-checked only when the prototype epoch moves, which
  never happened in steady state in either app) already behaved like
  JSC's per-feature watchpoints. Bet A added bits for RegExp, array
  species and "Object.prototype has no `then`". Measured against the
  estimates:

  | Item | Saved | Estimate |
  |---|---:|---:|
  | `str.match(re)` (7.3k → 2.7k) | 4.6k | 5.9k |
  | species and `slice` | 2.0k | 4.3k |
  | `Object.keys` (920 → 380) | 0.5k | 1k |
  | `await` and settling | 0.5k | 2.5k |

  The remainder of each is allocation (arrays, promises, frames), which is
  Bet B's work. Atom-lookup caching was skipped (a safe cache would need
  clearing on every GC, for ~0.3k).
- **Bet B** (−14.2k on Hono, −7.4k on Elysia; estimate −12 to −17k).
  Each measured on Hono as it went in:

  | Item | Saved | Estimate |
  |---|---:|---:|
  | Closure variables by value: parameters and async functions' variables (boxes 13 → 2 a request) | 5.3k | 2–3k |
  | `instanceof` cache (constructor shape, class, `prototype` slot; chain walked inline) | 2.0k | 1.9k |
  | Put-transition cache (8 additions a request: 380 → ~100 each) | 1.7k | 1.4k |
  | Array and property storage: elements of literals in the array's cell; elements and properties that outgrow it in cells the owner marks, no finalizer | 2.1k | 1–2k |
  | Inline caches marked in a minor collection only while they hold young shapes | 0.7k | |
  | Per-site entries for properties a shape lacks (a miss cache) | 0.7k | 2–4k with the epoch split |
  | Luminous's runtime and glue compiled without stack protector and CET markers, as the engine | 0.5k | |
  | Builtin constructors' and namespaces' shapes shared at startup, so that sites cache their static methods (`Object.create`, `JSON.stringify`; Elysia: 1.0k) | ~0.8k | |
  | The collection trigger's test inline in allocations (`0016`) | ~0.2k | |

  Not done: final-shape allocation and a slimmer allocation path (object
  creation is still 3.6k: ~100 instructions an object, a fifth of it the
  function's prologue and epilogue), and the epoch
  split (the epoch never moved in steady state, as with Bet A). The
  VM-wide miss cache became per-site entries: what missed every request
  was a few sites, each with one absent property.
- **Found and fixed on the way:**
  - `JSON.stringify` of an array with holes after its elements dropped
    them (`0013`).
  - Predefined atoms cannot be added to the engine: the builtins shipped
    as bytecode (`Array.fromAsync`, `Iterator.zip`) number theirs from the
    table, and test262 caught it.
  - A use after free in minor collections (`0014`), there since the
    generational collector: functions and `arguments` objects did not
    mark the variable references still open. A closure made old while a
    variable it captured was open (and young) was not remembered; once the
    variable closed, a minor collection freed it under the closure. A
    stress test of Bet B's young-cache list found it, with a 64 KB young
    generation (`gc_young_caches.ts` in Luminous's tests).
- **What remains** (Hono, 52.8k against Bun's 43.8k):
  - Hono's router: `match` in `reg-exp-router/matcher.js` uses `this` in
    a plain function, which Luminous does not compile; the arrow it makes
    and the SmartRouter binds runs in the interpreter (~2k a request).
  - Hono sets each response from the previous one (`new Response(res.body,
    res)`): Beyond makes a byte stream for the body every request, and a
    controller for it (3.3k). A stream of a stored body could stay a body
    until read.
  - `obj[key]` reads go through the engine, with the key made an atom each
    time (Elysia: 8 a request, ~1.3k; Hono: 7). A site could cache the
    key string with the shape, as JSC's get-by-value does.
  - Object creation (3.6k), strings and atoms (3.8k), calls into C
    builtins (3.2k), promises (3.0k).
