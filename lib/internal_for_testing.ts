// bun:internal-for-testing (Bun's src/js/internal-for-testing.ts), the part
// Node's tests use through their common module: `exposedInternals`, the
// node-internal modules a test with `// Flags: --expose-internals` requires
// (served by common/index.js's require interceptor), each loaded when
// first read. Available with --expose-internals, as Bun's release builds
// have it.

/** A module's default export, else its namespace. */
function def(m: any): any {
  return m?.default ?? m;
}

function nodeNormalizeEncoding(enc: unknown): string | undefined {
  if (enc == null) return "utf8";
  if (typeof enc !== "string") return undefined;
  const lower = enc.toLowerCase();
  if (lower === "utf-16le") return "utf16le";
  if (lower === "buffer" || lower === "utf16-le") return undefined;
  return import.meta.require("node:internal/bindings/node_util_binding").normalizeEncoding(enc);
}

// (Node's lib/internal/util.js: countBinaryOnes, getCIDR.)
function countBinaryOnes(n: number): number {
  n = n - ((n >>> 1) & 0x55555555);
  n = (n & 0x33333333) + ((n >>> 2) & 0x33333333);
  return (((n + (n >>> 4)) & 0xf0f0f0f) * 0x1010101) >>> 24;
}

function getCIDR(address: string, netmask: string, family: string): string | null {
  let ones = 0;
  let split = ".";
  let range = 10;
  let groupLength = 8;
  let hasZeros = false;
  let lastPos = 0;
  if (family === "IPv6") {
    split = ":";
    range = 16;
    groupLength = 16;
  }
  for (let i = 0; i < netmask.length; i++) {
    if (netmask[i] !== split) {
      if (i + 1 < netmask.length) continue;
      i++;
    }
    const part = netmask.slice(lastPos, i);
    lastPos = i + 1;
    if (part !== "") {
      if (hasZeros) {
        if (part !== "0") return null;
      } else {
        const binary = Number.parseInt(part, range);
        const binaryOnes = countBinaryOnes(binary);
        ones += binaryOnes;
        if (binaryOnes !== groupLength) {
          if ((binary & 1) !== 0) return null;
          hasZeros = true;
        }
      }
    }
  }
  return `${address}/${ones}`;
}

function assignFunctionName(name: any, fn: Function, descriptor: object = {}): Function {
  if (typeof name !== "string") {
    const symbolDescription = name.description;
    if (symbolDescription === undefined) throw new Error("Attempted to name function after descriptionless Symbol");
    name = `[${symbolDescription}]`;
  }
  return Object.defineProperty(fn, "name", {
    __proto__: null,
    writable: false,
    enumerable: false,
    configurable: true,
    ...Object.getOwnPropertyDescriptor(fn, "name"),
    ...descriptor,
    value: name,
  } as PropertyDescriptor);
}

/** Node's internal WeakReference: a WeakRef pinning its target while referenced. */
class WeakReference {
  #ref: WeakRef<object>;
  #strong: object | null = null;
  #refCount = 0;
  constructor(object: object) {
    this.#ref = new WeakRef(object);
  }
  get(): object | undefined {
    return this.#strong ?? this.#ref.deref();
  }
  incRef(): void {
    if (++this.#refCount === 1) this.#strong = this.#ref.deref() ?? null;
  }
  decRef(): void {
    if (--this.#refCount === 0) this.#strong = null;
  }
}

const cached: Record<string, unknown> = Object.create(null);

function lazy(name: string, make: () => unknown): void {
  Object.defineProperty(exposedInternals, name, {
    get: () => (name in cached ? cached[name] : (cached[name] = make())),
    enumerable: true,
    configurable: true,
  });
}

export const exposedInternals: Record<string, unknown> = {};
lazy("internal/streams/add-abort-signal", () => def(import.meta.require("node:internal/streams/add-abort-signal")));
lazy("internal/util/debuglog", () => def(import.meta.require("node:internal/util/debuglog")));
lazy("internal/async_context_frame", () => def(import.meta.require("node:internal/async_context_frame")));
lazy("internal/async_hooks", () => def(import.meta.require("node:internal/async_hooks")));
lazy("internal/webstreams/adapters", () => def(import.meta.require("node:internal/webstreams_adapters")));
lazy("internal/dgram", () => def(import.meta.require("node:internal/dgram")));
lazy("internal/validators", () => def(import.meta.require("node:internal/validators")));
lazy("internal/util/inspect", () => def(import.meta.require("node:internal/util/inspect")));
lazy("internal/freelist", () => def(import.meta.require("node:internal/freelist")));
lazy("internal/fixed_queue", () => def(import.meta.require("node:internal/fixed_queue")).FixedQueue);
lazy("internal/assert/myers_diff", () => def(import.meta.require("node:internal/assert/myers_diff")));
lazy("internal/errors", () => def(import.meta.require("node:internal/errors")));
lazy("internal/util", () => ({
  normalizeEncoding: nodeNormalizeEncoding,
  assertCrypto() {},
  getCIDR,
  isError: (e: unknown) => import.meta.require("node:util/types").default.isNativeError(e) || e instanceof Error,
  assignFunctionName,
  kEnumerableProperty: Object.freeze({ __proto__: null, enumerable: true }),
  kEmptyObject: def(import.meta.require("node:internal/shared")).kEmptyObject,
  WeakReference,
}));
lazy("internal/event_target", () => ({
  Event: globalThis.Event,
  CustomEvent: globalThis.CustomEvent,
  EventTarget: globalThis.EventTarget,
  kWeakHandler: def(import.meta.require("node:internal/shared")).kWeakHandler,
}));
lazy("internal/child_process", () => ({ ChildProcess: def(import.meta.require("node:child_process")).ChildProcess }));
lazy("internal/fs/utils", () => {
  // (The parsers fs's own calls use.)
  const b = import.meta.require("node:internal/bindings/node_fs_binding");
  return { stringToFlags: b.stringToFlagsForTesting, validateRmOptionsSync: b.rmOptionsForTesting };
});

export const isASANEnabled = false;

export default { exposedInternals, isASANEnabled };
