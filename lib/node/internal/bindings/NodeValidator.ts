// Bun's validators in C++ (src/jsc/bindings/NodeValidator.cpp), for
// internal/validators: the same checks, defaults and errors (Bun's, where
// they are not Node's: `must be of type AbortSignal`, the port as it is in
// ERR_SOCKET_BAD_PORT, ...).
//
// Every fs, Buffer and stream call goes through these, so a value that passes
// costs only `typeof` tests and comparisons: errors are made only on the
// failure path.

import {
  $ERR_INVALID_ARG_TYPE,
  $ERR_INVALID_ARG_VALUE,
  $ERR_OUT_OF_RANGE,
  $ERR_SOCKET_BAD_PORT,
  codedTypeError,
  determineSpecificType,
  inspectValue,
} from "./../errcodes.ts";

const ArrayIsArray = Array.isArray;
const ArrayBufferIsView = ArrayBuffer.isView;
const TypedArrayLength = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), "length")!.get!;

// The flags of validateObject's options (internal/validators's
// kValidateObject*, Node's).
const kValidateObjectAllowNullable = 1;
const kValidateObjectAllowArray = 2;
const kValidateObjectAllowFunction = 4;

/** `>= min && <= max`: the range validateInteger, Int32, Uint32 and Number state. */
function conjunctiveRange(min: number, max: number): string {
  return `>= ${min} && <= ${max}`;
}

/** Bun's ERR::INVALID_ARG_INSTANCE: `The "name" argument must be an instance of X. Received ...` */
function invalidArgInstance(name: string, expected: string, value: unknown): Error {
  const type = name.indexOf(".") !== -1 ? "property" : "argument";
  return codedTypeError(
    "ERR_INVALID_ARG_TYPE",
    `The "${name}" ${type} must be an instance of ${expected}. Received ${determineSpecificType(value)}`,
  );
}

/** validateObject(value, name[, flags]): an object, null, an array or a function as `flags` allow. */
export function jsFunction_validateObject(value: unknown, name: unknown, options?: unknown): void {
  // (Only an int32 is flags.)
  const flags = typeof options === "number" && (options | 0) === options ? options : 0;
  if (typeof value === "object" && value !== null) {
    if ((flags & kValidateObjectAllowArray) !== 0 || !ArrayIsArray(value)) return;
    throw $ERR_INVALID_ARG_TYPE(name, "object", value);
  }
  if (value === null) {
    if ((flags & kValidateObjectAllowNullable) !== 0) return;
  } else if (typeof value === "function") {
    if ((flags & kValidateObjectAllowFunction) !== 0) return;
  }
  throw $ERR_INVALID_ARG_TYPE(name, "object", value);
}

/** validateInteger(value, name, min = MIN_SAFE_INTEGER, max = MAX_SAFE_INTEGER) */
export function jsFunction_validateInteger(value: unknown, name: unknown, min?: unknown, max?: unknown): void {
  if (typeof value !== "number") throw $ERR_INVALID_ARG_TYPE(name, "number", value);
  const lower = min === undefined ? -9007199254740991 : +(min as any);
  let upper = max === undefined ? 9007199254740991 : +(max as any);
  // (As std::max: the lower bound when the upper one is less, or NaN.)
  if (!(lower < upper)) upper = lower;
  if (value % 1 !== 0) throw $ERR_OUT_OF_RANGE(name, "an integer", value);
  if (value < lower || value > upper) throw $ERR_OUT_OF_RANGE(name, conjunctiveRange(lower, upper), value);
}

/** validateNumber(value, name, min, max): bounds that are null or undefined are not checked. */
export function jsFunction_validateNumber(value: unknown, name: unknown, min?: unknown, max?: unknown): void {
  if (typeof value !== "number") throw $ERR_INVALID_ARG_TYPE(name, "number", value);
  // (Both converted, as Bun does, before either is checked.)
  const lower = min === undefined ? NaN : +(min as any);
  const upper = max === undefined ? NaN : +(max as any);
  const hasMin = min !== undefined && min !== null;
  const hasMax = max !== undefined && max !== null;
  if ((hasMin && value < lower) || (hasMax && value > upper) || ((hasMin || hasMax) && value !== value)) {
    if (hasMin && hasMax) throw $ERR_OUT_OF_RANGE(name, conjunctiveRange(lower, upper), value);
    if (hasMin) throw $ERR_OUT_OF_RANGE(name, `>= ${lower}`, value);
    throw $ERR_OUT_OF_RANGE(name, `<= ${upper}`, value);
  }
}

/** validateFiniteNumber(number, name): true for a finite number, false for undefined and NaN. */
export function jsFunction_validateFiniteNumber(number: unknown, name: unknown): boolean {
  if (number === undefined) return false;
  if (typeof number === "number") {
    if (number !== number) return false;
    if (number !== Infinity && number !== -Infinity) return true;
    throw $ERR_OUT_OF_RANGE(name, "a finite number", number);
  }
  throw $ERR_INVALID_ARG_TYPE(name, "number", number);
}

/** checkRangesOrGetDefault(number, name, lower, upper, def): `number` in [lower, upper], or `def` when it is not finite. */
export function jsFunction_checkRangesOrGetDefault(
  number: unknown,
  name: unknown,
  lower: unknown,
  upper: unknown,
  def?: unknown,
): unknown {
  if (!jsFunction_validateFiniteNumber(number, name)) return def;
  const n = number as number;
  const min = +(lower as any);
  const max = +(upper as any);
  if (n < min || n > max) throw $ERR_OUT_OF_RANGE(name, `>= ${min} and <= ${max}`, number);
  return number;
}

/** Whether `c` is what Bun's validatePort trims: ECMAScript's white space and line terminators, and U+0085. */
function isPortSpace(c: number): boolean {
  if (c <= 0x20) return c === 0x20 || (c >= 0x09 && c <= 0x0d);
  return (
    c === 0x85 ||
    c === 0xa0 ||
    c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 ||
    c === 0x2029 ||
    c === 0x202f ||
    c === 0x205f ||
    c === 0xfeff
  );
}

function badPort(name: unknown, port: unknown, allowZero: boolean): Error {
  return $ERR_SOCKET_BAD_PORT(
    `${inspectValue(name, false)} should be ${allowZero ? ">=" : ">"} 0 and < 65536. Received ${inspectValue(port, false)}`,
  );
}

/**
 * validatePort(port, name = "Port", allowZero = true): a number, or a string
 * of one, that is an integer in [0, 65535] (but 0 unless allowed); the port as
 * it was given.
 */
export function jsFunction_validatePort(port: unknown, name?: unknown, allowZero?: unknown): unknown {
  if (name === undefined) name = "Port";
  const zero = allowZero === undefined ? true : !!allowZero;
  let n: number;
  if (typeof port === "number") {
    n = port;
  } else if (typeof port === "string") {
    let i = 0;
    while (i < port.length && isPortSpace(port.charCodeAt(i))) i++;
    if (i === port.length) throw badPort(name, port, zero);
    n = +port;
  } else {
    throw badPort(name, port, zero);
  }
  // (NaN and the infinities are not integers.)
  if (n % 1 !== 0 || n < 0 || n > 0xffff || (n === 0 && !zero)) throw badPort(name, port, zero);
  return port;
}

/** validateAbortSignal(signal, name): undefined, or an object with `aborted` (an AbortSignal). */
export function jsFunction_validateAbortSignal(signal: unknown, name: unknown): void {
  if (signal === undefined) return;
  if ((typeof signal === "object" && signal !== null) || typeof signal === "function") {
    if ("aborted" in (signal as object)) return;
  }
  throw $ERR_INVALID_ARG_TYPE(name, "AbortSignal", signal);
}

/** validateArray(value, name, minLength = 0) */
export function jsFunction_validateArray(value: unknown, name: unknown, minLength?: unknown): void {
  if (!ArrayIsArray(value)) throw invalidArgInstance(`${name}`, "Array", value);
  const length = +(value.length as any);
  const min = minLength === undefined ? 0 : +(minLength as any);
  if (length < min) {
    // (Bun's: the name as determineSpecificType describes it.)
    throw codedTypeError(
      "ERR_INVALID_ARG_VALUE",
      `The argument '${determineSpecificType(name)}' must be longer than ${min}. Received ${inspectValue(value, true)}`,
    );
  }
}

/** validateInt32(value, name, min = -2 ** 31, max = 2 ** 31 - 1) */
export function jsFunction_validateInt32(value: unknown, name: unknown, min?: unknown, max?: unknown): void {
  if (min === undefined && max === undefined && typeof value === "number" && (value | 0) === value) return;
  if (typeof value !== "number") throw $ERR_INVALID_ARG_TYPE(name, "number", value);
  const lower = min === undefined ? -2147483648 : +(min as any);
  const upper = max === undefined ? 2147483647 : +(max as any);
  if (value % 1 !== 0) throw $ERR_OUT_OF_RANGE(name, "an integer", value);
  if (value < lower || value > upper) throw $ERR_OUT_OF_RANGE(name, conjunctiveRange(lower, upper), value);
}

/** validateUint32(value, name, positive = false): an integer in [0, 2 ** 32 - 1] ([1, ...] if positive). */
export function jsFunction_validateUint32(value: unknown, name: unknown, positive?: unknown): void {
  if (typeof value !== "number") throw $ERR_INVALID_ARG_TYPE(name, "number", value);
  if (value % 1 !== 0) throw $ERR_OUT_OF_RANGE(name, "an integer", value);
  const min = positive ? 1 : 0;
  if (value < min || value > 4294967295) throw $ERR_OUT_OF_RANGE(name, conjunctiveRange(min, 4294967295), value);
}

/** The length validateEncoding checks: a string's, a typed array's, a buffer's bytes, an object's `length`. */
function dataLength(data: unknown): number {
  if (typeof data === "string") return data.length;
  if (typeof data !== "object" || data === null) {
    if (typeof data !== "function") return 0;
  } else if (ArrayBufferIsView(data)) {
    return data instanceof DataView ? data.byteLength : (TypedArrayLength.call(data) as number);
  } else if (data instanceof ArrayBuffer || (typeof SharedArrayBuffer === "function" && data instanceof SharedArrayBuffer)) {
    return (data as ArrayBuffer).byteLength;
  }
  // (ToLength.)
  const n = +((data as any).length as any);
  if (!(n > 0)) return 0;
  return n < 9007199254740991 ? Math.floor(n) : 9007199254740991;
}

/** validateEncoding(data, encoding): hex data of even length. */
export function jsFunction_validateEncoding(data: unknown, encoding: unknown): void {
  if (typeof encoding !== "string" || encoding.length !== 3) return;
  // ("hex" in any case.)
  if (
    (encoding.charCodeAt(0) | 0x20) !== 0x68 ||
    (encoding.charCodeAt(1) | 0x20) !== 0x65 ||
    (encoding.charCodeAt(2) | 0x20) !== 0x78
  ) {
    return;
  }
  const length = dataLength(data);
  if (length % 2 !== 0) throw $ERR_INVALID_ARG_VALUE("encoding", encoding, `is invalid for data of length ${length}`);
}

/** validateBuffer(buffer, name = "buffer"): undefined, or a typed array or DataView. */
export function jsFunction_validateBuffer(buffer: unknown, name?: unknown): void {
  if (buffer === undefined || ArrayBufferIsView(buffer)) return;
  throw invalidArgInstance(name === undefined ? "buffer" : `${name}`, "Buffer, TypedArray, or DataView", buffer);
}

/** SameValue (Object.is). */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return a !== 0 || 1 / (a as number) === 1 / (b as number);
  return a !== a && b !== b;
}

/** validateOneOf(value, name, oneOf): `value` is one of the array `oneOf` (SameValue). */
export function jsFunction_validateOneOf(value: unknown, name: unknown, oneOf: unknown): void {
  if (!ArrayIsArray(oneOf)) throw $ERR_INVALID_ARG_TYPE("values", "Array", oneOf);
  const length = oneOf.length;
  for (let i = 0; i < length; i++) {
    if (sameValue(value, oneOf[i])) return;
  }
  // `The argument 'name' must be one of: 'a', 'b'. Received 'c'`
  const n = inspectValue(name, false);
  let message = `The ${n.indexOf(".") !== -1 ? "property" : "argument"} '${n}' must be one of: `;
  for (let i = 0; i < length; i++) {
    const item = oneOf[i];
    message += typeof item === "string" ? `'${item}'` : inspectValue(item, false);
    if (i < length - 1) message += ", ";
  }
  throw codedTypeError("ERR_INVALID_ARG_VALUE", `${message}. Received ${inspectValue(value, true)}`);
}
