# Status

## APIs

- Timers: `setTimeout`, `setInterval`, `clearTimeout`, `clearInterval`, with
  `Timeout` objects (`ref`, `unref`, `refresh`), as Bun's; `performance.now`.
  The event loop waits on uSockets' until the next timer is due, as Bun's
  does, and runs the jobs callbacks queue in between. A top-level `await`
  waits on the loop. A promise rejected with no handler once the jobs are
  done is reported as an uncaught error, and the program exits with 1, as
  Bun's does.
- `Bun` is `Beyond` (the same object), so code written for Bun's API runs
  as it is: `serve`, `sleep`, `randomUUIDv7`, `gc`, `inspect`, `version`.
- `Beyond.serve({ port, hostname, fetch, routes, error, reusePort })`, as `Bun.serve`: HTTP/1.1
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
  others once answered, or all of them), a HEAD request answered with the
  response's length and no body, `server.reload(options)`,
  `server.pendingRequests`. `routes`, as Bun's: exact paths before
  `:param` patterns before `*` ones (params percent-decoded, on
  `request.params`), a handler or a `Response` per path or per method (a
  method a path does not handle goes to `fetch`, HEAD to its GET); a
  `Response` is sent as it is to every method, with Bun's etag (the
  xxHash64 of its body) and a 304 for a matching `If-None-Match`.
  `reusePort`, as Bun's: servers that set it share their port, in one
  process or several (SO_REUSEPORT, the kernel spreading the connections
  across them), on by default with `development: false` or in a
  node:cluster worker (`NODE_UNIQUE_ID` set); without it the port is the
  server's alone. `ipv6Only` for an IPv6 `hostname`. Without `port`, the
  port is `BUN_PORT`'s, `PORT`'s or `NODE_PORT`'s, else 3000, as Bun's.
- `await r.json()` where an `aot type` is expected (Luminous converts the
  result to it): a `Request`'s or `Response`'s body is parsed to the type
  directly, only its fields made (`parseJsonAs`; the general way, with its
  errors, for anything else).
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
## Tests

The tests (`cargo test`) run programs whose output must be Bun 1.4.3's, the WPT
URL data and streams tests, a server answering over TCP, and `fetch()`
against a server of the test's own.
## Elysia

Elysia 2 (`bench/elysia`) runs on Beyond: its AOT plugin for `Bun.build`
composes the handlers at build time (`bun build.ts`), so the bundle makes no
function with `new Function` at run time, and `beyond build dist/app.js`
compiles it; Elysia takes its Bun adapter (`Bun.serve` with `routes` and
`reload`). Its responses are Bun's but for the order and case of some
header names.
## Not yet

Not yet: TLS for `Beyond.serve`, client certificates and
`checkServerIdentity` for `fetch`, HTTP/2, WebSockets, `crypto.subtle`,
TextDecoder's legacy encodings but windows-1252; errors print without
Bun's source excerpt, and their stacks' lines are the bundle's.
