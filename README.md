# Beyond

A JavaScript and TypeScript runtime built on [Luminous](https://github.com/notwindstone/luminous),
the ahead-of-time TypeScript compiler: a program and the runtime's own APIs are
compiled together into one native executable.

## Plan

The first milestone is the web-interoperable (WinterTC) globals and an HTTP
server, measured against `Bun.serve`:

- `URL` / `URLSearchParams`, `TextEncoder` / `TextDecoder`, `Headers`,
  `Request` / `Response`, timers, `AbortController` / `AbortSignal`,
  `Event` / `EventTarget`, `crypto.getRandomValues`, `structuredClone`;
- `Beyond.serve`, an HTTP/1.1 server.

How it is built, following [Bun](https://github.com/oven-sh/bun) (see
[NOTICE](NOTICE)):

1. The socket and HTTP layer is Bun's fork of uSockets and uWebSockets
   (Apache 2.0), as is: what makes `Bun.serve` fast does not depend on the
   JavaScript engine.
2. The logic of Bun's Rust implementations (request and response bodies,
   headers, the server's request handling, text encoding) is ported to the
   engine Luminous uses (QuickJS-NG): Bun's code is written against
   JavaScriptCore.
3. `URL`, `Event` / `EventTarget` and `AbortController` are written anew in
   TypeScript, compiled by Luminous with the program (Bun's are WebKit's
   WebCore, LGPL).
4. Text encoding uses simdutf (Apache 2.0), as Bun does.

The native core is Rust (a static library with a C interface, linked into
each program), with uSockets and uWebSockets as C and C++.

## Building

```sh
scripts/setup.sh          # Luminous (a submodule) and its engine
cargo build --release
target/release/beyond run app.ts
```

`beyond build app.ts -o app` writes the executable. Needs clang (Bun's
networking code uses its extensions), zlib, brotli's decoder
(libbrotlidec) and OpenSSL 3 (libssl, libcrypto).

## Status

- Timers: `setTimeout`, `setInterval`, `clearTimeout`, `clearInterval`, with
  `Timeout` objects (`ref`, `unref`, `refresh`), as Bun's; `performance.now`.
  The event loop waits on uSockets' until the next timer is due, as Bun's
  does, and runs the jobs callbacks queue in between. A top-level `await`
  waits on the loop. A promise rejected with no handler once the jobs are
  done is reported as an uncaught error, and the program exits with 1, as
  Bun's does.
- `Beyond.serve({ port, hostname, fetch, error })`, as `Bun.serve`: HTTP/1.1
  on Bun's uSockets and uWebSockets, keep-alive and pipelining included. The
  `fetch` handler returns a `Response` or a promise of one. A request's
  body that comes with its head is handed to it whole; one still coming
  when the loop's turn ends is read as it arrives (the handler called then,
  as Bun calls it on the head), the connection paused while it waits for a
  reader. A response whose body is a stream (or an async generator) is
  sent chunked as it is read, each chunk written when the connection has
  room (uWebSockets' writable callbacks, as Bun's sink does); a stream that
  fails midway closes the connection. `server.port`, `server.url`,
  `server.stop(closeActiveConnections)` (idle connections closed, the
  others once answered, or all of them).
- `fetch()`, as Bun's: HTTP/1.1 on uSockets (the response parsed with
  picohttpparser), over TLS for `https:` (OpenSSL, on the socket through
  memory BIOs; Bun's bundled Mozilla root certificates trusted, with
  `NODE_EXTRA_CA_CERTS`; `tls: { ca, rejectUnauthorized, serverName }`;
  the certificate checked after the handshake, then the name, with Bun's
  errors: `DEPTH_ZERO_SELF_SIGNED_CERT`, `ERR_TLS_CERT_ALTNAME_INVALID`,
  `EPROTO`, ...), keep-alive connections pooled per host, bodies decoded
  (gzip, deflate, br, zstd), redirects followed (`redirect: "follow"`,
  `"manual"`, `"error"`; 303, and 301/302 of a POST, as a GET), and an
  `AbortSignal` aborting the request or the body being read. The response's
  body is read as it arrives: it is buffered while nothing reads it, and the
  connection is paused while more than 1 MB is waiting; a response that
  came whole with its head is handed over at once. Its errors are Bun's
  (`ECONNREFUSED`, `ECONNRESET`, `ENOTFOUND`, `UnexpectedRedirect`, ...),
  with their codes, messages and properties. A request body that is a
  stream (or an async generator) is sent chunked as it is read, waiting
  while the connection is backpressured.
- `Blob`, `File` and `FormData`; bodies of them, of strings, bytes and
  `URLSearchParams` (multipart/form-data written and read, urlencoded
  read: `formData()`, `blob()`), with their content types as Bun gives them.
- Streams, the WHATWG standard's: `ReadableStream` (default and byte
  streams, default and BYOB readers, `tee`, `pipeTo`, `pipeThrough`, async
  iteration, `ReadableStream.from`), `WritableStream`, `TransformStream`,
  their controllers, the queuing strategies, `TextEncoderStream` and
  `TextDecoderStream`; Bun's `text`, `json`, `bytes` and `blob` on
  `ReadableStream`, and `Blob.stream()`. Written from the standard's
  algorithms in TypeScript, all of it compiled natively; they pass 1277 of
  the 1291 web platform tests of streams and encoding streams (Bun: 1286;
  the rest need WebAssembly, MessageChannel or legacy encodings). They print
  as Bun's do.
- `Headers`, `Request` and `Response` as the Fetch standard has them, with
  string, byte and stream bodies (`body`, `text`, `json`, `arrayBuffer`, `bytes`;
  `Response.json`, `Response.redirect`, `Response.error`). Written in
  TypeScript that Luminous compiles to native code: the classes keep their
  state in plain fields (not `#private` ones) and check header names and
  values without regular expressions, so that every constructor and method
  on a request's path is native. A response's headers are made only when the
  program reads them; most responses only send a content type.

- `URL` and `URLSearchParams`: the URL standard's parser (a state machine,
  with a fast path for the common URL: a special scheme, credentials, a
  domain or IPv4 host, a port, and a path, query and fragment that need no
  encoding, dot segments and `%` escapes included; one that serializes as
  it is written keeps its input as its `href`), hosts with IPv4, IPv6 and
  internationalized domains (punycode, and UTS #46's mapping approximated
  with NFKC, lower case and the Unicode categories), all the setters. It
  passes all of the web platform tests' URL data (urltestdata 896/896,
  setters 278/278, toascii 87/87; Bun: 881, 274 and 80) and 2668 of the
  2675 IdnaTestV2 cases (Bun: 1909).
- `TextEncoder` and `TextDecoder`: UTF-8 (native: Rust's validation and its
  lossy decoding, which is the standard's), UTF-16LE/BE and windows-1252
  (the standard's `latin1` and `ascii`), `fatal`, `ignoreBOM` and streaming.
- `Event`, `CustomEvent`, `EventTarget` (capture, `once`, `passive`,
  `signal`, `handleEvent` objects), `AbortController` and `AbortSignal`
  (`abort`, `timeout`, `any`, `onabort`), `reportError` (as Bun's: the error
  is printed and the program exits with 1 after the current task).
- `console`, formatting values as Bun does (its formatter's rules, ported:
  objects one property a line, arrays on one line until 80 columns, quoted
  strings inside values, `[Object ...]` past depth 2, `[Circular]`, class
  names, Map/Set/typed arrays/promises, `%s %d %i %f %o %O %j %c`), and
  Beyond's classes print as Bun's do; `group`, `count`, `time`, `assert`,
  `trace`; `Beyond.inspect`. Standard output is buffered (flushed before
  the event loop waits, before standard error is written, and at exit).
- `crypto.getRandomValues` and `crypto.randomUUID` (from the kernel, through
  a buffer), `structuredClone` (with `transfer`), `self`; and from
  QuickJS-NG, `queueMicrotask`, `atob`, `btoa`, `DOMException`.

The tests (`cargo test`) run programs whose output must be Bun 1.4.3's, the WPT
URL data and streams tests, a server answering over TCP, and `fetch()`
against a server of the test's own.

Not yet: TLS for `Beyond.serve`, client certificates and
`checkServerIdentity` for `fetch`, HTTP/2, WebSockets, `crypto.subtle`,
TextDecoder's legacy encodings but windows-1252; errors print without
Bun's source excerpt, and their stacks' lines are the bundle's.

## Performance

Against Bun 1.4.3 on the same 4-core machine, runs alternated
(`bench/run.sh`, which needs `bun` and `oha`).

`Beyond.serve` against `Bun.serve`: the same program
(`new Response("Hello World!")`, and `Response.json({...})` of a small
object, bench/serve-*.ts), 10 seconds of `oha -c 50` on the machine the
server runs on:

| | requests/s | p99 latency | memory (RSS) |
|---|---|---|---|
| Beyond, text | 98,016 | 1.34 ms | 21 MB |
| Bun, text | 89,400 | 1.62 ms | 24 MB |
| Beyond, JSON | 92,627 | 1.35 ms | 21 MB |
| Bun, JSON | 84,799 | 1.69 ms | 25 MB |

Beyond answers about 10% more text and 9% more JSON requests a second than
Bun, with lower tail latency, in about 85% of the memory (the load
generator shares the cores). What got it there:

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

`fetch()` against Bun's: 300,000 fetches of a short text from a Beyond
server in another process, 1, 10 or 50 of them in flight, each response
read with `text()` (bench/fetch.ts), three rounds a run, two runs each:

| in flight | Beyond | Bun |
|---|---|---|
| 1 | 21,538 fetches/s | 11,369 fetches/s |
| 10 | 112,381 fetches/s | 66,260 fetches/s |
| 50 | 108,853 fetches/s | 85,200 fetches/s |

Beyond's client does about 90% more fetches a second than Bun's one at a
time, 70% more with 10 in flight and 28% more with 50, on one thread (Bun
gives its client a thread of its own), at a peak of 22 MB (Bun: 32 MB).
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

`new URL(s).href` (bench/url.ts) takes 0.37 µs for a plain URL
(`http://127.0.0.1:3000/`; Bun: 0.10), 0.68 µs with credentials, a port,
a query and a fragment (Bun: 0.19 to 0.27), 0.85 µs with dot segments (Bun:
0.16 to 0.21): still about four times Bun's, from 1 to 9 µs before. Luminous
now compiles the parser's character scans as integer compares (a scan of
13 compares a character went from 15.6 ns to 2.8 ns a character), and the
fast path covers credentials, dot segments and escapes, keeps a canonical
input as the URL's serialization and its path as one string, and makes no
string for the scheme.

Streaming a large body is slower than Bun's for now: 256 MB in 64 KB chunks
takes 1.25 s (Bun: 0.81 s).
