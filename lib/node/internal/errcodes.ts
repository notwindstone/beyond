// Node's error codes, made as Bun makes them: a function for each code of
// Bun's table (src/jsc/bindings/ErrorCode.ts), named as Bun's JavaScript
// calls it, `$` and the code (`$ERR_OUT_OF_RANGE`, `$ABORT_ERR`), and
// `$<code>_<Constructor>` for the table's other constructors
// (`$ERR_INVALID_STATE_TypeError`). Each takes the arguments Bun's
// `$ERR_X(...)` takes and builds the message as Bun's C++ does (ErrorCode.cpp:
// `jsFunctionMakeErrorWithCode`, its `simpleErrorMessages` table and the
// helpers they call); a code with no message of its own takes the message as
// its first argument (`${message}`, as Bun's `toWTFString`: `undefined` when
// there is none).
//
// The errors are Node's: an instance of the table's constructor, named as the
// table names it (`AbortError`), with an own `code`, and a `toString()` that
// gives `${name} [${code}]: ${message}`.
//
// This module imports nothing (lib/node's modules get these functions through
// node:internal/intrinsics, and validators use them), so it describes values
// itself, as Bun's C++ does: `determineSpecificType` ("type string ('x')",
// "an instance of Foo"), `JSValueToStringSafe` (`inspectValue` here) and the
// one-line `Bun.inspect` it falls back to for objects.

export type NodeError = Error & { code: string };
export type NodeTypeError = TypeError & { code: string };
export type NodeRangeError = RangeError & { code: string };
export type NodeSyntaxError = SyntaxError & { code: string };
export type NodeURIError = URIError & { code: string };

const ArrayIsArray = Array.isArray;

// ---- The errors ----

/** Node's (and Bun's) `toString` of its errors. */
function nodeErrorToString(this: any): string {
  return `${this.name} [${this.code}]: ${this.message}`;
}

const toStringDescriptor: PropertyDescriptor = {
  value: nodeErrorToString,
  writable: true,
  enumerable: false,
  configurable: true,
};

/** `e` with its own `code` (as Node's, enumerable) and Node's `toString`. */
function withCode(e: any, code: string): any {
  e.code = code;
  Object.defineProperty(e, "toString", toStringDescriptor);
  return e;
}

/** `e` named `name`: the table's name where it is not its constructor's (`AbortError`). */
function withName(e: any, name: string): any {
  Object.defineProperty(e, "name", { value: name, writable: true, enumerable: false, configurable: true });
  return e;
}

/** An `Error` with `code` and `message`, as the codes' functions make. */
export function codedError(code: string, message: string): NodeError {
  return withCode(new Error(message), code);
}

/** A `TypeError` with `code` and `message`. */
export function codedTypeError(code: string, message: string): NodeTypeError {
  return withCode(new TypeError(message), code);
}

/** A `RangeError` with `code` and `message`. */
export function codedRangeError(code: string, message: string): NodeRangeError {
  return withCode(new RangeError(message), code);
}

/** A `SyntaxError` with `code` and `message`. */
export function codedSyntaxError(code: string, message: string): NodeSyntaxError {
  return withCode(new SyntaxError(message), code);
}

/** A `URIError` with `code` and `message`. */
export function codedURIError(code: string, message: string): NodeURIError {
  return withCode(new URIError(message), code);
}

// ---- Values in messages ----

/**
 * A function's name as Bun's `Zig::functionName` finds it: its own `name`
 * when that is a string ("" for an anonymous one).
 */
function functionName(fn: unknown): string {
  const d = Object.getOwnPropertyDescriptor(fn, "name");
  return d !== undefined && typeof d.value === "string" ? d.value : "";
}

/**
 * Bun's `determineSpecificType` (Node's, with Bun's differences: `-0` is
 * `type number (0)`, and a string is cut and quoted as below): what
 * ERR_INVALID_ARG_TYPE and ERR_INVALID_RETURN_VALUE say they received.
 */
export function determineSpecificType(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  switch (typeof value) {
    case "number":
      if (value !== value) return "type number (NaN)";
      if (value === Infinity) return "type number (Infinity)";
      if (value === -Infinity) return "type number (-Infinity)";
      return `type number (${value})`;
    case "boolean":
      return value ? "type boolean (true)" : "type boolean (false)";
    case "bigint":
      return `type bigint (${value}n)`;
    case "symbol":
      return `type symbol (${String(value)})`;
    case "function":
      return `function ${functionName(value)}`;
    case "string": {
      // (More than 28 characters: the first 25 and "...". Quoted in single
      // quotes, or, when the string has one, in double quotes escaping only
      // double quotes.)
      const s = value as string;
      const view = s.length > 28 ? `${s.slice(0, 25)}...` : s;
      if (s.indexOf("'") === -1) return `type string ('${view}')`;
      return `type string ("${view.split('"').join('\\"')}")`;
    }
  }
  const ctor = (value as any).constructor;
  if (ctor) return `an instance of ${ctor.name}`;
  return inspectValue(value, false);
}

/**
 * Bun's `JSValueToStringSafe`: a value as its string, a function as
 * `[Function: name]`, an object as one-line `Bun.inspect` shows it; with
 * `quotes`, a string quoted as Node's `util.inspect` quotes it (what
 * ERR_INVALID_ARG_VALUE says it received).
 */
export function inspectValue(value: unknown, quotes: boolean): string {
  switch (typeof value) {
    case "string":
      return quotes ? quoteString(value as string) : (value as string);
    case "number":
      return `${value}`;
    case "undefined":
      return "undefined";
    case "boolean":
      return value ? "true" : "false";
    case "bigint":
      return `${value}n`;
    case "symbol": {
      const d = (value as symbol).description;
      return d === undefined || d === "" ? "symbol" : String(value);
    }
    case "function": {
      const name = functionName(value);
      return name === "" ? "[Function (anonymous)]" : `[Function: ${name}]`;
    }
  }
  if (value === null) return "null";
  return formatValue(value, [], 0);
}

const HEX = "0123456789abcdef";

/**
 * `s` in single quotes (in double quotes if it has a single quote), with
 * `\b \t \n \f \r \\`, the quote and the other C0 and C1 controls escaped,
 * as Node's `util.inspect` (and Bun's `appendEscapedQuotedChar`) do.
 */
function quoteString(s: string): string {
  const quote = s.indexOf("'") === -1 ? 39 : 34;
  const q = quote === 39 ? "'" : '"';
  let out = q;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let esc: string;
    if (c === 8) esc = "\\b";
    else if (c === 9) esc = "\\t";
    else if (c === 10) esc = "\\n";
    else if (c === 12) esc = "\\f";
    else if (c === 13) esc = "\\r";
    else if (c === 92) esc = "\\\\";
    else if (c === quote) esc = `\\${q}`;
    else if (c < 0x20 || (c >= 0x7f && c <= 0x9f)) esc = `\\x${HEX[c >> 4]}${HEX[c & 15]}`;
    else continue;
    out += s.slice(start, i) + esc;
    start = i + 1;
  }
  return out + s.slice(start) + q;
}

/** Node's `addNumericalSeparator`: digits grouped in threes ("4_294_967_297"). */
function addNumericalSeparator(val: string): string {
  let res = "";
  let i = val.length;
  const start = val.charCodeAt(0) === 45 ? 1 : 0;
  for (; i >= start + 4; i -= 3) res = `_${val.slice(i - 3, i)}${res}`;
  return `${val.slice(0, i)}${res}`;
}

/**
 * What ERR_OUT_OF_RANGE says it received (Bun's `appendOutOfRangeReceived`):
 * integers and bigints beyond ±2 ** 32 with separators, the rest as
 * `inspectValue` (unquoted).
 */
function outOfRangeReceived(input: unknown): string {
  if (typeof input === "number") {
    if (input % 1 === 0 && (input > 4294967296 || input < -4294967296)) return addNumericalSeparator(`${input}`);
  } else if (typeof input === "bigint") {
    const digits = `${input}`;
    return `${input > 4294967296n || input < -4294967296n ? addNumericalSeparator(digits) : digits}n`;
  }
  return inspectValue(input, false);
}

// ---- One-line Bun.inspect ----
//
// What Bun.inspect shows on one line with strings quoted
// (`Bun__inspect_singleline`, Bun 1.4's): objects whole at any depth, with
// their properties along the prototype chain up to Object.prototype
// (enumerable or not, but `constructor`), accessors as `[Getter]`; arrays to
// 100 elements; strings in double quotes.

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const MapSize = Object.getOwnPropertyDescriptor(Map.prototype, "size")!.get!;
const SetSize = Object.getOwnPropertyDescriptor(Set.prototype, "size")!.get!;
const TypedArrayLength = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), "length")!.get!;
const DatePrototypeGetTime = Date.prototype.getTime;

/** `getter.call(o)`, or -1 when `o` is not of its class. */
function sizeOf(getter: () => number, o: object): number {
  try {
    return getter.call(o);
  } catch {
    return -1;
  }
}

/** `v` inside a value, `depth` containers deep. */
function formatValue(v: unknown, seen: object[], depth: number): string {
  switch (typeof v) {
    case "undefined":
      return "undefined";
    case "boolean":
      return v ? "true" : "false";
    case "number":
      return Object.is(v, -0) ? "-0" : `${v}`;
    case "bigint":
      return `${v}n`;
    case "string":
      return JSON.stringify(v);
    case "symbol":
      return String(v);
    case "function":
      return formatFunction(v as Function);
  }
  if (v === null) return "null";
  const o = v as object;
  if (seen.indexOf(o) !== -1) return "[Circular]";
  seen.push(o);
  const s = formatObject(o, seen, depth);
  seen.pop();
  return s;
}

function formatFunction(f: Function): string {
  if (Function.prototype.toString.call(f).startsWith("class")) {
    const name = functionName(f);
    const proto = Object.getPrototypeOf(f);
    const base = typeof proto === "function" && proto !== Function.prototype ? functionName(proto) : "";
    const extend = base === "" ? "" : ` extends ${base}`;
    return name === "" ? `[class (anonymous)${extend}]` : `[class ${name}${extend}]`;
  }
  const name = functionName(f);
  const proto = Object.getPrototypeOf(f);
  let kind = proto !== null && proto !== undefined ? proto.constructor?.name : undefined;
  if (typeof kind !== "string" || kind === "Function") kind = "";
  if (name === "" || name === kind) return kind === "" ? "[Function]" : `[${kind}]`;
  return kind === "" ? `[Function: ${name}]` : `[${kind}: ${name}]`;
}

/** The name an object prints with ("" for a plain object). */
function objectName(o: object): string {
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
  return name === "Object" ? "" : name;
}

function formatKey(k: string | symbol): string {
  if (typeof k === "symbol") {
    const d = k.description;
    return `[Symbol(${d === undefined ? "" : d})]`;
  }
  return IDENTIFIER.test(k) ? k : JSON.stringify(k);
}

/** A property as `key: value`, from its descriptor. */
function formatProperty(k: string | symbol, d: PropertyDescriptor, seen: object[], depth: number): string {
  if (d.get !== undefined || d.set !== undefined) {
    const kind = d.get !== undefined && d.set !== undefined ? "[Getter/Setter]" : d.get !== undefined ? "[Getter]" : "[Setter]";
    return `${formatKey(k)}: ${kind}`;
  }
  return `${formatKey(k)}: ${formatValue(d.value, seen, depth + 1)}`;
}

function formatObject(o: object, seen: object[], depth: number): string {
  if (ArrayIsArray(o)) return formatArray(o as unknown[], seen, depth);
  if (o instanceof Error) return formatError(o);
  if (ArrayBuffer.isView(o)) return formatView(o);
  if (o instanceof ArrayBuffer || (typeof SharedArrayBuffer === "function" && o instanceof SharedArrayBuffer)) {
    const bytes = new Uint8Array(o as ArrayBuffer);
    return `ArrayBuffer(${bytes.length}) ${formatNumbers(bytes, bytes.length)}`;
  }
  const mapSize = o instanceof Map ? sizeOf(MapSize, o) : -1;
  if (mapSize === 0) return "Map {}";
  if (mapSize > 0) {
    let s = `Map(${mapSize}) {`;
    let i = 0;
    for (const [k, v] of Map.prototype.entries.call(o)) {
      s += `${i++ === 0 ? " " : ", "}${formatValue(k, seen, depth + 1)}: ${formatValue(v, seen, depth + 1)}`;
    }
    return `${s} }`;
  }
  const setSize = o instanceof Set ? sizeOf(SetSize, o) : -1;
  if (setSize === 0) return "Set {}";
  if (setSize > 0) {
    let s = `Set(${setSize}) {`;
    let i = 0;
    for (const v of Set.prototype.values.call(o)) s += `${i++ === 0 ? " " : ", "}${formatValue(v, seen, depth + 1)}`;
    return `${s} }`;
  }
  if (o instanceof WeakMap) return "WeakMap {}";
  if (o instanceof WeakSet) return "WeakSet {}";
  if (o instanceof Date) {
    const date = formatDate(o);
    if (date !== null) return date;
  }
  if (o instanceof RegExp) return RegExp.prototype.toString.call(o);
  if (o instanceof String) return JSON.stringify(String.prototype.valueOf.call(o));
  if (o instanceof Number) return `[Number: ${Number.prototype.valueOf.call(o)}]`;
  if (o instanceof Boolean) return `[Boolean: ${Boolean.prototype.valueOf.call(o)}]`;
  if (o instanceof Promise) return "Promise {}";
  return formatPlain(o, seen, depth);
}

/** A Date as its ISO string (`Invalid Date`), or null for an object that is not a Date. */
function formatDate(o: object): string | null {
  let t: number;
  try {
    t = DatePrototypeGetTime.call(o);
  } catch {
    return null;
  }
  return t !== t ? "Invalid Date" : Date.prototype.toISOString.call(o);
}

/** An object as `Name { key: value, ... }`. */
function formatPlain(o: object, seen: object[], depth: number): string {
  const name = objectName(o);
  const prefix = name === "" ? "" : `${name} `;
  let keys = Reflect.ownKeys(o);
  // (Its own Symbol.toStringTag names it, and is shown only when alone.)
  const hideTag = keys.length > 1 && typeof (o as any)[Symbol.toStringTag] === "string";
  const done: (string | symbol)[] = [];
  let s = "";
  let cur: object | null = o;
  while (cur !== null) {
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      if (k === "constructor") continue;
      if (k === Symbol.toStringTag && (cur !== o || hideTag)) continue;
      if (done.indexOf(k) !== -1) continue;
      done.push(k);
      const d = Reflect.getOwnPropertyDescriptor(cur, k);
      if (d === undefined) continue;
      s += `${s === "" ? "" : ", "}${formatProperty(k, d, seen, depth)}`;
    }
    cur = Object.getPrototypeOf(cur);
    if (cur === Object.prototype) break;
    if (cur !== null) keys = Reflect.ownKeys(cur);
  }
  return s === "" ? `${prefix}{}` : `${prefix}{ ${s} }`;
}

/** An array: holes as `empty item`s, its first 100 elements, then its other properties. */
function formatArray(a: unknown[], seen: object[], depth: number): string {
  const len = a.length;
  if (len === 0) return "[]";
  let s = "[ ";
  let emptyStart = -1;
  if (0 in a) s += formatValue(a[0], seen, depth + 1);
  else emptyStart = 0;
  let nonempty = 1;
  for (let i = 1; i < len; i++) {
    if (!(i in a)) {
      if (emptyStart < 0) emptyStart = i;
      continue;
    }
    if (nonempty >= 100) {
      s += `,\n${"  ".repeat(depth + 1)}... ${len - i} more items`;
      break;
    }
    nonempty++;
    if (emptyStart >= 0) {
      s += formatEmpties(emptyStart, i - emptyStart);
      emptyStart = -1;
    }
    s += `, ${formatValue(a[i], seen, depth + 1)}`;
  }
  if (emptyStart >= 0) s += formatEmpties(emptyStart, len - emptyStart);
  const keys = Reflect.ownKeys(a);
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    if (k === "length" || (typeof k === "string" && String(Number(k) >>> 0) === k && Number(k) < len)) continue;
    const d = Reflect.getOwnPropertyDescriptor(a, k);
    if (d !== undefined) s += `, ${formatProperty(k, d, seen, depth)}`;
  }
  return `${s} ]`;
}

function formatEmpties(start: number, count: number): string {
  const s = count === 1 ? "empty item" : `${count} x empty items`;
  return start > 0 ? `, ${s}` : s;
}

/** Typed arrays (`Uint8Array(2) [ 1, 2 ]`), Buffers (`<Buffer 01 02>`) and DataViews. */
function formatView(v: ArrayBufferView): string {
  if (v instanceof DataView) {
    const bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    return `DataView(${bytes.length}) ${formatNumbers(bytes, bytes.length)}`;
  }
  const items = v as unknown as ArrayLike<number | bigint>;
  const length = TypedArrayLength.call(v) as number;
  const ctor = (v as any).constructor;
  const name = typeof ctor === "function" && typeof ctor.name === "string" ? ctor.name : "TypedArray";
  if (name === "Buffer") {
    let s = "<Buffer";
    const shown = length < 50 ? length : 50;
    for (let i = 0; i < shown; i++) {
      const b = items[i] as number;
      s += ` ${HEX[b >> 4]}${HEX[b & 15]}`;
    }
    if (length > 50) s += ` ... ${length - 50} more bytes`;
    return `${s}>`;
  }
  return `${name}(${length}) ${formatNumbers(items, length)}`;
}

/** `[ 1, 2, 3 ]`: the first 513 numbers of a typed array or of bytes. */
function formatNumbers(items: ArrayLike<number | bigint>, length: number): string {
  if (length === 0) return "[]";
  const big = typeof items[0] === "bigint";
  const shown = length < 513 ? length : 513;
  let s = "[";
  for (let i = 0; i < shown; i++) s += `${i === 0 ? " " : ", "}${items[i]}${big ? "n" : ""}`;
  if (length > 513) s += `, ... ${length - 513} more`;
  return `${s} ]`;
}

/** An error inside a message: `Name: message` and its stack. */
function formatError(e: Error): string {
  const name = `${e.name}`;
  const message = `${e.message}`;
  let s = message === "" ? name : `${name}: ${message}`;
  const stack = e.stack;
  if (typeof stack === "string" && stack !== "") {
    const lines = stack.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith("at ")) s += `\n    ${line}`;
    }
  }
  return s;
}

// ---- The messages of ERR_INVALID_ARG_TYPE and ERR_INVALID_ARG_VALUE ----

/** `"name" argument` (`"name" property` for a dotted name), or `name` that ends with " argument". */
function parameter(name: string): string {
  if (name.endsWith(" argument")) return name;
  return `"${name}" ${name.indexOf(".") !== -1 ? "property" : "argument"}`;
}

/** `a`, `a or b`, `a, b, or c`. */
function addList(list: string[]): string {
  const n = list.length;
  if (n === 0) return "";
  if (n === 1) return list[0];
  if (n === 2) return `${list[0]} or ${list[1]}`;
  let s = "";
  for (let i = 0; i < n - 1; i++) s += `${list[i]}, `;
  return `${s}or ${list[n - 1]}`;
}

const CLASS_NAME = /^[A-Z][a-zA-Z0-9]*$/;
const UPPER = /[A-Z]/;

function isPrimitiveTypeName(type: string): boolean {
  return (
    type === "string" ||
    type === "function" ||
    type === "number" ||
    type === "object" ||
    type === "Function" ||
    type === "Object" ||
    type === "boolean" ||
    type === "bigint" ||
    type === "symbol"
  );
}

/**
 * ERR_INVALID_ARG_TYPE's message for one expected type, taken as it is
 * written (Bun's): "of type X", or, for a phrase ("Array of unique
 * strings"), "an Array of unique strings".
 */
function invalidArgType(name: string, expected: string, actual: unknown): string {
  let s = `The ${parameter(name)} must be `;
  if (expected.indexOf(" ") !== -1 && expected.indexOf(", ") === -1 && expected.indexOf(" or ") === -1) {
    if (UPPER.test(expected)) s += "an ";
  } else {
    s += "of type ";
  }
  return `${s}${expected}. Received ${determineSpecificType(actual)}`;
}

/**
 * ERR_INVALID_ARG_TYPE's message for a list of expected types, sorted as
 * Node's: primitive types ("of type"), class names ("an instance of"), and
 * the others.
 */
function invalidArgTypeList(name: string, expected: unknown[], actual: unknown): string {
  const types: string[] = [];
  const instances: string[] = [];
  const other: string[] = [];
  for (let i = 0, n = expected.length; i < n; i++) {
    const value = `${expected[i]}`;
    if (isPrimitiveTypeName(value)) types.push(value.toLowerCase());
    else if (CLASS_NAME.test(value)) instances.push(value);
    else other.push(value);
  }
  // (`object` among instances is the instance `Object`.)
  if (instances.length > 0) {
    const pos = types.indexOf("object");
    if (pos !== -1) {
      types.splice(pos, 1);
      instances.push("Object");
    }
  }
  let s = `The ${parameter(name)} must be `;
  if (types.length > 0) {
    s += `${types.length > 1 ? "one of type " : "of type "}${addList(types)}`;
    if (instances.length > 0 || other.length > 0) s += " or ";
  }
  if (instances.length > 0) {
    s += `an instance of ${addList(instances)}`;
    if (other.length > 0) s += " or ";
  }
  if (other.length > 0) {
    if (other.length > 1) s += `one of ${addList(other)}`;
    else s += `${UPPER.test(other[0]) ? "an " : ""}${other[0]}`;
  }
  return `${s}. Received ${determineSpecificType(actual)}`;
}

/** ERR_INVALID_ARG_VALUE's message: `The argument 'name' is invalid. Received 'value'`. */
function invalidArgValue(name: unknown, value: unknown, reason: unknown): string {
  const n = `${name}`;
  const type = n.indexOf(".") !== -1 ? "property" : "argument";
  if (reason === undefined) return `The ${type} '${n}' is invalid. Received ${inspectValue(value, true)}`;
  return `The ${type} '${n}' ${reason}. Received ${inspectValue(value, true)}`;
}

// ---- The codes, in the table's order ----

export function $ABORT_ERR(message?: unknown): NodeError {
  return withName(codedError("ABORT_ERR", `${message}`), "AbortError");
}

export function $ERR_ACCESS_DENIED(message?: unknown): NodeError {
  return codedError("ERR_ACCESS_DENIED", `${message}`);
}

export function $ERR_AMBIGUOUS_ARGUMENT(arg?: unknown, message?: unknown): NodeTypeError {
  return codedTypeError("ERR_AMBIGUOUS_ARGUMENT", `The "${arg}" argument is ambiguous. ${message}`);
}

export function $ERR_ARG_NOT_ITERABLE(message?: unknown): NodeTypeError {
  return codedTypeError("ERR_ARG_NOT_ITERABLE", `${message}`);
}

export function $ERR_ASSERTION(message?: unknown): NodeError {
  return codedError("ERR_ASSERTION", `${message}`);
}

export function $ERR_ASYNC_CALLBACK(name?: unknown): NodeTypeError {
  return codedTypeError("ERR_ASYNC_CALLBACK", `${name} must be a function`);
}

export function $ERR_ASYNC_TYPE(name?: unknown): NodeTypeError {
  return codedTypeError("ERR_ASYNC_TYPE", `Invalid name for async "type": ${name}`);
}

export function $ERR_BODY_ALREADY_USED(message?: unknown): NodeTypeError {
  return codedTypeError("ERR_BODY_ALREADY_USED", `${message}`);
}

export function $ERR_BORINGSSL(message?: unknown): NodeError {
  return codedError("ERR_BORINGSSL", `${message}`);
}

export function $ERR_ZSTD(message?: unknown): NodeError {
  return codedError("ERR_ZSTD", `${message}`);
}

export function $ERR_BROTLI_INVALID_PARAM(p?: unknown): NodeRangeError {
  return codedRangeError("ERR_BROTLI_INVALID_PARAM", `${p} is not a valid Brotli parameter`);
}

/** `"name" is outside of buffer bounds`, or `Attempt to access memory outside buffer bounds`. */
export function $ERR_BUFFER_OUT_OF_BOUNDS(name?: unknown): NodeRangeError {
  if (name !== undefined) return codedRangeError("ERR_BUFFER_OUT_OF_BOUNDS", `"${name}" is outside of buffer bounds`);
  return codedRangeError("ERR_BUFFER_OUT_OF_BOUNDS", "Attempt to access memory outside buffer bounds");
}

export function $ERR_BUFFER_TOO_LARGE(len?: unknown): NodeRangeError {
  return codedRangeError("ERR_BUFFER_TOO_LARGE", `Cannot create a Buffer larger than ${len} bytes`);
}

export function $ERR_CHILD_PROCESS_IPC_REQUIRED(where?: unknown): NodeError {
  return codedError(
    "ERR_CHILD_PROCESS_IPC_REQUIRED",
    `Forked processes must have an IPC channel, missing value 'ipc' in ${where}`,
  );
}

export function $ERR_CHILD_PROCESS_STDIO_MAXBUFFER(message?: unknown): NodeRangeError {
  return codedRangeError("ERR_CHILD_PROCESS_STDIO_MAXBUFFER", `${message} maxBuffer length exceeded`);
}

export function $ERR_CLOSED_MESSAGE_PORT(message?: unknown): NodeError {
  return codedError("ERR_CLOSED_MESSAGE_PORT", `${message}`);
}

export function $ERR_CONSOLE_WRITABLE_STREAM(message?: unknown): NodeTypeError {
  return codedTypeError("ERR_CONSOLE_WRITABLE_STREAM", `${message}`);
}

export function $ERR_CONSTRUCT_CALL_INVALID(message?: unknown): NodeTypeError {
  return codedTypeError("ERR_CONSTRUCT_CALL_INVALID", `${message}`);
}

export function $ERR_CONSTRUCT_CALL_REQUIRED(message?: unknown): NodeTypeError {
  return codedTypeError("ERR_CONSTRUCT_CALL_REQUIRED", `${message}`);
}

export function $ERR_CRYPTO_CUSTOM_ENGINE_NOT_SUPPORTED(message?: unknown): NodeError {
  return codedError("ERR_CRYPTO_CUSTOM_ENGINE_NOT_SUPPORTED", `${message}`);
}

export function $ERR_CRYPTO_ECDH_INVALID_FORMAT(message?: unknown): NodeTypeError {
  return codedTypeError("ERR_CRYPTO_ECDH_INVALID_FORMAT", `${message}`);
}

export function $ERR_CRYPTO_ECDH_INVALID_PUBLIC_KEY(message?: unknown): NodeError {
  return codedError("ERR_CRYPTO_ECDH_INVALID_PUBLIC_KEY", `${message}`);
}

export function $ERR_CRYPTO_HASH_FINALIZED(message?: unknown): NodeError {
  return codedError("ERR_CRYPTO_HASH_FINALIZED", `${message}`);
}

export function $ERR_CRYPTO_HASH_UPDATE_FAILED(message?: unknown): NodeError {
  return codedError("ERR_CRYPTO_HASH_UPDATE_FAILED", `${message}`);
}

export function $ERR_CRYPTO_INCOMPATIBLE_KEY_OPTIONS(message?: unknown): NodeError {
  return codedError("ERR_CRYPTO_INCOMPATIBLE_KEY_OPTIONS", `${message}`);
}

export function $ERR_CRYPTO_INCOMPATIBLE_KEY(arg0?: unknown, arg1?: unknown): NodeError {
  return codedError("ERR_CRYPTO_INCOMPATIBLE_KEY", `Incompatible ${arg0}: ${arg1}`);
}

export function $ERR_CRYPTO_INVALID_AUTH_TAG(message?: unknown): NodeTypeError {
  return codedTypeError("ERR_CRYPTO_INVALID_AUTH_TAG", `${message}`);
}

export function $ERR_CRYPTO_INVALID_CURVE(message?: unknown): NodeTypeError {
  return codedTypeError("ERR_CRYPTO_INVALID_CURVE", `${message}`);
}

export function $ERR_CRYPTO_INVALID_DIGEST(message?: unknown): NodeTypeError {
  return codedTypeError("ERR_CRYPTO_INVALID_DIGEST", `${message}`);
}

export function $ERR_CRYPTO_INVALID_IV(message?: unknown): NodeTypeError {
  return codedTypeError("ERR_CRYPTO_INVALID_IV", `${message}`);
}

export function $ERR_CRYPTO_INVALID_JWK(message?: unknown): NodeTypeError {
  return codedTypeError("ERR_CRYPTO_INVALID_JWK", `${message}`);
}

export function $ERR_CRYPTO_INVALID_KEY_OBJECT_TYPE(arg0?: unknown, arg1?: unknown): NodeTypeError {
  return codedTypeError("ERR_CRYPTO_INVALID_KEY_OBJECT_TYPE", `Invalid key object type ${arg0}, expected ${arg1}.`);
}

export function $ERR_CRYPTO_INVALID_KEYLEN(message?: unknown): NodeRangeError {
  return codedRangeError("ERR_CRYPTO_INVALID_KEYLEN", `${message}`);
}

export function $ERR_CRYPTO_INVALID_KEYPAIR(message?: unknown): NodeRangeError {
  return codedRangeError("ERR_CRYPTO_INVALID_KEYPAIR", `${message}`);
}

export function $ERR_CRYPTO_INVALID_KEYTYPE(message?: unknown): NodeRangeError {
  return codedRangeError("ERR_CRYPTO_INVALID_KEYTYPE", `${message}`);
}

export function $ERR_CRYPTO_INVALID_MESSAGELEN(message?: unknown): NodeRangeError {
  return codedRangeError("ERR_CRYPTO_INVALID_MESSAGELEN", `${message}`);
}

export function $ERR_CRYPTO_INVALID_SCRYPT_PARAMS(message?: unknown): NodeRangeError {
  return codedRangeError("ERR_CRYPTO_INVALID_SCRYPT_PARAMS", `${message}`);
}

export function $ERR_CRYPTO_INVALID_STATE(message?: unknown): NodeError {
  return codedError("ERR_CRYPTO_INVALID_STATE", `${message}`);
}

export function $ERR_CRYPTO_JWK_UNSUPPORTED_CURVE(message?: unknown): NodeError {
  return codedError("ERR_CRYPTO_JWK_UNSUPPORTED_CURVE", `${message}`);
}

export function $ERR_CRYPTO_JWK_UNSUPPORTED_KEY_TYPE(message?: unknown): NodeError {
  return codedError("ERR_CRYPTO_JWK_UNSUPPORTED_KEY_TYPE", `${message}`);
}

export function $ERR_CRYPTO_OPERATION_FAILED(message?: unknown): NodeError {
  return codedError("ERR_CRYPTO_OPERATION_FAILED", `${message}`);
}

export function $ERR_CRYPTO_SIGN_KEY_REQUIRED(message?: unknown): NodeError {
  return codedError("ERR_CRYPTO_SIGN_KEY_REQUIRED", `${message}`);
}

export function $ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH(message?: unknown): NodeRangeError {
  return codedRangeError("ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH", `${message}`);
}

export function $ERR_CRYPTO_UNKNOWN_CIPHER(message?: unknown): NodeError {
  return codedError("ERR_CRYPTO_UNKNOWN_CIPHER", `${message}`);
}

export function $ERR_CRYPTO_UNKNOWN_DH_GROUP(message?: unknown): NodeError {
  return codedError("ERR_CRYPTO_UNKNOWN_DH_GROUP", `${message}`);
}

export function $ERR_CRYPTO_UNSUPPORTED_OPERATION(message?: unknown): NodeError {
  return codedError("ERR_CRYPTO_UNSUPPORTED_OPERATION", `${message}`);
}

export function $ERR_DIR_CLOSED(): NodeError {
  return codedError("ERR_DIR_CLOSED", "Directory handle was closed");
}

export function $ERR_DLOPEN_DISABLED(message?: unknown): NodeError {
  return codedError("ERR_DLOPEN_DISABLED", `${message}`);
}

export function $ERR_DLOPEN_FAILED(message?: unknown): NodeError {
  return codedError("ERR_DLOPEN_FAILED", `${message}`);
}

export function $ERR_DNS_SET_SERVERS_FAILED(message?: unknown): NodeError {
  return codedError("ERR_DNS_SET_SERVERS_FAILED", `${message}`);
}

export function $ERR_ENCODING_INVALID_ENCODED_DATA(message?: unknown): NodeTypeError {
  return codedTypeError("ERR_ENCODING_INVALID_ENCODED_DATA", `${message}`);
}

export function $ERR_ENCODING_NOT_SUPPORTED(message?: unknown): NodeRangeError {
  return codedRangeError("ERR_ENCODING_NOT_SUPPORTED", `${message}`);
}

export function $ERR_EVENT_RECURSION(message?: unknown): NodeError {
  return codedError("ERR_EVENT_RECURSION", `${message}`);
}

export function $ERR_FEATURE_UNAVAILABLE_ON_PLATFORM(message?: unknown): NodeTypeError {
  return codedTypeError("ERR_FEATURE_UNAVAILABLE_ON_PLATFORM", `${message}`);
}

export function $ERR_FORMDATA_PARSE_ERROR(message?: unknown): NodeTypeError {
  return codedTypeError("ERR_FORMDATA_PARSE_ERROR", `${message}`);
}

export function $ERR_FS_CP_DIR_TO_NON_DIR(message?: unknown): NodeError {
  return codedError("ERR_FS_CP_DIR_TO_NON_DIR", `${message}`);
}

export function $ERR_FS_CP_EINVAL(message?: unknown): NodeError {
  return codedError("ERR_FS_CP_EINVAL", `${message}`);
}

export function $ERR_FS_CP_FIFO_PIPE(message?: unknown): NodeError {
  return codedError("ERR_FS_CP_FIFO_PIPE", `${message}`);
}

export function $ERR_FS_CP_NON_DIR_TO_DIR(message?: unknown): NodeError {
  return codedError("ERR_FS_CP_NON_DIR_TO_DIR", `${message}`);
}

export function $ERR_FS_CP_SOCKET(message?: unknown): NodeError {
  return codedError("ERR_FS_CP_SOCKET", `${message}`);
}

export function $ERR_FS_CP_UNKNOWN(message?: unknown): NodeError {
  return codedError("ERR_FS_CP_UNKNOWN", `${message}`);
}

export function $ERR_FS_EISDIR(message?: unknown): NodeError {
  return codedError("ERR_FS_EISDIR", `${message}`);
}

export function $ERR_HTTP_BODY_NOT_ALLOWED(): NodeError {
  return codedError(
    "ERR_HTTP_BODY_NOT_ALLOWED",
    "Adding content for this request method or response status is not allowed.",
  );
}

export function $ERR_HTTP_HEADERS_SENT(action?: unknown): NodeError {
  return codedError("ERR_HTTP_HEADERS_SENT", `Cannot ${action} headers after they are sent to the client`);
}

export function $ERR_HTTP_CONTENT_LENGTH_MISMATCH(actual?: unknown, expected?: unknown): NodeError {
  return codedError(
    "ERR_HTTP_CONTENT_LENGTH_MISMATCH",
    `Response body's content-length of ${actual} byte(s) does not match the content-length of ${expected} byte(s) set in header`,
  );
}

export function $ERR_HTTP_INVALID_HEADER_VALUE(value?: unknown, name?: unknown): NodeTypeError {
  return codedTypeError("ERR_HTTP_INVALID_HEADER_VALUE", `Invalid value "${value}" for header "${name}"`);
}

export function $ERR_HTTP_INVALID_STATUS_CODE(code?: unknown): NodeRangeError {
  return codedRangeError("ERR_HTTP_INVALID_STATUS_CODE", `Invalid status code: ${code}`);
}

export function $ERR_HTTP_REQUEST_TIMEOUT(message?: unknown): NodeError {
  return codedError("ERR_HTTP_REQUEST_TIMEOUT", `${message}`);
}

export function $ERR_HTTP_TRAILER_INVALID(): NodeError {
  return codedError("ERR_HTTP_TRAILER_INVALID", "Trailers are invalid with this transfer encoding");
}

export function $ERR_HTTP_SOCKET_ASSIGNED(): NodeError {
  return codedError("ERR_HTTP_SOCKET_ASSIGNED", "ServerResponse has an already assigned socket");
}

export function $ERR_HTTP2_ALTSVC_INVALID_ORIGIN(): NodeTypeError {
  return codedTypeError("ERR_HTTP2_ALTSVC_INVALID_ORIGIN", "HTTP/2 ALTSVC frames require a valid origin");
}

export function $ERR_HTTP2_ALTSVC_LENGTH(): NodeTypeError {
  return codedTypeError("ERR_HTTP2_ALTSVC_LENGTH", "HTTP/2 ALTSVC frames are limited to 16382 bytes");
}

export function $ERR_HTTP2_CONNECT_AUTHORITY(): NodeError {
  return codedError("ERR_HTTP2_CONNECT_AUTHORITY", ":authority header is required for CONNECT requests");
}

export function $ERR_HTTP2_CONNECT_SCHEME(): NodeError {
  return codedError("ERR_HTTP2_CONNECT_SCHEME", "The :scheme header is forbidden for CONNECT requests");
}

export function $ERR_HTTP2_CONNECT_PATH(): NodeError {
  return codedError("ERR_HTTP2_CONNECT_PATH", "The :path header is forbidden for CONNECT requests");
}

export function $ERR_HTTP2_ERROR(message?: unknown): NodeError {
  return codedError("ERR_HTTP2_ERROR", `${message}`);
}

export function $ERR_HTTP2_HEADER_SINGLE_VALUE(message?: unknown): NodeTypeError {
  return codedTypeError("ERR_HTTP2_HEADER_SINGLE_VALUE", `${message}`);
}

export function $ERR_HTTP2_HEADERS_AFTER_RESPOND(): NodeError {
  return codedError("ERR_HTTP2_HEADERS_AFTER_RESPOND", "Cannot specify additional headers after response initiated");
}

export function $ERR_HTTP2_HEADERS_SENT(): NodeError {
  return codedError("ERR_HTTP2_HEADERS_SENT", "Response has already been initiated.");
}

export function $ERR_HTTP2_INFO_STATUS_NOT_ALLOWED(): NodeRangeError {
  return codedRangeError("ERR_HTTP2_INFO_STATUS_NOT_ALLOWED", "Informational status codes cannot be used");
}

export function $ERR_HTTP2_INVALID_HEADER_VALUE(value?: unknown, name?: unknown): NodeTypeError {
  return codedTypeError("ERR_HTTP2_INVALID_HEADER_VALUE", `Invalid value "${value}" for header "${name}"`);
}

export function $ERR_HTTP2_INVALID_INFO_STATUS(code?: unknown): NodeRangeError {
  return codedRangeError("ERR_HTTP2_INVALID_INFO_STATUS", `Invalid informational status code: ${code}`);
}

export function $ERR_HTTP2_INVALID_ORIGIN(): NodeTypeError {
  return codedTypeError("ERR_HTTP2_INVALID_ORIGIN", "HTTP/2 ORIGIN frames require a valid origin");
}

export function $ERR_HTTP2_INVALID_PSEUDOHEADER(name?: unknown): NodeTypeError {
  return codedTypeError(
    "ERR_HTTP2_INVALID_PSEUDOHEADER",
    `"${name}" is an invalid pseudoheader or is used incorrectly`,
  );
}

export function $ERR_HTTP2_INVALID_SESSION(): NodeError {
  return codedError("ERR_HTTP2_INVALID_SESSION", "The session has been destroyed");
}

export function $ERR_HTTP2_INVALID_STREAM(): NodeError {
  return codedError("ERR_HTTP2_INVALID_STREAM", "The stream has been destroyed");
}

export function $ERR_HTTP2_MAX_PENDING_SETTINGS_ACK(): NodeError {
  return codedError("ERR_HTTP2_MAX_PENDING_SETTINGS_ACK", "Maximum number of pending settings acknowledgements");
}

export function $ERR_HTTP2_NO_SOCKET_MANIPULATION(): NodeError {
  return codedError(
    "ERR_HTTP2_NO_SOCKET_MANIPULATION",
    "HTTP/2 sockets should not be directly manipulated (e.g. read and written)",
  );
}

export function $ERR_HTTP2_ORIGIN_LENGTH(message?: unknown): NodeTypeError {
  return codedTypeError("ERR_HTTP2_ORIGIN_LENGTH", `${message}`);
}

export function $ERR_HTTP2_OUT_OF_STREAMS(): NodeError {
  return codedError("ERR_HTTP2_OUT_OF_STREAMS", "No stream ID is available because maximum stream ID has been reached");
}

export function $ERR_HTTP2_PAYLOAD_FORBIDDEN(status?: unknown): NodeError {
  return codedError("ERR_HTTP2_PAYLOAD_FORBIDDEN", `Responses with ${status} status must not have a payload`);
}

export function $ERR_HTTP2_PING_CANCEL(): NodeError {
  return codedError("ERR_HTTP2_PING_CANCEL", "HTTP2 ping cancelled");
}

export function $ERR_HTTP2_PING_LENGTH(): NodeRangeError {
  return codedRangeError("ERR_HTTP2_PING_LENGTH", "HTTP2 ping payload must be 8 bytes");
}

export function $ERR_HTTP2_PSEUDOHEADER_NOT_ALLOWED(): NodeTypeError {
  return codedTypeError("ERR_HTTP2_PSEUDOHEADER_NOT_ALLOWED", "Cannot set HTTP/2 pseudo-headers");
}

export function $ERR_HTTP2_PUSH_DISABLED(): NodeError {
  return codedError("ERR_HTTP2_PUSH_DISABLED", "HTTP/2 client has disabled push streams");
}

export function $ERR_HTTP2_SEND_FILE_NOSEEK(): NodeError {
  return codedError("ERR_HTTP2_SEND_FILE_NOSEEK", "Offset or length can only be specified for regular files");
}

export function $ERR_HTTP2_SEND_FILE(): NodeError {
  return codedError("ERR_HTTP2_SEND_FILE", "Directories cannot be sent");
}

export function $ERR_HTTP2_SESSION_ERROR(code?: unknown): NodeError {
  return codedError("ERR_HTTP2_SESSION_ERROR", `Session closed with error code ${code}`);
}

export function $ERR_HTTP2_SOCKET_UNBOUND(): NodeError {
  return codedError("ERR_HTTP2_SOCKET_UNBOUND", "The socket has been disconnected from the Http2Session");
}

export function $ERR_HTTP2_STATUS_101(): NodeError {
  return codedError("ERR_HTTP2_STATUS_101", "HTTP status code 101 (Switching Protocols) is forbidden in HTTP/2");
}

export function $ERR_HTTP2_STATUS_INVALID(code?: unknown): NodeRangeError {
  return codedRangeError("ERR_HTTP2_STATUS_INVALID", `Invalid status code: ${code}`);
}

export function $ERR_HTTP2_STREAM_ERROR(code?: unknown): NodeError {
  return codedError("ERR_HTTP2_STREAM_ERROR", `Stream closed with error code ${code}`);
}

export function $ERR_HTTP2_TRAILERS_ALREADY_SENT(): NodeError {
  return codedError("ERR_HTTP2_TRAILERS_ALREADY_SENT", "Trailing headers have already been sent");
}

export function $ERR_HTTP2_TRAILERS_NOT_READY(): NodeError {
  return codedError(
    "ERR_HTTP2_TRAILERS_NOT_READY",
    "Trailing headers cannot be sent until after the wantTrailers event is emitted",
  );
}

export function $ERR_HTTP2_TOO_MANY_CUSTOM_SETTINGS(): NodeError {
  return codedError("ERR_HTTP2_TOO_MANY_CUSTOM_SETTINGS", "Number of custom settings exceeds MAX_ADDITIONAL_SETTINGS");
}

export function $ERR_HTTP2_TOO_MANY_INVALID_FRAMES(): NodeError {
  return codedError("ERR_HTTP2_TOO_MANY_INVALID_FRAMES", "Too many invalid HTTP/2 frames");
}

export function $ERR_HTTP2_UNSUPPORTED_PROTOCOL(message?: unknown): NodeError {
  return codedError("ERR_HTTP2_UNSUPPORTED_PROTOCOL", `${message}`);
}

export function $ERR_HTTP2_INVALID_SETTING_VALUE(message?: unknown): NodeTypeError {
  return codedTypeError("ERR_HTTP2_INVALID_SETTING_VALUE", `${message}`);
}

export function $ERR_HTTP2_INVALID_SETTING_VALUE_RangeError(message?: unknown): NodeRangeError {
  return codedRangeError("ERR_HTTP2_INVALID_SETTING_VALUE", `${message}`);
}

export function $ERR_ILLEGAL_CONSTRUCTOR(): NodeTypeError {
  return codedTypeError("ERR_ILLEGAL_CONSTRUCTOR", "Illegal constructor");
}

export function $ERR_INCOMPATIBLE_OPTION_PAIR(message?: unknown): NodeTypeError {
  return codedTypeError("ERR_INCOMPATIBLE_OPTION_PAIR", `${message}`);
}

/** `Invalid address family: family host:port`, with the error's `host` and `port`. */
export function $ERR_INVALID_ADDRESS_FAMILY(addressType: unknown, host: unknown, port: unknown): NodeRangeError {
  const e: any = codedRangeError("ERR_INVALID_ADDRESS_FAMILY", `Invalid address family: ${addressType} ${host}:${port}`);
  e.host = host;
  e.port = port;
  return e;
}

/**
 * `The "name" argument must be of type string. Received type number (5)`:
 * `expected` is one type, written as it is, or an array of them (Node's
 * sorting into types, instances and the rest).
 */
export function $ERR_INVALID_ARG_TYPE(name: unknown, expected: unknown, actual?: unknown): NodeTypeError {
  const message = ArrayIsArray(expected)
    ? invalidArgTypeList(`${name}`, expected, actual)
    : invalidArgType(`${name}`, `${expected}`, actual);
  return codedTypeError("ERR_INVALID_ARG_TYPE", message);
}

/** `The argument 'name' is invalid. Received 'value'`, or `reason` in place of "is invalid". */
export function $ERR_INVALID_ARG_VALUE(name: unknown, value?: unknown, reason?: unknown): NodeTypeError {
  return codedTypeError("ERR_INVALID_ARG_VALUE", invalidArgValue(name, value, reason));
}

/** ERR_INVALID_ARG_VALUE as a RangeError. */
export function $ERR_INVALID_ARG_VALUE_RangeError(name: unknown, value?: unknown, reason?: unknown): NodeRangeError {
  return codedRangeError("ERR_INVALID_ARG_VALUE", invalidArgValue(name, value, reason));
}

export function $ERR_INVALID_ASYNC_ID(name?: unknown, value?: unknown): NodeRangeError {
  return codedRangeError("ERR_INVALID_ASYNC_ID", `Invalid ${name} value: ${value}`);
}

/** `Invalid character in name`, then ` ["field"]` when there is a field. */
export function $ERR_INVALID_CHAR(name: unknown, field?: unknown): NodeTypeError {
  let message = `Invalid character in ${name}`;
  if (field !== undefined) message += ` ["${field}"]`;
  return codedTypeError("ERR_INVALID_CHAR", message);
}

export function $ERR_INVALID_CURSOR_POS(): NodeTypeError {
  return codedTypeError("ERR_INVALID_CURSOR_POS", "Cannot set cursor row without setting its column");
}

export function $ERR_INVALID_FD_TYPE(type?: unknown): NodeTypeError {
  return codedTypeError("ERR_INVALID_FD_TYPE", `Unsupported fd type: ${type}`);
}

export function $ERR_INVALID_FILE_URL_HOST(message?: unknown): NodeTypeError {
  return codedTypeError("ERR_INVALID_FILE_URL_HOST", `${message}`);
}

export function $ERR_INVALID_FILE_URL_PATH(message?: unknown): NodeTypeError {
  return codedTypeError("ERR_INVALID_FILE_URL_PATH", `${message}`);
}

export function $ERR_INVALID_HANDLE_TYPE(): NodeTypeError {
  return codedTypeError("ERR_INVALID_HANDLE_TYPE", "This handle type cannot be sent");
}

export function $ERR_INVALID_HTTP_TOKEN(name?: unknown, value?: unknown): NodeTypeError {
  return codedTypeError("ERR_INVALID_HTTP_TOKEN", `${name} must be a valid HTTP token ["${value}"]`);
}

export function $ERR_INVALID_IP_ADDRESS(ip?: unknown): NodeTypeError {
  return codedTypeError("ERR_INVALID_IP_ADDRESS", `Invalid IP address: ${ip}`);
}

/** `The MIME syntax for a part in "input" is invalid`, then ` at position` (but -1). */
export function $ERR_INVALID_MIME_SYNTAX(part: unknown, input: unknown, position?: unknown): NodeTypeError {
  const p = `${part}`;
  const i = `${input}`;
  const at = (position as any) | 0;
  let message = `The MIME syntax for a ${p} in "${i}" is invalid`;
  if (at !== -1) message += ` at ${at}`;
  return codedTypeError("ERR_INVALID_MIME_SYNTAX", message);
}

export function $ERR_INVALID_MODULE(message?: unknown): NodeError {
  return codedError("ERR_INVALID_MODULE", `${message}`);
}

export function $ERR_INVALID_OBJECT_DEFINE_PROPERTY(message?: unknown): NodeTypeError {
  return codedTypeError("ERR_INVALID_OBJECT_DEFINE_PROPERTY", `${message}`);
}

export function $ERR_INVALID_PROTOCOL(proto?: unknown, expected?: unknown): NodeTypeError {
  return codedTypeError("ERR_INVALID_PROTOCOL", `Protocol "${proto}" not supported. Expected "${expected}"`);
}

/** `Expected input to be returned from the "name" function but got type number (5).` */
export function $ERR_INVALID_RETURN_VALUE(input: unknown, name: unknown, value?: unknown): NodeTypeError {
  return codedTypeError(
    "ERR_INVALID_RETURN_VALUE",
    `Expected ${input} to be returned from the "${name}" function but got ${determineSpecificType(value)}.`,
  );
}

export function $ERR_INVALID_STATE(message?: unknown): NodeError {
  return codedError("ERR_INVALID_STATE", `Invalid state: ${message}`);
}

export function $ERR_INVALID_STATE_TypeError(message?: unknown): NodeTypeError {
  return codedTypeError("ERR_INVALID_STATE", `Invalid state: ${message}`);
}

export function $ERR_INVALID_STATE_RangeError(message?: unknown): NodeRangeError {
  return codedRangeError("ERR_INVALID_STATE", `Invalid state: ${message}`);
}

export function $ERR_INVALID_THIS(arg?: unknown): NodeTypeError {
  return codedTypeError("ERR_INVALID_THIS", `Value of "this" must be of type ${arg}`);
}

export function $ERR_INVALID_URI(): NodeURIError {
  return codedURIError("ERR_INVALID_URI", "URI malformed");
}

export function $ERR_INVALID_URL_SCHEME(expected?: unknown): NodeTypeError {
  return codedTypeError("ERR_INVALID_URL_SCHEME", `The URL must be of scheme ${expected}`);
}

/** `Invalid URL` (not the URL: Node's), with the error's `input` and `base` (when not null). */
export function $ERR_INVALID_URL(input?: unknown, base?: unknown): NodeTypeError {
  const e: any = codedTypeError("ERR_INVALID_URL", "Invalid URL");
  e.input = input;
  if (base !== undefined && base !== null) e.base = base;
  return e;
}

export function $ERR_IP_BLOCKED(ip?: unknown): NodeError {
  return codedError("ERR_IP_BLOCKED", `IP(${ip}) is blocked by net.BlockList`);
}

export function $ERR_IPC_CHANNEL_CLOSED(): NodeError {
  return codedError("ERR_IPC_CHANNEL_CLOSED", "Channel closed");
}

export function $ERR_IPC_DISCONNECTED(): NodeError {
  return codedError("ERR_IPC_DISCONNECTED", "IPC channel is already disconnected");
}

export function $ERR_IPC_ONE_PIPE(): NodeError {
  return codedError("ERR_IPC_ONE_PIPE", "Child process can have only one IPC pipe");
}

export function $ERR_LOAD_SQLITE_EXTENSION(message?: unknown): NodeError {
  return codedError("ERR_LOAD_SQLITE_EXTENSION", `${message}`);
}

export function $ERR_MEMORY_ALLOCATION_FAILED(message?: unknown): NodeRangeError {
  return codedRangeError("ERR_MEMORY_ALLOCATION_FAILED", `${message}`);
}

export function $ERR_METHOD_NOT_IMPLEMENTED(method?: unknown): NodeError {
  return codedError("ERR_METHOD_NOT_IMPLEMENTED", `The ${method} method is not implemented`);
}

/**
 * `The "a" argument must be specified`, `The "a" and "b" arguments must be
 * specified`, `The "a", "b", and "c" arguments must be specified`; one array
 * is alternatives: `The "a" or "b" argument must be specified`.
 */
export function $ERR_MISSING_ARGS(...names: unknown[]): NodeTypeError {
  const n = names.length;
  let message: string;
  if (n <= 1) {
    const first = names[0];
    if (ArrayIsArray(first)) {
      message = "The ";
      for (let i = 0; i < first.length; i++) message += `${i > 0 ? "or " : ""}"${first[i]}" `;
      message += "argument must be specified";
    } else {
      message = `The "${first}" argument must be specified`;
    }
  } else if (n === 2) {
    message = `The "${names[0]}" and "${names[1]}" arguments must be specified`;
  } else {
    message = "The ";
    for (let i = 0; i < n; i++) {
      if (i === n - 1) message += "and ";
      message += `"${names[i]}"${i !== n - 1 ? "," : ""} `;
    }
    message += "arguments must be specified";
  }
  return codedTypeError("ERR_MISSING_ARGS", message);
}

export function $ERR_MISSING_PASSPHRASE(message?: unknown): NodeTypeError {
  return codedTypeError("ERR_MISSING_PASSPHRASE", `${message}`);
}

export function $ERR_MODULE_LINK_MISMATCH(message?: unknown): NodeTypeError {
  return codedTypeError("ERR_MODULE_LINK_MISMATCH", `${message}`);
}

export function $ERR_MODULE_NOT_FOUND(message?: unknown): NodeError {
  return codedError("ERR_MODULE_NOT_FOUND", `${message}`);
}

export function $ERR_MULTIPLE_CALLBACK(): NodeError {
  return codedError("ERR_MULTIPLE_CALLBACK", "Callback called multiple times");
}

export function $ERR_OPERATION_FAILED(reason?: unknown): NodeError {
  return codedError("ERR_OPERATION_FAILED", `Operation failed: ${inspectValue(reason, false)}`);
}

/** `The value of "name" is out of range. It must be range. Received 4_294_967_297` */
export function $ERR_OUT_OF_RANGE(name: unknown, range: unknown, input?: unknown): NodeRangeError {
  return codedRangeError(
    "ERR_OUT_OF_RANGE",
    `The value of "${name}" is out of range. It must be ${range}. Received ${outOfRangeReceived(input)}`,
  );
}

export function $ERR_PARSE_ARGS_INVALID_OPTION_VALUE(message?: unknown): NodeTypeError {
  return codedTypeError("ERR_PARSE_ARGS_INVALID_OPTION_VALUE", `${message}`);
}

export function $ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL(message?: unknown): NodeTypeError {
  return codedTypeError("ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL", `${message}`);
}

export function $ERR_PARSE_ARGS_UNKNOWN_OPTION(message?: unknown): NodeTypeError {
  return codedTypeError("ERR_PARSE_ARGS_UNKNOWN_OPTION", `${message}`);
}

export function $ERR_POSTGRES_AUTHENTICATION_FAILED_PBKDF2(message?: unknown): NodeError {
  return withName(codedError("ERR_POSTGRES_AUTHENTICATION_FAILED_PBKDF2", `${message}`), "PostgresError");
}

export function $ERR_POSTGRES_CONNECTION_CLOSED(message?: unknown): NodeError {
  return withName(codedError("ERR_POSTGRES_CONNECTION_CLOSED", `${message}`), "PostgresError");
}

export function $ERR_POSTGRES_CONNECTION_TIMEOUT(message?: unknown): NodeError {
  return withName(codedError("ERR_POSTGRES_CONNECTION_TIMEOUT", `${message}`), "PostgresError");
}

export function $ERR_POSTGRES_EXPECTED_REQUEST(message?: unknown): NodeError {
  return withName(codedError("ERR_POSTGRES_EXPECTED_REQUEST", `${message}`), "PostgresError");
}

export function $ERR_POSTGRES_EXPECTED_STATEMENT(message?: unknown): NodeError {
  return withName(codedError("ERR_POSTGRES_EXPECTED_STATEMENT", `${message}`), "PostgresError");
}

export function $ERR_POSTGRES_IDLE_TIMEOUT(message?: unknown): NodeError {
  return withName(codedError("ERR_POSTGRES_IDLE_TIMEOUT", `${message}`), "PostgresError");
}

export function $ERR_POSTGRES_INVALID_BACKEND_KEY_DATA(message?: unknown): NodeTypeError {
  return withName(codedTypeError("ERR_POSTGRES_INVALID_BACKEND_KEY_DATA", `${message}`), "PostgresError");
}

export function $ERR_POSTGRES_INVALID_BINARY_DATA(message?: unknown): NodeTypeError {
  return withName(codedTypeError("ERR_POSTGRES_INVALID_BINARY_DATA", `${message}`), "PostgresError");
}

export function $ERR_POSTGRES_INVALID_BYTE_SEQUENCE_FOR_ENCODING(message?: unknown): NodeTypeError {
  return withName(codedTypeError("ERR_POSTGRES_INVALID_BYTE_SEQUENCE_FOR_ENCODING", `${message}`), "PostgresError");
}

export function $ERR_POSTGRES_INVALID_BYTE_SEQUENCE(message?: unknown): NodeTypeError {
  return withName(codedTypeError("ERR_POSTGRES_INVALID_BYTE_SEQUENCE", `${message}`), "PostgresError");
}

export function $ERR_POSTGRES_INVALID_CHARACTER(message?: unknown): NodeTypeError {
  return withName(codedTypeError("ERR_POSTGRES_INVALID_CHARACTER", `${message}`), "PostgresError");
}

export function $ERR_POSTGRES_INVALID_MESSAGE_LENGTH(message?: unknown): NodeError {
  return withName(codedError("ERR_POSTGRES_INVALID_MESSAGE_LENGTH", `${message}`), "PostgresError");
}

export function $ERR_POSTGRES_INVALID_MESSAGE(message?: unknown): NodeError {
  return withName(codedError("ERR_POSTGRES_INVALID_MESSAGE", `${message}`), "PostgresError");
}

export function $ERR_POSTGRES_INVALID_QUERY_BINDING(message?: unknown): NodeError {
  return withName(codedError("ERR_POSTGRES_INVALID_QUERY_BINDING", `${message}`), "PostgresError");
}

export function $ERR_POSTGRES_INVALID_SERVER_KEY(message?: unknown): NodeError {
  return withName(codedError("ERR_POSTGRES_INVALID_SERVER_KEY", `${message}`), "PostgresError");
}

export function $ERR_POSTGRES_INVALID_SERVER_SIGNATURE(message?: unknown): NodeError {
  return withName(codedError("ERR_POSTGRES_INVALID_SERVER_SIGNATURE", `${message}`), "PostgresError");
}

export function $ERR_POSTGRES_INVALID_TRANSACTION_STATE(message?: unknown): NodeError {
  return withName(codedError("ERR_POSTGRES_INVALID_TRANSACTION_STATE", `${message}`), "PostgresError");
}

export function $ERR_POSTGRES_LIFETIME_TIMEOUT(message?: unknown): NodeError {
  return withName(codedError("ERR_POSTGRES_LIFETIME_TIMEOUT", `${message}`), "PostgresError");
}

export function $ERR_POSTGRES_MULTIDIMENSIONAL_ARRAY_NOT_SUPPORTED_YET(message?: unknown): NodeError {
  return withName(codedError("ERR_POSTGRES_MULTIDIMENSIONAL_ARRAY_NOT_SUPPORTED_YET", `${message}`), "PostgresError");
}

export function $ERR_POSTGRES_NOT_TAGGED_CALL(message?: unknown): NodeError {
  return withName(codedError("ERR_POSTGRES_NOT_TAGGED_CALL", `${message}`), "PostgresError");
}

export function $ERR_POSTGRES_NULLS_IN_ARRAY_NOT_SUPPORTED_YET(message?: unknown): NodeError {
  return withName(codedError("ERR_POSTGRES_NULLS_IN_ARRAY_NOT_SUPPORTED_YET", `${message}`), "PostgresError");
}

export function $ERR_POSTGRES_OVERFLOW(message?: unknown): NodeTypeError {
  return withName(codedTypeError("ERR_POSTGRES_OVERFLOW", `${message}`), "PostgresError");
}

export function $ERR_POSTGRES_QUERY_CANCELLED(message?: unknown): NodeError {
  return withName(codedError("ERR_POSTGRES_QUERY_CANCELLED", `${message}`), "PostgresError");
}

export function $ERR_POSTGRES_SASL_SIGNATURE_INVALID_BASE64(message?: unknown): NodeError {
  return withName(codedError("ERR_POSTGRES_SASL_SIGNATURE_INVALID_BASE64", `${message}`), "PostgresError");
}

export function $ERR_POSTGRES_SASL_SIGNATURE_MISMATCH(message?: unknown): NodeError {
  return withName(codedError("ERR_POSTGRES_SASL_SIGNATURE_MISMATCH", `${message}`), "PostgresError");
}

export function $ERR_POSTGRES_SERVER_ERROR(message?: unknown): NodeError {
  return withName(codedError("ERR_POSTGRES_SERVER_ERROR", `${message}`), "PostgresError");
}

export function $ERR_POSTGRES_SYNTAX_ERROR(message?: unknown): NodeSyntaxError {
  return withName(codedSyntaxError("ERR_POSTGRES_SYNTAX_ERROR", `${message}`), "PostgresError");
}

export function $ERR_POSTGRES_TLS_NOT_AVAILABLE(message?: unknown): NodeError {
  return withName(codedError("ERR_POSTGRES_TLS_NOT_AVAILABLE", `${message}`), "PostgresError");
}

export function $ERR_POSTGRES_TLS_UPGRADE_FAILED(message?: unknown): NodeError {
  return withName(codedError("ERR_POSTGRES_TLS_UPGRADE_FAILED", `${message}`), "PostgresError");
}

export function $ERR_POSTGRES_UNEXPECTED_MESSAGE(message?: unknown): NodeError {
  return withName(codedError("ERR_POSTGRES_UNEXPECTED_MESSAGE", `${message}`), "PostgresError");
}

export function $ERR_POSTGRES_UNKNOWN_AUTHENTICATION_METHOD(message?: unknown): NodeError {
  return withName(codedError("ERR_POSTGRES_UNKNOWN_AUTHENTICATION_METHOD", `${message}`), "PostgresError");
}

export function $ERR_POSTGRES_UNKNOWN_FORMAT_CODE(message?: unknown): NodeError {
  return withName(codedError("ERR_POSTGRES_UNKNOWN_FORMAT_CODE", `${message}`), "PostgresError");
}

export function $ERR_POSTGRES_UNSAFE_TRANSACTION(message?: unknown): NodeError {
  return withName(codedError("ERR_POSTGRES_UNSAFE_TRANSACTION", `${message}`), "PostgresError");
}

export function $ERR_POSTGRES_UNSUPPORTED_ARRAY_FORMAT(message?: unknown): NodeTypeError {
  return withName(codedTypeError("ERR_POSTGRES_UNSUPPORTED_ARRAY_FORMAT", `${message}`), "PostgresError");
}

export function $ERR_POSTGRES_UNSUPPORTED_AUTHENTICATION_METHOD(message?: unknown): NodeError {
  return withName(codedError("ERR_POSTGRES_UNSUPPORTED_AUTHENTICATION_METHOD", `${message}`), "PostgresError");
}

export function $ERR_POSTGRES_UNSUPPORTED_BYTEA_FORMAT(message?: unknown): NodeTypeError {
  return withName(codedTypeError("ERR_POSTGRES_UNSUPPORTED_BYTEA_FORMAT", `${message}`), "PostgresError");
}

export function $ERR_POSTGRES_UNSUPPORTED_INTEGER_SIZE(message?: unknown): NodeTypeError {
  return withName(codedTypeError("ERR_POSTGRES_UNSUPPORTED_INTEGER_SIZE", `${message}`), "PostgresError");
}

export function $ERR_POSTGRES_UNSUPPORTED_NUMERIC_FORMAT(message?: unknown): NodeTypeError {
  return withName(codedTypeError("ERR_POSTGRES_UNSUPPORTED_NUMERIC_FORMAT", `${message}`), "PostgresError");
}

export function $ERR_PROXY_INVALID_CONFIG(message?: unknown): NodeError {
  return codedError("ERR_PROXY_INVALID_CONFIG", `${message}`);
}

export function $ERR_MYSQL_CONNECTION_CLOSED(message?: unknown): NodeError {
  return withName(codedError("ERR_MYSQL_CONNECTION_CLOSED", `${message}`), "MySQLError");
}

export function $ERR_MYSQL_CONNECTION_TIMEOUT(message?: unknown): NodeError {
  return withName(codedError("ERR_MYSQL_CONNECTION_TIMEOUT", `${message}`), "MySQLError");
}

export function $ERR_MYSQL_IDLE_TIMEOUT(message?: unknown): NodeError {
  return withName(codedError("ERR_MYSQL_IDLE_TIMEOUT", `${message}`), "MySQLError");
}

export function $ERR_MYSQL_LIFETIME_TIMEOUT(message?: unknown): NodeError {
  return withName(codedError("ERR_MYSQL_LIFETIME_TIMEOUT", `${message}`), "MySQLError");
}

export function $ERR_UNHANDLED_REJECTION(message?: unknown): NodeError {
  return withName(codedError("ERR_UNHANDLED_REJECTION", `${message}`), "UnhandledPromiseRejection");
}

export function $ERR_S3_INVALID_ENDPOINT(message?: unknown): NodeError {
  return codedError("ERR_S3_INVALID_ENDPOINT", `${message}`);
}

export function $ERR_S3_INVALID_METHOD(message?: unknown): NodeError {
  return codedError("ERR_S3_INVALID_METHOD", `${message}`);
}

export function $ERR_S3_INVALID_PATH(message?: unknown): NodeError {
  return codedError("ERR_S3_INVALID_PATH", `${message}`);
}

export function $ERR_S3_INVALID_SESSION_TOKEN(message?: unknown): NodeError {
  return codedError("ERR_S3_INVALID_SESSION_TOKEN", `${message}`);
}

export function $ERR_S3_INVALID_SIGNATURE(message?: unknown): NodeError {
  return codedError("ERR_S3_INVALID_SIGNATURE", `${message}`);
}

export function $ERR_S3_MISSING_CREDENTIALS(message?: unknown): NodeError {
  return codedError("ERR_S3_MISSING_CREDENTIALS", `${message}`);
}

export function $ERR_SCRIPT_EXECUTION_INTERRUPTED(): NodeError {
  return codedError("ERR_SCRIPT_EXECUTION_INTERRUPTED", "Script execution was interrupted by `SIGINT`");
}

export function $ERR_SCRIPT_EXECUTION_TIMEOUT(message?: unknown): NodeError {
  return codedError("ERR_SCRIPT_EXECUTION_TIMEOUT", `${message}`);
}

export function $ERR_SERVER_ALREADY_LISTEN(): NodeError {
  return codedError("ERR_SERVER_ALREADY_LISTEN", "Listen method has been called more than once without closing.");
}

export function $ERR_SERVER_NOT_RUNNING(): NodeError {
  return codedError("ERR_SERVER_NOT_RUNNING", "Server is not running.");
}

export function $ERR_SOCKET_ALREADY_BOUND(): NodeError {
  return codedError("ERR_SOCKET_ALREADY_BOUND", "Socket is already bound");
}

export function $ERR_SOCKET_BAD_BUFFER_SIZE(): NodeTypeError {
  return codedTypeError("ERR_SOCKET_BAD_BUFFER_SIZE", "Buffer size must be a positive integer");
}

export function $ERR_SOCKET_BAD_PORT(message?: unknown): NodeRangeError {
  return codedRangeError("ERR_SOCKET_BAD_PORT", `${message}`);
}

export function $ERR_SOCKET_BAD_TYPE(): NodeTypeError {
  return codedTypeError("ERR_SOCKET_BAD_TYPE", "Bad socket type specified. Valid types are: udp4, udp6");
}

export function $ERR_SOCKET_CLOSED_BEFORE_CONNECTION(): NodeError {
  return codedError("ERR_SOCKET_CLOSED_BEFORE_CONNECTION", "Socket closed before the connection was established");
}

export function $ERR_SOCKET_CLOSED(): NodeError {
  return codedError("ERR_SOCKET_CLOSED", "Socket is closed");
}

export function $ERR_SOCKET_CONNECTION_TIMEOUT(): NodeError {
  return codedError("ERR_SOCKET_CONNECTION_TIMEOUT", "Socket connection timeout");
}

export function $ERR_SOCKET_DGRAM_IS_CONNECTED(): NodeError {
  return codedError("ERR_SOCKET_DGRAM_IS_CONNECTED", "Already connected");
}

export function $ERR_SOCKET_DGRAM_NOT_CONNECTED(): NodeError {
  return codedError("ERR_SOCKET_DGRAM_NOT_CONNECTED", "Not connected");
}

export function $ERR_SOCKET_DGRAM_NOT_RUNNING(): NodeError {
  return codedError("ERR_SOCKET_DGRAM_NOT_RUNNING", "Not running");
}

export function $ERR_STREAM_ALREADY_FINISHED(method?: unknown): NodeError {
  return codedError("ERR_STREAM_ALREADY_FINISHED", `Cannot call ${method} after a stream was finished`);
}

export function $ERR_STREAM_CANNOT_PIPE(): NodeError {
  return codedError("ERR_STREAM_CANNOT_PIPE", "Cannot pipe, not readable");
}

export function $ERR_STREAM_DESTROYED(method?: unknown): NodeError {
  return codedError("ERR_STREAM_DESTROYED", `Cannot call ${method} after a stream was destroyed`);
}

export function $ERR_STREAM_ITER_MISSING_FLAG(): NodeTypeError {
  return codedTypeError(
    "ERR_STREAM_ITER_MISSING_FLAG",
    "The stream/iter API requires the --experimental-stream-iter flag",
  );
}

export function $ERR_STREAM_NULL_VALUES(): NodeTypeError {
  return codedTypeError("ERR_STREAM_NULL_VALUES", "May not write null values to stream");
}

export function $ERR_STREAM_PREMATURE_CLOSE(): NodeError {
  return codedError("ERR_STREAM_PREMATURE_CLOSE", "Premature close");
}

export function $ERR_STREAM_PUSH_AFTER_EOF(): NodeError {
  return codedError("ERR_STREAM_PUSH_AFTER_EOF", "stream.push() after EOF");
}

export function $ERR_STREAM_RELEASE_LOCK(): NodeError {
  return withName(codedError("ERR_STREAM_RELEASE_LOCK", "Stream reader cancelled via releaseLock()"), "AbortError");
}

export function $ERR_STREAM_UNABLE_TO_PIPE(): NodeError {
  return codedError("ERR_STREAM_UNABLE_TO_PIPE", "Cannot pipe to a closed or destroyed stream");
}

export function $ERR_STREAM_UNSHIFT_AFTER_END_EVENT(): NodeError {
  return codedError("ERR_STREAM_UNSHIFT_AFTER_END_EVENT", "stream.unshift() after end event");
}

export function $ERR_STREAM_WRAP(message?: unknown): NodeError {
  return codedError("ERR_STREAM_WRAP", `${message}`);
}

export function $ERR_STREAM_WRITE_AFTER_END(): NodeError {
  return codedError("ERR_STREAM_WRITE_AFTER_END", "write after end");
}

export function $ERR_STRING_TOO_LONG(message?: unknown): NodeError {
  return codedError("ERR_STRING_TOO_LONG", `${message}`);
}

export function $ERR_TLS_CERT_ALTNAME_FORMAT(): NodeSyntaxError {
  return codedSyntaxError("ERR_TLS_CERT_ALTNAME_FORMAT", "Invalid subject alternative name string");
}

/** With the error's `reason`, `host` and `cert`. */
export function $ERR_TLS_CERT_ALTNAME_INVALID(reason: unknown, host?: unknown, cert?: unknown): NodeError {
  const e: any = codedError("ERR_TLS_CERT_ALTNAME_INVALID", `Hostname/IP does not match certificate's altnames: ${reason}`);
  e.reason = reason;
  e.host = host;
  e.cert = cert;
  return e;
}

export function $ERR_TLS_HANDSHAKE_TIMEOUT(): NodeError {
  return codedError("ERR_TLS_HANDSHAKE_TIMEOUT", "TLS handshake timeout");
}

export function $ERR_TLS_INVALID_CONTEXT(message?: unknown): NodeTypeError {
  return codedTypeError("ERR_TLS_INVALID_CONTEXT", `${message}`);
}

export function $ERR_TLS_INVALID_PROTOCOL_METHOD(message?: unknown): NodeTypeError {
  return codedTypeError("ERR_TLS_INVALID_PROTOCOL_METHOD", `${message}`);
}

export function $ERR_TLS_INVALID_PROTOCOL_VERSION(a?: unknown, b?: unknown): NodeTypeError {
  return codedTypeError("ERR_TLS_INVALID_PROTOCOL_VERSION", `${a} is not a valid ${b} TLS protocol version`);
}

export function $ERR_TLS_PROTOCOL_VERSION_CONFLICT(version?: unknown, secureProtocol?: unknown): NodeTypeError {
  return codedTypeError(
    "ERR_TLS_PROTOCOL_VERSION_CONFLICT",
    `TLS protocol version ${version} conflicts with secureProtocol ${secureProtocol}`,
  );
}

export function $ERR_TLS_RENEGOTIATION_DISABLED(): NodeError {
  return codedError("ERR_TLS_RENEGOTIATION_DISABLED", "TLS session renegotiation disabled for this socket");
}

export function $ERR_TLS_RENEGOTIATION_UNSUPPORTED(): NodeError {
  return codedError(
    "ERR_TLS_RENEGOTIATION_UNSUPPORTED",
    "TLS session renegotiation is unsupported by this TLS implementation",
  );
}

export function $ERR_TLS_REQUIRED_SERVER_NAME(): NodeError {
  return codedError("ERR_TLS_REQUIRED_SERVER_NAME", "\"servername\" is required parameter for Server.addContext");
}

export function $ERR_TLS_SNI_FROM_SERVER(): NodeError {
  return codedError("ERR_TLS_SNI_FROM_SERVER", "Cannot issue SNI from a TLS server-side socket");
}

export function $ERR_TLS_INVALID_STATE(): NodeError {
  return codedError("ERR_TLS_INVALID_STATE", "TLS socket connection must be securely established");
}

export function $ERR_TLS_ALPN_CALLBACK_WITH_PROTOCOLS(): NodeTypeError {
  return codedTypeError(
    "ERR_TLS_ALPN_CALLBACK_WITH_PROTOCOLS",
    "The ALPNCallback and ALPNProtocols TLS options are mutually exclusive",
  );
}

/** With the error's `reason` and `library`, as OpenSSL's. */
export function $ERR_SSL_NO_CIPHER_MATCH(): NodeError {
  const e: any = codedError("ERR_SSL_NO_CIPHER_MATCH", "No cipher match");
  e.reason = "no cipher match";
  e.library = "SSL routines";
  return e;
}

export function $ERR_UNAVAILABLE_DURING_EXIT(): NodeError {
  return codedError("ERR_UNAVAILABLE_DURING_EXIT", "Cannot call function in process exit handler");
}

export function $ERR_UNCAUGHT_EXCEPTION_CAPTURE_ALREADY_SET(message?: unknown): NodeError {
  return codedError("ERR_UNCAUGHT_EXCEPTION_CAPTURE_ALREADY_SET", `${message}`);
}

export function $ERR_UNESCAPED_CHARACTERS(arg?: unknown): NodeTypeError {
  return codedTypeError("ERR_UNESCAPED_CHARACTERS", `${arg} contains unescaped characters`);
}

/** `Unhandled error.`, or `Unhandled error. (err)` (err as its string). */
export function $ERR_UNHANDLED_ERROR(err?: unknown): NodeError {
  return codedError("ERR_UNHANDLED_ERROR", err === undefined ? "Unhandled error." : `Unhandled error. (${err})`);
}

export function $ERR_UNKNOWN_CREDENTIAL(message?: unknown): NodeError {
  return codedError("ERR_UNKNOWN_CREDENTIAL", `${message}`);
}

export function $ERR_UNKNOWN_ENCODING(encoding?: unknown): NodeTypeError {
  return codedTypeError("ERR_UNKNOWN_ENCODING", `Unknown encoding: ${inspectValue(encoding, false)}`);
}

export function $ERR_UNKNOWN_SIGNAL(message?: unknown): NodeTypeError {
  return codedTypeError("ERR_UNKNOWN_SIGNAL", `${message}`);
}

export function $ERR_ZSTD_INVALID_PARAM(arg?: unknown): NodeRangeError {
  return codedRangeError("ERR_ZSTD_INVALID_PARAM", `${arg} is not a valid zstd parameter`);
}

export function $ERR_USE_AFTER_CLOSE(name?: unknown): NodeError {
  return codedError("ERR_USE_AFTER_CLOSE", `${name} was closed`);
}

export function $ERR_WEBASSEMBLY_RESPONSE(message?: unknown): NodeTypeError {
  return codedTypeError("ERR_WEBASSEMBLY_RESPONSE", `${message}`);
}

export function $ERR_WORKER_INVALID_EXEC_ARGV(message?: unknown): NodeError {
  return codedError("ERR_WORKER_INVALID_EXEC_ARGV", `${message}`);
}

export function $ERR_WORKER_NOT_RUNNING(message?: unknown): NodeError {
  return codedError("ERR_WORKER_NOT_RUNNING", `${message}`);
}

export function $ERR_WORKER_UNSUPPORTED_OPERATION(message?: unknown): NodeTypeError {
  return codedTypeError("ERR_WORKER_UNSUPPORTED_OPERATION", `${message}`);
}

export function $ERR_WORKER_PATH(message?: unknown): NodeTypeError {
  return codedTypeError("ERR_WORKER_PATH", `${message}`);
}

export function $ERR_ZLIB_INITIALIZATION_FAILED(): NodeError {
  return codedError("ERR_ZLIB_INITIALIZATION_FAILED", "Initialization failed");
}

export function $MODULE_NOT_FOUND(message?: unknown): NodeError {
  return codedError("MODULE_NOT_FOUND", `${message}`);
}

export function $ERR_INTERNAL_ASSERTION(message?: unknown): NodeError {
  return codedError("ERR_INTERNAL_ASSERTION", `${message}`);
}

export function $ERR_OSSL_EVP_INVALID_DIGEST(message?: unknown): NodeError {
  return codedError("ERR_OSSL_EVP_INVALID_DIGEST", `${message}`);
}

export function $ERR_KEY_GENERATION_JOB_FAILED(message?: unknown): NodeError {
  return codedError("ERR_KEY_GENERATION_JOB_FAILED", `${message}`);
}

export function $ERR_MISSING_OPTION(message?: unknown): NodeTypeError {
  return codedTypeError("ERR_MISSING_OPTION", `${message}`);
}

export function $ERR_REDIS_AUTHENTICATION_FAILED(message?: unknown): NodeError {
  return withName(codedError("ERR_REDIS_AUTHENTICATION_FAILED", `${message}`), "RedisError");
}

export function $ERR_REDIS_CONNECTION_CLOSED(message?: unknown): NodeError {
  return withName(codedError("ERR_REDIS_CONNECTION_CLOSED", `${message}`), "RedisError");
}

export function $ERR_REDIS_CONNECTION_TIMEOUT(message?: unknown): NodeError {
  return withName(codedError("ERR_REDIS_CONNECTION_TIMEOUT", `${message}`), "RedisError");
}

export function $ERR_REDIS_IDLE_TIMEOUT(message?: unknown): NodeError {
  return withName(codedError("ERR_REDIS_IDLE_TIMEOUT", `${message}`), "RedisError");
}

export function $ERR_REDIS_INVALID_ARGUMENT(message?: unknown): NodeError {
  return withName(codedError("ERR_REDIS_INVALID_ARGUMENT", `${message}`), "RedisError");
}

export function $ERR_REDIS_INVALID_ARRAY(message?: unknown): NodeError {
  return withName(codedError("ERR_REDIS_INVALID_ARRAY", `${message}`), "RedisError");
}

export function $ERR_REDIS_INVALID_BULK_STRING(message?: unknown): NodeError {
  return withName(codedError("ERR_REDIS_INVALID_BULK_STRING", `${message}`), "RedisError");
}

export function $ERR_REDIS_INVALID_COMMAND(message?: unknown): NodeError {
  return withName(codedError("ERR_REDIS_INVALID_COMMAND", `${message}`), "RedisError");
}

export function $ERR_REDIS_INVALID_DATABASE(message?: unknown): NodeError {
  return withName(codedError("ERR_REDIS_INVALID_DATABASE", `${message}`), "RedisError");
}

export function $ERR_REDIS_INVALID_ERROR_STRING(message?: unknown): NodeError {
  return withName(codedError("ERR_REDIS_INVALID_ERROR_STRING", `${message}`), "RedisError");
}

export function $ERR_REDIS_INVALID_INTEGER(message?: unknown): NodeError {
  return withName(codedError("ERR_REDIS_INVALID_INTEGER", `${message}`), "RedisError");
}

export function $ERR_REDIS_INVALID_PASSWORD(message?: unknown): NodeError {
  return withName(codedError("ERR_REDIS_INVALID_PASSWORD", `${message}`), "RedisError");
}

export function $ERR_REDIS_INVALID_RESPONSE(message?: unknown): NodeError {
  return withName(codedError("ERR_REDIS_INVALID_RESPONSE", `${message}`), "RedisError");
}

export function $ERR_REDIS_INVALID_RESPONSE_TYPE(message?: unknown): NodeError {
  return withName(codedError("ERR_REDIS_INVALID_RESPONSE_TYPE", `${message}`), "RedisError");
}

export function $ERR_REDIS_INVALID_SIMPLE_STRING(message?: unknown): NodeError {
  return withName(codedError("ERR_REDIS_INVALID_SIMPLE_STRING", `${message}`), "RedisError");
}

export function $ERR_REDIS_INVALID_STATE(message?: unknown): NodeError {
  return withName(codedError("ERR_REDIS_INVALID_STATE", `${message}`), "RedisError");
}

export function $ERR_REDIS_INVALID_USERNAME(message?: unknown): NodeError {
  return withName(codedError("ERR_REDIS_INVALID_USERNAME", `${message}`), "RedisError");
}

export function $ERR_REDIS_TLS_NOT_AVAILABLE(message?: unknown): NodeError {
  return withName(codedError("ERR_REDIS_TLS_NOT_AVAILABLE", `${message}`), "RedisError");
}

export function $ERR_REDIS_TLS_UPGRADE_FAILED(message?: unknown): NodeError {
  return withName(codedError("ERR_REDIS_TLS_UPGRADE_FAILED", `${message}`), "RedisError");
}

export function $HPE_UNEXPECTED_CONTENT_LENGTH(message?: unknown): NodeError {
  return codedError("HPE_UNEXPECTED_CONTENT_LENGTH", `${message}`);
}

export function $HPE_INVALID_CONTENT_LENGTH(message?: unknown): NodeError {
  return codedError("HPE_INVALID_CONTENT_LENGTH", `${message}`);
}

export function $HPE_INVALID_TRANSFER_ENCODING(message?: unknown): NodeError {
  return codedError("HPE_INVALID_TRANSFER_ENCODING", `${message}`);
}

export function $HPE_INVALID_EOF_STATE(message?: unknown): NodeError {
  return codedError("HPE_INVALID_EOF_STATE", `${message}`);
}

export function $HPE_INVALID_METHOD(message?: unknown): NodeError {
  return codedError("HPE_INVALID_METHOD", `${message}`);
}

export function $HPE_INTERNAL(message?: unknown): NodeError {
  return codedError("HPE_INTERNAL", `${message}`);
}

export function $ERR_VM_MODULE_STATUS(reason?: unknown): NodeError {
  return codedError("ERR_VM_MODULE_STATUS", `Module status ${reason}`);
}

export function $ERR_VM_MODULE_ALREADY_LINKED(): NodeError {
  return codedError("ERR_VM_MODULE_ALREADY_LINKED", "Module has already been linked");
}

export function $ERR_VM_MODULE_CANNOT_CREATE_CACHED_DATA(): NodeError {
  return codedError(
    "ERR_VM_MODULE_CANNOT_CREATE_CACHED_DATA",
    "Cached data cannot be created for a module which has been evaluated",
  );
}

export function $ERR_VM_MODULE_NOT_MODULE(): NodeError {
  return codedError("ERR_VM_MODULE_NOT_MODULE", "Provided module is not an instance of Module");
}

export function $ERR_VM_MODULE_DIFFERENT_CONTEXT(): NodeError {
  return codedError("ERR_VM_MODULE_DIFFERENT_CONTEXT", "Linked modules must use the same context");
}

/** With the error's `cause`. */
export function $ERR_VM_MODULE_LINK_FAILURE(message: unknown, cause?: unknown): NodeError {
  const e: any = codedError("ERR_VM_MODULE_LINK_FAILURE", `${message}`);
  e.cause = cause;
  return e;
}

export function $ERR_VM_MODULE_CACHED_DATA_REJECTED(message?: unknown): NodeError {
  return codedError("ERR_VM_MODULE_CACHED_DATA_REJECTED", `${message}`);
}

export function $ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING(): NodeTypeError {
  return codedTypeError("ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING", "A dynamic import callback was not specified.");
}

export function $HPE_INVALID_HEADER_TOKEN(message?: unknown): NodeError {
  return codedError("HPE_INVALID_HEADER_TOKEN", `${message}`);
}

export function $HPE_HEADER_OVERFLOW(message?: unknown): NodeError {
  return codedError("HPE_HEADER_OVERFLOW", `${message}`);
}

export function $HPE_INVALID_VERSION(message?: unknown): NodeError {
  return codedError("HPE_INVALID_VERSION", `${message}`);
}

export function $HPE_LF_EXPECTED(message?: unknown): NodeError {
  return codedError("HPE_LF_EXPECTED", `${message}`);
}

export function $HPE_CHUNK_EXTENSIONS_OVERFLOW(message?: unknown): NodeError {
  return codedError("HPE_CHUNK_EXTENSIONS_OVERFLOW", `${message}`);
}

export function $HPE_PAUSED_H2_UPGRADE(message?: unknown): NodeError {
  return codedError("HPE_PAUSED_H2_UPGRADE", `${message}`);
}

export function $HPE_CLOSED_CONNECTION(message?: unknown): NodeError {
  return codedError("HPE_CLOSED_CONNECTION", `${message}`);
}

export function $HPE_INVALID_CHUNK_SIZE(message?: unknown): NodeError {
  return codedError("HPE_INVALID_CHUNK_SIZE", `${message}`);
}

export function $HPE_INVALID_CONSTANT(message?: unknown): NodeError {
  return codedError("HPE_INVALID_CONSTANT", `${message}`);
}

export function $ERR_SECRETS_NOT_FOUND(message?: unknown): NodeError {
  return codedError("ERR_SECRETS_NOT_FOUND", `${message}`);
}

export function $ERR_SECRETS_ACCESS_DENIED(message?: unknown): NodeError {
  return codedError("ERR_SECRETS_ACCESS_DENIED", `${message}`);
}

export function $ERR_SECRETS_PLATFORM_ERROR(message?: unknown): NodeError {
  return codedError("ERR_SECRETS_PLATFORM_ERROR", `${message}`);
}

export function $ERR_SECRETS_USER_CANCELED(message?: unknown): NodeError {
  return codedError("ERR_SECRETS_USER_CANCELED", `${message}`);
}

export function $ERR_SECRETS_INTERACTION_NOT_ALLOWED(message?: unknown): NodeError {
  return codedError("ERR_SECRETS_INTERACTION_NOT_ALLOWED", `${message}`);
}

export function $ERR_SECRETS_AUTH_FAILED(message?: unknown): NodeError {
  return codedError("ERR_SECRETS_AUTH_FAILED", `${message}`);
}

export function $ERR_SECRETS_INTERACTION_REQUIRED(message?: unknown): NodeError {
  return codedError("ERR_SECRETS_INTERACTION_REQUIRED", `${message}`);
}

export function $ERR_WORKER_MESSAGING_ERRORED(message?: unknown): NodeError {
  return codedError("ERR_WORKER_MESSAGING_ERRORED", `${message}`);
}

export function $ERR_WORKER_MESSAGING_FAILED(message?: unknown): NodeError {
  return codedError("ERR_WORKER_MESSAGING_FAILED", `${message}`);
}

export function $ERR_WORKER_MESSAGING_SAME_THREAD(message?: unknown): NodeError {
  return codedError("ERR_WORKER_MESSAGING_SAME_THREAD", `${message}`);
}

export function $ERR_WORKER_MESSAGING_TIMEOUT(message?: unknown): NodeError {
  return codedError("ERR_WORKER_MESSAGING_TIMEOUT", `${message}`);
}

export function $ERR_POSTGRES_CONNECTION_FAILED(message?: unknown): NodeError {
  return withName(codedError("ERR_POSTGRES_CONNECTION_FAILED", `${message}`), "PostgresError");
}

export function $ERR_MYSQL_CONNECTION_FAILED(message?: unknown): NodeError {
  return withName(codedError("ERR_MYSQL_CONNECTION_FAILED", `${message}`), "MySQLError");
}

export function $ERR_POSTGRES_CONNECTION_REFUSED(message?: unknown): NodeError {
  return withName(codedError("ERR_POSTGRES_CONNECTION_REFUSED", `${message}`), "PostgresError");
}

export function $ERR_MYSQL_CONNECTION_REFUSED(message?: unknown): NodeError {
  return withName(codedError("ERR_MYSQL_CONNECTION_REFUSED", `${message}`), "MySQLError");
}

export function $ERR_HTTP2_GOAWAY_SESSION(): NodeError {
  return codedError("ERR_HTTP2_GOAWAY_SESSION", "New streams cannot be created after receiving a GOAWAY");
}

export function $ERR_TLS_ALPN_CALLBACK_INVALID_RESULT(message?: unknown): NodeTypeError {
  return codedTypeError("ERR_TLS_ALPN_CALLBACK_INVALID_RESULT", `${message}`);
}

export function $ERR_PROXY_TUNNEL(message?: unknown): NodeError {
  return codedError("ERR_PROXY_TUNNEL", `${message}`);
}

export function $ERR_FS_CP_EEXIST(message?: unknown): NodeError {
  return codedError("ERR_FS_CP_EEXIST", `${message}`);
}

export function $ERR_FS_CP_SYMLINK_TO_SUBDIRECTORY(message?: unknown): NodeError {
  return codedError("ERR_FS_CP_SYMLINK_TO_SUBDIRECTORY", `${message}`);
}

export function $ERR_DIR_CONCURRENT_OPERATION(message?: unknown): NodeError {
  return codedError("ERR_DIR_CONCURRENT_OPERATION", `${message}`);
}

export function $ERR_INVALID_BUFFER_SIZE(message?: unknown): NodeRangeError {
  return codedRangeError("ERR_INVALID_BUFFER_SIZE", `${message}`);
}

export function $ERR_TRACE_EVENTS_CATEGORY_REQUIRED(message?: unknown): NodeTypeError {
  return codedTypeError("ERR_TRACE_EVENTS_CATEGORY_REQUIRED", `${message}`);
}

export function $ERR_TRACE_EVENTS_UNAVAILABLE(message?: unknown): NodeError {
  return codedError("ERR_TRACE_EVENTS_UNAVAILABLE", `${message}`);
}

export function $ERR_TRAILING_JUNK_AFTER_STREAM_END(): NodeTypeError {
  return codedTypeError(
    "ERR_TRAILING_JUNK_AFTER_STREAM_END",
    "Trailing junk found after the end of the compressed stream",
  );
}

export function $ERR_SQLITE_ERROR(message?: unknown): NodeError {
  return codedError("ERR_SQLITE_ERROR", `${message}`);
}

export function $ERR_HTTP2_INVALID_CONNECTION_HEADERS(message?: unknown): NodeTypeError {
  return codedTypeError("ERR_HTTP2_INVALID_CONNECTION_HEADERS", `${message}`);
}

export function $ERR_QUIC_CONNECTION_FAILED(message?: unknown): NodeError {
  return codedError("ERR_QUIC_CONNECTION_FAILED", `${message}`);
}

export function $ERR_QUIC_ENDPOINT_CLOSED(message?: unknown): NodeError {
  return codedError("ERR_QUIC_ENDPOINT_CLOSED", `${message}`);
}

export function $ERR_QUIC_OPEN_STREAM_FAILED(message?: unknown): NodeError {
  return codedError("ERR_QUIC_OPEN_STREAM_FAILED", `${message}`);
}

export function $ERR_QUIC_STREAM_ABORTED(message?: unknown): NodeError {
  return codedError("ERR_QUIC_STREAM_ABORTED", `${message}`);
}

export function $ERR_QUIC_STREAM_RESET(message?: unknown): NodeError {
  return codedError("ERR_QUIC_STREAM_RESET", `${message}`);
}

export function $ERR_QUIC_VERSION_NEGOTIATION_ERROR(message?: unknown): NodeError {
  return codedError("ERR_QUIC_VERSION_NEGOTIATION_ERROR", `${message}`);
}

export function $HPE_STRICT(message?: unknown): NodeError {
  return codedError("HPE_STRICT", `${message}`);
}

export function $ERR_NOT_BUILDING_SNAPSHOT(message?: unknown): NodeError {
  return codedError("ERR_NOT_BUILDING_SNAPSHOT", `${message}`);
}

export function $ERR_CANNOT_WATCH_SIGINT(message?: unknown): NodeError {
  return codedError("ERR_CANNOT_WATCH_SIGINT", `${message}`);
}

export function $ERR_INSPECTOR_NOT_AVAILABLE(message?: unknown): NodeError {
  return codedError("ERR_INSPECTOR_NOT_AVAILABLE", `${message}`);
}

export function $ERR_INVALID_REPL_EVAL_CONFIG(message?: unknown): NodeTypeError {
  return codedTypeError("ERR_INVALID_REPL_EVAL_CONFIG", `${message}`);
}

export function $ERR_INVALID_REPL_INPUT(message?: unknown): NodeTypeError {
  return codedTypeError("ERR_INVALID_REPL_INPUT", `${message}`);
}

/** `message` when it is a string. */
export function $ERR_INSPECTOR_ALREADY_ACTIVATED(message?: unknown): NodeError {
  return codedError(
    "ERR_INSPECTOR_ALREADY_ACTIVATED",
    typeof message === "string"
      ? message
      : "Inspector is already activated. Close it with inspector.close() before activating it again.",
  );
}

export function $ERR_INSPECTOR_NOT_ACTIVE(): NodeError {
  return codedError("ERR_INSPECTOR_NOT_ACTIVE", "Inspector is not active");
}

export function $ERR_INSPECTOR_ALREADY_CONNECTED(): NodeError {
  return codedError("ERR_INSPECTOR_ALREADY_CONNECTED", "The inspector session is already connected");
}

export function $ERR_INSPECTOR_NOT_CONNECTED(): NodeError {
  return codedError("ERR_INSPECTOR_NOT_CONNECTED", "Session is not connected");
}

export function $ERR_INSPECTOR_NOT_WORKER(): NodeError {
  return codedError("ERR_INSPECTOR_NOT_WORKER", "Current thread is not a worker");
}

export function $ERR_INSPECTOR_COMMAND(message?: unknown): NodeError {
  return codedError("ERR_INSPECTOR_COMMAND", `Inspector error ${message}`);
}

export function $ERR_REDIS_SERVER_ERROR(message?: unknown): NodeError {
  return withName(codedError("ERR_REDIS_SERVER_ERROR", `${message}`), "RedisError");
}

export function $ERR_FFI_CC_DISABLED(message?: unknown): NodeError {
  return codedError("ERR_FFI_CC_DISABLED", `${message}`);
}

// ---- AbortError ----

/**
 * Bun's `$makeAbortError(message, options)` (`jsFunctionMakeAbortError`): an
 * ABORT_ERR, `The operation was aborted` when there is no message, with
 * `options.cause` as its `cause`.
 */
export function $makeAbortError(message?: unknown, options?: unknown): NodeError {
  if (typeof options === "string" || typeof options === "symbol" || typeof options === "bigint") {
    throw $ERR_INVALID_ARG_TYPE("options", "object", options);
  }
  const text = message === undefined ? "The operation was aborted" : `${message}`;
  const e =
    (typeof options === "object" && options !== null) || typeof options === "function"
      ? new Error(text, options as ErrorOptions)
      : new Error(text);
  return withName(withCode(e, "ABORT_ERR"), "AbortError");
}
