// Module resolution as Bun's: Node's built-in modules by name, relative and
// absolute paths, and packages through `node_modules` (`exports` and
// `imports` with conditions, main fields), with TypeScript's extensions.
// Paths are resolved by Beyond's build library (crates/beyond-build).

import { buildResolve } from "beyond:native";

/** Node's built-in modules (as `node:` specifiers drop the prefix). */
export const builtinModules = [
  "assert", "assert/strict", "async_hooks", "buffer", "child_process", "cluster", "console", "constants", "crypto",
  "dgram", "diagnostics_channel", "dns", "dns/promises", "domain", "events", "fs", "fs/promises", "http", "http2",
  "https", "inspector", "module", "net", "os", "path", "path/posix", "path/win32", "perf_hooks", "process", "punycode",
  "querystring", "readline", "readline/promises", "repl", "stream", "stream/consumers", "stream/promises", "stream/web",
  "string_decoder", "sys", "timers", "timers/promises", "tls", "trace_events", "tty", "url", "util", "util/types", "v8",
  "vm", "wasi", "worker_threads", "zlib",
];
const builtins = new Set(builtinModules);

/** Whether `spec` names a built-in module (`fs`, `node:fs`; `bun:*`). */
export function isBuiltin(spec: string): boolean {
  if (spec.startsWith("node:")) return builtins.has(spec.slice(5)) || spec === "node:test" || spec === "node:sqlite";
  return builtins.has(spec) || spec.startsWith("bun:") || spec === "bun";
}

export type ResolveKind = "import" | "require";

const EXTENSIONS = [".tsx", ".ts", ".jsx", ".js", ".mjs", ".cjs", ".mts", ".cts", ".json"];

/** Resolution's conditions for `target` (bun, node, browser) and kind. */
export function conditionsFor(target: string, kind: ResolveKind, extra: string[] = []): string[] {
  const base = target === "browser" ? ["browser"] : target === "node" ? ["node"] : ["bun", "node"];
  return [...extra, ...base, kind, ...(kind === "import" ? ["module"] : []), "default"];
}

export function mainFieldsFor(target: string, kind: ResolveKind): string[] {
  if (target === "browser") return ["browser", "module", "main"];
  return kind === "require" ? ["main", "module"] : ["module", "main"];
}

/** The file `spec` names from directory `dir`, or an error (`code`
 * MODULE_NOT_FOUND) as Bun's: `Cannot find module 'x' from 'dir'`. */
export function resolveFile(
  dir: string,
  spec: string,
  options: { target?: string; kind?: ResolveKind; conditions?: string[]; extensions?: string[]; mainFields?: string[] } = {},
): string {
  const target = options.target ?? "bun";
  const kind = options.kind ?? "import";
  const r = JSON.parse(
    buildResolve(
      JSON.stringify({
        dir,
        spec,
        conditions: options.conditions ?? conditionsFor(target, kind),
        extensions: options.extensions ?? EXTENSIONS,
        mainFields: options.mainFields ?? mainFieldsFor(target, kind),
      }),
    ) as string,
  );
  if (r.path !== undefined) return r.path as string;
  const e = new Error(`Cannot find module '${spec}' from '${dir}'`);
  (e as any).code = "MODULE_NOT_FOUND";
  throw e;
}
