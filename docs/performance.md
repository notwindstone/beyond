# Performance

## How it is measured

Against Bun 1.4.3 on the same 4-core machine, runs alternated
(`bench/run.sh`, which needs `bun` and `oha`, and runs Bun with
`BUN_OPTIONS` cleared: an environment may set `--smol` there, as this
machine's does, and the earlier versions of these tables had Bun with
it). The tables come from one run of `bench/run.sh serve json hono
elysia fetch url` (Beyond's programs built by `beyond build`, with LLVM),
after the changes of [direction.md](direction.md)'s section 6
(the Hono and Elysia tables from `bench/run.sh hono elysia` after its Bet
B and what followed, the averages of the run's two rounds, on a day this
machine ran about a third slower: Bun's own figures are too):
what carries over is each line's ratio to Bun's, which moves by 10–20%
between runs (this cloud VM's speed drifts by 40–60% in a day, Bun's and
Beyond's alike).
## 8-byte values

Luminous's values are 8 bytes (NaN-boxed, with 32-bit references: its
patch 0011, and the numbers it saves on programs that keep data in its
README). A server keeps little, so Beyond's peak about 1 MB lower than
with 16-byte values (Hono 26 MB from 27, Elysia 29 MB from 30, the plain
servers 23 MB either way), at the same throughput within this machine's
drift (measured alternately with a build of the 16-byte engine).
## `Beyond.serve`

`Beyond.serve` against `Bun.serve`: the same program
(`new Response("Hello World!")`, and `Response.json({...})` of a small
object, bench/serve-*.ts), 10 seconds of `oha -c 50` on the machine the
server runs on:

| | requests/s | p99 latency | memory (RSS) |
|---|---|---|---|
| Beyond, text | 80,497 | 1.60 ms | 23 MB |
| Bun, text | 64,115 | 1.90 ms | 23–24 MB |
| Beyond, JSON | 79,613 | 1.62 ms | 23–24 MB |
| Bun, JSON | 58,838 | 2.06 ms | 23–24 MB |

Beyond answers about 26% more text and 35% more JSON requests a second
than Bun (16% and 17% before section 6's changes), with lower tail
latency, in about as much memory (the load generator shares the cores;
the mean of two runs each).
## JSON

JSON of bigger objects, typed (`aot type`) or not (`bench/run.sh json`):
a user of 7 fields with a nested point made for each request
(bench/serve-user.ts, 105 bytes), and a list of 50 of them made once
(bench/serve-users.ts, 5.7 KB). Beyond runs each with the objects typed
and plain (the same program with `type`); Bun has no typed objects:

| | one user | p99 | 50 users | p99 |
|---|---|---|---|---|
| Beyond, typed | 72,872 | 1.70 ms | 35,561 | 3.03 ms |
| Beyond, plain | 70,183 | 1.78 ms | 25,945 | 4.04 ms |
| Bun | 51,659 | 2.41 ms | 33,041 | 3.48 ms |

With one small object, writing the JSON is a small part of a request,
and Beyond answers 36–41% more than Bun either way. With 50, typed
objects answer 37% more requests than plain ones, and 8% more than Bun;
plain ones 21% fewer than Bun (the general fast path reads each object's
keys from its shape, checking each one, where a typed object's are
encoded once). All use 21–29 MB. What got it there:

- The request path is native code: `Headers`, `Request` and `Response`
  keep their state in plain fields and check without regular expressions
  (before that, Beyond answered about a third as many text requests).
- A program's globals (`Response`, `Request`, `URL`, ...) are bindings of
  Beyond's modules to Luminous (`--global`): `new Response(...)` is the
  class's native constructor, not the engine constructing a global (+15%).
- The server makes the request's URL in C, shares the strings of common
  methods and header names, and a response with no headers of its own
  sends only its content type.
- Two engine fast paths in Luminous's patch: `instanceof` without calling
  `Symbol.hasInstance` when it cannot have been replaced, and
  `JSON.stringify` of plain data straight from object shapes (a small
  object's went from about 8,800 instructions to a few hundred), into a
  buffer kept between calls, with numbers written in place. Objects of an
  `aot type`, and arrays of them, are written from their fields: a small
  one in about the time Bun takes, 100 of them in about half
  (`Response.json` of them too).
## Typed data (`aot type`)

Arrays of 1,000 objects `{ id: int, x: number, name: string }`, `xs[i].x +
xs[i].id` over them in a native function, nanoseconds an element (two runs;
this VM's speed moves by up to 2x between runs here):

| | Beyond | Bun 1.4.3 |
|---|---:|---:|
| `aot type X = Array<A>` (A an `aot type`) | 1.4–4.3 | 2.8–3.6 |
| `type Y = Array<A>` (a plain alias of the same) | 1.3–3.9 | 2.7–4.2 |
| `type Z = Array<B>` (plain objects) | 13.5–21 | 2.7–4.8 |
| `Object.freeze` of an array of plain objects | 13.7–14.3 | 42–53 |
| `Object.freeze` of an `aot type X` array | 1.3 | 42–43 |

A plain alias of an array of an `aot type` is that type (it was read as an
untyped array: 22–27 ns). Untyped objects are where Bun's JIT is ahead (its
inline caches; Beyond's are the engine's). Freezing an array keeps it as
fast as before (Luminous's patch `0023`: it made QuickJS's array a
dictionary of properties, 43–61 ns, as freezing does JSC's), and an array
of `aot type` objects freezes and seals as a whole (it threw).
`Object.keys(o).length` counts the keys without making the array (patch
`0022`): 13–16 ns for a 5-field plain object (42–46 before), 15–16 ns for
an `aot type` object (311–342 before); Bun 13–23 ns. Counting them with
`for`-`in` takes 25–30 ns (144–152 before; Bun 11–22): native code steps
through the keys of the object's shape, shared by every loop over objects
of that shape, without a call or an allocation per loop (patch `0024`).

`JSON.parse(text)` and `await r.json()` where an `aot type` is expected
parse to it directly (only its fields made: Luminous's README, "From
JSON"); the same text plain, and Bun's (two runs):

| | typed | plain | Bun |
|---|---:|---:|---:|
| `JSON.parse`, one object of 6 fields (one nested) | 330–343 ns | 308–311 ns | 349–368 ns |
| `JSON.parse`, 50 of them with 3 fields the type lacks (6.6 KB) | 30.8–31.4 µs | 33.2–34.5 µs | 43.8–49.9 µs |
| `Response#json()`, the same 50 from bytes | 37.6–38.3 µs | 41.3–42.2 µs | 61.0–64.1 µs |

Typed, one small object parses as fast as Bun's parse, and the 50 objects
in about 70% of its time (60% from a body). Before the parser's numbers,
keys, strings and checks were made cheaper (5,927 instructions for the
small object, now 2,985), the small one took 695–738 ns and the 50
52.7–54.6 µs. Plain, `JSON.parse` took four times Bun's (1,470–1,516 ns,
146–148 µs, from a body 145–163 µs): Luminous's patch `0024` parses the
text's bytes in place and makes objects with the shape of the last ones
with the same keys (13,013 instructions for the small object, now 3,053),
and `json()` parses a body's bytes without decoding them first.

## Objects: `{}` and `Object.create(null)`

Native functions over 2,000,000 iterations (`bench/objects.ts`: best of
five, nanoseconds an iteration). Before and now were measured in the same
minute, with the previous Luminous and this one; this VM ran slower than
for the figures in earlier versions of this table (a dictionary: 25 ns
then, 32–38 now, with either):

| | `{}` before → now | `Object.create(null)` before → now | Bun (`{}` / null) |
|---|---:|---:|---:|
| a new empty object | 4.9–5.0 → 1.1–1.4 | 8.1–9.1 → 4.0–4.1 | 0.4 / 0.4 |
| a new one, 3 keys added, 2 read | 26.7–27.9 → 8.8 | 31.2–34.2 → 9.8–10.3 | 1.3–1.4 / 1.3 |
| 3 keys added to `{}` by a function that returns it, 1 read | 24.1–26.6 → 12.8–13.0 | | 1.3 |
| a dictionary of 64 dynamic keys (a key set, then read) | 34.2–35.7 → 35.3–38.0 | 32.6–34.6 → 32.0–34.1 | 17.4–17.5 / 16.9–17.7 |
| 2 keys read and a missing one | 12.4–13.1 → 10.9–11.2 | 12.5–13.0 → 10.7–11.1 | 0.4 / 1.6–1.7 |

An object that stays in its function is not made at all now (Luminous's
`virtualize_objects`, as Bun's JIT does): its properties live in locals,
an addition to an object of `Object.prototype` is checked against a
setter or read-only property of the key there (one comparison while no
watched prototype changed), and a key `Object.create(null)` was not
given reads `undefined`. Where the object itself is needed (passed,
returned, a key it lacks) it is made then, once, from the properties it
has: a function that fills `{}` and returns it makes the object with its
final shape in one go. Instructions an iteration: a new `{}` with 3 keys
added and 2 read, 342 → 53 (`Object.create(null)`: 381 → 83); a new
empty `{}`, 40 → 8; the function that returns it, 322 → 116. What is left
is the arithmetic on untyped values and, for `Object.create(null)`,
reading `Object.create` each iteration, which Bun's JIT hoists out of the
loop.

`Object.create(p)` that escapes is made as `{}` is, while it is the
builtin: the site keeps the empty shape of its prototype and allocates
inline. An addition a site cached is made inline (the shape after and the
value stored), and an empty object has room for 4 properties in its cell.
A dictionary's keys: a shape transition found in the table was checked
property by property (about 2,000 comparisons for 64 keys), now once;
`d[k]` with a key string the engine has seen reads and writes an ordinary
object's properties without the general lookup (about 515 instructions a
key, now about 225). A missing key is now read from the site's cache
inline, without a call (156 instructions an iteration, now 123); Bun
hoists these reads out of the loop entirely. Luminous's patch `0025` and
README.

## Hono

A Hono 4.13 app (bench/hono: text, JSON and path parameter routes, and a
middleware that sets a header after the handler, `bench/run.sh hono`):

| | text | JSON | `/users/:id` | memory |
|---|---|---|---|---|
| Beyond | 30,669 | 26,631 | 25,505 | 27–28 MB |
| Bun | 29,993 | 24,434 | 22,341 | 33–41 MB |

Beyond answers 97-125% as many requests a second as Bun (102-114% on
average), in 68-85% of the memory: 61-75% before the changes of
[direction.md](direction.md)'s section 6 (the uWS request no
longer zeroed, the request's fields made when read, builtins that skip
what the specification looks up while it is unchanged, LLVM by default:
83,454 instructions a `/users/:id` request, then 67,008), and 77-84% before
its Bet B (an object model that pays at creation: closure variables
captured by value, caches for `instanceof`, for added and for absent
properties, arrays and property arrays that need no finalization: 52,818),
and 89-108% before ordinary functions using `this` (Hono's router)
compiled and objects and arrays were made inline (now 49,723; Bun's
43,802).
Against Bun with `--smol`, which is slower here, it answered 77-86% before
them (about half before Luminous compiled Hono's classes:
written as class expressions, with private fields, private methods and
fields that are arrow functions; 69-74% before native code made closures
inline, async ones included, and 74-80% before promises and awaits lost
their allocations: see Luminous's patch 0007). Its
responses are Bun's but for the case of header names. What Hono still
costs more here: the objects the engine makes for each request, and the
response its middleware makes again with its headers copied (its body
made a stream).
## Elysia

The same routes in Elysia 2 (bench/elysia, `bench/run.sh elysia`): one
bundle built ahead of time with Elysia's AOT plugin, on Beyond and on Bun,
and on Bun the app as written too (Elysia composing its handlers with
`new Function` at run time):

| | text | JSON | `/users/:id` | memory |
|---|---|---|---|---|
| Beyond | 45,074 | 38,788 | 38,919 | 29–30 MB |
| Bun | 39,306 | 37,372 | 35,232 | 35–40 MB |
| Bun (run-time handlers) | 38,079 | 36,769 | 33,777 | 37–43 MB |

Beyond answers 97-115% as many requests a second as Bun (104-115% on
average; 78-85% before section 6's changes, 88-93% before its Bet B;
35,133 instructions a `/users/:id` request, from 50,825; Bun's 33,183),
in 75-85% of the memory.
All of Elysia is native but one function (`tee`, a computed method in an
object literal). The class of each request's context (`class Context
extends Base`, made in a function) is native since classes inside
functions compile: the same bundle with that function kept interpreted,
run alternately with it, answers 52,300 and 44,200 requests a second
(text, `/users/:id`) where it answers 63,300 and 48,700.
## Hono and Elysia on several cores

The same Hono and Elysia apps on one and on two server processes sharing
port 3000 (`reusePort: true`), each process pinned to a core of its own
(cores 2 and 3, `taskset`) and `wrk -t2 -c50` pinned to the other two:
3 seconds of warm-up, then 10 measured, the mean of two rounds. The
servers are the limit here: they use 195–199% of their two cores, wrk at
most 125% of its two. (Pinned, Bun's compiler and collector threads
share its server's core.)

Hono:

| servers | path | Beyond | Bun | Beyond / Bun |
|---|---|---:|---:|---:|
| 1 | `/` | 28,352 | 27,300 | 104% |
| 1 | `/json` | 25,672 | 21,646 | 119% |
| 1 | `/users/42` | 23,414 | 21,066 | 111% |
| 2 | `/` | 63,172 | 59,151 | 107% |
| 2 | `/json` | 57,751 | 52,314 | 110% |
| 2 | `/users/42` | 50,890 | 44,544 | 114% |

Elysia 2, Bun on the bundle built with the AOT plugin (as Beyond) and on
the app as written:

| servers | path | Beyond | Bun, AOT | Bun, as written | Beyond / Bun, AOT |
|---|---|---:|---:|---:|---:|
| 1 | `/` | 42,976 | 38,405 | 39,312 | 112% |
| 1 | `/json` | 38,488 | 32,451 | 32,568 | 119% |
| 1 | `/users/42` | 33,410 | 30,730 | 28,893 | 109% |
| 2 | `/` | 87,218 | 81,942 | 77,162 | 106% |
| 2 | `/json` | 80,702 | 67,647 | 69,280 | 119% |
| 2 | `/users/42` | 77,776 | 64,357 | 68,856 | 121% |

Memory (RSS, the servers' together):

| | 1 server | 2 servers |
|---|---:|---:|
| Hono, Beyond | 28 MB | 57 MB |
| Hono, Bun | 42 MB | 84 MB |
| Elysia, Beyond | 31 MB | 62 MB |
| Elysia, Bun, AOT | 38 MB | 76 MB |
| Elysia, Bun, as written | 42 MB | 85 MB |

Two servers answer 2.0–2.4 times what one does, Beyond's and Bun's alike
(above twice on this VM for both, so the ratios hold). A run moves by up
to 10–15% between rounds: read each ratio as about ±5%.
## `fetch()`

`fetch()` against Bun's: 300,000 fetches of a short text from a Beyond
server in another process, 1, 10 or 50 of them in flight, each response
read with `text()` (bench/fetch.ts), three rounds a run, two runs each:

| in flight | Beyond | Bun |
|---|---|---|
| 1 | 14,828 fetches/s | 7,736 fetches/s |
| 10 | 103,484 fetches/s | 58,530 fetches/s |
| 50 | 108,707 fetches/s | 79,337 fetches/s |

Beyond's client does about 92% more fetches a second than Bun's one at a
time, 77% more with 10 in flight and 37% more with 50, on one thread (Bun
gives its client a thread of its own), at a peak of 25-26 MB (Bun: 29-43
MB).
Over TLS (against a `Bun.serve` with a certificate), it does about twice
as many one at a time (17,500 a second; Bun: 9,200), and as many with 50 in
flight (about 65,000, where the server is the limit) in 57% of the CPU
time.
A fetch of a small response went from about 77,000 instructions to about
15,000:

- A response whose head and body come together (most) is handed to
  JavaScript as one event, its body as bytes, after its connection is back
  in the pool; the head is parsed where the socket's bytes are, and each
  request slot keeps its buffers.
- `fetch()` keeps a request's state in an object of a class (no closures
  per request: one handler for every request's events), takes a URL with
  nothing else without making a `Request`, and keeps the head of a GET of
  a URL it fetched recently. A response's headers are made from the
  received ones only when read.
- Its promise, and the ones `text()`, `json()` and the like return, are
  made settled or settled from native code, without resolving functions
  (Luminous's `JS_NewPendingPromise`); native async functions' promises
  are too.
- In the engine (Luminous's patch 0003): resolving functions made with
  their properties at once (each was two property definitions), the
  property array of every object in its own allocation (functions,
  arrays, promises, typed arrays were each two allocations), and a string
  literal's hash reused as a `Map` key.
- The native side no longer throws (and catches) an exception to tell a
  typed array from an `ArrayBuffer`, which cost every request a
  `TypeError` with its stack: 14% of a fetch then. Header names are found
  in a hash table, and picohttpparser scans with SSE4.2.
## `URL`

`new URL(s).href` (bench/url.ts) takes 0.36 to 0.39 µs for a plain URL
(`http://127.0.0.1:3000/`; Bun: 0.14 to 0.16), 0.57 to 0.6 µs with
credentials, a port, a query and a fragment (Bun: 0.25), 0.9 to 1.2 µs
with dot segments (Bun: 0.23): two and a half to five times Bun's, from 1
to 9 µs before. Luminous
now compiles the parser's character scans as integer compares (a scan of
13 compares a character went from 15.6 ns to 2.8 ns a character), and the
fast path covers credentials, dot segments and escapes, keeps a canonical
input as the URL's serialization and its path as one string, and makes no
string for the scheme.
## Streams

Streaming a large body is slower than Bun's for now: 256 MB in 64 KB chunks
takes 1.25 s (Bun: 0.81 s).
