# D — Bun: architecture, request path, event loop, perf history, JSC fork, memory

Source: Bun clone at `study/bun` (HEAD `017b2439a7`, 2026-10-16; 18,469 commits). All paths below are
relative to that clone unless noted. Read-only study; nothing was modified.

---

## 0. TL;DR for Beyond

- Bun's **runtime-side** per-request path is not especially lean (eager AbortSignal, heap-boxed Request,
  generic `JSC::call` through a `MarkedArgumentBuffer`, header copy on first `.headers` access, GC
  extra-memory report per request). Beyond's ~7.9k vs Bun's ~15.5k instr/req on that side is consistent
  with what the code shows. Bun wins on the **JS side** (JIT + JSC object model), not via server tricks.
- The server techniques that matter most for us are (1) **draining microtasks synchronously right after the
  handler and unwrapping an already-settled promise in place** (no extra tick for `async` handlers),
  (2) **corking: all writes of all requests parsed from one `read()` go out in one `send()`**,
  (3) **pre-built hidden classes (Structures) for every runtime-created object** (route `params`, generated
  classes via `LazyClassStructure`), filled by direct slot stores, (4) **lazily materialized Request
  fields cached in internal slots** (`cache: true` → `WriteBarrier` field in the cell), (5) **pre-interned
  property names for reading option bags** (`ResponseInit`), (6) **string/JSON bodies kept as the engine
  string and written as Latin-1 bytes without a copy**, (7) **static routes served entirely in native code**.
- Memory: JSC allocates through Bun's mimalloc (not libpas); THP disabled for mimalloc arenas
  (Bun.serve hello 46 MB vs 68 MB with THP); startup-hot functions ordered to the front of `.text`
  (−9 MB RSS); an idle GC controller (1 s / 30 s `collectAsync`, plus idle *full* collections at
  10 s / 2 min / 10 min that let JSC age out JIT code); per-request `reportExtraMemory(sizeof(ctx))` so
  eden GCs keep pace with native garbage (removing it raised RSS 15–20 MB).
- Surprise: Bun was **rewritten from Zig to Rust in May 2026** (`23427dbc12`, #30412), largely by
  Claude-driven workflow scripts; several perf/RSS regressions from the port were found and fixed
  afterwards. Also a 1.2.6→1.4.2 **pipelining regression of ~14 `send()`s per response** was only fixed
  in Sept 2026 (`86e3c7584f`).

---

## 1. Architecture overview

### 1.1 Zig → Rust

- `23427dbc12` 2026-05-14 "Rewrite Bun in Rust (#30412)" (Jarred Sumner, co-author Dylan Conway). The
  message says only: "Blog post with details coming soon. Still some optimization work to do before this
  lands in non-canary version." It deletes `build.zig` and `scripts/build/zig.ts`, adds `Cargo.toml`
  (workspace of ~200 crates), `scripts/build/rust.ts`, and ~40 `.claude/workflows/phase-*.workflow.js`
  scripts (`phase-a-port`, `phase-b2-cycle`, `phase-d-unsafe-audit`, `phase-g-mega-swarm`,
  `phase-h-windows-bughunt`...) — i.e. the port was driven by orchestrated Claude agent swarms in
  phases (port → break crate cycles → ungate → test swarms → unsafe audit → idioms audit).
- `d4514457e8` 2026-06-24 "Remove the .zig porting-reference sources" — Zig sources kept only as port
  reference for ~6 weeks. Today: 0 `.zig` files, 3,222 `.rs` files.
- **Why**: no rationale document is in the repo. Indirect evidence: the review culture (`REVIEW.md`)
  calls native memory safety "the most-blocked category"; the codegen grew `sharedThis` /
  "R-2 noalias re-entrancy" rules (`src/codegen/class-definitions.ts` `sharedThis` doc, citing a proven
  miscompile `b818e70e1c57` in `NodeHTTPResponse::cork`). I would not claim more than "safety/maintainability,
  details in an unpublished blog post".
- Port aftermath (perf work explicitly comparing to the last Zig release 1.3.14):
  `0b1e7e507b` "restore SIMD ASCII fast paths lost in the Rust port", `32a161f5af` "bundler: close the
  main-thread perf gap vs Zig 1.3.14", `19dd34df33` RSS regression (see §6), `db170d9882` "drop
  per-iteration heap allocs at 7 reshaped-for-borrowck sites", `a5e30c96d9` require() of builtins
  slower than 1.3.14 → deferred module init.

### 1.2 Layers (`CLAUDE.md`, `src/CLAUDE.md`)

| Layer | Where | Notes |
|---|---|---|
| JS engine | oven-sh/WebKit fork, prebuilt per ABI (`scripts/build/deps/webkit.ts:6` pins `WEBKIT_VERSION`) | built `PORT=JSCOnly`, static JSC, FTL on, `USE_BUN_JSC_ADDITIONS`, `USE_BUN_EVENT_LOOP`, `USE_MIMALLOC`+`USE_EXTERNAL_MIMALLOC` |
| C++ bindings | `src/jsc/bindings/` (~420 files) | `ZigGlobalObject.cpp` (still named Zig), WebCore-derived `FetchHeaders`, `HTTPHeaderMap`, streams, AbortSignal, `NodeHTTP.cpp`, `ServerRouteList.cpp`, generated classes |
| Rust JSC glue | `src/jsc/` (`bun_jsc`) | `VirtualMachine.rs`, `event_loop.rs`, `JSValue.rs`, `GarbageCollectionController.rs`, `host_fn.rs` |
| Runtime APIs | `src/runtime/` (`bun_runtime`) | `server/` (Bun.serve), `webcore/` (Request/Response/Body/Blob/streams/fetch), `node/`, `timer/` |
| Event loop crate | `src/event_loop/` | `Task` (16 B tag+ptr), `ConcurrentTask`, `DeferredTaskQueue`, `EventLoopTimer` |
| Sockets/HTTP | `packages/bun-usockets/` (C), `packages/bun-uws/src/*.h` (C++ header-only) | Bun's fork of uSockets/uWebSockets, with HTTP/2, HTTP/3 (lsquic), two cork slots |
| Allocator | oven-sh/mimalloc fork (`scripts/build/deps/mimalloc.ts`) | global malloc override on Linux; JSC heap allocates through it |
| Builtin JS | `src/js/` (`$`-intrinsics, bundled by `src/codegen/bundle-*.ts`) | streams, node:* modules |

### 1.3 How JS-visible classes are defined (codegen)

- Schema: `*.classes.ts` files using `define()` from `src/codegen/class-definitions.ts`
  (e.g. `src/runtime/webcore/response.classes.ts` defines Request/Response/Blob). Generator:
  `src/codegen/generate-classes.ts` (2,731 lines) emits C++ JSC classes + Rust `#[no_mangle]` thunks
  (`src/runtime/generated_classes.rs`). A newer unified `.bind.ts` generator (`af5743d74c`, 2026-10-15,
  "One bindgen") is replacing it; same vocabulary (`construct`, `proto`, `cache`, `internalFields`).
- Per class it generates `JSFoo : JSDestructibleObject` holding `void* m_ctx` (the Rust struct
  pointer), a `FooPrototype`, a `FooConstructor`, an **IsoSubspace** (`subspaceFor`, gen-classes:341/982)
  and a **`LazyClassStructure`** slot in the global object (`m_generatedLazyClasses[N]`,
  gen-classes:2089–2335, `initGeneratedLazyClasses` uses `initLater`): prototype/structure/constructor
  are created on first use, so unused classes cost nothing at startup.
- Prototype members are a static `HashTableValue[]` (gen-classes:136–190): methods as
  `NativeFunctionType`, getters as `CustomAccessor | DOMAttribute` (JSC reifies static tables lazily).
- **Cached values (`cache: true`)**: each cached getter gets a `mutable WriteBarrier<Unknown> m_<name>`
  in the cell (gen-classes:563–575). The getter thunk (gen-classes:706–740) returns `m_name` if set,
  else calls the Rust getter, stores the result with `.set(vm, this, result)`. `visitChildren` appends
  them (`appendHidden`, gen-classes:1104). Rust gets `<name>_get_cached`/`_set_cached` accessors.
  Request uses it for `headers`, `url`, `body`, `signal`; Response for `headers`, `url`, `statusText`, `body`.
  `values: ["stream"]` declares extra internal WriteBarrier slots not tied to a getter.
- **Finalizers**: `finalize: true` → C++ destructor calls `Foo__finalize(m_ctx)` → Rust
  `finalize(self: Box<Self>)` (gen-classes:1179–1190, 1801–1815); `refCounted: true` → wrapper holds one
  ref, finalizer drops it. `estimatedSize: true` → `reportExtraMemoryAllocated` at creation and
  `reportExtraMemoryVisited` in visitChildren (gen-classes:483, 1149); `hasPendingActivity` → opaque root.
- `JSType: "0b11101110"` gives the cells a dedicated JSType so `jsDynamicCast`/`as_class_ref` is a type-byte
  compare; `inherits` is generated as a switch (gen-classes:2238).
- Hand-written C++ classes follow the skill `.claude/skills/implementing-jsc-classes-cpp` (three classes,
  HashTableValue arrays, IsoSubspace, structures cached on the global object).

---

## 2. HTTP server request path (Bun.serve `fetch` handler, HTTP/1.1)

### 2.1 uWS → Rust

1. `packages/bun-uws/src/HttpContext.h:323` `onData`: `us_socket_ref`, HTTP/2 preface sniff,
   **cork the socket** (`:413`), then `consumePostPadded` parses *all* requests in the read buffer
   (`HttpParser.h`, zero-copy `HttpRequest` views into the receive buffer, header names lowercased in
   place, parser has a bloom filter `BloomFilter.h` for header lookups). Per request: reset response state,
   re-cork (`:570`, "every request of this read is dispatched corked"), route via `HttpRouter`
   (`selectedRouter->route(method, url)`), then:
   `if (!hasResponded() && !onAborted && !socketData) std::terminate();` — a handler must respond
   synchronously or register onAborted.
2. Route callback → `src/runtime/server/mod.rs:3495` `extern "C" on_request<SSL,DEBUG>` →
   `NewServer::on_request` (mod.rs:1139) → `prepare_js_request_context` (mod.rs:731; the generic H2/H3
   twin is `server_body.rs:2682`).

### 2.2 What is created per request (`prepare_js_request_context`, server_body.rs:2682–2935)

- Content-Length parsed only for methods with a body; 413 check up front.
- `RequestContext` **claimed from a per-server `HiveArray` pool** with heap fallback
  (`request_pool().claim()`; `create_in` placement-new). Not a malloc in steady state.
- `deprecated_report_extra_memory(size_of::<Ctx>())` (GC pacing, §6).
- Body slot from a per-VM `HiveRef` pool (`body::hive_alloc`, Body.rs:576), refcount shared between ctx
  and Request.
- **AbortSignal created eagerly**: `AbortSignal::new` → `WebCore__AbortSignal__new` (bindings.cpp:5833)
  = a refcounted C++ `WebCore::AbortSignal` (EventTarget) per request, not a JS object. Ref'd twice.
  The JS wrapper is created only on `req.signal` (Request.rs:688 `get_signal`).
- `Request::new(Request::init(...))` → **`Box::new`** (mimalloc) of the Rust Request (url/headers empty).
- `request_object.to_js()` → generated `JSRequest` cell (IsoSubspace, cached Structure) with `m_ctx`.
- **Lazy URL**: `Request.url` is empty until `getUrl` → `ensure_url` (Request.rs:864) builds
  `http(s)://` + Host + path into a 128-byte stack buffer, runs it through the WHATWG href normalizer
  (`bun_url::href_from_string`) and keeps the same buffer when nothing changed. The comment notes they
  avoided `core::fmt::write` because "it shows up in per-request profiles". Cached in `m_url` by codegen.
- **Lazy headers**: `ensure_fetch_headers` (Request.rs:242) → `FetchHeaders::createFromUWS`
  (bindings.cpp:2572): iterates all uWS headers, **copies each value into a new WTF::String**,
  maps names via gperf `findHTTPHeaderName` into the common-header enum, uncommon names
  `isolatedCopy`'d. One copy of all headers on first `.headers` access, then cached in `m_headers`.
- `method` getter returns an interned common string (`acf0b68299` "request.method getter not allocate").
- With `routes: {"/users/:id": fn}`, `ServerRouteList::callRoute` (ServerRouteList.cpp:239) creates a
  `JSBunRequest` with a **params object built from a per-route pre-made Structure** (`structureForParamsObject`,
  :173: one Structure per route with all param names added as transitions once; per request
  `constructEmptyObject(vm, structure)` + `putDirectOffset(i, value)`; values decoded with
  `decodeURIComponentSIMD`).

### 2.3 Calling JS and the response

- `server_body.rs:2667`/mod.rs: `enter_event_loop_scope_without_checkpoint()` (bumps the enter count so
  nested callbacks don't drain mid-handler, see §3) then `on_request_fn.call(global, server, &[req, server])`
  → `Bun__JSValue__call` (bindings.cpp:3279): stop-check, `AsyncContextFrame` unwrap, a
  `MarkedArgumentBuffer`, `JSC::call`. Nothing like a cached-call trampoline.
- `RequestContext::on_response` (RequestContext.rs:2795):
  1. **`drain_microtasks()` immediately** (RequestContext.rs:685) — runs nextTicks + the JSC microtask queue
     before inspecting the result, so an `async` handler that awaited only resolved promises has settled.
  2. If the result is a `Response` → render. If a promise → **`promise.unwrap(MarkHandled)`**: if already
     fulfilled, render synchronously in the same `onData` (no extra tick, still corked); if pending,
     `then_with_value(cell, ON_RESOLVE, ON_REJECT)` with a small promise cell.
- `protect_for_body_and_render` (RequestContext.rs:4101): the Response wrapper is rooted only if the body
  is sent after return (file/stream); in-memory bodies are rendered synchronously, no rooting.
- `do_render_with_body` (RequestContext.rs:3173) → `to_blob_if_possible()`:
  - **String bodies** (`Body::Value::WTFStringImpl`, Body.rs:515–554): `new Response("hi")` stores the JSC
    `StringImpl` with +1 ref, **no copy**. At render, `to_utf8()` borrows the 8-bit buffer if all-ASCII
    (zero copy) and only transcodes Latin-1-non-ASCII/UTF-16 to an owned UTF-8 `InternalBlob`
    (Body.rs:721). `ArrayBuffer` bodies are copied (`bytes.to_vec()`, Body.rs:983).
  - **JSON**: `Response.json` (Response.rs:847) calls `json_stringify_fast` (JSC `FastStringifier`, used
    when `space` is `undefined`; commits `1d7cb4bbad`, `d04b86d34f`), keeps the resulting string as body,
    and puts `content-type` via `put_default` on a lazily created FetchHeaders.
- `do_render_blob` (RequestContext.rs:3504): if not already corked and body < 15 KiB, wrap in
  `run_corked` ("Faster to do the memcpy than to do the two network calls").
- `render_metadata` (RequestContext.rs:3851): `swap_init_headers()` takes the Response's FetchHeaders
  (no clone), `do_write_status` uses a static status-line table (`HTTPStatusText::get`), then
  `do_write_headers` → `fast_remove(ContentLength/TransferEncoding)` → `FetchHeaders__toUWSResponse`
  (NodeHTTP.cpp:1026 → `writeFetchHeadersToUWSResponse`, :523): Set-Cookie list first, then
  `commonHeaders()` writing `httpHeaderNameString(key)` (static lowercase names, no lookup) and value,
  setting uWS state bits (wrote content-length / date / transfer-encoding / connection: close), then
  uncommon headers. 16-bit strings converted with a SIMD Latin-1 narrowing (`HTTPLatin1String.h`).
  Content-Type default derived from the body kind (`text/plain;charset=utf-8` for strings).
- `render_bytes` (RequestContext.rs:4019) → `resp.try_end(bytes, len, close)`; on backpressure,
  `on_writable` continuation. uWS auto-writes `Date` from a per-loop 32-byte string refreshed by a 1 s
  timer that is enabled only while a server is active (`LoopData.h:169 updateDate`,
  `timer/Timer.rs:45 update_date_header_timer_if_necessary`), and `Content-Length` via
  `writeUnsigned64`.
- After return: `detach_request()` (uWS request is stack/receive-buffer memory and dies after the
  callback), ctx returns to the pool; the Request/Response Rust objects die when their wrappers are
  collected (`Request::finalize`, Request.rs:721 — hot path is one `Box::from_raw` drop).

### 2.4 Static routes and other skipped work

- `routes: { "/": new Response("hi") }` → `StaticRoute` (StaticRoute.rs): body + headers converted once
  at `serve()` time; `on_request` (:291) does conditional-GET (ETag/If-None-Match), then corked
  `render_metadata` + `try_end` — **no JS, no Request object**. With the cork fix: 661k req/s at
  pipeline depth 16 vs 214k for `fetch: () => new Response("hi")` (`86e3c7584f` table).
- `FileRoute`, `DirectoryRoute`, `HTMLBundle` similar native routes.

### 2.5 Corking history (important)

- `86e3c7584f` (2026-09-14) "keep the socket corked across the requests of one read": since 1.2.6
  (#17093) `internalEnd` uncorked after the first response, so the rest of a pipelined read did one
  `send()` per status line/header/body: **14k req/s at depth 16 (3.25M sends)** → **214k req/s
  (14,400 sends), sys 59.6 → 0.83 µs/req**; `routes:` 150k → 661k. Fix: a response completed during
  `onData` leaves the cork; `onData` uncorks once after the last request; close paths flush the cork first.
- `44f5b6a1dc` (2026-03-28) second cork slot: an awaited handler resuming while another socket holds the
  single cork buffer went uncorked (190k → 22k req/s). Now two slots, empty-slot stealing, LRU eviction
  (`LoopData.h`, `CORK_BUFFER_SIZE = 128 KiB`, `CORK_COPY_MAX = 16 KiB`: larger writes go as a vectored
  write behind the buffer).

### 2.6 Where Bun spends per request that Beyond can avoid

Eager `WebCore::AbortSignal` (malloc + refcount ×2), heap `Box<Request>`, `reportExtraMemory`, generic
`JSC::call` with a `MarkedArgumentBuffer` and AsyncContextFrame check, nextTick queue checks around the
microtask drain, `JSRequest` wrapper + later `JSFetchHeaders` wrapper, full header copy on first
`.headers`, URL normalization through the WHATWG parser on first `.url`, refcount churn on WTF strings.
Hono reads `req.url` (and often headers) on every request, so Bun pays the URL build + href parse each time.

---

## 3. Event loop and microtasks

- `src/jsc/event_loop.rs`. `EventLoop` = `tasks` (LinearFifo of 16-byte `Task {tag, ctx, ptr}`),
  `immediate_tasks`/`next_immediate_tasks` (two queues so setImmediate in setImmediate waits a tick),
  `yield_tasks`, lock-free `concurrent_tasks` (MPSC from other threads), `deferred_tasks`,
  `entered_event_loop_count`.
- **Checkpoint rule**: `enter()`/`exit()` (:307/:318) count nesting; only the outermost `exit()` drains
  microtasks. Request dispatch uses `enter_scope_without_checkpoint` (:376, `0d34bf2d71`): the count is
  held across the handler so nested native→JS callbacks (`server.upgrade()` → `open()`) don't drain
  mid-handler, and the dispatcher drains explicitly once (`on_response`) — one checkpoint per request.
- `drain_microtasks_with_global` (:406): `release_weak_refs()` (JSC WeakRef targets), then C++
  `GlobalObject::drainMicrotasks` (ZigGlobalObject.cpp:3125): stopped-VM check, reset AsyncLocalStorage
  frame if no script on stack, **nextTick queue first** (`JSNextTickQueue::drain`, JSNextTickQueue.cpp:75 —
  a JS `processTicksAndRejections` function held in an internal field, only called if non-empty),
  `vm.drainMicrotasks()`, nextTicks again; then Rust runs `deferred_tasks` and QUIC drain.
- JSC's microtask queue (upstream now) is a ring of `QueuedTask { InternalMicrotask kind, args... }`
  (`webkit/Source/JavaScriptCore/runtime/Microtask.h:36`): promise reactions, async-function resume, etc.
  are enum-dispatched jobs with inline arguments — no per-job allocation or JS function object. Bun's
  fork adds `BunPerformMicrotaskJob` / `BunInvokeJobWithArguments` kinds for native-queued jobs
  (bindings.cpp:5829).
- `tick()`/`tick_turn` (:774/:783): pull concurrent tasks, `process_gc_timer`, run task batches with a
  microtask drain after each batch, bounded by `CONCURRENT_REFILLS_PER_TICK = 8`, then
  `handle_rejected_promises`. Each task runs, and the drain is per batch (task callbacks that enter JS use
  `run_callback`, which does its own enter/exit checkpoint).
- `auto_tick` (`src/runtime/jsc_hooks.rs:946`): immediates, pending unrefs, Date-header timer, imminent
  WTF GC timer, then poll epoll/kqueue with the timer-heap deadline (timeout 0 if immediates pending).
- Optimizations in history: `4494170f74` setImmediate uses a zero poll timeout instead of an eventfd write
  (44k eventfd writes per 5 s loop → 0); `c271c6c38e` timer heap for setTimeout/setInterval;
  `36aad18b32` removed `ManagedTask` (boxed closure) — each callback type gets its own tag: one alloc,
  one free and one indirect call less per task; `8484e1b827` ConcurrentTask 24 → 16 B;
  `9bb4a6af19` uSockets 4 s sweep timer only while sockets exist; `ffb316c4c4` `drainMicrotasks()` no
  longer re-enters the task queue.

---

## 4. Performance history: techniques and methodology

### 4.1 Recurring techniques (with examples)

1. **Lazy everything, cache on first use**: `9702568161` "Lazy URL"; lazy `headers`/`signal`; codegen
   `cache: true`; `LazyClassStructure` per class; `6596bf1174` lazy ESM exports of `"bun"` (was reifying
   115 properties); `a5e30c96d9` deferred requires in node:* (assert 11.2 → 0.55 ms); `a1f2e22140` lazy
   accessors; `b668561c31`/`db928c2474` lazily loaded fs.watch modules.
2. **Pre-built Structures / no per-call atomization**: `e29e830a25` "pre-built Structure for
   path.parse() result objects"; ServerRouteList params structure; `693e7995bb` cached structure in
   JSBunRequest::clone; `f816284bcb` replaced `get_truthy(global, b"statusText")` (atomizes a string each
   call) with `fast_get_truthy(BuiltinName::statusText)`; `c8e1f6fa5b` node:vm "stop atomizing option
   names". `.claude/docs/landing-prs.md` codifies: "`vm.propertyNames`/BuiltinNames instead of
   `Identifier::fromString` per call (takes a lock, shows up in profiles)", "a structure created per
   instance permanently defeats inline caching".
3. **Avoid refcount/alloc churn in header handling**: `f816284bcb` `trimHTTPSpaceIfNeeded` (check first/last
   char before calling `String::trim`, avoid atomic ref round-trip), `CommonHeadersVector` inline capacity
   0 → 2; `408c9374b2` Headers iteration without a lookup and string per name (precomputed rank sort,
   per-VM atomized header-name strings, `constructArrayPair`); `accccbfdaf` 2x faster headers.get/has/delete.
4. **Fast paths in the engine's own APIs**: JSON FastStringifier (`1d7cb4bbad`); JSArrayIterator butterfly
   fast path (`0ffd1b1e5f`); structuredClone fast paths for simple objects/arrays/strings
   (`ad1fa514ed`, `fa78d2b408`); `fe4a66e086` URLPattern via `RegExp::match` directly.
5. **Syscall batching**: cork (§2.5); `4494170f74` no eventfd for setImmediate; TLS/keepalive set once per
   connection not per request (`d4928764f2`, `72e37255cb`).
6. **Struct packing / smaller tasks**: `3898ed5e3f` pack bools, reorder fields; `8484e1b827`; `36aad18b32`.
7. **Skip work nobody observes**: `eba4da23e6` no Event object in `AbortSignal.abort()` without listeners;
   `9bb4a6af19` sweep timer only with sockets.
8. **SIMD for strings**: simdutf/highway everywhere (`b5dff55ef3` 8x faster atob, `9c5d339ccb`, `370b25c086`,
   `HTTPLatin1String`).

### 4.2 Methodology

- `docs/project/benchmarking.mdx`: mitata for micro; for HTTP "you _must use_ an HTTP benchmarking tool
  that is at least as fast as Bun.serve()" (oha, bombardier, uSockets `http_load_test`); hyperfine for CLI;
  `bun:jsc` `heapStats()` for object-type counts; `Bun.gc(true)`.
- `bench/` has mitata snippets per API (`bench/snippets/http-hello.js`, `request-method-getter.mjs`,
  `headers-iterate.mjs`, `response-json.mjs`, `microtask-throughput.mjs`, `abort-signal.mjs`…), often added
  with the optimization.
- `.claude/docs/landing-prs.md` "Performance: what reviewers block": numbers from `bench/` for ALL input
  classes (both string encodings, short/long); "must not regress ANY measured case"; compare vs previous
  Bun and Node; "Never port V8/Node micro-optimizations assuming they transfer to JSC"; treat existing
  fast paths (inline directives, corking flags) as load-bearing; "the common case pays zero for rare
  features" (no Proxies / getOwnPropertySlot hooks on hot paths); count copies and allocations; state
  `size_of` of frequently instantiated structs.
- Recent PRs measure with `perf` + LLVM symbolication under `oha` load (`f816284bcb`), user-mode
  instruction counts (`501152c9c0`: 1212M → 1136M), `send()` counts via an `LD_PRELOAD` shim and
  `TCP_INFO` segment counts (`86e3c7584f`), `VmHWM` peak RSS (`19dd34df33`), and bisect by release.
  Tests assert the mechanism (e.g. `process.memoryUsage().external` growth per request; GC log shows a
  FullCollection while idle).

---

## 5. Bun's JSC fork (oven-sh/WebKit)

- Pinned by commit in `scripts/build/deps/webkit.ts:6`; prebuilt tarballs per {os, arch, libc,
  debug/lto/asan} from oven-sh/WebKit releases (`autobuild-<sha>`). Upgrades follow
  `.claude/commands/upgrade-webkit.md` (merge upstream, keep Bun changes, check `JSType.h` against
  `src/jsc/JSType.rs`). Frequent: ~2–4 bumps/month in 2026. The local WebKit clone in `study/webkit` is
  upstream, so fork diffs are visible only through Bun's commit messages and API usage.
- Build flags (webkit.ts local mode): `PORT=JSCOnly`, `ENABLE_STATIC_JSC`, `ENABLE_FTL_JIT`,
  `USE_BUN_JSC_ADDITIONS`, `USE_BUN_EVENT_LOOP` (WTF RunLoop kind `Bun`, asserted at
  ZigGlobalObject.cpp: "Every JS VM's RunLoop should use Bun's RunLoop implementation"),
  **`USE_MIMALLOC` + `USE_EXTERNAL_MIMALLOC` ("JSC allocates through Bun's mimalloc, not libpas")**,
  `ENABLE_REMOTE_INSPECTOR`, media/WebRTC off.
- Bun-specific engine APIs/patches visible from Bun: `InternalMicrotask::BunPerformMicrotaskJob` /
  `BunInvokeJobWithArguments`; `JSC__VM__collectAsyncIdle` + `GCRequest::isIdle` (WebKit#558);
  `VM::shrinkFootprintNow`; `Heap::totalBytesAllocated()/sizeAfterLastCollection()/allocationBudgetThisCycle()`
  (added for embedders, WebKit#628); `heap.disableStopIfNecessaryTimer()`; portable bytecode cache for
  `--compile --bytecode` (many fork PRs: #494, #677, #707); faster URL parser (`3cf314956b`,
  `30fa519703`); module loader rewrite (`73e8889f8c`), import-slot linking (`68d08889b0`).
- Memory-related fork work (all 2026, from commit messages):
  - `561641b6e1` WebKit#542/#546/#547: MarkedBlock page release; CodeBlock aging that reaches optimized code.
  - `6c06195725` WebKit#557/#558: FTL code (no execution counter) ages out in *idle-tagged* full
    collections; express idle RSS 148 → 127 MB, surviving FunctionCodeBlocks ~2,400 → ~200.
  - `494b4e0864` WebKit#628: module function declarations instantiated on first read; call link records
    and array profiles allocated on second execution; value profiles allocated only when reaching
    Baseline; module/program code released after it runs; slow-path thunks clear the stack their callee
    will occupy (less conservative-scan retention). WebKit#630: `for-of`/destructuring over arrays without
    an iterator object; one RegExpObject per `/x/.test(s)` literal site.
  - `1878660bb4` WebKit#768: idle JSC helper threads release mimalloc free memory after 100 ms.
  - `501152c9c0` cheaper CodeBlock linking (8-slot resolve cache) — −6.3% startup instructions.
- `--smol`: `Zig__GlobalObject__create` (ZigGlobalObject.cpp:518) creates the VM with
  `HeapType::Small` instead of `Large`, keeps JSC's stop-if-necessary timer enabled (disabled otherwise),
  and the runtime transpiler cache etc. check `vm.smol`. Workers use `mini_mode` similarly.

---

## 6. Memory / RSS

- **mimalloc** (oven-sh fork, `scripts/build/deps/mimalloc.ts`): single-TU build; global malloc override on
  Linux (not macOS/Windows/ASAN; there ICU/libuv/BoringSSL/c-ares are pointed at mimalloc explicitly,
  `619ea140bd`); `MI_SKIP_COLLECT_ON_EXIT`, `MI_NO_PROCESS_DETACH`, `MI_FREE_USE_PAGEMAP`;
  initial-exec TLS; **`MI_DEFAULT_ALLOW_THP=0`**: measured on a THP=always box, `bun -e 1` 30 vs 54 MB
  peak, **Bun.serve hello 46 vs 68 MB RSS**. Scavenger thread started explicitly (`8814decf6e`); the event
  loop hands its heaps to the scavenger only on a blocking poll (`b73ae471a0`); purge tuned so an
  allocation takes resident memory before purged memory; `mi_heap_new/destroy` 7x cheaper.
- **JSC heap through mimalloc** (above) — one allocator, one purge policy for everything.
- **GC pacing for native garbage**: `19dd34df33` — every request reports `size_of::<RequestContext>()`
  as extra memory. Removing it (in #30909) raised the Bun.serve plateau from 42 → 53–61 MB and Elysia
  65 → 78–83 MB: the JS heap stays tiny, so eden GCs ran too rarely while Request/Response boxes,
  AbortSignals and body strings piled up in malloc. Generated classes report `estimatedSize`.
- **Idle GC controller** (`src/jsc/GarbageCollectionController.rs`, origin `bddf523ac9` 2022 "Reduce memory
  usage in Bun.serve() by up to 3x"): repeating timer 1 s while the heap changes, 30 s once quiet,
  `collectAsync` each tick; idle *full* collections after `BUN_IDLE_GC_SECONDS=10,110,480` seconds of
  quiet (first snapshots live code, later ones age out code), last one after `shrinkFootprintNow()`.
  Large TUI app idle RSS 460–491 → 365–380 MB (`561641b6e1`).
- **Binary layout**: `c76d6b2162` symbol-ordering file puts startup-executed functions together:
  `bun -e 'console.log(1)'` 29.2 → 19.9 MB, a Bun.serve+bundler script 51.7 → 42.4 MB (fault-around of
  64 KB around scattered hot functions). `3d3016e329` trims ~2 MB without touching hot paths;
  `-fno-pic`/no-PIE to keep vtables out of `.data.rel.ro`. Compiled executables `MADV_DONTNEED` /
  `MADV_PAGEOUT` embedded sources after load (`c14e37e7e5`, `561641b6e1`).
- **Lazy loading**: generated classes and many globals are lazy (`LazyClassStructure`, `LazyProperty`),
  builtins bundled as bytecode-able JS in `src/js/` loaded on first `require`, lazy accessors for module
  exports, deferred module-init (§4.1).

---

## 7. Techniques worth adopting for Beyond, ranked by expected gain

Context: Beyond's runtime side is already ~2x cheaper than Bun's; the gap is in untyped framework JS.
So the biggest wins are things that reduce work the *JS* side does because of the runtime's objects,
plus throughput/memory items.

1. **Pre-built shapes for every runtime-created object + direct slot init** (Bun: per-route params
   Structure + `putDirectOffset`; `LazyClassStructure` per class; `path.parse()` prebuilt structure).
   For Luminous this attacks the 8.4k "object creation" bucket (21 objects/req × ~250 instr via
   `JS_NewObjectProtoClass`) and the 1.7k "add_property after creation" bucket: create objects with a
   final shape already containing the slots, write values by offset; for JS-created object literals,
   compile literal sites to a cached shape (QuickJS shape per literal site) instead of N `add_property`
   transitions. Also makes ICs monomorphic. Expected gain: several k instr/req.
2. **Synchronous microtask drain after the handler + in-place unwrap of a settled promise** (RequestContext.rs:2795).
   If Beyond does a full loop turn for `async` handlers, adopt this; render in the same `onData` while corked.
3. **Cork all responses of one read, uncork once** (`86e3c7584f`; two cork slots `44f5b6a1dc`). We use
   Bun's uWS fork — make sure our fork includes the Sept 2026 fix; pipelined benchmarks change 15x.
4. **Pre-interned atoms for reading option bags and well-known properties** (`fast_get(BuiltinName)`):
   `ResponseInit.{status,statusText,headers}`, `headers` init objects, `Response.json` args. In QuickJS,
   use predefined `JSAtom`s and IC'd lookups from C, never `JS_GetPropertyStr`.
5. **Lazy Request fields cached in hidden slots** (codegen `cache: true`): build url/headers/signal only on
   access, store in an internal slot (not a JS-visible own property, so the object's shape stays fixed and
   accessor ICs on the prototype stay valid). Create AbortSignal lazily — Bun does not, we can.
   Prefer reading headers straight from the uWS request buffer on `get(name)` before materializing a map.
6. **Zero-copy string/JSON bodies**: keep the engine string; if 8-bit ASCII, `write` its buffer directly;
   JSON.stringify fast path without a `space` arg; default Content-Type from body kind.
7. **Header writer with a common-header enum and static lowercase names**, Set-Cookie list separate,
   small inline capacity, trim only when first/last char is whitespace, SIMD Latin-1 narrowing.
8. **Static routes served natively** (`StaticRoute`): pre-rendered status+headers+body, ETag/304, no JS.
9. **Native-garbage GC pacing**: report per-request native bytes to our GC (Bun's `reportExtraMemory`),
   otherwise RSS plateaus 15–20 MB higher under load.
10. **Memory hygiene**: disable THP for our arenas (`MADV_NOHUGEPAGE`), symbol-ordering file for startup
    (`--symbol-ordering-file`), idle GC timer (1 s/30 s) with occasional full GC and allocator purge when
    quiet, hand free pages back only on blocking polls, start the allocator's purge thread explicitly.
11. **Event-loop micro-items**: 16-byte tagged tasks with no boxed closures; setImmediate via zero poll
    timeout not eventfd; sweep/Date timers only while sockets exist; nested enter count so microtasks drain
    once per callback.

---

## 8. Surprises

- The Zig → Rust rewrite (May 2026) was executed through phased Claude agent workflows committed in the
  repo (`.claude/workflows/phase-*.workflow.js`, removed later); rationale unpublished in-tree.
- Bun.serve did ~14 `send()`s per pipelined response from 1.2.6 to 1.4.2 (14k req/s at depth 16).
- JSC in Bun allocates through mimalloc (`USE_EXTERNAL_MIMALLOC`), not libpas/bmalloc.
- THP alone costs a Bun.serve hello server 22 MB RSS; code layout alone 9 MB.
- Bun creates a C++ `AbortSignal` for every request eagerly, and boxes the Request on the heap per request.
- uWS dispatch calls `std::terminate()` if a handler returns without responding and without `onAborted`.
- Bun's maintainers ban blaming the conservative stack scanner (CLAUDE.md rule 15), and note JSC runs
  `sanitizeStack` at every interpreter entry — the 2.9k instr/req `sanitizeStackForVMImpl` in our Bun
  profile is that per-entry cost (a JSC design cost Beyond doesn't have).
- Much of Bun's 2026 memory work is in the engine fork (code aging, lazy profiles, lazy module function
  instantiation), not in the runtime.
