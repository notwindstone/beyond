// How console.log shows values: Bun's formatter (src/jsc/ConsoleObject.rs,
// MIT), its rules ported to TypeScript. Objects are multi-line, arrays one
// line until the line would pass 80 columns (or an element is an object,
// or there are more than 10), strings are quoted inside other values,
// objects deeper than 2 levels are `[Object ...]`.
//
// Beyond's own classes (Headers, Response, ...) print themselves through
// `describe` with the formatter's primitives, as Bun's native classes do.

import { promiseState } from "beyond:native";

/** Node's (and Bun's) hook: `[inspectCustom](depth, options, inspect)`. */
export const inspectCustom = Symbol.for("nodejs.util.inspect.custom");

/** Beyond's classes' hook: `[describe](formatter)` prints the value. */
export const describe = Symbol("beyond.describe");

export interface InspectOptions {
  depth?: number;
  quoteStrings?: boolean;
  singleLine?: boolean;
}

const T_UNDEFINED = 0;
const T_NULL = 1;
const T_INTEGER = 2;
const T_DOUBLE = 3;
const T_BOOLEAN = 4;
const T_STRING = 5;
const T_SYMBOL = 6;
const T_BIGINT = 7;
const T_ARRAY = 8;
const T_OBJECT = 9;
const T_FUNCTION = 10;
const T_CLASS = 11;
const T_ERROR = 12;
const T_TYPED_ARRAY = 13;
const T_MAP = 14;
const T_SET = 15;
const T_DATE = 16;
const T_PROMISE = 17;
const T_REGEXP = 18;
const T_CUSTOM = 19;
const T_DESCRIBED = 20;
const T_GETTER_SETTER = 21;
const T_BOXED = 22;

function isPrimitive(tag: number): boolean {
  return tag <= T_BIGINT;
}

/** Whether a value of this kind may contain itself. */
function canCircle(tag: number): boolean {
  return tag === T_ARRAY || tag === T_OBJECT || tag === T_MAP || tag === T_SET || tag === T_ERROR ||
    tag === T_DESCRIBED;
}

function isClass(f: Function): boolean {
  return Function.prototype.toString.call(f).startsWith("class");
}

/** What kind of value `v` is, for printing. */
function tagOf(v: unknown): number {
  switch (typeof v) {
    case "undefined":
      return T_UNDEFINED;
    case "number":
      return (v as number) === ((v as number) | 0) && !Object.is(v, -0) ? T_INTEGER : T_DOUBLE;
    case "boolean":
      return T_BOOLEAN;
    case "string":
      return T_STRING;
    case "symbol":
      return T_SYMBOL;
    case "bigint":
      return T_BIGINT;
    case "function":
      if (typeof (v as any)[inspectCustom] === "function") return T_CUSTOM;
      return isClass(v as Function) ? T_CLASS : T_FUNCTION;
  }
  if (v === null) return T_NULL;
  const o = v as any;
  if (typeof o[describe] === "function") return T_DESCRIBED;
  if (typeof o[inspectCustom] === "function") return T_CUSTOM;
  if (Array.isArray(o)) return T_ARRAY;
  if (o instanceof Error) return T_ERROR;
  if (ArrayBuffer.isView(o) || o instanceof ArrayBuffer) return T_TYPED_ARRAY;
  if (o instanceof Map || o instanceof WeakMap) return T_MAP;
  if (o instanceof Set || o instanceof WeakSet) return T_SET;
  if (o instanceof Date) return T_DATE;
  if (o instanceof RegExp) return T_REGEXP;
  if (promiseState(o) >= 0) return T_PROMISE;
  if (o instanceof Number || o instanceof String || o instanceof Boolean) return T_BOXED;
  return T_OBJECT;
}

const IDENTIFIER = /^[A-Za-z_$ªµºÀ-ÖØ-öø-ÿ][\w$ªµºÀ-ÖØ-öø-ÿ]*$/;

/** A double as Bun writes it: as JavaScript does, but -0. */
function double(n: number): string {
  return Object.is(n, -0) ? "-0" : String(n);
}

/** The class name an object prints with (none for plain objects). */
function objectName(o: object): string | null {
  const proto = Object.getPrototypeOf(o);
  if (proto === null) return "[Object: null prototype]";
  if (proto === Object.prototype) {
    const tag = (o as any)[Symbol.toStringTag];
    if (typeof tag === "string" && tag !== "") return tag;
  }
  const ctor = proto.constructor;
  let name = typeof ctor === "function" ? ctor.name : "";
  if (typeof name !== "string" || name === "") {
    const tag = (o as any)[Symbol.toStringTag];
    name = typeof tag === "string" ? tag : "";
  }
  return name === "" || name === "Object" ? null : name;
}

export class Formatter {
  out = "";
  indent = 0;
  depth = 0;
  maxDepth = 2;
  quoteStrings = false;
  singleLine = false;
  // The estimated length of the current line (Bun's
  // `estimated_line_length`): past 80 is a good time for a new line.
  line = 0;
  // The objects being printed (around the value being printed).
  seen: object[] = [];

  write(s: string): void {
    this.out += s;
  }

  /** Whether a value printed now is past the depth (shown as `[Name ...]`). */
  tooDeep(): boolean {
    return this.depth > this.maxDepth;
  }

  add(n: number): void {
    this.line += n;
  }

  resetLine(): void {
    this.line = this.indent * 2;
  }

  goodTimeForNewLine(): boolean {
    if (this.line > 80) {
      this.resetLine();
      return true;
    }
    return false;
  }

  writeIndent(): void {
    this.out += "  ".repeat(this.indent);
  }

  comma(): void {
    this.out += ",";
    this.line += 1;
  }

  space(): void {
    this.out += " ";
    this.line += 1;
  }

  /** Prints `v`. */
  format(v: unknown): void {
    const tag = tagOf(v);
    if (canCircle(tag)) {
      if (this.seen.includes(v as object)) {
        this.write("[Circular]");
        return;
      }
      this.seen.push(v as object);
      try {
        this.formatTag(tag, v);
      } finally {
        this.seen.pop();
      }
      return;
    }
    this.formatTag(tag, v);
  }

  formatTag(tag: number, v: unknown): void {
    switch (tag) {
      case T_UNDEFINED:
        this.add(9);
        this.write("undefined");
        return;
      case T_NULL:
        this.add(4);
        this.write("null");
        return;
      case T_INTEGER: {
        const s = String(v);
        this.add(s.length);
        this.write(s);
        return;
      }
      case T_DOUBLE: {
        const s = double(v as number);
        this.add(s.length);
        this.write(s);
        return;
      }
      case T_BOOLEAN:
        this.add(v ? 4 : 5);
        this.write(v ? "true" : "false");
        return;
      case T_STRING:
        return this.string(v as string);
      case T_SYMBOL: {
        const d = (v as symbol).description;
        const s = d === undefined || d === "" ? "Symbol()" : `Symbol(${d})`;
        this.add(s.length);
        this.write(s);
        return;
      }
      case T_BIGINT: {
        const s = `${v}n`;
        this.add(s.length);
        this.write(s);
        return;
      }
      case T_ARRAY:
        return this.array(v as unknown[]);
      case T_OBJECT:
        return this.object(v as object);
      case T_FUNCTION:
        return this.func(v as Function);
      case T_CLASS:
        return this.klass(v as Function);
      case T_ERROR:
        return this.error(v as Error);
      case T_TYPED_ARRAY:
        return this.typedArray(v as ArrayBufferView | ArrayBuffer);
      case T_MAP:
        return this.map(v as Map<unknown, unknown>);
      case T_SET:
        return this.set(v as Set<unknown>);
      case T_DATE: {
        const d = v as Date;
        const s = Number.isNaN(d.getTime()) ? "Invalid Date" : d.toISOString();
        this.add(s.length);
        this.write(s);
        return;
      }
      case T_PROMISE: {
        if (!this.singleLine && this.goodTimeForNewLine()) {
          this.write("\n");
          this.writeIndent();
        }
        const state = promiseState(v);
        this.write(`Promise { ${state === 0 ? "<pending>" : state === 1 ? "<resolved>" : "<rejected>"} }`);
        return;
      }
      case T_REGEXP: {
        const s = String(v);
        this.add(s.length);
        this.write(s);
        return;
      }
      case T_BOXED: {
        const o = v as any;
        // (A String inside a value is shown as its string, as Bun's.)
        if (o instanceof String && this.quoteStrings) return this.string(String(o));
        const name = o instanceof Number ? "Number" : o instanceof String ? "String" : "Boolean";
        const inner = name === "String" ? JSON.stringify(String(o)) : name === "Number" ? double(Number(o)) : String(o.valueOf());
        const s = `[${name}: ${inner}]`;
        this.add(s.length);
        this.write(s);
        return;
      }
      case T_CUSTOM:
        return this.custom(v as object);
      case T_DESCRIBED:
        (v as any)[describe](this);
        return;
    }
  }

  /** A string: as it is at the top level, quoted in other values. */
  string(s: string): void {
    this.add(s.length);
    if (!this.quoteStrings) {
      this.write(s);
    } else {
      this.write(JSON.stringify(s));
    }
  }

  func(f: Function): void {
    const printable = typeof f.name === "string" ? f.name : "";
    const proto = Object.getPrototypeOf(f);
    let kind = proto?.constructor?.name;
    if (typeof kind !== "string" || kind === "Function") kind = "";
    let s: string;
    if (printable === "" || kind === printable) s = kind === "" ? "[Function]" : `[${kind}]`;
    else s = kind === "" ? `[Function: ${printable}]` : `[${kind}: ${printable}]`;
    this.write(s);
  }

  klass(c: Function): void {
    const name = c.name;
    const proto = Object.getPrototypeOf(c);
    const base = typeof proto === "function" && proto !== Function.prototype ? proto.name : "";
    this.add(name.length + base.length);
    if (name === "") this.write(base === "" ? "[class (anonymous)]" : `[class (anonymous) extends ${base}]`);
    else this.write(base === "" ? `[class ${name}]` : `[class ${name} extends ${base}]`);
  }

  error(e: Error): void {
    let name = "Error";
    let message = "";
    try {
      name = String(e.name);
      message = String(e.message);
    } catch {}
    let out = message === "" ? name : `${name}: ${message}`;
    const stack = typeof e.stack === "string" ? e.stack : "";
    for (const line of stack.split("\n")) {
      const t = line.trim();
      if (t.startsWith("at ")) out += `\n${"  ".repeat(this.indent)}      ${t}`;
    }
    this.write(out);
  }

  custom(o: object): void {
    const fn = (o as any)[inspectCustom];
    const result = fn.call(o, this.maxDepth - this.depth, { depth: this.maxDepth - this.depth }, inspect);
    if (typeof result === "string") {
      this.write(result);
    } else if (result === o) {
      // (Itself: printed as an object, without the hook.)
      this.object(o);
    } else {
      this.format(result);
    }
  }

  // ---- Arrays ----

  array(a: unknown[]): void {
    const len = a.length;
    if (len === 0) {
      this.write("[]");
      this.add(2);
      return;
    }
    // (As Bun 1.4.3's: past the depth, as objects are.)
    if (this.depth > this.maxDepth) {
      this.write("[Array ...]");
      this.add(11);
      return;
    }
    // (Heuristic: more than 10, probably should have a newline before it.)
    let wasGoodTime = len > 10;
    const prevQuote = this.quoteStrings;
    this.indent++;
    this.depth++;
    this.add(2);
    this.quoteStrings = true;
    let emptyStart = -1;
    {
      const has = 0 in a;
      const tag = has ? tagOf(a[0]) : T_UNDEFINED;
      // (A String object is shown as its string.)
      const primitive = isPrimitive(tag) || (tag === T_BOXED && a[0] instanceof String);
      wasGoodTime = wasGoodTime || (has && !primitive) || this.goodTimeForNewLine();
      if (!this.singleLine && wasGoodTime) {
        this.resetLine();
        this.write("[\n");
        this.writeIndent();
        this.add(1);
      } else {
        this.write("[ ");
        this.add(2);
      }
      if (!has) emptyStart = 0;
      else this.format(a[0]);
    }
    let nonempty = 1;
    let i = 1;
    for (; i < len; i++) {
      if (!(i in a)) {
        if (emptyStart < 0) emptyStart = i;
        continue;
      }
      if (nonempty >= 100) {
        this.comma();
        this.write("\n");
        this.line = 0;
        this.writeIndent();
        this.write(`... ${len - i} more items`);
        this.add(16);
        break;
      }
      nonempty++;
      if (emptyStart >= 0) {
        this.empties(emptyStart, i - emptyStart, () => (wasGoodTime = true));
        emptyStart = -1;
      }
      this.comma();
      if (!this.singleLine && this.goodTimeForNewLine()) {
        this.write("\n");
        wasGoodTime = true;
        this.writeIndent();
      } else {
        this.space();
      }
      this.format(a[i]);
    }
    if (emptyStart >= 0) this.empties(emptyStart, len - emptyStart, () => (wasGoodTime = true));
    // The array's other properties.
    const keys = Object.keys(a).filter((k) => !(String(Number(k) >>> 0) === k && Number(k) < len));
    if (keys.length > 0) {
      for (const k of keys) {
        this.comma();
        if (!this.singleLine && this.goodTimeForNewLine()) {
          this.write("\n");
          this.writeIndent();
          wasGoodTime = true;
        } else {
          this.space();
        }
        this.key(k);
        this.format((a as any)[k]);
      }
    }
    this.indent--;
    this.depth--;
    this.quoteStrings = prevQuote;
    // (Bun 1.4 breaks the line before the bracket only if it broke one
    // inside.)
    if (!this.singleLine && wasGoodTime) {
      this.resetLine();
      this.write("\n");
      this.writeIndent();
      this.write("]");
      this.resetLine();
      this.add(1);
    } else {
      this.write(" ]");
      this.add(2);
    }
  }

  /** `count` holes from `start` (after an element if `start` > 0). */
  empties(start: number, count: number, newline: () => void): void {
    if (start > 0) {
      this.comma();
      if (!this.singleLine && this.goodTimeForNewLine()) {
        newline();
        this.write("\n");
        this.writeIndent();
      } else {
        this.space();
      }
    }
    if (count === 1) {
      this.add(10);
      this.write("empty item");
    } else {
      const s = `${count} x empty items`;
      this.add(s.length);
      this.write(s);
    }
  }

  // ---- Objects ----

  /** A property key, then ": ". */
  key(k: string | symbol): void {
    if (typeof k === "symbol") {
      const s = `[Symbol(${k.description ?? ""})]: `;
      this.add(1 + 11 + (k.description ?? "").length);
      this.write(s);
    } else if (IDENTIFIER.test(k)) {
      this.add(k.length + 1);
      this.write(`${k}: `);
    } else {
      this.add(k.length + 2);
      this.write(`${JSON.stringify(k)}: `);
    }
  }

  object(o: object): void {
    const prevQuote = this.quoteStrings;
    this.quoteStrings = true;
    let alwaysNewline = !this.singleLine && this.goodTimeForNewLine();
    if (this.depth > this.maxDepth) {
      if (this.singleLine) this.write(" ");
      else if (this.goodTimeForNewLine()) {
        this.write("\n");
        this.writeIndent();
        this.resetLine();
      }
      // (A class's instance too: Bun names only those with a tag.)
      const tag = (o as any)[Symbol.toStringTag];
      this.write(`[${typeof tag === "string" && tag !== "" ? tag : "Object"} ...]`);
      this.quoteStrings = prevQuote;
      return;
    }
    // (A plain object named by its tag does not show it, but alone.)
    const keys = Reflect.ownKeys(o);
    const hideTag = keys.length > 1 && typeof (o as any)[Symbol.toStringTag] === "string";
    let i = 0;
    for (const k of keys) {
      if (hideTag && k === Symbol.toStringTag) continue;
      const d = Object.getOwnPropertyDescriptor(o, k);
      if (d === undefined || !d.enumerable) continue;
      if (i === 0) {
        const name = objectName(o);
        if (name !== null) this.write(`${name} `);
        if (!this.singleLine) alwaysNewline = true;
        this.line = this.indent * 2 + 1;
        this.indent++;
        this.depth++;
        if (this.singleLine) this.write("{ ");
        else {
          this.write("{\n");
          this.writeIndent();
        }
      } else {
        this.comma();
        if (!this.singleLine && (alwaysNewline || this.goodTimeForNewLine())) {
          this.write("\n");
          this.writeIndent();
          this.resetLine();
        } else {
          this.space();
        }
      }
      i++;
      this.key(k);
      if (d.get !== undefined || d.set !== undefined) {
        this.write(d.get !== undefined && d.set !== undefined ? "[Getter/Setter]" : d.get !== undefined ? "[Getter]" : "[Setter]");
      } else {
        this.format(d.value);
      }
    }
    this.quoteStrings = prevQuote;
    if (i === 0) {
      const name = objectName(o);
      if (name !== null) this.write(`${name} `);
      this.write("{}");
      return;
    }
    this.depth--;
    this.indent--;
    if (alwaysNewline) {
      this.comma();
      this.write("\n");
      this.writeIndent();
      this.write("}");
      this.add(1);
    } else {
      this.add(2);
      this.write(" }");
    }
  }

  /**
   * An object of `name` with `entries` (Beyond's classes' `describe`),
   * printed as Bun prints its native classes: one entry a line, keys as
   * given (quoted with `quoteKeys`), then `tail` on a line of its own;
   * `{}` when there is neither.
   */
  record(
    name: string,
    entries: [string, unknown][],
    options?: { quoteKeys?: boolean; tail?: string; lastComma?: boolean; full?: boolean },
  ): void {
    const tail = options?.tail;
    // (`full`: shown whole at any depth, as Bun's Blob, Request, Response.)
    if (this.depth > this.maxDepth && options?.full !== true) {
      this.write(`[${name} ...]`);
      return;
    }
    if (entries.length === 0 && tail === undefined) {
      this.write(`${name} {}`);
      return;
    }
    const prevQuote = this.quoteStrings;
    this.quoteStrings = true;
    this.write(`${name} {\n`);
    this.indent++;
    this.depth++;
    for (let i = 0; i < entries.length; i++) {
      this.resetLine();
      this.writeIndent();
      const [k, v] = entries[i];
      if (options?.quoteKeys) {
        this.add(k.length + 2);
        this.write(`${JSON.stringify(k)}: `);
      } else {
        this.key(k);
      }
      this.format(v);
      if (i < entries.length - 1 || options?.lastComma !== false) this.comma();
      this.write("\n");
    }
    if (tail !== undefined) {
      this.writeIndent();
      this.write(`${tail}\n`);
    }
    this.depth--;
    this.indent--;
    this.quoteStrings = prevQuote;
    this.writeIndent();
    this.write("}");
    this.add(1);
  }

  // ---- Collections ----

  map(m: Map<unknown, unknown>): void {
    const name = m instanceof WeakMap ? "WeakMap" : "Map";
    const size = m instanceof Map ? m.size : 0;
    if (size === 0) {
      this.write(`${name} {}`);
      return;
    }
    if (this.depth > this.maxDepth) {
      this.add(name.length + 6);
      this.write(`[${name} ...]`);
      return;
    }
    const prevQuote = this.quoteStrings;
    this.quoteStrings = true;
    this.write(`${name}(${size}) {\n`);
    this.indent++;
    this.depth++;
    for (const [k, v] of m) {
      this.writeIndent();
      this.format(k);
      this.write(": ");
      this.format(v);
      this.comma();
      this.write("\n");
    }
    this.indent--;
    this.depth--;
    this.quoteStrings = prevQuote;
    this.writeIndent();
    this.write("}");
  }

  set(s: Set<unknown>): void {
    const name = s instanceof WeakSet ? "WeakSet" : "Set";
    const size = s instanceof Set ? s.size : 0;
    if (size === 0) {
      this.write(`${name} {}`);
      return;
    }
    if (this.depth > this.maxDepth) {
      this.add(name.length + 6);
      this.write(`[${name} ...]`);
      return;
    }
    const prevQuote = this.quoteStrings;
    this.quoteStrings = true;
    this.write(`${name}(${size}) {\n`);
    this.indent++;
    this.depth++;
    for (const v of s) {
      this.writeIndent();
      this.format(v);
      this.comma();
      this.write("\n");
    }
    this.indent--;
    this.depth--;
    this.quoteStrings = prevQuote;
    this.writeIndent();
    this.write("}");
  }

  typedArray(v: ArrayBufferView | ArrayBuffer): void {
    let name: string;
    let items: ArrayLike<number | bigint>;
    let length: number;
    if (v instanceof ArrayBuffer) {
      name = "ArrayBuffer";
      items = new Uint8Array(v);
      length = v.byteLength;
    } else if (v instanceof DataView) {
      name = "DataView";
      items = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
      length = v.byteLength;
    } else {
      name = (v as any).constructor?.name ?? "TypedArray";
      items = v as unknown as ArrayLike<number | bigint>;
      length = items.length;
    }
    if (items.length === 0) {
      this.write(`${name}(${length}) []`);
      return;
    }
    const big = typeof items[0] === "bigint";
    const show = Math.min(items.length, 513);
    let s = `${name}(${length}) [ ${big ? `${items[0]}n` : double(items[0] as number)}`;
    for (let i = 1; i < show; i++) s += `, ${big ? `${items[i]}n` : double(items[i] as number)}`;
    if (items.length > 513) s += `, ... ${items.length - 513} more`;
    this.write(s + " ]");
  }
}

/** Formats `v` as console.log shows it inside a message (strings quoted if asked). */
export function inspect(v: unknown, options?: InspectOptions): string {
  const f = new Formatter();
  if (options?.depth !== undefined) f.maxDepth = options.depth === Infinity ? 1e9 : options.depth;
  if (options?.quoteStrings !== undefined) f.quoteStrings = options.quoteStrings;
  if (options?.singleLine !== undefined) f.singleLine = options.singleLine;
  f.format(v);
  return f.out;
}

/** The text of console.log(...args): the first string's % directives filled. */
export function formatArgs(args: unknown[], indent = 0): string {
  const f = new Formatter();
  f.indent = indent;
  f.writeIndent();
  for (let k = 0; k < args.length; k++) {
    if (k > 0) f.write(" ");
    const v = args[k];
    if (typeof v === "string" && k + 1 < args.length && v.indexOf("%") >= 0) {
      k = percent(f, v, args, k + 1) - 1;
    } else {
      f.format(v);
    }
  }
  return f.out;
}

/** Writes `s` with its % directives filled from `args[next..]`: where the arguments resume. */
function percent(f: Formatter, s: string, args: unknown[], next: number): number {
  let start = 0;
  for (let i = 0; i < s.length - 1; i++) {
    if (s.charCodeAt(i) !== 0x25) continue;
    const d = s[i + 1];
    if (d === "%") {
      f.write(s.slice(start, i + 1));
      start = i + 2;
      i++;
      continue;
    }
    if ("sdifoOjc".indexOf(d) < 0 || next >= args.length) continue;
    f.write(s.slice(start, i));
    start = i + 2;
    i++;
    const v = args[next++];
    switch (d) {
      case "s":
        f.write(typeof v === "symbol" ? String(v.description) : typeof v === "string" ? v : stringOf(v));
        break;
      case "d":
      case "i": {
        const n = typeof v === "symbol" ? NaN : Number(v);
        f.write(Number.isFinite(n) ? String(Math.trunc(n)) : "NaN");
        break;
      }
      case "f": {
        const n = typeof v === "symbol" ? NaN : Number(v);
        f.write(double(n));
        break;
      }
      case "o":
      case "O": {
        const q = f.quoteStrings;
        f.quoteStrings = true;
        f.format(v);
        f.quoteStrings = q;
        break;
      }
      case "j":
        f.write(String(JSON.stringify(v)));
        break;
      case "c":
        break;
    }
  }
  f.write(s.slice(start));
  return next;
}

function stringOf(v: unknown): string {
  try {
    return String(v);
  } catch {
    return Object.prototype.toString.call(v);
  }
}
