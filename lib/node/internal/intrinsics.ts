// The intrinsics of Bun's engine (JavaScriptCore's `@` names, which Bun's
// Node.js modules write `$isCallable`, `$toClass`, ...) as Beyond has them:
// what Bun's modules import (scripts: crates/bun-import), as plain
// functions that Luminous compiles and inlines, and natives of QuickJS-NG's
// where JavaScript cannot tell (a promise's state, a proxy's target).

import {
  isProxy as nativeIsProxy,
  promiseMarkHandled,
  promiseResult,
  promiseState,
  proxyHandler,
  proxyTarget,
} from "beyond:native";
import constants from "./bindings/constants.ts";
import Dequeue from "./fifo.ts";

export * from "./errcodes.ts";

export const $Array = Array;
export const $Promise = Promise;
/** Bun's internal Buffer constructor: a view of an ArrayBuffer (`new
 * $Buffer(ab, offset, length)`) or a copy of an array, without Buffer()'s
 * checks (node:buffer's FastBuffer, its species; read when called, as
 * Buffer comes after this module). */
export function $Buffer(a?: any, b?: any, c?: any): any {
  return new ((globalThis as any).Buffer[Symbol.species])(a, b, c);
}

export function $isCallable(value: unknown): boolean {
  return typeof value === "function";
}

export const $isArray = Array.isArray;
export const $isJSArray = Array.isArray;

export function $isObject(value: unknown): boolean {
  return value !== null && (typeof value === "object" || typeof value === "function");
}

export function $isUndefinedOrNull(value: unknown): boolean {
  return value === undefined || value === null;
}

export function $isPromise(value: unknown): boolean {
  return value instanceof Promise;
}

export function $isMap(value: unknown): boolean {
  return value instanceof Map;
}

export function $isSet(value: unknown): boolean {
  return value instanceof Set;
}

export function $isRegExpObject(value: unknown): boolean {
  return value instanceof RegExp;
}

export function $isProxyObject(value: unknown): boolean {
  return nativeIsProxy(value) as boolean;
}

export const $proxyFieldTarget = 0;
export const $proxyFieldHandler = 1;

/** `$getProxyInternalField(proxy, $proxyFieldTarget)`: its target or handler. */
export function $getProxyInternalField(proxy: object, field: number): unknown {
  return field === 0 ? proxyTarget(proxy) : proxyHandler(proxy);
}

export function $isTypedArrayView(value: unknown): boolean {
  return ArrayBuffer.isView(value);
}

export const $isFinite = isFinite;

export function $inheritsReadableStream(value: unknown): boolean {
  return value instanceof ReadableStream;
}

export function $inheritsWritableStream(value: unknown): boolean {
  return value instanceof WritableStream;
}

export function $inheritsTransformStream(value: unknown): boolean {
  return value instanceof TransformStream;
}

export function $inheritsBlob(value: unknown): boolean {
  return value instanceof Blob;
}

export function $toLength(value: number): number {
  const n = Math.trunc(Number(value));
  if (!(n > 0)) return 0;
  return n < Number.MAX_SAFE_INTEGER ? n : Number.MAX_SAFE_INTEGER;
}

export const $min = Math.min;

export function $arrayPush<T>(array: T[], value: T): void {
  array[array.length] = value;
}

export function $newArrayWithSize<T>(size: number): T[] {
  return new Array(size);
}

/** Defines `obj[key]` as a data property, past setters. */
export function $putByValDirect(obj: object, key: PropertyKey, value: unknown): void {
  Object.defineProperty(obj, key, { value, writable: true, enumerable: true, configurable: true });
}

export const $putByIdDirect = $putByValDirect;

// (A private name the converted modules also read as a property, `x.$name`
// — as native-readable.ts does `$bunNativePtr` — is that property.)
export function $putByIdDirectPrivate(obj: object, key: string, value: unknown): void {
  Object.defineProperty(obj, "$" + key, { value, writable: true, configurable: true });
}

export function $getByIdDirectPrivate(obj: any, key: string): unknown {
  return obj["$" + key];
}

export function $getByIdDirect(obj: any, key: PropertyKey): unknown {
  return obj[key];
}

/** Mimics `class X extends base {}` for a function `fn` (Bun's toClass). */
export function $toClass(fn: Function, name: string, base?: Function | null): void {
  const prototype = base ? Object.create(base.prototype) : {};
  Object.defineProperty(prototype, "constructor", { value: fn, writable: true, configurable: true });
  Object.setPrototypeOf(fn, base ?? Function.prototype);
  Object.defineProperty(fn, "prototype", { value: prototype, writable: true });
  Object.defineProperty(fn, "name", { value: name, configurable: true });
}

// ---- Promises ----

const resolvers = new WeakMap<Promise<unknown>, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();

/** A pending promise that `$resolvePromise` and `$rejectPromise` settle. */
export function $newPromise<T = unknown>(): Promise<T> {
  let resolve!: (v: unknown) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res as (v: unknown) => void;
    reject = rej;
  });
  resolvers.set(promise, { resolve, reject });
  return promise;
}

export function $resolvePromise<T>(promise: Promise<T>, value: unknown): void {
  resolvers.get(promise)?.resolve(value);
}

export function $rejectPromise(promise: Promise<unknown>, reason: unknown): void {
  resolvers.get(promise)?.reject(reason);
}

export const $resolvePromiseWithFirstResolvingFunctionCallCheck = $resolvePromise;
export const $rejectPromiseWithFirstResolvingFunctionCallCheck = $rejectPromise;

/** A promise's state, as JavaScriptCore numbers them: pending 0, fulfilled
 * 1, rejected 2. */
export function $peekPromiseStatus(promise: Promise<unknown>): number {
  return promiseState(promise) as number;
}

export function $peekPromiseSettledValue<V>(promise: Promise<V>): V | undefined {
  return promiseResult(promise) as V | undefined;
}

export function $pokePromiseAsHandled(promise: Promise<unknown>): void {
  promiseMarkHandled(promise);
}

// ---- Errors ----

/** An AbortError, as Bun's: an Error named AbortError, code ABORT_ERR. */
export function $makeAbortError(message?: string, options?: { cause?: unknown }): Error {
  const e = new Error(message ?? "The operation was aborted", options) as Error & { code: string };
  e.name = "AbortError";
  e.code = "ABORT_ERR";
  return e;
}

export function $makeTypeError(message: string): TypeError {
  return new TypeError(message);
}

/** An llhttp parse error (`HPE_*`), as Node's: code the name. */
function parseError(code: string) {
  return (message: string) => {
    const e = new Error(message) as Error & { code: string };
    e.code = code;
    return e;
  };
}

export const $HPE_CHUNK_EXTENSIONS_OVERFLOW = parseError("HPE_CHUNK_EXTENSIONS_OVERFLOW");
export const $HPE_CLOSED_CONNECTION = parseError("HPE_CLOSED_CONNECTION");
export const $HPE_HEADER_OVERFLOW = parseError("HPE_HEADER_OVERFLOW");
export const $HPE_INTERNAL = parseError("HPE_INTERNAL");
export const $HPE_INVALID_CHUNK_SIZE = parseError("HPE_INVALID_CHUNK_SIZE");
export const $HPE_INVALID_CONSTANT = parseError("HPE_INVALID_CONSTANT");
export const $HPE_INVALID_CONTENT_LENGTH = parseError("HPE_INVALID_CONTENT_LENGTH");
export const $HPE_INVALID_EOF_STATE = parseError("HPE_INVALID_EOF_STATE");
export const $HPE_INVALID_HEADER_TOKEN = parseError("HPE_INVALID_HEADER_TOKEN");
export const $HPE_INVALID_METHOD = parseError("HPE_INVALID_METHOD");
export const $HPE_INVALID_TRANSFER_ENCODING = parseError("HPE_INVALID_TRANSFER_ENCODING");
export const $HPE_INVALID_VERSION = parseError("HPE_INVALID_VERSION");
export const $HPE_LF_EXPECTED = parseError("HPE_LF_EXPECTED");
export const $HPE_PAUSED_H2_UPGRADE = parseError("HPE_PAUSED_H2_UPGRADE");
export const $HPE_STRICT = parseError("HPE_STRICT");
export const $HPE_UNEXPECTED_CONTENT_LENGTH = parseError("HPE_UNEXPECTED_CONTENT_LENGTH");

/** What Bun's build rejects (code for another platform): thrown if reached. */
export function $bundleError(message: string): never {
  throw new Error(message);
}

// ---- Natives Beyond does not have yet ----

/** A stand-in for Bun's native `symbol` of `module`: any property of it is
 * another stand-in, as is each element it is destructured to, and calling
 * or constructing one throws. */
export function $nativeStub(module: string, symbol: string): any {
  const fail = () => {
    const e = new Error(`Beyond does not implement ${module}.${symbol} yet`) as Error & { code: string };
    e.code = "ERR_NOT_IMPLEMENTED";
    throw e;
  };
  const target = function () {} as any;
  const children = new Map<PropertyKey, unknown>();
  return new Proxy(target, {
    apply: fail,
    construct: fail,
    get(_t, key) {
      // (Not a thenable, a primitive or an instanceof hook: those are read
      // without calling them.)
      if (key === "then" || key === Symbol.toPrimitive || key === Symbol.hasInstance || key === Symbol.toStringTag)
        return undefined;
      if (key === Symbol.iterator) {
        return function* () {
          for (let i = 0; ; i++) yield $nativeStub(module, `${symbol}[${i}]`);
        };
      }
      let child = children.get(key);
      if (child === undefined) children.set(key, (child = $nativeStub(module, `${symbol}.${String(key)}`)));
      return child;
    },
  });
}

// ---- State ----

/** The async context (AsyncLocalStorage's): field 0 is the current frame. */
export const $asyncContext: unknown[] = [undefined];

export function $getInternalField(obj: any, index: number): any {
  return obj[index];
}

export function $putInternalField(obj: any, index: number, value: unknown): void {
  obj[index] = value;
}

export const $processBindingConstants = constants;

/** CommonJS modules required so far, by id (node:module's cache). */
export const $requireMap = new Map<string, { exports: any }>();

/** Natives classes of Bun's (generated from its .classes.ts files). */
export const $ZigGeneratedClasses: any = $nativeStub("ZigGeneratedClasses", "classes");

/** A FIFO queue (Bun's internal/fifo). */
export function $createFIFO(): Dequeue<any> {
  return new Dequeue();
}

/** Web streams' internals (lib/streams.ts). */
export { webStreamClosedPromise as $webStreamClosedPromise, webStreamControllerError as $webStreamControllerError } from "../../streams.ts";
