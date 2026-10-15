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
networking code uses its extensions) and zlib.

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
  `fetch` handler returns a `Response` or a promise of one; request bodies
  are read whole before it runs. A response whose body is a stream (or an
  async generator) is sent chunked as it is read, each chunk written when
  the connection has room (uWebSockets' writable callbacks, as Bun's sink
  does); a stream that fails midway closes the connection. `server.port`,
  `server.url`, `server.stop()`.
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
  with a fast path for the common URL), hosts with IPv4, IPv6 and
  internationalized domains (punycode, and UTS #46's mapping approximated
  with NFKC, lower case and the Unicode categories), all the setters. It
  passes all of the web platform tests' URL data (urltestdata 896/896,
  setters 278/278, toascii 87/87; Bun: 881, 274 and 80) and 2626 of the
  2634 IdnaTestV2 cases (Bun: 1867).
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

The tests (`cargo test`) run programs whose output must be Bun's, the WPT
URL data and streams tests, and a server answering over TCP.

Not yet: TLS, HTTP/2, WebSockets, `fetch` (the client), `crypto.subtle`,
request bodies as they arrive (they are read whole first), TextDecoder's
legacy encodings but windows-1252; errors print without Bun's source
excerpt, and their stacks' lines are the bundle's.

## Performance

`Beyond.serve` against `Bun.serve` (Bun 1.4.2), the same program
(`new Response("Hello World!")`, and `Response.json({...})` of a small
object), 10 seconds of `oha -c 50` on the same 4-core machine as the
server, runs alternated:

| | requests/s | p99 latency | memory (RSS) |
|---|---|---|---|
| Beyond, text | 122,973 | 0.90 ms | 21 MB |
| Bun, text | 111,861 | 1.18 ms | 25 MB |
| Beyond, JSON | 115,680 | 0.97 ms | 22 MB |
| Bun, JSON | 107,297 | 1.23 ms | 27 MB |

Beyond answers about 10% more text and 8% more JSON requests a second than
Bun, with lower tail latency, in about 80% of the memory (the load
generator shares the cores). What got it there:

- The request path is native code: `Headers`, `Request` and `Response`
  keep their state in plain fields and check without regular expressions
  (before that, Beyond answered 37,661 text and 25,350 JSON requests a
  second).
- A program's globals (`Response`, `Request`, `URL`, ...) are bindings of
  Beyond's modules to Luminous (`--global`): `new Response(...)` is the
  class's native constructor, not the engine constructing a global (+15%).
- The server makes the request's URL in C, shares the strings of common
  methods and header names, and a response with no headers of its own
  sends only its content type.
- Two engine fast paths in Luminous's patch: `instanceof` without calling
  `Symbol.hasInstance` when it cannot have been replaced, and
  `JSON.stringify` of plain data straight from object shapes (a small
  object's went from about 8,800 instructions to a few hundred).

Streaming a large body is slower than Bun's for now: 256 MB in 64 KB chunks
takes 1.25 s (Bun: 0.81 s).
