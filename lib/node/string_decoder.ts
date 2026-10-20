// node:string_decoder, as Bun's (src/jsc/bindings/JSStringDecoder.cpp): it
// decodes Buffers to strings, keeping the bytes of a character split across
// writes (UTF-8, UTF-16LE, base64, base64url) for the next. The algorithm is
// Node's string_decoder.js of before its C++ one (MIT, Node.js contributors).

import { $ERR_INVALID_ARG_TYPE, $ERR_INVALID_THIS, $ERR_UNKNOWN_ENCODING } from "node:internal/intrinsics";

/** The canonical name of an encoding (Node's normalizeEncoding). */
function normalizeEncoding(enc: unknown): string | undefined {
  if (enc === undefined || enc === null || enc === "") return "utf8";
  switch (String(enc).toLowerCase()) {
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
    case "ascii":
      return "ascii";
    case "hex":
      return "hex";
    default:
      return undefined;
  }
}

function bufferOf(buf: unknown): Buffer {
  if (Buffer.isBuffer(buf)) return buf;
  if (ArrayBuffer.isView(buf)) return Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  throw $ERR_INVALID_ARG_TYPE("buf", "Buffer, TypedArray, or DataView", buf);
}

/** How many bytes the UTF-8 character starting with byte `b` has (0 for
 * ASCII), or -1 for a continuation byte, -2 for an invalid one. */
function utf8CheckByte(b: number): number {
  if (b <= 0x7f) return 0;
  if (b >> 5 === 0x06) return 2;
  if (b >> 4 === 0x0e) return 3;
  if (b >> 3 === 0x1e) return 4;
  return b >> 6 === 0x02 ? -1 : -2;
}

interface Decoder {
  encoding: string;
  lastChar: Buffer;
  lastNeed: number;
  lastTotal: number;
}

/** (What StringDecoder made a decoder: its methods take no other `this`.) */
const kDecoder = Symbol("kDecoder");

function check(d: unknown): Decoder {
  if (d === null || typeof d !== "object" || (d as any)[kDecoder] !== true) throw $ERR_INVALID_THIS("StringDecoder");
  return d as Decoder;
}

/** A decoder of `encoding` (utf8 by default): callable without `new`, as
 * Node's (`StringDecoder.call(obj)` makes `obj` one). */
export function StringDecoder(this: Decoder, encoding?: string): void {
  const enc = normalizeEncoding(encoding);
  if (enc === undefined) throw $ERR_UNKNOWN_ENCODING(encoding);
  this.encoding = enc;
  this[kDecoder] = true;
  this.lastChar = Buffer.allocUnsafe(4);
  this.lastNeed = 0;
  this.lastTotal = 0;
}

/** The text of `buf`, keeping an incomplete character's bytes. */
StringDecoder.prototype.write = function write(this: Decoder, buf: unknown): string {
  check(this);
  if (typeof buf === "string") return buf;
  return decode(this, bufferOf(buf));
};

/** The text of `buf` and whatever is kept: the end of the input. */
StringDecoder.prototype.end = function end(this: Decoder, buf?: unknown): string {
  check(this);
  const b = buf === undefined ? undefined : bufferOf(buf);
  try {
    switch (this.encoding) {
      case "utf8":
      case "utf16le": {
        const first = b === undefined || b.length === 0 ? "" : decode(this, b);
        return this.lastNeed ? first + this.lastChar.toString(this.encoding, 0, this.lastTotal - this.lastNeed) : first;
      }
      case "base64":
      case "base64url": {
        const first = b === undefined || b.length === 0 ? "" : decode(this, b);
        return this.lastNeed ? first + this.lastChar.toString(this.encoding, 0, 3 - this.lastNeed) : first;
      }
      default:
        return b === undefined || b.length === 0 ? "" : decode(this, b);
    }
  } finally {
    // (As Node's FlushData: lastChar stays.)
    this.lastNeed = 0;
    this.lastTotal = 0;
  }
};

/** The text of `buf` from byte `i` on. */
StringDecoder.prototype.text = function (this: Decoder, buf: unknown, i: number): string {
  check(this);
  const b = bufferOf(buf);
  const offset = i | 0;
  if (offset < 0 || offset > b.length) return "";
  return decode(this, b.subarray(offset));
};

/** Bun's JSStringDecoder::write. */
function decode(d: Decoder, buf: Buffer): string {
  if (buf.length === 0) return "";
  if (!buffers(d)) return buf.toString(d.encoding as BufferEncoding);
  if (d.lastNeed) {
    const first = fillLast(d, buf);
    if (first.length === 0) return first;
    const offset = d.lastNeed;
    d.lastNeed = 0;
    d.lastTotal = 0;
    if (offset === buf.length) return first;
    const second = text(d, buf, offset);
    return second.length === 0 ? first : first + second;
  }
  return text(d, buf, 0);
}

function text(d: Decoder, buf: Buffer, offset: number): string {
  const length = buf.length;
  switch (d.encoding) {
    case "utf16le": {
      if (length === offset) return "";
      if ((length - offset) % 2 === 0) {
        const c = (buf[length - 1] << 8) + buf[length - 2];
        if (c >= 0xd800 && c <= 0xdbff) {
          d.lastNeed = 2;
          d.lastTotal = 4;
          d.lastChar[0] = buf[length - 2];
          d.lastChar[1] = buf[length - 1];
          return buf.toString("utf16le", offset, length - 2);
        }
        return buf.toString("utf16le", offset, length);
      }
      d.lastNeed = 1;
      d.lastTotal = 2;
      d.lastChar[0] = buf[length - 1];
      return buf.toString("utf16le", offset, length - 1);
    }
    case "utf8": {
      const total = utf8CheckIncomplete(d, buf, length, offset);
      if (!d.lastNeed) return buf.toString("utf8", offset, length);
      d.lastTotal = total;
      const end = length - (total - d.lastNeed);
      if (end < length) buf.copy(d.lastChar, 0, end, Math.min(end + 4, length));
      return buf.toString("utf8", offset, end);
    }
    default: {
      // (base64, base64url)
      const n = (length - offset) % 3;
      if (n === 0) return buf.toString(d.encoding as BufferEncoding, offset, length);
      d.lastNeed = 3 - n;
      d.lastTotal = 3;
      if (n === 1) {
        d.lastChar[0] = buf[length - 1];
      } else {
        d.lastChar[0] = buf[length - 2];
        d.lastChar[1] = buf[length - 1];
      }
      return buf.toString(d.encoding as BufferEncoding, offset, length - n);
    }
  }
}

function buffers(d: Decoder): boolean {
  const e = d.encoding;
  return e === "utf8" || e === "utf16le" || e === "base64" || e === "base64url";
}

const isContinuation = (b: number) => (b & 0xc0) === 0x80;

/** Completes the kept character with the start of `buf` (Bun's fillLast):
 * its text, or "" if `buf` does not have all of it. */
function fillLast(d: Decoder, buf: Buffer): string {
  const length = buf.length;
  if (d.encoding === "utf8") {
    // (A byte that starts a character, where a continuation was expected:
    // what is kept is an error, and decoding goes on from that byte.)
    const max = Math.min(length, d.lastNeed);
    for (let i = 0; i < max; i++) {
      if (!isContinuation(buf[i])) {
        const chars = d.lastTotal - d.lastNeed + i;
        buf.copy(d.lastChar, d.lastTotal - d.lastNeed, 0, i);
        d.lastNeed = i;
        return d.lastChar.toString("utf8", 0, chars);
      }
    }
  }
  if (d.lastNeed <= length) {
    buf.copy(d.lastChar, d.lastTotal - d.lastNeed, 0, d.lastNeed);
    return d.lastChar.toString(d.encoding as BufferEncoding, 0, d.lastTotal);
  }
  buf.copy(d.lastChar, d.lastTotal - d.lastNeed, 0, length);
  if (d.encoding === "utf8") {
    const lastLastNeed = d.lastNeed;
    const total = utf8CheckIncomplete(d, d.lastChar, d.lastTotal - lastLastNeed + length, 0);
    if (total === 0) {
      const len = d.lastTotal - d.lastNeed + length;
      d.lastNeed = length;
      return d.lastChar.toString("utf8", 0, len);
    }
    d.lastNeed = lastLastNeed;
  }
  d.lastNeed -= length;
  return "";
}

/** How many bytes the character at the end of `buf[..length]` (from `i`)
 * has, if it is incomplete (lastNeed: how many it lacks). */
function utf8CheckIncomplete(d: Decoder, buf: Uint8Array, length: number, i: number): number {
  let j = length - 1;
  if (j < i) return 0;
  let nb = utf8CheckByte(buf[j]);
  if (nb >= 0) {
    if (nb > 0) d.lastNeed = nb - 1;
    return nb;
  }
  if (j === 0 || --j < i || nb === -2) return 0;
  nb = utf8CheckByte(buf[j]);
  if (nb >= 0) {
    if (nb > 0) d.lastNeed = nb - 2;
    return nb;
  }
  if (j === 0 || --j < i || nb === -2) return 0;
  nb = utf8CheckByte(buf[j]);
  if (nb >= 0) {
    if (nb > 0) {
      if (nb === 2) nb = 0;
      else d.lastNeed = nb - 3;
    }
    return nb;
  }
  return 0;
}

export default { StringDecoder };
