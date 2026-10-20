// Beyond.build (Bun.build): bundles entry points into ES modules, with
// Bun's plugin API (onStart, onResolve, onLoad, onEnd, namespaces,
// loaders) and its results (BuildOutput, BuildArtifact, BuildMessage).
//
// The bundler is Luminous's, in Beyond's build library (crates/beyond-
// build): its module graph merged into one module, each module's names kept
// apart (scope hoisting), types erased. It runs on a thread of its own and
// asks this code to resolve each import and load each module; plugins answer
// first (awaited: they may be async), then Bun's resolution and the files.

import { buildClose, buildNext, buildStart, buildTranspile, cwd, readFile, stat, writeFile, xxh64Hex } from "beyond:native";
import { mimeOf } from "./file.ts";
import { mkdirp } from "./sys/fs.ts";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "./sys/path.ts";
import { isBuiltin, resolveFile } from "./resolve.ts";

type Loader = "js" | "jsx" | "ts" | "tsx" | "json" | "jsonc" | "toml" | "text" | "file" | "css" | "html" | "napi" | "wasm" | "object";

interface OnResolveArgs {
  path: string;
  importer: string;
  namespace: string;
  resolveDir: string;
  kind: "entry-point-build" | "import-statement" | "dynamic-import" | "require-call";
  pluginData?: unknown;
}

interface OnResolveResult {
  path?: string;
  namespace?: string;
  external?: boolean;
  pluginData?: unknown;
}

interface OnLoadArgs {
  path: string;
  namespace: string;
  loader: Loader;
  side: "server" | "client";
  defer: () => Promise<void>;
  pluginData?: unknown;
}

interface OnLoadResult {
  contents?: string | ArrayBuffer | ArrayBufferView;
  loader?: Loader;
  resolveDir?: string;
  exports?: Record<string, unknown>;
}

type Callback<A, R> = (args: A) => R | undefined | null | void | Promise<R | undefined | null | void>;

interface Hook<A, R> {
  filter: RegExp;
  namespace?: string;
  callback: Callback<A, R>;
  plugin: string;
}

export interface BunPlugin {
  name: string;
  target?: string;
  setup(build: PluginBuilder): void | Promise<void>;
}

export interface BuildConfig {
  entrypoints: string[];
  outdir?: string;
  target?: "browser" | "bun" | "node";
  format?: "esm" | "cjs" | "iife";
  naming?: string | { entry?: string; chunk?: string; asset?: string };
  root?: string;
  splitting?: boolean;
  plugins?: BunPlugin[];
  external?: string[];
  packages?: "bundle" | "external";
  define?: Record<string, string>;
  loader?: Record<string, Loader>;
  minify?: boolean | { whitespace?: boolean; syntax?: boolean; identifiers?: boolean };
  sourcemap?: "none" | "linked" | "inline" | "external" | boolean;
  banner?: string;
  footer?: string;
  publicPath?: string;
  conditions?: string | string[];
  throw?: boolean;
  [key: string]: unknown;
}

/** A message of a build, as Bun's BuildMessage. */
export class BuildMessage {
  name = "BuildMessage";
  level: "error" | "warning" | "info" | "debug" | "verbose";
  message: string;
  position: {
    lineText: string;
    file: string;
    namespace: string;
    line: number;
    column: number;
    length: number;
    offset: number;
  } | null;
  notes: unknown[] = [];
  constructor(message: string, level: BuildMessage["level"] = "error", position: BuildMessage["position"] = null) {
    this.message = message;
    this.level = level;
    this.position = position;
  }
  /** The position's line and column, from 0. */
  get line(): number {
    return this.position === null ? 0 : this.position.line - 1;
  }
  get column(): number {
    return this.position === null ? 0 : Math.max(this.position.column - 1, 0);
  }
  toString(): string {
    return `${this.name}: ${this.message}`;
  }
  toJSON(): object {
    return { name: this.name, position: this.position, message: this.message, level: this.level };
  }
}
// (As Bun's: an Error, though not made by Error.)
Object.setPrototypeOf(BuildMessage.prototype, Error.prototype);

/** A specifier that did not resolve, as Bun's ResolveMessage. */
export class ResolveMessage extends BuildMessage {
  override name = "ResolveMessage";
  code = "ERR_MODULE_NOT_FOUND";
  specifier: string;
  importKind: OnResolveArgs["kind"];
  referrer = "";
  constructor(message: string, specifier: string, importKind: OnResolveArgs["kind"], position: BuildMessage["position"]) {
    super(message, "error", position);
    this.specifier = specifier;
    this.importKind = importKind;
  }
  override toJSON(): object {
    return { ...super.toJSON(), specifier: this.specifier, importKind: this.importKind, referrer: this.referrer };
  }
}

/** An output of a build, as Bun's BuildArtifact. */
export class BuildArtifact {
  path: string;
  loader: Loader;
  hash: string | null;
  kind: "entry-point" | "chunk" | "asset" | "sourcemap" | "bytecode";
  sourcemap: BuildArtifact | null = null;
  type: string;
  #bytes: Uint8Array;
  constructor(path: string, bytes: Uint8Array, loader: Loader, kind: BuildArtifact["kind"], type: string, hash: string | null) {
    this.path = path;
    this.#bytes = bytes;
    this.loader = loader;
    this.kind = kind;
    this.type = type;
    this.hash = hash;
  }
  get size(): number {
    return this.#bytes.length;
  }
  async text(): Promise<string> {
    return new TextDecoder().decode(this.#bytes);
  }
  async arrayBuffer(): Promise<ArrayBuffer> {
    return this.#bytes.slice().buffer as ArrayBuffer;
  }
  async bytes(): Promise<Uint8Array> {
    return this.#bytes.slice();
  }
  async json(): Promise<any> {
    return JSON.parse(await this.text());
  }
  stream(): ReadableStream<Uint8Array> {
    return new Blob([this.#bytes]).stream();
  }
}

export interface BuildOutput {
  success: boolean;
  outputs: BuildArtifact[];
  logs: BuildMessage[];
}

/** The loader of a file by its extension (`config.loader` first). */
function loaderOf(path: string, overrides: Record<string, Loader> | undefined): Loader | undefined {
  const ext = extname(path);
  const o = overrides?.[ext];
  if (o !== undefined) return o;
  switch (ext) {
    case ".js":
    case ".mjs":
    case ".cjs":
      return "js";
    case ".jsx":
      return "jsx";
    case ".ts":
    case ".mts":
    case ".cts":
      return "ts";
    case ".tsx":
      return "tsx";
    case ".json":
      return "json";
    case ".jsonc":
      return "jsonc";
    case ".toml":
      return "toml";
    case ".txt":
      return "text";
    case ".css":
      return "css";
    case ".html":
      return "html";
    case ".node":
      return "napi";
    case ".wasm":
      return "wasm";
  }
  return undefined;
}

/** Whether `spec` matches a pattern of `external` (`*` a wildcard). */
function matchesExternal(spec: string, patterns: string[]): boolean {
  for (const p of patterns) {
    if (p === spec) return true;
    if (p.includes("*")) {
      const re = new RegExp("^" + p.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
      if (re.test(spec)) return true;
    } else if (spec.startsWith(p + "/")) {
      return true;
    }
  }
  return false;
}

/** The lowest directory that has every path. */
function commonDir(paths: string[]): string {
  let dir = dirname(paths[0]);
  for (const p of paths.slice(1)) {
    while (!(p + "/").startsWith(dir === "/" ? "/" : dir + "/")) dir = dirname(dir);
  }
  return dir;
}

/** Bytes as a string of one character each (for hashing). */
function binaryString(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 4096) s += String.fromCharCode(...bytes.subarray(i, i + 4096));
  return s;
}

/** Bun's content hash: 8 base-36 characters. */
function hashOf(text: string): string {
  const h = BigInt("0x" + (xxh64Hex(text) as string));
  return (h % 36n ** 8n).toString(36).padStart(8, "0");
}

/** A module the bundle has: where it is, in which namespace. */
interface ModuleInfo {
  path: string;
  namespace: string;
  pluginData?: unknown;
  resolveDir?: string;
}

class Build {
  config: BuildConfig;
  logs: BuildMessage[] = [];
  resolvers: Hook<OnResolveArgs, OnResolveResult>[] = [];
  loaders: Hook<OnLoadArgs, OnLoadResult>[] = [];
  starts: (() => unknown)[] = [];
  ends: ((result: BuildOutput) => unknown)[] = [];
  virtual = new Map<string, () => OnLoadResult | Promise<OnLoadResult>>();
  modules = new Map<string, ModuleInfo>();
  root: string;
  target: string;
  conditions: string[];

  constructor(config: BuildConfig, root: string) {
    this.config = config;
    this.root = root;
    this.target = config.target ?? "browser";
    const c = config.conditions;
    this.conditions = c === undefined ? [] : Array.isArray(c) ? c : [c];
  }

  /** The id the bundler knows a module by: its path, or `namespace:path`. */
  idOf(path: string, namespace: string): string {
    const id = namespace === "file" ? path : `${namespace}:${path}`;
    if (!this.modules.has(id)) this.modules.set(id, { path, namespace });
    return id;
  }

  info(id: string): ModuleInfo {
    return this.modules.get(id) ?? { path: id, namespace: "file" };
  }

  /** Plugins' resolution of `spec`, else Bun's: the answer to the bundler. */
  async resolve(spec: string, importerId: string, kind: OnResolveArgs["kind"]): Promise<{ path?: string; external?: string; error?: string }> {
    const importer = importerId === "" ? undefined : this.info(importerId);
    const namespace = importer?.namespace ?? "file";
    const resolveDir = importer === undefined
      ? this.root
      : importer.resolveDir ?? (importer.namespace === "file" ? dirname(importer.path) : this.root);
    for (const h of this.resolvers) {
      if (h.namespace !== undefined && h.namespace !== namespace) continue;
      if (!h.filter.test(spec)) continue;
      const args: OnResolveArgs = { path: spec, importer: importer?.path ?? "", namespace, resolveDir, kind };
      if (importer?.pluginData !== undefined) args.pluginData = importer.pluginData;
      const r = await h.callback(args);
      if (r === undefined || r === null) continue;
      if (typeof r !== "object") throw new TypeError(`onResolve() of plugin "${h.plugin}" must return an object`);
      if (r.external) return { external: r.path ?? spec };
      const ns = r.namespace ?? "file";
      let path = r.path ?? spec;
      if (ns === "file" && !isAbsolute(path)) path = resolve(resolveDir, path);
      const id = this.idOf(path, ns);
      if (r.pluginData !== undefined) this.modules.get(id)!.pluginData = r.pluginData;
      return { path: id };
    }
    // Bun's: built-in modules and `external` stay imports.
    const external = this.config.external ?? [];
    if (isBuiltin(spec) || spec.startsWith("bun:")) {
      if (this.target !== "browser" || spec.startsWith("node:")) return { external: spec };
    }
    if (matchesExternal(spec, external)) return { external: spec };
    const bare = !spec.startsWith(".") && !spec.startsWith("/");
    if (bare && this.config.packages === "external") return { external: spec };
    if (namespace !== "file" && importer?.resolveDir === undefined && !bare && !isAbsolute(spec)) {
      return { error: `Could not resolve: "${spec}"` };
    }
    try {
      const path = resolveFile(resolveDir, spec, {
        target: this.target,
        kind: kind === "require-call" ? "require" : "import",
        conditions: this.conditions.length ? [...this.conditions, ...defaultConditions(this.target)] : undefined,
      });
      return { path: this.idOf(path, "file") };
    } catch {
      return { error: `Could not resolve: "${spec}"${bare ? `. Maybe you need to "bun install"?` : ""}` };
    }
  }

  /** Plugins' loading of a module, else the file's: the answer. */
  async load(id: string): Promise<{ default?: true; contents?: string; loader?: string; error?: string }> {
    const m = this.info(id);
    const fallback: Loader = m.namespace === "file" ? (loaderOf(m.path, this.config.loader) ?? "file") : "js";
    for (const h of this.loaders) {
      if (h.namespace !== undefined && h.namespace !== m.namespace) continue;
      if (!h.filter.test(m.path)) continue;
      const args: OnLoadArgs = { path: m.path, namespace: m.namespace, loader: fallback, side: "server", defer: () => Promise.resolve() };
      if (m.pluginData !== undefined) args.pluginData = m.pluginData;
      const r = await h.callback(args);
      if (r === undefined || r === null) continue;
      if (typeof r !== "object") throw new TypeError(`onLoad() of plugin "${h.plugin}" must return an object`);
      if (r.resolveDir !== undefined) m.resolveDir = r.resolveDir;
      const loader = r.loader ?? fallback;
      if (r.exports !== undefined && r.contents === undefined) {
        // (An object's properties as a module's exports.)
        const names = Object.keys(r.exports);
        const lines = names.map((n, i) => `const __e${i} = ${JSON.stringify(r.exports![n])};`);
        const exp = names.map((n, i) => `__e${i} as ${JSON.stringify(n)}`).join(", ");
        return { contents: `${lines.join("\n")}\nexport { ${exp} };\nexport default ${JSON.stringify(r.exports)};\n`, loader: "js" };
      }
      return this.contents(m, contentsText(r.contents), loader);
    }
    const virtual = this.virtual.get(m.path);
    if (virtual !== undefined && m.namespace === "virtual") {
      const r = await virtual();
      return this.contents(m, contentsText(r.contents), r.loader ?? "js");
    }
    if (m.namespace !== "file") return { error: `Do not know how to load path: ${m.namespace}:${m.path}` };
    switch (fallback) {
      case "js":
      case "jsx":
      case "ts":
      case "tsx":
      case "json":
        return { default: true };
    }
    return this.contents(m, undefined, fallback);
  }

  /** The answer for contents of a loader (the file's if undefined). */
  contents(m: ModuleInfo, text: string | undefined, loader: Loader): { contents?: string; loader?: string; error?: string } {
    const read = () => (text !== undefined ? text : (readFile(m.path, true) as string));
    switch (loader) {
      case "js":
      case "jsx":
      case "ts":
      case "tsx":
      case "json":
      case "text":
        return { contents: read(), loader };
      case "jsonc":
        return { contents: JSON.stringify(parseJsonc(read())), loader: "json" };
      case "file": {
        // (Copied next to the bundle; the module is its path there.)
        const bytes = text !== undefined ? new TextEncoder().encode(text) : new Uint8Array(readFile(m.path, false) as ArrayBuffer);
        const name = this.assetName(m.path, bytes);
        this.assets.push({ name, bytes });
        const url = (this.config.publicPath ?? "./") + name;
        return { contents: `export default ${JSON.stringify(url)};`, loader: "js" };
      }
    }
    return { error: `No loader is configured for "${extname(m.path) || m.path}" files: ${m.path}` };
  }

  assets: { name: string; bytes: Uint8Array }[] = [];

  assetName(path: string, bytes: Uint8Array): string {
    const naming = typeof this.config.naming === "object" ? this.config.naming.asset : undefined;
    const ext = extname(path);
    return applyNaming(naming ?? "[name]-[hash].[ext]", {
      dir: "",
      name: basename(path, ext),
      ext: ext.slice(1),
      hash: hashOf(binaryString(bytes)),
    });
  }

  /** Bundle entry point `entry` (its id): the code, or a message. */
  async bundle(entryId: string): Promise<{ code?: string; error?: string; warnings: string[] }> {
    const minify = this.config.minify;
    const handle = buildStart(
      JSON.stringify({
        entry: entryId,
        root: this.root,
        define: this.config.define ?? {},
        minify: minify === true ? { whitespace: true, syntax: true, identifiers: true } : minify || {},
      }),
    ) as number;
    let answer: string | null = null;
    try {
      for (;;) {
        const req = JSON.parse(buildNext(handle, answer) as string);
        let a: unknown;
        try {
          if (req.op === "resolve") {
            a = await this.resolve(req.spec, req.from, req.dynamic ? "dynamic-import" : "import-statement");
          } else if (req.op === "load") {
            a = await this.load(req.path);
          } else if (req.op === "done") {
            return { code: req.code, warnings: req.warnings ?? [] };
          } else {
            return { error: req.message, warnings: [] };
          }
        } catch (e) {
          // (A plugin threw: the build fails with its error.)
          a = { error: e instanceof Error ? e.message : String(e) };
        }
        answer = JSON.stringify(a);
      }
    } finally {
      buildClose(handle);
    }
  }
}

function defaultConditions(target: string): string[] {
  return target === "browser" ? ["browser", "import", "module", "default"] : target === "node" ? ["node", "import", "module", "default"] : ["bun", "node", "import", "module", "default"];
}

function contentsText(c: OnLoadResult["contents"]): string | undefined {
  if (c === undefined || typeof c === "string") return c;
  if (c instanceof ArrayBuffer) return new TextDecoder().decode(c);
  if (ArrayBuffer.isView(c)) return new TextDecoder().decode(c);
  return String(c);
}

/** JSON with comments and trailing commas. */
function parseJsonc(text: string): unknown {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2);
      i = i < 0 ? text.length : i + 2;
    } else {
      out += c;
      i++;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

/** `naming`'s template with [dir], [name], [ext] and [hash] filled. */
function applyNaming(template: string, parts: { dir: string; name: string; ext: string; hash: string }): string {
  const s = template
    .replace(/\[dir\]/g, parts.dir)
    .replace(/\[name\]/g, parts.name)
    .replace(/\[ext\]/g, parts.ext)
    .replace(/\[hash\]/g, parts.hash);
  return s.replace(/^\.?\/+/, "").replace(/\/\/+/g, "/");
}

/** A bundler error with its position (`file:line: message`, the line of
 * the specifier it is about), as BuildMessage's (Bun's: the specifier's
 * column after its quote, the quoted specifier's length). */
function messageOf(text: string): BuildMessage {
  const m = /^(\/[^:\n]*|[\w-]+:[^:\n]*):(\d+): ([\s\S]*)$/.exec(text);
  if (m === null) return new BuildMessage(text);
  const [, file, line, message] = m;
  let lineText = "";
  let lineStart = 0;
  try {
    const lines = (readFile(file, true) as string).split("\n");
    lineText = lines[Number(line) - 1] ?? "";
    for (let i = 0; i < Number(line) - 1; i++) lineStart += lines[i].length + 1;
  } catch {}
  const spec = /"((?:[^"\\]|\\.)*)"/.exec(message)?.[1];
  let column = 0;
  let length = 0;
  if (spec !== undefined) {
    for (const q of ['"', "'", "`"]) {
      const at = lineText.indexOf(q + spec + q);
      if (at >= 0) {
        column = at + 1;
        length = spec.length + 2;
        break;
      }
    }
  }
  const position = {
    lineText,
    file,
    namespace: file.startsWith("/") ? "file" : file.slice(0, file.indexOf(":")),
    line: Number(line),
    column,
    length,
    offset: lineStart + Math.max(column - 1, 0),
  };
  if (spec !== undefined && message.startsWith("Could not resolve: ")) {
    const dynamic = /\bimport\s*\(\s*$/.test(lineText.slice(0, Math.max(column - 1, 0)));
    return new ResolveMessage(message, spec, dynamic ? "dynamic-import" : "import-statement", position);
  }
  return new BuildMessage(message, "error", position);
}

class PluginBuilder {
  #build: Build;
  #plugin: string;
  config: BuildConfig;
  constructor(build: Build, plugin: string) {
    this.#build = build;
    this.#plugin = plugin;
    this.config = build.config;
    // (Own properties, as Bun's.)
    const self = this as any;
    for (const k of ["addPreload", "module", "onBeforeParse", "onDispose", "onEnd", "onLoad", "onResolve", "onStart", "resolve"]) {
      self[k] = self[k].bind(this);
    }
    self.esbuild = undefined;
    self.initialOptions = build.config;
  }
  onStart(callback: () => unknown): this {
    this.#build.starts.push(callback);
    return this;
  }
  onEnd(callback: (result: BuildOutput) => unknown): this {
    this.#build.ends.push(callback);
    return this;
  }
  onResolve(options: { filter: RegExp; namespace?: string }, callback: Callback<OnResolveArgs, OnResolveResult>): this {
    if (!(options?.filter instanceof RegExp)) throw new TypeError("onResolve() expects a filter RegExp");
    this.#build.resolvers.push({ filter: options.filter, namespace: options.namespace, callback, plugin: this.#plugin });
    return this;
  }
  onLoad(options: { filter: RegExp; namespace?: string }, callback: Callback<OnLoadArgs, OnLoadResult>): this {
    if (!(options?.filter instanceof RegExp)) throw new TypeError("onLoad() expects a filter RegExp");
    this.#build.loaders.push({ filter: options.filter, namespace: options.namespace, callback, plugin: this.#plugin });
    return this;
  }
  onBeforeParse(): this {
    throw new Error("onBeforeParse() (native plugins) is not supported by Beyond");
  }
  onDispose(_callback: () => unknown): this {
    return this;
  }
  /** A virtual module: `specifier` is the module `callback` gives. */
  module(specifier: string, callback: () => OnLoadResult | Promise<OnLoadResult>): this {
    this.#build.virtual.set(specifier, callback);
    const filter = new RegExp("^" + specifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$");
    this.#build.resolvers.unshift({ filter, callback: () => ({ path: specifier, namespace: "virtual" }), plugin: this.#plugin });
    return this;
  }
  /** Resolve as the build would (without the plugins). */
  async resolve(specifier: string, options?: { importer?: string; kind?: OnResolveArgs["kind"] }): Promise<{ path: string; namespace: string; external: boolean }> {
    const importer = options?.importer ?? "";
    const r = await this.#build.resolve(specifier, importer && this.#build.idOf(importer, "file"), options?.kind ?? "import-statement");
    if (r.error !== undefined) throw new Error(r.error);
    if (r.external !== undefined) return { path: r.external, namespace: "file", external: true };
    const m = this.#build.info(r.path!);
    return { path: m.path, namespace: m.namespace, external: false };
  }
  addPreload(): this {
    return this;
  }
}

/** Beyond.build(config): Bun.build. */
export async function build(config: BuildConfig): Promise<BuildOutput> {
  if (config === null || typeof config !== "object") throw new TypeError("Expected a config object");
  const entries = config.entrypoints;
  if (!Array.isArray(entries) || entries.length === 0) throw new TypeError("Expected entrypoints to be an array of strings");
  const base = cwd() as string;
  const entryPaths = entries.map((e) => resolve(base, String(e)));
  const root = config.root !== undefined ? resolve(base, config.root) : commonDir(entryPaths);
  const b = new Build(config, root);
  const fail = (m: BuildMessage) => b.logs.push(m);
  if (config.format !== undefined && config.format !== "esm") fail(new BuildMessage(`format "${config.format}" is not supported by Beyond yet`));
  if (config.splitting) fail(new BuildMessage("splitting is not supported by Beyond yet"));
  const sm = config.sourcemap;
  if (sm !== undefined && sm !== "none" && sm !== false) b.logs.push(new BuildMessage("sourcemap is not supported by Beyond yet: none was made", "warning"));
  for (const plugin of config.plugins ?? []) {
    if (plugin === null || typeof plugin !== "object" || typeof plugin.setup !== "function") {
      throw new TypeError("Expected plugin to be an object with a setup function");
    }
    await plugin.setup(new PluginBuilder(b, String(plugin.name)));
  }
  for (const s of b.starts) await s();
  const outputs: BuildArtifact[] = [];
  if (!b.logs.some((l) => l.level === "error")) {
    for (let i = 0; i < entries.length; i++) {
      const r = await b.resolve(String(entries[i]).startsWith(".") || isAbsolute(String(entries[i])) ? entryPaths[i] : String(entries[i]), "", "entry-point-build");
      if (r.error !== undefined || r.path === undefined) {
        fail(new BuildMessage(`ModuleNotFound resolving "${entries[i]}" (entry point)`));
        continue;
      }
      const entry = b.info(r.path);
      if (entry.namespace === "file" && stat(entry.path, true, false) === undefined) {
        fail(new BuildMessage(`ModuleNotFound resolving "${entries[i]}" (entry point)`));
        continue;
      }
      const res = await b.bundle(r.path);
      for (const w of res.warnings) b.logs.push(new BuildMessage(w, "warning"));
      if (res.error !== undefined) {
        fail(messageOf(res.error));
        continue;
      }
      let code = res.code!;
      if (config.banner) code = `${config.banner}\n${code}`;
      if (b.target === "bun") code = `// @bun\n${code}`;
      if (config.footer) code = `${code}\n${config.footer}\n`;
      const rel = relative(root, entry.namespace === "file" ? entry.path : join(root, entry.path));
      const ext = extname(rel);
      const naming = typeof config.naming === "string" ? config.naming : config.naming?.entry;
      const name = applyNaming(naming ?? "[dir]/[name].[ext]", {
        dir: dirname(rel) === "." ? "" : dirname(rel),
        name: basename(rel, ext),
        ext: "js",
        hash: hashOf(code),
      });
      const bytes = new TextEncoder().encode(code);
      const loader = entry.namespace === "file" ? (loaderOf(entry.path, config.loader) ?? "js") : "js";
      const path = config.outdir !== undefined ? resolve(base, config.outdir, name) : `./${name}`;
      outputs.push(new BuildArtifact(path, bytes, loader, "entry-point", "text/javascript;charset=utf-8", hashOf(code)));
    }
    for (const a of b.assets) {
      const path = config.outdir !== undefined ? resolve(base, config.outdir, a.name) : `./${a.name}`;
      outputs.push(new BuildArtifact(path, a.bytes, "file", "asset", mimeOf(a.name), null));
    }
  }
  const success = !b.logs.some((l) => l.level === "error");
  if (success && config.outdir !== undefined) {
    for (const o of outputs) {
      mkdirp(dirname(o.path));
      writeFile(o.path, await o.bytes(), false, undefined);
    }
  }
  const result: BuildOutput = { success, outputs: success ? outputs : [], logs: b.logs };
  for (const e of b.ends) await e(result);
  if (!success && config.throw !== false) {
    throw new AggregateError(b.logs.filter((l) => l.level === "error"), "Bundle failed");
  }
  return result;
}

/** Beyond.Transpiler's transformSync (TypeScript and JSX to JavaScript). */
export function transpile(code: string, loader: Loader = "ts", path = "input." + loader): string {
  const r = JSON.parse(buildTranspile(JSON.stringify({ path, source: code, loader })) as string);
  if (r.error !== undefined) throw new SyntaxError(r.error);
  return r.code;
}
