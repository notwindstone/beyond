// node:buffer: Node's lib/buffer.js of v24.3.0 (MIT, Node.js contributors),
// which Bun's JSBuffer.cpp matches, on Beyond's natives for what Node's
// binding does (crates/beyond-rt/native/buffer.c: encodings, searching,
// filling, comparing, swapping) and node:internal/buffer for the methods
// Node writes in JavaScript. Blob and File are Beyond's.

import {
  bufferByteLength,
  bufferCompare,
  bufferCompareOffset,
  bufferCopy,
  bufferFill,
  bufferIndexOfBuffer,
  bufferIndexOfNumber,
  bufferIndexOfString,
  bufferIsAscii,
  bufferIsUtf8,
  bufferSlice,
  bufferSwap,
} from "beyond:native";
import { Blob, File } from "../blob.ts";
import {
  $ERR_BUFFER_OUT_OF_BOUNDS as ERR_BUFFER_OUT_OF_BOUNDS,
  $ERR_INVALID_ARG_TYPE as ERR_INVALID_ARG_TYPE,
  $ERR_INVALID_ARG_VALUE as ERR_INVALID_ARG_VALUE,
  $ERR_INVALID_BUFFER_SIZE,
  $ERR_MISSING_ARGS as ERR_MISSING_ARGS,
  $ERR_OUT_OF_RANGE as ERR_OUT_OF_RANGE,
  $ERR_UNKNOWN_ENCODING as ERR_UNKNOWN_ENCODING,
} from "node:internal/errcodes";
import {
  FastBuffer,
  markAsUntransferable,
  addBufferPrototypeMethods,
  createUnsafeBuffer,
  validateArray,
  validateBuffer,
  validateInteger,
  validateNumber,
  validateString,
} from "node:internal/buffer";
import { isAnyArrayBuffer, isArrayBufferView, isUint8Array, isTypedArray } from "node:util/types";
import { jsFunctionGetOwnNonIndexProperties as getOwnNonIndexProperties } from "node:internal/bindings/UtilInspect";

// ---- Node's primordials, internal/util and the buffer binding ----

const ArrayBufferIsView = ArrayBuffer.isView;
const ArrayIsArray = Array.isArray;
const ArrayPrototypeForEach = (a, f) => Array.prototype.forEach.call(a, f);
const MathFloor = Math.floor;
const MathMin = Math.min;
const MathTrunc = Math.trunc;
const NumberIsInteger = Number.isInteger;
const NumberIsNaN = Number.isNaN;
const NumberMAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
const NumberMIN_SAFE_INTEGER = Number.MIN_SAFE_INTEGER;
const ObjectDefineProperties = Object.defineProperties;
const ObjectDefineProperty = Object.defineProperty;
const ObjectPrototypeHasOwnProperty = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const ObjectSetPrototypeOf = Object.setPrototypeOf;
const RegExpPrototypeSymbolReplace = (re, s, r) => re[Symbol.replace](s, r);
const StringPrototypeCharCodeAt = (s, i) => s.charCodeAt(i);
const StringPrototypeSlice = (s, a, b) => s.slice(a, b);
const StringPrototypeToLowerCase = (s) => s.toLowerCase();
const StringPrototypeTrim = (s) => s.trim();
const SymbolSpecies = Symbol.species;
const SymbolToPrimitive = Symbol.toPrimitive;
const TypedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const typedArrayGetter = (name) => Object.getOwnPropertyDescriptor(TypedArrayPrototype, name).get;
const getBuffer = typedArrayGetter("buffer");
const getByteLength = typedArrayGetter("byteLength");
const getByteOffset = typedArrayGetter("byteOffset");
const getLength = typedArrayGetter("length");
const TypedArrayPrototypeFill = (a, v, s, e) => TypedArrayPrototype.fill.call(a, v, s, e);
const TypedArrayPrototypeGetBuffer = (a) => getBuffer.call(a);
const TypedArrayPrototypeGetByteLength = (a) => getByteLength.call(a);
const TypedArrayPrototypeGetByteOffset = (a) => getByteOffset.call(a);
const TypedArrayPrototypeGetLength = (a) => getLength.call(a);
const TypedArrayPrototypeSet = (a, src, off) => TypedArrayPrototype.set.call(a, src, off);
const TypedArrayPrototypeSlice = (a, s, e) => TypedArrayPrototype.slice.call(a, s, e);
const Uint8ArrayPrototype = Uint8Array.prototype;

// (The longest buffer and string, as Bun's and the engine's.)
const kMaxLength = 2 ** 32;
const kStringMaxLength = 2 ** 30 - 1;

// Node's encodings, numbered as its binding's (internal/util's encodingsMap).
const encodingsMap = { __proto__: null, ascii: 0, utf8: 1, base64: 2, utf16le: 3, latin1: 4, hex: 5, buffer: 6, base64url: 7 };

const byteLengthUtf8 = (s) => bufferByteLength(s, 1);
const _compare = bufferCompare;
const compareOffset = bufferCompareOffset;
const _copy = bufferCopy;
const bindingFill = bufferFill;
const bindingIsAscii = bufferIsAscii;
const bindingIsUtf8 = bufferIsUtf8;
const indexOfBuffer = bufferIndexOfBuffer;
const indexOfNumber = bufferIndexOfNumber;
const indexOfString = bufferIndexOfString;
const _swap16 = (b) => bufferSwap(b, 2);
const _swap32 = (b) => bufferSwap(b, 4);
const _swap64 = (b) => bufferSwap(b, 8);

const ALL_PROPERTIES = 0;
const ONLY_ENUMERABLE = 2;
const customInspectSymbol = Symbol.for("nodejs.util.inspect.custom");
const kIsEncodingSymbol = Symbol("kIsEncodingSymbol");

// Provide validateInteger() but with kMaxLength as the default maximum value.
const validateOffset = (value, name, min = 0, max = kMaxLength) => validateInteger(value, name, min, max);

function ERR_INVALID_BUFFER_SIZE(size) {
  return $ERR_INVALID_BUFFER_SIZE(`Buffer size must be a multiple of ${size}`);
}

function lazyDOMException(message, name) {
  return new DOMException(message, name);
}

function utilInspect(value, options) {
  return import.meta.require("node:util").inspect(value, options);
}

/** Node's normalizeEncoding: the canonical name, or undefined. */
function normalizeEncoding(enc) {
  if (enc == null || enc === "utf8" || enc === "utf-8") return "utf8";
  switch (`${enc}`.toLowerCase()) {
    case "utf8":
    case "utf-8":
      return "utf8";
    case "ucs2":
    case "ucs-2":
    case "utf16le":
    case "utf-16le":
      return "utf16le";
    case "latin1":
    case "binary":
      return "latin1";
    case "base64":
      return "base64";
    case "base64url":
      return "base64url";
    case "hex":
      return "hex";
    case "ascii":
      return "ascii";
    case "":
      return "utf8";
  }
  return undefined;
}

function deprecate(fn, message, code) {
  let warned = false;
  return function (...args) {
    if (!warned) {
      warned = true;
      process.emitWarning(message, "DeprecationWarning", code);
    }
    return new.target ? Reflect.construct(fn, args, new.target) : fn.apply(this, args);
  };
}

function genericNodeError(message, props) {
  return Object.assign(new Error(message), props);
}

function Buffer(arg, encodingOrOffset, length) {
  // Common case.
  if (typeof arg === 'number') {
    if (typeof encodingOrOffset === 'string') {
      throw new ERR_INVALID_ARG_TYPE('string', 'string', arg);
    }
    return Buffer.alloc(arg);
  }
  return Buffer.from(arg, encodingOrOffset, length);
}

FastBuffer.prototype.constructor = Buffer;
Buffer.prototype = FastBuffer.prototype;
addBufferPrototypeMethods(Buffer.prototype);

const constants = ObjectDefineProperties({}, {
  MAX_LENGTH: {
    __proto__: null,
    value: kMaxLength,
    writable: false,
    enumerable: true,
  },
  MAX_STRING_LENGTH: {
    __proto__: null,
    value: kStringMaxLength,
    writable: false,
    enumerable: true,
  },
});

Buffer.poolSize = 8 * 1024;
let poolSize, poolOffset, allocPool, allocBuffer;

function createPool() {
  poolSize = Buffer.poolSize;
  allocBuffer = createUnsafeBuffer(poolSize);
  allocPool = allocBuffer.buffer;
  markAsUntransferable(allocPool);
  poolOffset = 0;
}
createPool();

function alignPool() {
  // Ensure aligned slices
  if (poolOffset & 0x7) {
    poolOffset |= 0x7;
    poolOffset++;
  }
}

function toInteger(n, defaultVal) {
  n = +n;
  if (!NumberIsNaN(n) &&
      n >= NumberMIN_SAFE_INTEGER &&
      n <= NumberMAX_SAFE_INTEGER) {
    return ((n % 1) === 0 ? n : MathFloor(n));
  }
  return defaultVal;
}

function copyImpl(source, target, targetStart, sourceStart, sourceEnd) {
  if (!ArrayBufferIsView(source))
    throw new ERR_INVALID_ARG_TYPE('source', ['Buffer', 'Uint8Array'], source);
  if (!ArrayBufferIsView(target))
    throw new ERR_INVALID_ARG_TYPE('target', ['Buffer', 'Uint8Array'], target);

  if (targetStart === undefined) {
    targetStart = 0;
  } else {
    targetStart = NumberIsInteger(targetStart) ? targetStart : toInteger(targetStart, 0);
    if (targetStart < 0)
      throw new ERR_OUT_OF_RANGE('targetStart', '>= 0', targetStart);
  }

  if (sourceStart === undefined) {
    sourceStart = 0;
  } else {
    sourceStart = NumberIsInteger(sourceStart) ? sourceStart : toInteger(sourceStart, 0);
    if (sourceStart < 0 || sourceStart > source.byteLength)
      throw new ERR_OUT_OF_RANGE('sourceStart', `>= 0 && <= ${source.byteLength}`, sourceStart);
  }

  if (sourceEnd === undefined) {
    sourceEnd = source.byteLength;
  } else {
    sourceEnd = NumberIsInteger(sourceEnd) ? sourceEnd : toInteger(sourceEnd, 0);
    if (sourceEnd < 0)
      throw new ERR_OUT_OF_RANGE('sourceEnd', '>= 0', sourceEnd);
  }

  if (targetStart >= target.byteLength || sourceStart >= sourceEnd)
    return 0;

  return _copyActual(source, target, targetStart, sourceStart, sourceEnd);
}

function _copyActual(source, target, targetStart, sourceStart, sourceEnd) {
  if (sourceEnd - sourceStart > target.byteLength - targetStart)
    sourceEnd = sourceStart + target.byteLength - targetStart;

  let nb = sourceEnd - sourceStart;
  const sourceLen = source.byteLength - sourceStart;
  if (nb > sourceLen)
    nb = sourceLen;

  if (nb <= 0)
    return 0;

  _copy(source, target, targetStart, sourceStart, nb);

  return nb;
}

ObjectDefineProperty(Buffer, SymbolSpecies, {
  __proto__: null,
  enumerable: false,
  configurable: true,
  get() { return FastBuffer; },
});

/**
 * Functionally equivalent to Buffer(arg, encoding) but throws a TypeError
 * if value is a number.
 * Buffer.from(str[, encoding])
 * Buffer.from(array)
 * Buffer.from(buffer)
 * Buffer.from(arrayBuffer[, byteOffset[, length]])
 */
Buffer.from = function from(value, encodingOrOffset, length) {
  if (typeof value === 'string')
    return fromString(value, encodingOrOffset);

  if (typeof value === 'object' && value !== null) {
    if (isAnyArrayBuffer(value))
      return fromArrayBuffer(value, encodingOrOffset, length);

    const valueOf = value.valueOf && value.valueOf();
    if (valueOf != null &&
        valueOf !== value &&
        (typeof valueOf === 'string' || typeof valueOf === 'object')) {
      return from(valueOf, encodingOrOffset, length);
    }

    const b = fromObject(value);
    if (b)
      return b;

    if (typeof value[SymbolToPrimitive] === 'function') {
      const primitive = value[SymbolToPrimitive]('string');
      if (typeof primitive === 'string') {
        return fromString(primitive, encodingOrOffset);
      }
    }
  }

  throw new ERR_INVALID_ARG_TYPE(
    'first argument',
    ['string', 'Buffer', 'ArrayBuffer', 'Array', 'Array-like Object'],
    value,
  );
};

/**
 * Creates the Buffer as a copy of the underlying ArrayBuffer of the view
 * rather than the contents of the view.
 * @param {TypedArray} view
 * @param {number} [offset]
 * @param {number} [length]
 * @returns {Buffer}
 */
Buffer.copyBytesFrom = function copyBytesFrom(view, offset, length) {
  if (!isTypedArray(view)) {
    throw new ERR_INVALID_ARG_TYPE('view', [ 'TypedArray' ], view);
  }

  const viewLength = TypedArrayPrototypeGetLength(view);
  if (viewLength === 0) {
    return Buffer.alloc(0);
  }

  if (offset !== undefined || length !== undefined) {
    if (offset !== undefined) {
      validateInteger(offset, 'offset', 0);
      if (offset >= viewLength) return Buffer.alloc(0);
    } else {
      offset = 0;
    }
    let end;
    if (length !== undefined) {
      validateInteger(length, 'length', 0);
      end = offset + length;
    } else {
      end = viewLength;
    }

    view = TypedArrayPrototypeSlice(view, offset, end);
  }

  return fromArrayLike(new Uint8Array(
    TypedArrayPrototypeGetBuffer(view),
    TypedArrayPrototypeGetByteOffset(view),
    TypedArrayPrototypeGetByteLength(view)));
};

// Identical to the built-in %TypedArray%.of(), but avoids using the deprecated
// Buffer() constructor. Must use arrow function syntax to avoid automatically
// adding a `prototype` property and making the function a constructor.
//
// Refs: https://tc39.github.io/ecma262/#sec-%typedarray%.of
// Refs: https://esdiscuss.org/topic/isconstructor#content-11
const of = (...items) => {
  const newObj = createUnsafeBuffer(items.length);
  for (let k = 0; k < items.length; k++)
    newObj[k] = items[k];
  return newObj;
};
Buffer.of = of;

ObjectSetPrototypeOf(Buffer, Uint8Array);

/**
 * Creates a new filled Buffer instance.
 * alloc(size[, fill[, encoding]])
 */
Buffer.alloc = function alloc(size, fill, encoding) {
  validateNumber(size, 'size', 0, kMaxLength);
  if (fill !== undefined && fill !== 0 && size > 0) {
    const buf = createUnsafeBuffer(size);
    return _fill(buf, fill, 0, buf.length, encoding);
  }
  return createUnsafeBuffer(size);
};

/**
 * Equivalent to Buffer(num), by default creates a non-zero-filled Buffer
 * instance. If `--zero-fill-buffers` is set, will zero-fill the buffer.
 */
Buffer.allocUnsafe = function allocUnsafe(size) {
  validateNumber(size, 'size', 0, kMaxLength);
  return allocate(size);
};

/**
 * Equivalent to SlowBuffer(num), by default creates a non-zero-filled
 * Buffer instance that is not allocated off the pre-initialized pool.
 * If `--zero-fill-buffers` is set, will zero-fill the buffer.
 */
Buffer.allocUnsafeSlow = function allocUnsafeSlow(size) {
  validateNumber(size, 'size', 0, kMaxLength);
  return createUnsafeBuffer(size);
};

// If --zero-fill-buffers command line argument is set, a zero-filled
// buffer is returned.
function SlowBuffer(size) {
  validateNumber(size, 'size', 0, kMaxLength);
  return createUnsafeBuffer(size);
}

ObjectSetPrototypeOf(SlowBuffer.prototype, Uint8ArrayPrototype);
ObjectSetPrototypeOf(SlowBuffer, Uint8Array);

function allocate(size) {
  if (size <= 0) {
    return new FastBuffer();
  }
  if (size < (Buffer.poolSize >>> 1)) {
    if (size > (poolSize - poolOffset))
      createPool();
    const b = new FastBuffer(allocPool, poolOffset, size);
    poolOffset += size;
    alignPool();
    return b;
  }
  return createUnsafeBuffer(size);
}

function fromStringFast(string, ops) {
  const maxLength = Buffer.poolSize >>> 1;

  let length = string.length; // Min length

  if (length >= maxLength)
    return createFromString(string, ops);

  length *= 4; // Max length (4 bytes per character)

  if (length >= maxLength)
    length = ops.byteLength(string); // Actual length

  if (length >= maxLength)
    return createFromString(string, ops, length);

  if (length > (poolSize - poolOffset))
    createPool();

  const actual = ops.write(allocBuffer, string, poolOffset, length);
  const b = new FastBuffer(allocPool, poolOffset, actual);

  poolOffset += actual;
  alignPool();
  return b;
}

function createFromString(string, ops, length = ops.byteLength(string)) {
  const buf = Buffer.allocUnsafeSlow(length);
  const actual = ops.write(buf, string, 0, length);
  return actual < length ? new FastBuffer(buf.buffer, 0, actual) : buf;
}

function fromString(string, encoding) {
  let ops;
  if (!encoding || encoding === 'utf8' || typeof encoding !== 'string') {
    ops = encodingOps.utf8;
  } else {
    ops = getEncodingOps(encoding);
    if (ops === undefined)
      throw new ERR_UNKNOWN_ENCODING(encoding);
  }

  return string.length === 0 ? new FastBuffer() : fromStringFast(string, ops);
}

function fromArrayBuffer(obj, byteOffset, length) {
  // Convert byteOffset to integer
  if (byteOffset === undefined) {
    byteOffset = 0;
  } else {
    byteOffset = +byteOffset;
    if (NumberIsNaN(byteOffset))
      byteOffset = 0;
  }

  const maxLength = obj.byteLength - byteOffset;

  if (maxLength < 0)
    throw new ERR_BUFFER_OUT_OF_BOUNDS('offset');

  if (length !== undefined) {
    // Convert length to non-negative integer.
    length = +length;
    if (length > 0) {
      if (length > maxLength)
        throw new ERR_BUFFER_OUT_OF_BOUNDS('length');
    } else {
      length = 0;
    }
  }

  return new FastBuffer(obj, byteOffset, length);
}

function fromArrayLike(obj) {
  if (obj.length <= 0)
    return new FastBuffer();
  if (obj.length < (Buffer.poolSize >>> 1)) {
    if (obj.length > (poolSize - poolOffset))
      createPool();
    const b = new FastBuffer(allocPool, poolOffset, obj.length);
    TypedArrayPrototypeSet(b, obj, 0);
    poolOffset += obj.length;
    alignPool();
    return b;
  }
  return new FastBuffer(obj);
}

function fromObject(obj) {
  if (obj.length !== undefined || isAnyArrayBuffer(obj.buffer)) {
    if (typeof obj.length !== 'number') {
      return new FastBuffer();
    }
    return fromArrayLike(obj);
  }

  if (obj.type === 'Buffer' && ArrayIsArray(obj.data)) {
    return fromArrayLike(obj.data);
  }
}

// Static methods

Buffer.isBuffer = function isBuffer(b) {
  return b instanceof Buffer;
};

Buffer.compare = function compare(buf1, buf2) {
  if (!isUint8Array(buf1)) {
    throw new ERR_INVALID_ARG_TYPE('buf1', ['Buffer', 'Uint8Array'], buf1);
  }

  if (!isUint8Array(buf2)) {
    throw new ERR_INVALID_ARG_TYPE('buf2', ['Buffer', 'Uint8Array'], buf2);
  }

  if (buf1 === buf2) {
    return 0;
  }

  return _compare(buf1, buf2);
};

Buffer.isEncoding = function isEncoding(encoding) {
  return typeof encoding === 'string' && encoding.length !== 0 &&
         normalizeEncoding(encoding) !== undefined;
};
Buffer[kIsEncodingSymbol] = Buffer.isEncoding;

Buffer.concat = function concat(list, length) {
  validateArray(list, 'list');

  if (list.length === 0)
    return new FastBuffer();

  if (length === undefined) {
    length = 0;
    for (let i = 0; i < list.length; i++) {
      // (A Uint8Array's own length, not a `length` it may be given.)
      const len = isUint8Array(list[i]) ? TypedArrayPrototypeGetLength(list[i]) : list[i].length;
      if (len) {
        length += len;
      }
    }
  } else {
    validateOffset(length, 'length');
  }

  const buffer = Buffer.allocUnsafe(length);
  let pos = 0;
  for (let i = 0; i < list.length; i++) {
    const buf = list[i];
    if (!isUint8Array(buf)) {
      // TODO(BridgeAR): This should not be of type ERR_INVALID_ARG_TYPE.
      // Instead, find the proper error code for this.
      throw new ERR_INVALID_ARG_TYPE(
        `list[${i}]`, ['Buffer', 'Uint8Array'], list[i]);
    }
    pos += _copyActual(buf, buffer, pos, 0, buf.length);
  }

  // Note: `length` is always equal to `buffer.length` at this point
  if (pos < length) {
    // Zero-fill the remaining bytes if the specified `length` was more than
    // the actual total length, i.e. if we have some remaining allocated bytes
    // there were not initialized.
    TypedArrayPrototypeFill(buffer, 0, pos, length);
  }

  return buffer;
};

function base64ByteLength(str, bytes) {
  // Handle padding
  if (StringPrototypeCharCodeAt(str, bytes - 1) === 0x3D)
    bytes--;
  if (bytes > 1 && StringPrototypeCharCodeAt(str, bytes - 1) === 0x3D)
    bytes--;

  // Base64 ratio: 3/4
  return (bytes * 3) >>> 2;
}

const encodingOps = {
  utf8: {
    encoding: 'utf8',
    encodingVal: encodingsMap.utf8,
    byteLength: byteLengthUtf8,
    write: (buf, string, offset, len) => buf.utf8Write(string, offset, len),
    slice: (buf, start, end) => buf.utf8Slice(start, end),
    indexOf: (buf, val, byteOffset, dir) =>
      indexOfString(buf, val, byteOffset, encodingsMap.utf8, dir),
  },
  ucs2: {
    encoding: 'ucs2',
    encodingVal: encodingsMap.utf16le,
    byteLength: (string) => string.length * 2,
    write: (buf, string, offset, len) => buf.ucs2Write(string, offset, len),
    slice: (buf, start, end) => buf.ucs2Slice(start, end),
    indexOf: (buf, val, byteOffset, dir) =>
      indexOfString(buf, val, byteOffset, encodingsMap.utf16le, dir),
  },
  utf16le: {
    encoding: 'utf16le',
    encodingVal: encodingsMap.utf16le,
    byteLength: (string) => string.length * 2,
    write: (buf, string, offset, len) => buf.ucs2Write(string, offset, len),
    slice: (buf, start, end) => buf.ucs2Slice(start, end),
    indexOf: (buf, val, byteOffset, dir) =>
      indexOfString(buf, val, byteOffset, encodingsMap.utf16le, dir),
  },
  latin1: {
    encoding: 'latin1',
    encodingVal: encodingsMap.latin1,
    byteLength: (string) => string.length,
    write: (buf, string, offset, len) => buf.latin1Write(string, offset, len),
    slice: (buf, start, end) => buf.latin1Slice(start, end),
    indexOf: (buf, val, byteOffset, dir) =>
      indexOfString(buf, val, byteOffset, encodingsMap.latin1, dir),
  },
  ascii: {
    encoding: 'ascii',
    encodingVal: encodingsMap.ascii,
    byteLength: (string) => string.length,
    write: (buf, string, offset, len) => buf.asciiWrite(string, offset, len),
    slice: (buf, start, end) => buf.asciiSlice(start, end),
    indexOf: (buf, val, byteOffset, dir) =>
      indexOfBuffer(buf,
                    fromStringFast(val, encodingOps.ascii),
                    byteOffset,
                    encodingsMap.ascii,
                    dir),
  },
  base64: {
    encoding: 'base64',
    encodingVal: encodingsMap.base64,
    byteLength: (string) => base64ByteLength(string, string.length),
    write: (buf, string, offset, len) => buf.base64Write(string, offset, len),
    slice: (buf, start, end) => buf.base64Slice(start, end),
    indexOf: (buf, val, byteOffset, dir) =>
      indexOfBuffer(buf,
                    fromStringFast(val, encodingOps.base64),
                    byteOffset,
                    encodingsMap.base64,
                    dir),
  },
  base64url: {
    encoding: 'base64url',
    encodingVal: encodingsMap.base64url,
    byteLength: (string) => base64ByteLength(string, string.length),
    write: (buf, string, offset, len) =>
      buf.base64urlWrite(string, offset, len),
    slice: (buf, start, end) => buf.base64urlSlice(start, end),
    indexOf: (buf, val, byteOffset, dir) =>
      indexOfBuffer(buf,
                    fromStringFast(val, encodingOps.base64url),
                    byteOffset,
                    encodingsMap.base64url,
                    dir),
  },
  hex: {
    encoding: 'hex',
    encodingVal: encodingsMap.hex,
    byteLength: (string) => string.length >>> 1,
    write: (buf, string, offset, len) => buf.hexWrite(string, offset, len),
    slice: (buf, start, end) => buf.hexSlice(start, end),
    indexOf: (buf, val, byteOffset, dir) =>
      indexOfBuffer(buf,
                    fromStringFast(val, encodingOps.hex),
                    byteOffset,
                    encodingsMap.hex,
                    dir),
  },
};
function getEncodingOps(encoding) {
  encoding += '';
  switch (encoding.length) {
    case 4:
      if (encoding === 'utf8') return encodingOps.utf8;
      if (encoding === 'ucs2') return encodingOps.ucs2;
      encoding = StringPrototypeToLowerCase(encoding);
      if (encoding === 'utf8') return encodingOps.utf8;
      if (encoding === 'ucs2') return encodingOps.ucs2;
      break;
    case 5:
      if (encoding === 'utf-8') return encodingOps.utf8;
      if (encoding === 'ascii') return encodingOps.ascii;
      if (encoding === 'ucs-2') return encodingOps.ucs2;
      encoding = StringPrototypeToLowerCase(encoding);
      if (encoding === 'utf-8') return encodingOps.utf8;
      if (encoding === 'ascii') return encodingOps.ascii;
      if (encoding === 'ucs-2') return encodingOps.ucs2;
      break;
    case 7:
      if (encoding === 'utf16le' ||
          StringPrototypeToLowerCase(encoding) === 'utf16le')
        return encodingOps.utf16le;
      break;
    case 8:
      if (encoding === 'utf-16le' ||
          StringPrototypeToLowerCase(encoding) === 'utf-16le')
        return encodingOps.utf16le;
      break;
    case 6:
      if (encoding === 'latin1' || encoding === 'binary')
        return encodingOps.latin1;
      if (encoding === 'base64') return encodingOps.base64;
      encoding = StringPrototypeToLowerCase(encoding);
      if (encoding === 'latin1' || encoding === 'binary')
        return encodingOps.latin1;
      if (encoding === 'base64') return encodingOps.base64;
      break;
    case 3:
      if (encoding === 'hex' || StringPrototypeToLowerCase(encoding) === 'hex')
        return encodingOps.hex;
      break;
    case 9:
      if (encoding === 'base64url' ||
          StringPrototypeToLowerCase(encoding) === 'base64url')
        return encodingOps.base64url;
      break;
  }
}

function byteLength(string, encoding) {
  if (typeof string !== 'string') {
    if (isArrayBufferView(string) || isAnyArrayBuffer(string)) {
      return string.byteLength;
    }

    throw new ERR_INVALID_ARG_TYPE(
      'string', ['string', 'Buffer', 'ArrayBuffer'], string,
    );
  }

  const len = string.length;
  if (len === 0)
    return 0;

  if (!encoding || encoding === 'utf8') {
    return byteLengthUtf8(string);
  }

  if (encoding === 'ascii') {
    return len;
  }

  const ops = getEncodingOps(encoding);
  if (ops === undefined) {
    // TODO (ronag): Makes more sense to throw here.
    // throw new ERR_UNKNOWN_ENCODING(encoding);
    return byteLengthUtf8(string);
  }

  return ops.byteLength(string);
}

Buffer.byteLength = byteLength;

// For backwards compatibility.
ObjectDefineProperty(Buffer.prototype, 'parent', {
  __proto__: null,
  enumerable: true,
  get() {
    if (!(this instanceof Buffer))
      return undefined;
    return this.buffer;
  },
});
ObjectDefineProperty(Buffer.prototype, 'offset', {
  __proto__: null,
  enumerable: true,
  get() {
    if (!(this instanceof Buffer))
      return undefined;
    return this.byteOffset;
  },
});

Buffer.prototype.copy =
  function copy(target, targetStart, sourceStart, sourceEnd) {
    return copyImpl(this, target, targetStart, sourceStart, sourceEnd);
  };

// No need to verify that "buf.length <= MAX_UINT32" since it's a read-only
// property of a typed array.
// This behaves neither like String nor Uint8Array in that we set start/end
// to their upper/lower bounds if the value passed is out of range.
Buffer.prototype.toString = function toString(encoding, start, end) {
  if (arguments.length === 0) {
    return this.utf8Slice(0, this.length);
  }

  const len = this.length;

  if (start <= 0)
    start = 0;
  else if (start >= len)
    return '';
  else
    start = MathTrunc(start) || 0;

  if (end === undefined || end > len)
    end = len;
  else
    end = MathTrunc(end) || 0;

  if (end <= start)
    return '';

  if (encoding === undefined)
    return this.utf8Slice(start, end);

  const ops = getEncodingOps(encoding);
  if (ops === undefined)
    throw new ERR_UNKNOWN_ENCODING(encoding);

  return ops.slice(this, start, end);
};

Buffer.prototype.equals = function equals(otherBuffer) {
  if (!isUint8Array(otherBuffer)) {
    throw new ERR_INVALID_ARG_TYPE(
      'otherBuffer', ['Buffer', 'Uint8Array'], otherBuffer);
  }

  if (this === otherBuffer)
    return true;
  const len = TypedArrayPrototypeGetByteLength(this);
  if (len !== TypedArrayPrototypeGetByteLength(otherBuffer))
    return false;

  return len === 0 || _compare(this, otherBuffer) === 0;
};

let INSPECT_MAX_BYTES = 50;
// Override how buffers are presented by util.inspect().
Buffer.prototype[customInspectSymbol] = function inspect(recurseTimes, ctx) {
  const max = INSPECT_MAX_BYTES;
  const actualMax = MathMin(max, this.length);
  const remaining = this.length - max;
  let str = StringPrototypeTrim(RegExpPrototypeSymbolReplace(
    /(.{2})/g, this.hexSlice(0, actualMax), '$1 '));
  if (remaining > 0)
    str += ` ... ${remaining} more byte${remaining > 1 ? 's' : ''}`;
  // Inspect special properties as well, if possible.
  if (ctx) {
    let extras = false;
    const filter = ctx.showHidden ? ALL_PROPERTIES : ONLY_ENUMERABLE;
    const obj = { __proto__: null };
    ArrayPrototypeForEach(getOwnNonIndexProperties(this, filter),
                          (key) => {
                            extras = true;
                            obj[key] = this[key];
                          });
    if (extras) {
      if (this.length !== 0)
        str += ', ';
      // '[Object: null prototype] {'.length === 26
      // This is guarded with a test.
      str += StringPrototypeSlice(utilInspect(obj, {
        ...ctx,
        breakLength: Infinity,
        compact: true,
      }), 27, -2);
    }
  }
  let constructorName = 'Buffer';
  try {
    const { constructor } = this;
    if (typeof constructor === 'function' && ObjectPrototypeHasOwnProperty(constructor, 'name')) {
      constructorName = constructor.name;
    }
  } catch { /* Ignore error and use default name */ }
  return `<${constructorName} ${str}>`;
};
Buffer.prototype.inspect = Buffer.prototype[customInspectSymbol];

Buffer.prototype.compare = function compare(target,
                                            targetStart,
                                            targetEnd,
                                            sourceStart,
                                            sourceEnd) {
  if (!isUint8Array(target)) {
    throw new ERR_INVALID_ARG_TYPE('target', ['Buffer', 'Uint8Array'], target);
  }
  if (arguments.length === 1)
    return _compare(this, target);

  if (targetStart === undefined)
    targetStart = 0;
  else
    validateOffset(targetStart, 'targetStart');

  if (targetEnd === undefined)
    targetEnd = target.length;
  else
    validateOffset(targetEnd, 'targetEnd', 0, target.length);

  if (sourceStart === undefined)
    sourceStart = 0;
  else
    validateOffset(sourceStart, 'sourceStart');

  if (sourceEnd === undefined)
    sourceEnd = this.length;
  else
    validateOffset(sourceEnd, 'sourceEnd', 0, this.length);

  if (sourceStart >= sourceEnd)
    return (targetStart >= targetEnd ? 0 : -1);
  if (targetStart >= targetEnd)
    return 1;

  return compareOffset(this, target, targetStart, sourceStart, targetEnd,
                       sourceEnd);
};

// Finds either the first index of `val` in `buffer` at offset >= `byteOffset`,
// OR the last index of `val` in `buffer` at offset <= `byteOffset`.
//
// Arguments:
// - buffer - a Buffer to search
// - val - a string, Buffer, or number
// - byteOffset - an index into `buffer`; will be clamped to an int32
// - encoding - an optional encoding, relevant if val is a string
// - dir - true for indexOf, false for lastIndexOf
function bidirectionalIndexOf(buffer, val, byteOffset, encoding, dir) {
  validateBuffer(buffer);

  if (typeof byteOffset === 'string') {
    encoding = byteOffset;
    byteOffset = undefined;
  } else if (byteOffset > 0x7fffffff) {
    byteOffset = 0x7fffffff;
  } else if (byteOffset < -0x80000000) {
    byteOffset = -0x80000000;
  }
  // Coerce to Number. Values like null and [] become 0.
  byteOffset = +byteOffset;
  // If the offset is undefined, "foo", {}, coerces to NaN, search whole buffer.
  if (NumberIsNaN(byteOffset)) {
    byteOffset = dir ? 0 : (buffer.length || buffer.byteLength);
  }
  dir = !!dir;  // Cast to bool.

  if (typeof val === 'number')
    return indexOfNumber(buffer, val >>> 0, byteOffset, dir);

  let ops;
  if (encoding === undefined)
    ops = encodingOps.utf8;
  else
    ops = getEncodingOps(encoding);

  if (typeof val === 'string') {
    if (ops === undefined)
      throw new ERR_UNKNOWN_ENCODING(encoding);
    return ops.indexOf(buffer, val, byteOffset, dir);
  }

  if (isUint8Array(val)) {
    const encodingVal =
      (ops === undefined ? encodingsMap.utf8 : ops.encodingVal);
    return indexOfBuffer(buffer, val, byteOffset, encodingVal, dir);
  }

  throw new ERR_INVALID_ARG_TYPE(
    'value', ['number', 'string', 'Buffer', 'Uint8Array'], val,
  );
}

Buffer.prototype.indexOf = function indexOf(val, byteOffset, encoding) {
  return bidirectionalIndexOf(this, val, byteOffset, encoding, true);
};

Buffer.prototype.lastIndexOf = function lastIndexOf(val, byteOffset, encoding) {
  return bidirectionalIndexOf(this, val, byteOffset, encoding, false);
};

Buffer.prototype.includes = function includes(val, byteOffset, encoding) {
  return this.indexOf(val, byteOffset, encoding) !== -1;
};

// Usage:
//    buffer.fill(number[, offset[, end]])
//    buffer.fill(buffer[, offset[, end]])
//    buffer.fill(string[, offset[, end]][, encoding])
Buffer.prototype.fill = function fill(value, offset, end, encoding) {
  return _fill(this, value, offset, end, encoding);
};

function _fill(buf, value, offset, end, encoding) {
  if (typeof value === 'string') {
    if (offset === undefined || typeof offset === 'string') {
      encoding = offset;
      offset = 0;
      end = buf.length;
    } else if (typeof end === 'string') {
      encoding = end;
      end = buf.length;
    }

    const normalizedEncoding = normalizeEncoding(encoding);
    if (normalizedEncoding === undefined) {
      validateString(encoding, 'encoding');
      throw new ERR_UNKNOWN_ENCODING(encoding);
    }

    if (value.length === 0) {
      // If value === '' default to zero.
      value = 0;
    } else if (value.length === 1) {
      // Fast path: If `value` fits into a single byte, use that numeric value.
      if (normalizedEncoding === 'utf8') {
        const code = StringPrototypeCharCodeAt(value, 0);
        if (code < 128) {
          value = code;
        }
      } else if (normalizedEncoding === 'latin1') {
        value = StringPrototypeCharCodeAt(value, 0);
      }
    }
  } else {
    encoding = undefined;
  }

  if (offset === undefined) {
    offset = 0;
    end = buf.length;
  } else {
    validateOffset(offset, 'offset');
    // Invalid ranges are not set to a default, so can range check early.
    if (end === undefined) {
      end = buf.length;
    } else {
      validateOffset(end, 'end', 0, buf.length);
    }
    if (offset >= end)
      return buf;
  }


  if (typeof value === 'number') {
    // OOB check
    const byteLen = TypedArrayPrototypeGetByteLength(buf);
    const fillLength = end - offset;
    if (offset > end || fillLength + offset > byteLen)
      throw new ERR_BUFFER_OUT_OF_BOUNDS();

    TypedArrayPrototypeFill(buf, value, offset, end);
  } else {
    const res = bindingFill(buf, value, offset, end, encoding);
    if (res < 0) {
      if (res === -1)
        throw new ERR_INVALID_ARG_VALUE('value', value);
      throw new ERR_BUFFER_OUT_OF_BOUNDS();
    }
  }

  return buf;
}

Buffer.prototype.write = function write(string, offset, length, encoding) {
  // Buffer#write(string);
  if (offset === undefined) {
    return this.utf8Write(string, 0, this.length);
  }
  // Buffer#write(string, encoding)
  if (length === undefined && typeof offset === 'string') {
    encoding = offset;
    length = this.length;
    offset = 0;

  // Buffer#write(string, offset[, length][, encoding])
  } else {
    validateOffset(offset, 'offset', 0, this.length);

    const remaining = this.length - offset;

    if (length === undefined) {
      length = remaining;
    } else if (typeof length === 'string') {
      encoding = length;
      length = remaining;
    } else {
      validateOffset(length, 'length', 0, this.length);
      if (length > remaining)
        length = remaining;
    }
  }

  if (!encoding || encoding === 'utf8')
    return this.utf8Write(string, offset, length);
  if (encoding === 'ascii')
    return this.asciiWrite(string, offset, length);

  const ops = getEncodingOps(encoding);
  if (ops === undefined)
    throw new ERR_UNKNOWN_ENCODING(encoding);
  return ops.write(this, string, offset, length);
};

Buffer.prototype.toJSON = function toJSON() {
  if (this.length > 0) {
    const data = new Array(this.length);
    for (let i = 0; i < this.length; ++i)
      data[i] = this[i];
    return { type: 'Buffer', data };
  }
  return { type: 'Buffer', data: [] };
};

function adjustOffset(offset, length) {
  // Use Math.trunc() to convert offset to an integer value that can be larger
  // than an Int32. Hence, don't use offset | 0 or similar techniques.
  offset = MathTrunc(offset);
  if (offset === 0) {
    return 0;
  }
  if (offset < 0) {
    offset += length;
    return offset > 0 ? offset : 0;
  }
  if (offset < length) {
    return offset;
  }
  return NumberIsNaN(offset) ? 0 : length;
}

Buffer.prototype.subarray = function subarray(start, end) {
  const srcLength = this.length;
  start = adjustOffset(start, srcLength);
  end = end !== undefined ? adjustOffset(end, srcLength) : srcLength;
  const newLength = end > start ? end - start : 0;
  return new FastBuffer(this.buffer, this.byteOffset + start, newLength);
};

Buffer.prototype.slice = function slice(start, end) {
  return this.subarray(start, end);
};

function swap(b, n, m) {
  const i = b[n];
  b[n] = b[m];
  b[m] = i;
}

Buffer.prototype.swap16 = function swap16() {
  // For Buffer.length < 128, it's generally faster to
  // do the swap in javascript. For larger buffers,
  // dropping down to the native code is faster.
  const len = this.length;
  if (len % 2 !== 0)
    throw new ERR_INVALID_BUFFER_SIZE('16-bits');
  if (len < 128) {
    for (let i = 0; i < len; i += 2)
      swap(this, i, i + 1);
    return this;
  }
  return _swap16(this);
};

Buffer.prototype.swap32 = function swap32() {
  // For Buffer.length < 192, it's generally faster to
  // do the swap in javascript. For larger buffers,
  // dropping down to the native code is faster.
  const len = this.length;
  if (len % 4 !== 0)
    throw new ERR_INVALID_BUFFER_SIZE('32-bits');
  if (len < 192) {
    for (let i = 0; i < len; i += 4) {
      swap(this, i, i + 3);
      swap(this, i + 1, i + 2);
    }
    return this;
  }
  return _swap32(this);
};

Buffer.prototype.swap64 = function swap64() {
  // For Buffer.length < 192, it's generally faster to
  // do the swap in javascript. For larger buffers,
  // dropping down to the native code is faster.
  const len = this.length;
  if (len % 8 !== 0)
    throw new ERR_INVALID_BUFFER_SIZE('64-bits');
  if (len < 192) {
    for (let i = 0; i < len; i += 8) {
      swap(this, i, i + 7);
      swap(this, i + 1, i + 6);
      swap(this, i + 2, i + 5);
      swap(this, i + 3, i + 4);
    }
    return this;
  }
  return _swap64(this);
};

Buffer.prototype.toLocaleString = Buffer.prototype.toString;

/** Transcodes a Buffer between Node's text encodings (utf8, utf16le,
 * latin1, ascii): what cannot be encoded becomes "?" (as ICU's converters). */
function transcode(source, fromEncoding, toEncoding) {
  if (!isUint8Array(source)) {
    throw new ERR_INVALID_ARG_TYPE('source', ['Buffer', 'Uint8Array'], source);
  }
  if (source.length === 0) return Buffer.alloc(0);
  const from = normalizeEncoding(fromEncoding) || fromEncoding;
  const to = normalizeEncoding(toEncoding) || toEncoding;
  const supported = (e) => e === "utf8" || e === "utf16le" || e === "latin1" || e === "ascii";
  if (!supported(from) || !supported(to)) {
    throw genericNodeError("Unable to transcode Buffer [U_ILLEGAL_ARGUMENT_ERROR]", {
      code: "U_ILLEGAL_ARGUMENT_ERROR",
      errno: 1,
    });
  }
  let text = bufferSlice(source, 0, source.length, encodingsMap[from]);
  if (to === "latin1" || to === "ascii") {
    const limit = to === "latin1" ? 0xff : 0x7f;
    let out = "";
    for (const ch of text) out += ch.codePointAt(0) > limit ? "?" : ch;
    text = out;
  }
  return Buffer.from(text, to);
}

function btoa(input) {
  if (arguments.length === 0) {
    throw new ERR_MISSING_ARGS('input');
  }
  input = `${input}`;
  for (let i = 0; i < input.length; i++) {
    if (input.charCodeAt(i) > 0xff) throw lazyDOMException('Invalid character', 'InvalidCharacterError');
  }
  return bufferSlice(Buffer.from(input, 'latin1'), 0, input.length, encodingsMap.base64);
}

function atob(input) {
  if (arguments.length === 0) {
    throw new ERR_MISSING_ARGS('input');
  }
  input = `${input}`;
  // (Forgiving-base64: ASCII whitespace out, then at most two "=" that
  // pad to a multiple of 4.)
  let s = "";
  let pad = 0;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0d) continue;
    if (c === 0x3d) {
      pad++;
      s += "=";
      continue;
    }
    if (pad > 0 || !((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39) || c === 0x2b || c === 0x2f)) {
      throw lazyDOMException('Invalid character', 'InvalidCharacterError');
    }
    s += input[i];
  }
  if (pad > 0 && (pad > 2 || s.length % 4 !== 0)) {
    throw lazyDOMException('Invalid character', 'InvalidCharacterError');
  }
  if (pad === 0 && s.length % 4 === 1) {
    throw lazyDOMException('The string to be decoded is not correctly encoded.', 'InvalidCharacterError');
  }
  return bufferSlice(Buffer.from(s, 'base64'), undefined, undefined, encodingsMap.latin1);
}

function isUtf8(input) {
  if (isTypedArray(input) || isAnyArrayBuffer(input)) {
    return bindingIsUtf8(input);
  }

  throw new ERR_INVALID_ARG_TYPE('input', ['ArrayBuffer', 'Buffer', 'TypedArray'], input);
}

function isAscii(input) {
  if (isTypedArray(input) || isAnyArrayBuffer(input)) {
    return bindingIsAscii(input);
  }

  throw new ERR_INVALID_ARG_TYPE('input', ['ArrayBuffer', 'Buffer', 'TypedArray'], input);
}

const SlowBufferDeprecated = deprecate(
  SlowBuffer,
  'SlowBuffer() is deprecated. Please use Buffer.allocUnsafeSlow()',
  'DEP0030');

/** A Blob of a `blob:` URL (URL.createObjectURL's), if one is registered. */
function resolveObjectURL(url) {
  url = `${url}`;
  const registry = globalThis[Symbol.for("beyond.blobURLs")];
  return registry?.get(url);
}

const exported = {
  Buffer,
  SlowBuffer: SlowBufferDeprecated,
  transcode,
  isUtf8,
  isAscii,
  kMaxLength,
  kStringMaxLength,
  btoa,
  atob,
  Blob,
  File,
  resolveObjectURL,
};

ObjectDefineProperties(exported, {
  constants: {
    __proto__: null,
    configurable: false,
    enumerable: true,
    value: constants,
  },
  INSPECT_MAX_BYTES: {
    __proto__: null,
    configurable: true,
    enumerable: true,
    get() { return INSPECT_MAX_BYTES; },
    set(val) {
      validateNumber(val, 'INSPECT_MAX_BYTES', 0);
      INSPECT_MAX_BYTES = val;
    },
  },
});

export {
  Buffer,
  SlowBufferDeprecated as SlowBuffer,
  transcode,
  isUtf8,
  isAscii,
  kMaxLength,
  kStringMaxLength,
  btoa,
  atob,
  constants,
  INSPECT_MAX_BYTES,
  Blob,
  File,
  resolveObjectURL,
};
export default exported;
