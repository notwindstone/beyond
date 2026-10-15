// structuredClone (HTML's structured serialization, in one step): copies of
// primitives, plain objects and arrays, Date, RegExp, Map, Set, ArrayBuffer
// and its views, the wrappers of primitives and errors, cycles and shared
// references kept. Functions, symbols and other objects with internal state
// (promises, weak collections) cannot be cloned.

function uncloneable(what: string): never {
  throw new DOMException(`${what} could not be cloned.`, "DataCloneError");
}

const ERRORS: Record<string, ErrorConstructor> = {
  Error,
  EvalError,
  RangeError,
  ReferenceError,
  SyntaxError,
  TypeError,
  URIError,
};

function cloneValue(v: any, memory: Map<any, any>): any {
  const t = typeof v;
  if (t === "symbol") uncloneable("Symbol()");
  if (t === "function") uncloneable(String(v));
  if (t !== "object" || v === null) return v;
  const seen = memory.get(v);
  if (seen !== undefined) return seen;

  let out: any;
  if (Array.isArray(v)) {
    out = new Array(v.length);
    memory.set(v, out);
    for (const k of Object.keys(v)) out[k] = cloneValue(v[k], memory);
    return out;
  }
  if (v instanceof ArrayBuffer) {
    out = v.slice(0);
    memory.set(v, out);
    return out;
  }
  if (ArrayBuffer.isView(v)) {
    const buffer = cloneValue(v.buffer, memory);
    if (v instanceof DataView) out = new DataView(buffer, v.byteOffset, v.byteLength);
    else out = new (v.constructor as any)(buffer, v.byteOffset, (v as any).length);
    memory.set(v, out);
    return out;
  }
  if (v instanceof Map) {
    out = new Map();
    memory.set(v, out);
    for (const [k, x] of v) out.set(cloneValue(k, memory), cloneValue(x, memory));
    return out;
  }
  if (v instanceof Set) {
    out = new Set();
    memory.set(v, out);
    for (const x of v) out.add(cloneValue(x, memory));
    return out;
  }
  if (v instanceof Date) out = new Date(v.getTime());
  else if (v instanceof RegExp) out = new RegExp(v.source, v.flags);
  else if (v instanceof Error) {
    const name = String(v.name);
    out = new (ERRORS[name] ?? Error)();
    memory.set(v, out);
    if (Object.prototype.hasOwnProperty.call(v, "message")) {
      Object.defineProperty(out, "message", { value: String(v.message), writable: true, configurable: true });
    }
    if (typeof v.stack === "string") {
      Object.defineProperty(out, "stack", { value: v.stack, writable: true, configurable: true });
    }
    if (Object.prototype.hasOwnProperty.call(v, "cause")) {
      Object.defineProperty(out, "cause", { value: cloneValue(v.cause, memory), writable: true, configurable: true });
    }
    return out;
  } else {
    const tag = Object.prototype.toString.call(v);
    switch (tag) {
      case "[object Boolean]":
        out = Object(Boolean.prototype.valueOf.call(v));
        break;
      case "[object Number]":
        out = Object(Number.prototype.valueOf.call(v));
        break;
      case "[object String]":
        out = Object(String.prototype.valueOf.call(v));
        break;
      case "[object BigInt]":
        out = Object(BigInt.prototype.valueOf.call(v));
        break;
      case "[object SharedArrayBuffer]":
        out = v;
        break;
      default:
        if (
          v instanceof Promise || v instanceof WeakMap || v instanceof WeakSet || v instanceof WeakRef ||
          v instanceof FinalizationRegistry
        ) {
          uncloneable(`#<${v.constructor.name}>`);
        }
        // Any other object: its own enumerable string-keyed properties.
        out = {};
        memory.set(v, out);
        for (const k of Object.keys(v)) out[k] = cloneValue(v[k], memory);
        return out;
    }
  }
  memory.set(v, out);
  return out;
}

export interface StructuredSerializeOptions {
  transfer?: any[];
}

export function structuredClone<T>(value: T, options?: StructuredSerializeOptions): T {
  if (arguments.length === 0) throw new TypeError("structuredClone requires 1 argument");
  const transfer = options?.transfer ?? [];
  const seen = new Set<any>();
  for (const t of transfer) {
    if (!(t instanceof ArrayBuffer)) uncloneable(String(t));
    if (seen.has(t)) throw new DOMException("ArrayBuffer is duplicated in the transfer list", "DataCloneError");
    seen.add(t);
  }
  const out = cloneValue(value, new Map());
  // The clone has the contents; the transferred buffers are detached.
  for (const t of transfer) (t as any).transfer();
  return out;
}
