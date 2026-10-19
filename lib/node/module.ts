// node:module: `createRequire` (a CommonJS `require` for a file: built-in
// modules, JSON, and CommonJS modules, with `require.resolve`) and the list
// of built-in modules.

import { buildTranspile, readFile } from "beyond:native";
import { builtinModule } from "../modules.ts";
import { builtinModules, isBuiltin as isBuiltinSpec, resolveFile } from "../resolve.ts";
import { dirname } from "./path.ts";
import { fileURLToPath } from "./url.ts";

/** A built-in module as `require` returns it (its default export, else its
 * namespace). */
function builtin(name: string): unknown {
  if (name === "module" || name === "node:module") return Module;
  return builtinModule(name);
}

export { builtinModules };

export function isBuiltin(name: string): boolean {
  return isBuiltinSpec(name) && !name.startsWith("bun:");
}

interface CjsModule {
  id: string;
  filename: string;
  path: string;
  exports: any;
  loaded: boolean;
  children: CjsModule[];
  paths: string[];
  require?: NodeRequire;
}

interface NodeRequire {
  (spec: string): any;
  resolve: ((spec: string, options?: { paths?: string[] }) => string) & { paths: (spec: string) => string[] | null };
  cache: Record<string, CjsModule>;
  main: CjsModule | undefined;
  extensions: Record<string, unknown>;
}

const cache: Record<string, CjsModule> = Object.create(null);

/** The paths a package `spec` is looked for in from `dir`. */
function lookupPaths(dir: string): string[] {
  const out: string[] = [];
  for (let d = dir; ; d = dirname(d)) {
    if (!d.endsWith("/node_modules")) out.push(`${d === "/" ? "" : d}/node_modules`);
    if (d === "/" || d === ".") break;
  }
  return out;
}

function load(file: string): any {
  const cached = cache[file];
  if (cached) return cached.exports;
  const m: CjsModule = { id: file, filename: file, path: dirname(file), exports: {}, loaded: false, children: [], paths: lookupPaths(dirname(file)) };
  cache[file] = m;
  try {
    if (file.endsWith(".json")) {
      m.exports = JSON.parse(readFile(file, true) as string);
    } else if (file.endsWith(".node")) {
      throw new Error(`Cannot load native addon ${file}: not supported by Beyond`);
    } else {
      let source = readFile(file, true) as string;
      if (/\.[cm]?tsx?$/.test(file) || file.endsWith(".jsx")) {
        const r = JSON.parse(buildTranspile(JSON.stringify({ path: file, source })) as string);
        if (r.error !== undefined) throw new SyntaxError(r.error);
        source = r.code;
      }
      if (/^\s*(import\s*[\w{*"']|export\s)/m.test(source) && !/\bmodule\.exports\b|\bexports\.\w/.test(source)) {
        const e = new Error(`require() of ES Module ${file} is not supported by Beyond yet`);
        (e as any).code = "ERR_REQUIRE_ESM";
        throw e;
      }
      const req = makeRequire(file);
      m.require = req;
      const wrapper = new Function("exports", "require", "module", "__filename", "__dirname", `${source}\n//# sourceURL=${file}`);
      wrapper.call(m.exports, m.exports, req, m, file, dirname(file));
    }
    m.loaded = true;
    return m.exports;
  } catch (e) {
    delete cache[file];
    throw e;
  }
}

function makeRequire(from: string): NodeRequire {
  const dir = from.endsWith("/") ? from.slice(0, -1) : dirname(from);
  const resolve = (spec: string, options?: { paths?: string[] }): string => {
    if (isBuiltinSpec(spec)) return spec;
    for (const base of options?.paths ?? [dir]) {
      try {
        return resolveFile(base, spec, { kind: "require" });
      } catch (e) {
        if (options?.paths === undefined) throw e;
      }
    }
    const e = new Error(`Cannot find module '${spec}' from '${dir}'`);
    (e as any).code = "MODULE_NOT_FOUND";
    throw e;
  };
  resolve.paths = (spec: string): string[] | null => (isBuiltinSpec(spec) ? null : lookupPaths(dir));
  const require = ((spec: string) => {
    if (typeof spec !== "string") {
      const e = new TypeError(`The "id" argument must be of type string. Received ${typeof spec}`);
      (e as any).code = "ERR_INVALID_ARG_TYPE";
      throw e;
    }
    if (isBuiltinSpec(spec)) {
      const b = builtin(spec);
      if (b === undefined) {
        const e = new Error(`Beyond does not have the built-in module "${spec}" yet`);
        (e as any).code = "ERR_UNKNOWN_BUILTIN_MODULE";
        throw e;
      }
      return b;
    }
    return load(resolve(spec));
  }) as NodeRequire;
  require.resolve = resolve as NodeRequire["resolve"];
  require.cache = cache;
  require.main = undefined;
  require.extensions = { ".js": null, ".json": null, ".node": null };
  return require;
}

/** A `require` for module `filename` (a path, or a `file:` URL). */
export function createRequire(filename: string | URL): NodeRequire {
  const file = filename instanceof URL || filename.startsWith("file:") ? fileURLToPath(filename) : filename;
  if (!file.startsWith("/")) {
    const e = new TypeError(`The argument 'filename' must be a file URL object, file URL string, or absolute path string. Received ${JSON.stringify(filename)}`);
    (e as any).code = "ERR_INVALID_ARG_VALUE";
    throw e;
  }
  return makeRequire(file);
}

export function register(): void {}
export function syncBuiltinESMExports(): void {}
export function findSourceMap(): undefined {
  return undefined;
}

export class Module {
  static builtinModules = builtinModules;
  static createRequire = createRequire;
  static isBuiltin = isBuiltin;
}

export default Module;
