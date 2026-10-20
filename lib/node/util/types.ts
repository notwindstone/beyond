// node:util/types, as Bun's (src/jsc/modules/NodeUtilTypesModule.cpp): what
// kind of value something is, by the engine's class of the object (which a
// prototype or Symbol.toStringTag cannot fake), as Node's checks are.

import { classId, isAsyncFunction as nativeIsAsyncFunction, isProxy as nativeIsProxy } from "beyond:native";

function cls(value: unknown): number {
  return classId(value) as number;
}

// The classes of objects of each kind, as the engine numbers them.
const ARGUMENTS = cls((function (_a: unknown) {
  return arguments;
})(0));
const STRICT_ARGUMENTS = cls((function (this: unknown) {
  "use strict";
  return arguments;
})());
const ERROR = cls(new Error());
const DATE = cls(new Date(0));
const REGEXP = cls(/x/);
const NUMBER = cls(Object(0));
const STRING = cls(Object(""));
const BOOLEAN = cls(Object(false));
const SYMBOL = cls(Object(Symbol()));
const BIGINT = cls(Object(0n));
const MAP = cls(new Map());
const SET = cls(new Set());
const WEAKMAP = cls(new WeakMap());
const WEAKSET = cls(new WeakSet());
const MAP_ITERATOR = cls(new Map().entries());
const SET_ITERATOR = cls(new Set().values());
const PROMISE = cls(Promise.resolve());
const ARRAY_BUFFER = cls(new ArrayBuffer(0));
const SHARED_ARRAY_BUFFER = typeof SharedArrayBuffer === "function" ? cls(new SharedArrayBuffer(0)) : -1;
const DATA_VIEW = cls(new DataView(new ArrayBuffer(0)));
const GENERATOR = cls(
  (function* () {
    yield 0;
  })(),
);
const ASYNC_GENERATOR = cls(
  (async function* () {
    yield 0;
  })(),
);
const GENERATOR_FUNCTION = cls(function* () {
  yield 0;
});
const ASYNC_GENERATOR_FUNCTION = cls(async function* () {
  yield 0;
});
const UINT8 = cls(new Uint8Array(0));
const UINT8C = cls(new Uint8ClampedArray(0));
const UINT16 = cls(new Uint16Array(0));
const UINT32 = cls(new Uint32Array(0));
const INT8 = cls(new Int8Array(0));
const INT16 = cls(new Int16Array(0));
const INT32 = cls(new Int32Array(0));
const FLOAT16 = typeof (globalThis as any).Float16Array === "function" ? cls(new (globalThis as any).Float16Array(0)) : -1;
const FLOAT32 = cls(new Float32Array(0));
const FLOAT64 = cls(new Float64Array(0));
const BIGINT64 = cls(new BigInt64Array(0));
const BIGUINT64 = cls(new BigUint64Array(0));
const TYPED_LOW = Math.min(UINT8, UINT8C, UINT16, UINT32, INT8, INT16, INT32, FLOAT32, FLOAT64, BIGINT64, BIGUINT64);
const TYPED_HIGH = Math.max(UINT8, UINT8C, UINT16, UINT32, INT8, INT16, INT32, FLOAT32, FLOAT64, BIGINT64, BIGUINT64, FLOAT16);
let MODULE_NS = -1;

/** The class of module namespace objects (set by node:util's first use of
 * one: a namespace is not to be made here). */
export function setModuleNamespaceClass(ns: object): void {
  MODULE_NS = cls(ns);
}

export function isExternal(_value: unknown): boolean {
  return false;
}

export function isDate(value: unknown): boolean {
  return cls(value) === DATE;
}

export function isArgumentsObject(value: unknown): boolean {
  const c = cls(value);
  return c === ARGUMENTS || c === STRICT_ARGUMENTS;
}

export function isBigIntObject(value: unknown): boolean {
  return cls(value) === BIGINT;
}

export function isBooleanObject(value: unknown): boolean {
  return cls(value) === BOOLEAN;
}

export function isNumberObject(value: unknown): boolean {
  return cls(value) === NUMBER;
}

export function isStringObject(value: unknown): boolean {
  return cls(value) === STRING;
}

export function isSymbolObject(value: unknown): boolean {
  return cls(value) === SYMBOL;
}

export function isNativeError(value: unknown): boolean {
  return cls(value) === ERROR;
}

export function isRegExp(value: unknown): boolean {
  return cls(value) === REGEXP;
}

export function isAsyncFunction(value: unknown): boolean {
  if (typeof value !== "function") return false;
  return (nativeIsAsyncFunction(value) as boolean) || cls(value) === ASYNC_GENERATOR_FUNCTION;
}

export function isGeneratorFunction(value: unknown): boolean {
  const c = cls(value);
  return c === GENERATOR_FUNCTION || c === ASYNC_GENERATOR_FUNCTION;
}

export function isGeneratorObject(value: unknown): boolean {
  const c = cls(value);
  return c === GENERATOR || c === ASYNC_GENERATOR;
}

export function isPromise(value: unknown): boolean {
  return cls(value) === PROMISE;
}

export function isMap(value: unknown): boolean {
  return cls(value) === MAP;
}

export function isSet(value: unknown): boolean {
  return cls(value) === SET;
}

export function isMapIterator(value: unknown): boolean {
  return cls(value) === MAP_ITERATOR;
}

export function isSetIterator(value: unknown): boolean {
  return cls(value) === SET_ITERATOR;
}

export function isWeakMap(value: unknown): boolean {
  return cls(value) === WEAKMAP;
}

export function isWeakSet(value: unknown): boolean {
  return cls(value) === WEAKSET;
}

export function isArrayBuffer(value: unknown): boolean {
  return cls(value) === ARRAY_BUFFER;
}

export function isDataView(value: unknown): boolean {
  return cls(value) === DATA_VIEW;
}

export function isSharedArrayBuffer(value: unknown): boolean {
  return cls(value) === SHARED_ARRAY_BUFFER;
}

export function isProxy(value: unknown): boolean {
  return nativeIsProxy(value) as boolean;
}

export function isModuleNamespaceObject(value: unknown): boolean {
  return MODULE_NS !== -1 && cls(value) === MODULE_NS;
}

export function isAnyArrayBuffer(value: unknown): boolean {
  const c = cls(value);
  return c === ARRAY_BUFFER || c === SHARED_ARRAY_BUFFER;
}

export function isBoxedPrimitive(value: unknown): boolean {
  const c = cls(value);
  return c === NUMBER || c === STRING || c === BOOLEAN || c === SYMBOL || c === BIGINT;
}

export function isArrayBufferView(value: unknown): boolean {
  return ArrayBuffer.isView(value);
}

export function isTypedArray(value: unknown): boolean {
  const c = cls(value);
  return c >= TYPED_LOW && c <= TYPED_HIGH && c !== DATA_VIEW;
}

export function isUint8Array(value: unknown): boolean {
  return cls(value) === UINT8;
}

export function isUint8ClampedArray(value: unknown): boolean {
  return cls(value) === UINT8C;
}

export function isUint16Array(value: unknown): boolean {
  return cls(value) === UINT16;
}

export function isUint32Array(value: unknown): boolean {
  return cls(value) === UINT32;
}

export function isInt8Array(value: unknown): boolean {
  return cls(value) === INT8;
}

export function isInt16Array(value: unknown): boolean {
  return cls(value) === INT16;
}

export function isInt32Array(value: unknown): boolean {
  return cls(value) === INT32;
}

export function isFloat16Array(value: unknown): boolean {
  return cls(value) === FLOAT16;
}

export function isFloat32Array(value: unknown): boolean {
  return cls(value) === FLOAT32;
}

export function isFloat64Array(value: unknown): boolean {
  return cls(value) === FLOAT64;
}

export function isBigInt64Array(value: unknown): boolean {
  return cls(value) === BIGINT64;
}

export function isBigUint64Array(value: unknown): boolean {
  return cls(value) === BIGUINT64;
}

/** node:crypto's KeyObject class, once node:crypto is loaded. */
let KeyObjectClass: Function | undefined;
export function setKeyObjectClass(c: Function): void {
  KeyObjectClass = c;
}

export function isKeyObject(value: unknown): boolean {
  return KeyObjectClass !== undefined && value instanceof KeyObjectClass;
}

export function isCryptoKey(value: unknown): boolean {
  const CryptoKey = (globalThis as any).CryptoKey;
  return typeof CryptoKey === "function" && value instanceof CryptoKey;
}

export function isEventTarget(value: unknown): boolean {
  return value instanceof EventTarget;
}

export default {
  isExternal,
  isDate,
  isArgumentsObject,
  isBigIntObject,
  isBooleanObject,
  isNumberObject,
  isStringObject,
  isSymbolObject,
  isNativeError,
  isRegExp,
  isAsyncFunction,
  isGeneratorFunction,
  isGeneratorObject,
  isPromise,
  isMap,
  isSet,
  isMapIterator,
  isSetIterator,
  isWeakMap,
  isWeakSet,
  isArrayBuffer,
  isDataView,
  isSharedArrayBuffer,
  isProxy,
  isModuleNamespaceObject,
  isAnyArrayBuffer,
  isBoxedPrimitive,
  isArrayBufferView,
  isTypedArray,
  isUint8Array,
  isUint8ClampedArray,
  isUint16Array,
  isUint32Array,
  isInt8Array,
  isInt16Array,
  isInt32Array,
  isFloat16Array,
  isFloat32Array,
  isFloat64Array,
  isBigInt64Array,
  isBigUint64Array,
  isKeyObject,
  isCryptoKey,
  isEventTarget,
};
