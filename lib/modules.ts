// Modules a program loads at run time: what `import()` of a computed
// specifier imports (Luminous leaves it to the program), and their own
// imports. Specifiers resolve as Bun's (Node's built-in modules, paths,
// packages); TypeScript and JSX are made JavaScript (Beyond's build
// library); CommonJS modules are required (node:module) and imported as
// their exports. A module that is part of the program is the program's
// (Luminous registers its modules by path): one instance of each.

import { buildTranspile, cwd, importModule, importModuleSync, readFile, setModuleHooks, stat } from "beyond:native";
import { basename, dirname } from "./sys/path.ts";
import { fileURLToPath, pathToFileURL } from "./sys/url.ts";
import { isBuiltin, resolveFile } from "./resolve.ts";

/** Beyond's lib/ (this module's directory). */
export const LIB: string = import.meta.dirname;

/** Bun's modules Beyond has, by their files in lib/. */
const BUN_MODULES: Record<string, string> = { "bun:test": "jest.ts" };

function registry(): Map<string, () => object> | undefined {
  return (globalThis as any)[Symbol.for("luminous.modules")];
}

/** The name of the module `spec` imported by module `base` (a path; a
 * directory if it ends with `/`): an absolute path, or `node:name`. */
function resolveName(spec: string, base: string): string {
  if (spec.startsWith("beyond:") || spec.startsWith("qjs:") || spec.startsWith("luminous:")) return spec;
  if (spec.startsWith("file:")) spec = fileURLToPath(spec);
  if (isBuiltin(spec)) {
    if (spec.startsWith("bun:") || spec === "bun") return spec;
    return "node:" + (spec.startsWith("node:") ? spec.slice(5) : spec);
  }
  const dir = base.endsWith("/") ? base.slice(0, -1) || "/" : base.startsWith("/") ? dirname(base) : (cwd() as string);
  return resolveFile(dir, spec, { kind: "import" });
}

/** TypeScript or JSX as JavaScript. */
function transpile(path: string, source: string): string {
  const r = JSON.parse(buildTranspile(JSON.stringify({ path, source })) as string);
  if (r.error !== undefined) throw new SyntaxError(r.error);
  return r.code;
}

/** Whether a module's source is CommonJS (no `import` or `export`, and
 * `module.exports`, `exports.x` or `require`). */
function commonJS(path: string, code: string): boolean {
  if (path.endsWith(".cjs") || path.endsWith(".cts")) return true;
  if (path.endsWith(".mjs") || path.endsWith(".mts")) return false;
  if (/(^|[\n;])\s*(import\s*[\w{*"'`]|export\s+(\*|\{|default\b|const\b|let\b|var\b|function\b|class\b|async\b))/.test(code)) return false;
  return /\bmodule\.exports\b|\bexports\.[\w$]+\s*=|\brequire\s*\(/.test(code);
}

/** `import.meta` of module `path`, as Bun's. */
function metaOf(path: string): object {
  return {
    url: pathToFileURL(path).href,
    filename: path,
    dirname: dirname(path),
    dir: dirname(path),
    file: basename(path),
    path,
    main: false,
    resolve: (spec: string) => {
      const name = resolveName(String(spec), path);
      return name.startsWith("/") ? pathToFileURL(name).href : name;
    },
  };
}

/** The file of built-in module `name` (`fs/promises`) in lib/node: Bun's
 * modules are TypeScript, a few JavaScript. */
function builtinFile(name: string): string | undefined {
  for (const ext of [".ts", ".js"]) {
    const file = `${LIB}/node/${name}${ext}`;
    if (stat(file, true, false) !== undefined) return file;
  }
  return undefined;
}

/** What module `name` is: the program's, a CommonJS module's exports, or
 * JavaScript to compile. */
function load(name: string): { code?: string; exports?: object; meta?: object } {
  const shared = registry()?.get(name);
  if (shared !== undefined) return { exports: shared() };
  if (name.startsWith("node:")) {
    const file = builtinFile(name.slice(5));
    if (file === undefined) {
      const e = new Error(`Beyond does not have the built-in module "${name}" yet`);
      (e as any).code = "ERR_UNKNOWN_BUILTIN_MODULE";
      throw e;
    }
    const own = registry()?.get(file);
    if (own !== undefined) return { exports: own() };
    const f = JSON.stringify(file);
    return { code: `export * from ${f}; export { default } from ${f};\n` };
  }
  if (name.startsWith("bun:") || name === "bun") {
    const own = BUN_MODULES[name];
    if (own === undefined) throw new Error(`Beyond does not have the module "${name}" yet`);
    const file = `${LIB}/${own}`;
    const shared = registry()?.get(file);
    if (shared !== undefined) return { exports: shared() };
    const f = JSON.stringify(file);
    return { code: `export * from ${f}; export { default } from ${f};\n` };
  }
  if (name.endsWith(".json")) return { exports: { default: JSON.parse(readFile(name, true) as string) } };
  let code = readFile(name, true) as string;
  if (/\.[cm]?tsx?$|\.jsx$/.test(name)) code = transpile(name, code);
  if (commonJS(name, code)) {
    const { createRequire } = importModuleSync(`${LIB}/node/module.ts`) as any;
    const exports = createRequire(name)(name);
    const named: Record<string, unknown> = { default: exports };
    if (exports !== null && (typeof exports === "object" || typeof exports === "function")) {
      for (const k of Object.keys(exports)) if (k !== "default") named[k] = exports[k];
    }
    return { exports: named };
  }
  return { code, meta: metaOf(name) };
}

setModuleHooks(resolveName, load);

/** Luminous's `import()` of what is not part of the program: `specifier`
 * imported from directory `base`. */
(globalThis as any)[Symbol.for("luminous.import")] = (specifier: string, base: string): Promise<unknown> => {
  try {
    return importModule(resolveName(specifier, base)) as Promise<unknown>;
  } catch (e) {
    return Promise.reject(e);
  }
};

/** Luminous's `import.meta.resolve` of module `path`. */
(globalThis as any)[Symbol.for("luminous.resolve")] = (specifier: string, path: string): string => {
  const name = resolveName(specifier, path);
  return name.startsWith("/") ? pathToFileURL(name).href : name;
};

/** A module of Beyond's lib/ loaded now, interpreted (what programs seldom
 * use: it is not compiled into each). */
export function libModule(file: string): Promise<any> {
  return importModule(`${LIB}/${file}`) as Promise<any>;
}

export function libModuleSync(file: string): any {
  return importModuleSync(`${LIB}/${file}`);
}

/** A built-in module's namespace (its default export if it has one), now:
 * process.getBuiltinModule. */
export function builtinModule(name: string): unknown {
  if (name in BUN_MODULES) {
    const ns: any = importModuleSync(`${LIB}/${BUN_MODULES[name]}`);
    return ns?.default ?? ns;
  }
  if (!isBuiltin(name) || name.startsWith("bun:")) return undefined;
  // (One Beyond does not have yet: none, as an unknown one.)
  if (builtinFile(name.startsWith("node:") ? name.slice(5) : name) === undefined) return undefined;
  const ns: any = importModuleSync(resolveName(name, "/"));
  return ns?.default ?? ns;
}
