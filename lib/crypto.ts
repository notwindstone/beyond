// The `crypto` global's random numbers (Web Crypto's getRandomValues and
// randomUUID), from the kernel through a buffer (crates/beyond-rt/native/
// web.c). `crypto.subtle` is not there yet.

import { randomFill, randomUUID as nativeUUID } from "beyond:native";
import { describe, Formatter } from "./inspect.ts";

/** Whether `a` is a typed array of integers (what getRandomValues fills). */
function integerArray(a: unknown): boolean {
  return (
    a instanceof Uint8Array || a instanceof Int8Array || a instanceof Uint8ClampedArray ||
    a instanceof Uint16Array || a instanceof Int16Array || a instanceof Uint32Array || a instanceof Int32Array ||
    a instanceof BigUint64Array || a instanceof BigInt64Array
  );
}

export function getRandomValues<T extends ArrayBufferView | null>(array: T): T {
  if (!integerArray(array)) {
    throw new DOMException("The data argument must be an integer-type TypedArray", "TypeMismatchError");
  }
  const view = array as unknown as ArrayBufferView;
  if (view.byteLength > 65536) {
    throw new DOMException(
      `The ArrayBufferView's byte length (${view.byteLength}) exceeds the number of bytes of entropy available via this API (65536)`,
      "QuotaExceededError",
    );
  }
  randomFill(view);
  return array;
}

export function randomUUID(): `${string}-${string}-${string}-${string}-${string}` {
  return nativeUUID();
}

export class Crypto {
  getRandomValues<T extends ArrayBufferView | null>(array: T): T {
    return getRandomValues(array);
  }

  randomUUID(): `${string}-${string}-${string}-${string}-${string}` {
    return nativeUUID();
  }

  get [Symbol.toStringTag](): string {
    return "Crypto";
  }

  [describe](f: Formatter): void {
    const p = Crypto.prototype;
    f.record("Crypto", [["getRandomValues", p.getRandomValues], ["randomUUID", p.randomUUID]]);
  }
}

export const crypto = new Crypto();
