// node:module: `Module` (a CommonJS module: its `require`, which each
// module's `require` function calls, as Node's does, so that
// `Module.prototype.require` can be replaced), `createRequire` (built-in
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

interface NodeRequire {
  (spec: string): any;
  resolve: ((spec: string, options?: { paths?: string[] }) => string) & { paths: (spec: string) => string[] | null };
  cache: Record<string, Module>;
  main: Module | undefined;
  extensions: Record<string, unknown>;
}

const cache: Record<string, Module> = Object.create(null);

/** The paths a package `spec` is looked for in from `dir`. */
function lookupPaths(dir: string): string[] {
  const out: string[] = [];
  for (let d = dir; ; d = dirname(d)) {
    if (!d.endsWith("/node_modules")) out.push(`${d === "/" ? "" : d}/node_modules`);
    if (d === "/" || d === ".") break;
  }
  return out;
}

/** Whether node's internal modules (`internal/...`) are exposed: Node's
 * `--expose-internals`, as Bun has it. */
function exposeInternals(): boolean {
  const p: any = (globalThis as any).process;
  return p?.execArgv?.includes?.("--expose-internals") === true || p?.env?.BUN_FEATURE_FLAG_INTERNAL_FOR_TESTING === "1";
}

function notFound(spec: string, dir: string): Error {
  const e = new Error(`Cannot find module '${spec}' from '${dir}'`);
  (e as any).code = "MODULE_NOT_FOUND";
  return e;
}

function resolveFrom(dir: string, spec: string, options?: { paths?: string[] }): string {
  if (isBuiltinSpec(spec)) return spec;
  for (const base of options?.paths ?? [dir]) {
    try {
      return resolveFile(base, spec, { kind: "require" });
    } catch (e) {
      if (options?.paths === undefined) throw e;
    }
  }
  throw notFound(spec, dir);
}

/** What `require(spec)` gives in module `m`. */
function requireFrom(m: Module, spec: string): any {
  if (typeof spec !== "string") {
    const e = new TypeError(`The "id" argument must be of type string. Received ${typeof spec}`);
    (e as any).code = "ERR_INVALID_ARG_TYPE";
    throw e;
  }
  if (isBuiltinSpec(spec) || (spec.startsWith("internal/") && exposeInternals())) {
    const b = builtin(spec);
    if (b === undefined) {
      if (spec.startsWith("internal/")) throw notFound(spec, m.path);
      const e = new Error(`Beyond does not have the built-in module "${spec}" yet`);
      (e as any).code = "ERR_UNKNOWN_BUILTIN_MODULE";
      throw e;
    }
    return b;
  }
  return load(resolveFrom(m.path, spec), m);
}

function load(file: string, parent: Module | undefined): any {
  const cached = cache[file];
  if (cached) return cached.exports;
  const m = new Module(file, parent);
  m.filename = file;
  m.paths = lookupPaths(m.path);
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
      const req = makeRequire(m);
      const wrapper = new Function("exports", "require", "module", "__filename", "__dirname", `${source}\n//# sourceURL=${file}`);
      wrapper.call(m.exports, m.exports, req, m, file, m.path);
    }
    m.loaded = true;
    parent?.children.push(m);
    return m.exports;
  } catch (e) {
    delete cache[file];
    throw e;
  }
}

/** Module `m`'s `require` (it calls `m.require`). */
function makeRequire(m: Module): NodeRequire {
  const require = ((spec: string) => m.require(spec)) as NodeRequire;
  const resolve = (spec: string, options?: { paths?: string[] }): string => resolveFrom(m.path, spec, options);
  resolve.paths = (spec: string): string[] | null => (isBuiltinSpec(spec) ? null : lookupPaths(m.path));
  require.resolve = resolve as NodeRequire["resolve"];
  require.cache = cache;
  require.main = undefined;
  require.extensions = Module._extensions;
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
  const m = new Module(file);
  m.filename = file;
  // (A directory's, when it ends with `/`.)
  if (file.endsWith("/")) m.path = file.slice(0, -1) || "/";
  m.paths = lookupPaths(m.path);
  return makeRequire(m);
}

export function register(): void {}
export function syncBuiltinESMExports(): void {}
export function findSourceMap(): undefined {
  return undefined;
}

export class Module {
  id: string;
  filename: string | null = null;
  path: string;
  exports: any = {};
  loaded = false;
  children: Module[] = [];
  paths: string[] = [];
  parent: Module | undefined;

  constructor(id = "", parent?: Module) {
    this.id = id;
    this.path = id.startsWith("/") ? dirname(id) : ".";
    this.parent = parent;
  }

  /** `require(id)` in this module. */
  require(id: string): any {
    return requireFrom(this, id);
  }

  static builtinModules = builtinModules;
  static createRequire = createRequire;
  static isBuiltin = isBuiltin;
  static _cache = cache;
  static _extensions: Record<string, unknown> = { ".js": null, ".json": null, ".node": null };

  static _load(request: string, parent?: Module): any {
    return (parent ?? new Module(`${(globalThis as any).process.cwd()}/[eval]`)).require(request);
  }

  static _resolveFilename(request: string, parent?: Module, _isMain?: boolean, options?: { paths?: string[] }): string {
    return resolveFrom(parent?.path ?? (globalThis as any).process.cwd(), request, options);
  }

  static _nodeModulePaths(dir: string): string[] {
    return lookupPaths(dir);
  }

  static wrap(script: string): string {
    return `(function (exports, require, module, __filename, __dirname) { ${script}\n});`;
  }
}

export default Module;
