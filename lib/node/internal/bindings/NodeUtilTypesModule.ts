// Natives of Bun's NodeUtilTypesModule: deep equality (Node's algorithm:
// node:internal/util/deep_equal), util.isError, and the iterator checks.

import { isDeepStrictEqual, isPartialStrictEqual } from "node:internal/util/deep_equal";
import { isMapIterator, isNativeError, isSetIterator } from "node:util/types";

export function jsFunctionIsDeepStrictEqual(a: unknown, b: unknown, skipPrototype?: unknown): boolean {
  return isDeepStrictEqual(a, b, skipPrototype);
}

export function jsFunctionPartialDeepStrictEqual(actual: unknown, expected: unknown): boolean {
  return isPartialStrictEqual(actual, expected);
}

/** util.isError: a native error, or an object whose tag says Error. */
export function jsFunctionIsError(e: unknown): boolean {
  return isNativeError(e) || Object.prototype.toString.call(e) === "[object Error]" || e instanceof Error;
}

export function jsFunctionIsMapIterator(v: unknown): boolean {
  return isMapIterator(v);
}

export function jsFunctionIsSetIterator(v: unknown): boolean {
  return isSetIterator(v);
}
