# Beyond

A JavaScript and TypeScript runtime built on [Luminous](https://github.com/notwindstone/typescript-aot),
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
