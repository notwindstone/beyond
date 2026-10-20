// The runner of Node.js's tests (Bun's copy of them: test/js/node/test in
// Bun's repository; run.py runs each). Every built-in module is part of
// it, compiled, and evaluated when a test first requires it (the function
// below only names them); the test is loaded at run time, a CommonJS
// script required, an ES module (`.mjs`) imported: `runner <test.js>
// [args...]`.

import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** (Never called: the modules it names are the runner's.) */
export function builtins(): unknown[] {
  return [
    import.meta.require("node:_http2_upgrade"),
    import.meta.require("node:_http_agent"),
    import.meta.require("node:_http_client"),
    import.meta.require("node:_http_common"),
    import.meta.require("node:_http_incoming"),
    import.meta.require("node:_http_outgoing"),
    import.meta.require("node:_http_server"),
    import.meta.require("node:_stream_duplex"),
    import.meta.require("node:_stream_passthrough"),
    import.meta.require("node:_stream_readable"),
    import.meta.require("node:_stream_transform"),
    import.meta.require("node:_stream_wrap"),
    import.meta.require("node:_stream_writable"),
    import.meta.require("node:_tls_common"),
    import.meta.require("node:_tls_wrap"),
    import.meta.require("node:assert"),
    import.meta.require("node:assert/strict"),
    import.meta.require("node:async_hooks"),
    import.meta.require("node:buffer"),
    import.meta.require("node:child_process"),
    import.meta.require("node:cluster"),
    import.meta.require("node:console"),
    import.meta.require("node:crypto"),
    import.meta.require("node:dgram"),
    import.meta.require("node:diagnostics_channel"),
    import.meta.require("node:dns"),
    import.meta.require("node:dns/promises"),
    import.meta.require("node:domain"),
    import.meta.require("node:events"),
    import.meta.require("node:fs"),
    import.meta.require("node:fs/promises"),
    import.meta.require("node:http"),
    import.meta.require("node:http2"),
    import.meta.require("node:https"),
    import.meta.require("node:inspector"),
    import.meta.require("node:inspector/promises"),
    import.meta.require("node:module"),
    import.meta.require("node:net"),
    import.meta.require("node:os"),
    import.meta.require("node:path"),
    import.meta.require("node:path/posix"),
    import.meta.require("node:path/win32"),
    import.meta.require("node:perf_hooks"),
    import.meta.require("node:process"),
    import.meta.require("node:punycode"),
    import.meta.require("node:querystring"),
    import.meta.require("node:quic"),
    import.meta.require("node:readline"),
    import.meta.require("node:readline/promises"),
    import.meta.require("node:repl"),
    import.meta.require("node:stream"),
    import.meta.require("node:stream/consumers"),
    import.meta.require("node:stream/iter"),
    import.meta.require("node:stream/promises"),
    import.meta.require("node:stream/web"),
    import.meta.require("node:string_decoder"),
    import.meta.require("node:test"),
    import.meta.require("node:timers"),
    import.meta.require("node:timers/promises"),
    import.meta.require("node:tls"),
    import.meta.require("node:trace_events"),
    import.meta.require("node:tty"),
    import.meta.require("node:url"),
    import.meta.require("node:util"),
    import.meta.require("node:util/types"),
    import.meta.require("node:v8"),
    import.meta.require("node:vm"),
    import.meta.require("node:wasi"),
    import.meta.require("node:worker_threads"),
    import.meta.require("node:zlib"),
    import.meta.require("node:zlib/iter"),
  ];
}

const arg = process.argv[2];
if (arg === undefined) {
  console.error("usage: runner <test.js> [args...]");
  process.exit(2);
}
const file = resolve(arg);
// As `node <test.js>` has them: the test's path second.
process.argv.splice(1, 2, file);
if (file.endsWith(".mjs")) await import(pathToFileURL(file).href);
else createRequire(file)(file);
