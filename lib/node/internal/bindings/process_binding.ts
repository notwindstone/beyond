// process.binding(name), as Bun's (BunProcess.cpp's Process_functionBinding):
// the bindings Bun has, made of Beyond's modules, and an error naming the
// others.

import { $nativeStub } from "node:internal/intrinsics";
import constants from "./constants.ts";
import { httpAllMethods, httpMethods, uvErrors } from "./uv.ts";

function notImplemented(name: string): never {
  throw new Error(`process.binding("${name}") is not implemented in Beyond.`);
}

let uv: Record<string, unknown> | undefined;

/** process.binding("uv"): libuv's error codes (`UV_ENOENT`) and names. */
function uvBinding(): Record<string, unknown> {
  if (uv !== undefined) return uv;
  uv = {
    errname(err: unknown): string {
      if (typeof err !== "number" || !Number.isInteger(err)) return "Unknown system error";
      for (const [code, name] of uvErrors) if (code === err) return name;
      return `Unknown system error ${err}`;
    },
  };
  for (const [code, name] of uvErrors) uv[`UV_${name}`] = code;
  uv.getErrorMap = (): Map<number, [string, string]> => new Map(uvErrors.map(([code, name, message]) => [code, [name, message]]));
  return uv;
}

export function binding(name: unknown): unknown {
  const module = `${name}`;
  switch (module) {
    case "constants":
      return constants;
    case "uv":
      return uvBinding();
    case "config":
      return {
        isDebugBuild: false,
        hasOpenSSL: true,
        fipsMode: true,
        hasIntl: true,
        hasTracing: true,
        hasNodeOptions: true,
        hasInspector: true,
        noBrowserGlobals: false,
        bits: 64,
      };
    case "util":
      return import.meta.require("node:util/types").default;
    case "natives":
      return {};
    case "http_parser":
      return {
        methods: httpMethods,
        allMethods: httpAllMethods,
        // (llhttp's parser: not there yet.)
        HTTPParser: $nativeStub("http_parser", "HTTPParser"),
      };
    case "async_wrap":
    case "buffer":
    case "cares_wrap":
    case "contextify":
    case "crypto":
    case "crypto/x509":
    case "fs":
    case "fs_event_wrap":
    case "icu":
    case "inspector":
    case "js_stream":
    case "os":
    case "pipe_wrap":
    case "process_wrap":
    case "signal_wrap":
    case "spawn_sync":
    case "stream_wrap":
    case "tcp_wrap":
    case "tls_wrap":
    case "tty_wrap":
    case "udp_wrap":
    case "url":
    case "v8":
    case "zlib":
      return notImplemented(module);
    default:
      throw new Error(`No such module: ${module}`);
  }
}
