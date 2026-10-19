// node:buffer: `Buffer`, a Uint8Array with Node's encodings (utf8, latin1
// and binary, ascii, base64, base64url, hex, ucs2 and utf16le) and its
// common methods.

import { Blob, File } from "../blob.ts";

type Encoding = string;

function normalize(encoding: Encoding | undefined): string {
  const e = (encoding ?? "utf8").toLowerCase();
  switch (e) {
    case "utf8":
    case "utf-8":
      return "utf8";
    case "latin1":
    case "binary":
      return "latin1";
    case "ucs2":
    case "ucs-2":
    case "utf16le":
    case "utf-16le":
      return "utf16le";
    case "ascii":
    case "base64":
    case "base64url":
    case "hex":
      return e;
    default:
      throw new TypeError(`Unknown encoding: ${encoding}`);
  }
}

function fromString(s: string, encoding: string): Uint8Array {
  switch (encoding) {
    case "utf8":
      return new TextEncoder().encode(s);
    case "latin1":
    case "ascii": {
      const out = new Uint8Array(s.length);
      for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
      return out;
    }
    case "utf16le": {
      const out = new Uint8Array(s.length * 2);
      for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        out[2 * i] = c & 0xff;
        out[2 * i + 1] = c >> 8;
      }
      return out;
    }
    case "hex": {
      const n = s.length >> 1;
      const out = new Uint8Array(n);
      let i = 0;
      for (; i < n; i++) {
        const b = parseInt(s.substr(2 * i, 2), 16);
        if (Number.isNaN(b)) break;
        out[i] = b;
      }
      return i === n ? out : out.subarray(0, i);
    }
    case "base64":
    case "base64url": {
      let t = s.replace(/[^A-Za-z0-9+/\-_]/g, "").replace(/-/g, "+").replace(/_/g, "/");
      while (t.length % 4) t += "=";
      const bin = atob(t);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }
  }
  throw new TypeError(`Unknown encoding: ${encoding}`);
}

function toString(bytes: Uint8Array, encoding: string): string {
  switch (encoding) {
    case "utf8":
      return new TextDecoder().decode(bytes);
    case "latin1": {
      let s = "";
      for (let i = 0; i < bytes.length; i += 4096) s += String.fromCharCode(...bytes.subarray(i, i + 4096));
      return s;
    }
    case "ascii": {
      let s = "";
      for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i] & 0x7f);
      return s;
    }
    case "utf16le": {
      let s = "";
      for (let i = 0; i + 1 < bytes.length; i += 2) s += String.fromCharCode(bytes[i] | (bytes[i + 1] << 8));
      return s;
    }
    case "hex": {
      let s = "";
      for (let i = 0; i < bytes.length; i++) s += (bytes[i] < 16 ? "0" : "") + bytes[i].toString(16);
      return s;
    }
    case "base64":
    case "base64url": {
      const b64 = btoa(toString(bytes, "latin1"));
      return encoding === "base64" ? b64 : b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    }
  }
  throw new TypeError(`Unknown encoding: ${encoding}`);
}

export class Buffer extends Uint8Array {
  static from(value: any, encodingOrOffset?: any, length?: number): Buffer {
    if (typeof value === "string") {
      const bytes = fromString(value, normalize(encodingOrOffset));
      return new Buffer(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength);
    }
    if (value instanceof ArrayBuffer || (typeof SharedArrayBuffer !== "undefined" && value instanceof SharedArrayBuffer)) {
      const off = encodingOrOffset ?? 0;
      return new Buffer(value as ArrayBuffer, off, length ?? value.byteLength - off);
    }
    if (ArrayBuffer.isView(value)) {
      const copy = new Buffer(value.byteLength);
      copy.set(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
      return copy;
    }
    if (Array.isArray(value) || (value && typeof value.length === "number")) {
      const out = new Buffer(value.length);
      for (let i = 0; i < value.length; i++) out[i] = value[i];
      return out;
    }
    if (value && value.type === "Buffer" && Array.isArray(value.data)) return Buffer.from(value.data);
    throw new TypeError("The first argument must be of type string or an instance of Buffer, ArrayBuffer, or Array or an Array-like Object.");
  }

  static alloc(size: number, fill?: any, encoding?: Encoding): Buffer {
    const b = new Buffer(size);
    if (fill !== undefined && fill !== 0) b.fill(fill, 0, size, encoding);
    return b;
  }

  static allocUnsafe(size: number): Buffer {
    return new Buffer(size);
  }

  static allocUnsafeSlow(size: number): Buffer {
    return new Buffer(size);
  }

  static isBuffer(b: unknown): b is Buffer {
    return b instanceof Buffer;
  }

  static isEncoding(e: unknown): boolean {
    try {
      normalize(e as string);
      return typeof e === "string";
    } catch {
      return false;
    }
  }

  static byteLength(value: any, encoding?: Encoding): number {
    if (typeof value === "string") return fromString(value, normalize(encoding)).byteLength;
    return value.byteLength;
  }

  static concat(list: Uint8Array[], totalLength?: number): Buffer {
    const total = totalLength ?? list.reduce((n, b) => n + b.length, 0);
    const out = new Buffer(total);
    let off = 0;
    for (const b of list) {
      if (off >= total) break;
      out.set(b.subarray(0, total - off), off);
      off += b.length;
    }
    return out;
  }

  static compare(a: Uint8Array, b: Uint8Array): number {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
  }

  override toString(encoding?: Encoding, start = 0, end = this.length): string {
    return toString(this.subarray(start, end), normalize(encoding));
  }

  toJSON(): { type: "Buffer"; data: number[] } {
    return { type: "Buffer", data: Array.from(this) };
  }

  equals(other: Uint8Array): boolean {
    return Buffer.compare(this, other) === 0;
  }

  compare(other: Uint8Array): number {
    return Buffer.compare(this, other);
  }

  write(s: string, offset = 0, length?: number, encoding?: Encoding): number {
    if (typeof offset === "string") {
      encoding = offset;
      offset = 0;
    } else if (typeof length === "string") {
      encoding = length;
      length = undefined;
    }
    const bytes = fromString(s, normalize(encoding));
    const n = Math.min(bytes.length, length ?? this.length - offset, this.length - offset);
    this.set(bytes.subarray(0, n), offset);
    return n;
  }

  override fill(value: any, start = 0, end = this.length, encoding?: Encoding): this {
    if (typeof value === "string") {
      const bytes = value.length === 1 && (encoding === undefined || normalize(encoding) === "utf8") && value.charCodeAt(0) < 128
        ? new Uint8Array([value.charCodeAt(0)])
        : fromString(value, normalize(encoding));
      if (bytes.length === 0) return super.fill(0, start, end);
      for (let i = start, k = 0; i < end; i++, k = (k + 1) % bytes.length) this[i] = bytes[k];
      return this;
    }
    return super.fill(typeof value === "number" ? value & 0xff : value ? 1 : 0, start, end);
  }

  override slice(start?: number, end?: number): Buffer {
    return this.subarray(start, end);
  }

  override subarray(start?: number, end?: number): Buffer {
    const s = super.subarray(start, end);
    return new Buffer(s.buffer as ArrayBuffer, s.byteOffset, s.byteLength);
  }

  copy(target: Uint8Array, targetStart = 0, sourceStart = 0, sourceEnd = this.length): number {
    const src = this.subarray(sourceStart, Math.min(sourceEnd, sourceStart + target.length - targetStart));
    target.set(src, targetStart);
    return src.length;
  }

  readUInt8(offset = 0): number {
    return this[offset];
  }

  readUInt16LE(offset = 0): number {
    return this[offset] | (this[offset + 1] << 8);
  }

  readUInt32LE(offset = 0): number {
    return (this[offset] | (this[offset + 1] << 8) | (this[offset + 2] << 16)) + this[offset + 3] * 0x1000000;
  }

  readUInt32BE(offset = 0): number {
    return this[offset] * 0x1000000 + ((this[offset + 1] << 16) | (this[offset + 2] << 8) | this[offset + 3]);
  }

  writeUInt8(value: number, offset = 0): number {
    this[offset] = value;
    return offset + 1;
  }

  writeUInt32LE(value: number, offset = 0): number {
    this[offset] = value;
    this[offset + 1] = value >>> 8;
    this[offset + 2] = value >>> 16;
    this[offset + 3] = value >>> 24;
    return offset + 4;
  }

  writeUInt32BE(value: number, offset = 0): number {
    this[offset] = value >>> 24;
    this[offset + 1] = value >>> 16;
    this[offset + 2] = value >>> 8;
    this[offset + 3] = value;
    return offset + 4;
  }
}

export const kMaxLength = 2 ** 32;
export const constants = { MAX_LENGTH: kMaxLength, MAX_STRING_LENGTH: 2 ** 29 - 24 };
export { Blob, File };
export default { Buffer, Blob, File, kMaxLength, constants };
