// TextEncoder and TextDecoder (the Encoding standard), with the encodings
// Bun's TextDecoder has: UTF-8, UTF-16 (LE and BE) and windows-1252 (the
// standard's "latin1" and "ascii"). UTF-8 is native (crates/beyond-rt:
// web.c and encoding.rs); the rest is here.

import { decodeUtf8, encodeUtf8, encodeUtf8Into } from "beyond:native";
import { describe, Formatter } from "./inspect.ts";
import { describeAs, ReadableStream, TransformStream, WritableStream } from "./streams.ts";

export interface TextEncoderEncodeIntoResult {
  read: number;
  written: number;
}

export class TextEncoder {
  get encoding(): string {
    return "utf-8";
  }

  /** The UTF-8 of `input` (lone surrogates as U+FFFD). */
  encode(input: string = ""): Uint8Array {
    return encodeUtf8(String(input));
  }

  /** Writes as much of the UTF-8 of `source` as fits (whole characters). */
  encodeInto(source: string, destination: Uint8Array): TextEncoderEncodeIntoResult {
    if (!(destination instanceof Uint8Array)) {
      throw new TypeError('The "destination" argument must be an instance of Uint8Array');
    }
    return encodeUtf8Into(String(source), destination);
  }

  get [Symbol.toStringTag](): string {
    return "TextEncoder";
  }

  [describe](f: Formatter): void {
    const p = TextEncoder.prototype;
    f.record("TextEncoder", [["encoding", "utf-8"], ["encode", p.encode], ["encodeInto", p.encodeInto]]);
  }
}

const UTF8 = 0;
const UTF16LE = 1;
const UTF16BE = 2;
const WINDOWS1252 = 3;
const NAMES = ["utf-8", "utf-16le", "utf-16be", "windows-1252"];

/** The encodings' labels (as the standard lists them), to their numbers. */
const LABELS = new Map<string, number>();
for (const l of ["unicode-1-1-utf-8", "unicode11utf8", "unicode20utf8", "utf-8", "utf8", "x-unicode20utf8"]) {
  LABELS.set(l, UTF8);
}
for (const l of ["csunicode", "iso-10646-ucs-2", "ucs-2", "unicode", "unicodefeff", "utf-16", "utf-16le"]) {
  LABELS.set(l, UTF16LE);
}
for (const l of ["unicodefffe", "utf-16be"]) LABELS.set(l, UTF16BE);
for (const l of [
  "ansi_x3.4-1968", "ascii", "cp1252", "cp819", "csisolatin1", "ibm819", "iso-8859-1", "iso-ir-100", "iso8859-1",
  "iso88591", "iso_8859-1", "iso_8859-1:1987", "l1", "latin1", "us-ascii", "windows-1252", "x-cp1252",
]) {
  LABELS.set(l, WINDOWS1252);
}

/** What windows-1252 has at 0x80..0x9F (elsewhere, the byte's code point). */
const CP1252 = [
  0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152, 0x8d, 0x17d,
  0x8f, 0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122, 0x161, 0x203a, 0x153, 0x9d,
  0x17e, 0x178,
];

const EMPTY = new Uint8Array(0);

export type BufferSource = ArrayBuffer | ArrayBufferView;

/** The bytes of a BufferSource, as a Uint8Array (over the same memory). */
function bytesOf(input: BufferSource | undefined | null): Uint8Array {
  if (input === undefined || input === null) return EMPTY;
  if (input instanceof Uint8Array) return input;
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  if (input instanceof ArrayBuffer || Object.prototype.toString.call(input) === "[object SharedArrayBuffer]") {
    return new Uint8Array(input as ArrayBuffer);
  }
  throw new TypeError('The "input" argument must be an ArrayBuffer or an ArrayBufferView');
}

function isSpace(c: number): boolean {
  return c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0d;
}

/** The label without its leading and trailing ASCII whitespace. */
function trim(label: string): string {
  let start = 0;
  let end = label.length;
  while (start < end && isSpace(label.charCodeAt(start))) start++;
  while (end > start && isSpace(label.charCodeAt(end - 1))) end--;
  return label.slice(start, end);
}

/**
 * How many bytes at the end of `b[start..end]` begin a UTF-8 sequence that
 * more bytes could complete (0 if none): kept for the next chunk of a stream.
 */
function utf8Tail(b: Uint8Array, start: number, end: number): number {
  for (let k = 1; k <= 3 && end - k >= start; k++) {
    const c = b[end - k];
    if ((c & 0xc0) === 0x80) continue;
    const need = c >= 0xc2 && c <= 0xdf ? 2 : c >= 0xe0 && c <= 0xef ? 3 : c >= 0xf0 && c <= 0xf4 ? 4 : 0;
    if (need <= k) return 0;
    if (k >= 2) {
      // The second byte's range depends on the first.
      const d = b[end - k + 1];
      const lo = c === 0xe0 ? 0xa0 : c === 0xf0 ? 0x90 : 0x80;
      const hi = c === 0xed ? 0x9f : c === 0xf4 ? 0x8f : 0xbf;
      if (d < lo || d > hi) return 0;
    }
    return k;
  }
  return 0;
}

/** Code units to a string, in pieces (to keep argument lists short). */
function fromCodes(codes: number[]): string {
  if (codes.length <= 8192) return String.fromCharCode(...codes);
  let out = "";
  for (let i = 0; i < codes.length; i += 8192) out += String.fromCharCode(...codes.slice(i, i + 8192));
  return out;
}

function invalid(encoding: string): never {
  throw new TypeError(`The encoded data was not valid for encoding ${encoding}`);
}

export interface TextDecoderOptions {
  fatal?: boolean;
  ignoreBOM?: boolean;
}

export interface TextDecodeOptions {
  stream?: boolean;
}

export class TextDecoder {
  _encoding: number;
  _fatal: boolean;
  _ignoreBOM: boolean;
  // Within a stream: bytes of an unfinished character, and whether the
  // stream's start (where a byte order mark is) has been decoded.
  _pending: Uint8Array | null = null;
  _started = false;

  constructor(label: string = "utf-8", options?: TextDecoderOptions) {
    const e = LABELS.get(trim(String(label)).toLowerCase());
    if (e === undefined) throw new RangeError(`The "${label}" encoding is not supported`);
    this._encoding = e;
    this._fatal = options !== undefined && options !== null && Boolean(options.fatal);
    this._ignoreBOM = options !== undefined && options !== null && Boolean(options.ignoreBOM);
  }

  get encoding(): string {
    return NAMES[this._encoding];
  }

  get fatal(): boolean {
    return this._fatal;
  }

  get ignoreBOM(): boolean {
    return this._ignoreBOM;
  }

  decode(input?: BufferSource, options?: TextDecodeOptions): string {
    const stream = options !== undefined && options !== null && Boolean(options.stream);
    if (!stream && this._pending === null && !this._started && this._encoding === UTF8) {
      // The whole input at once (most calls): its bytes go to the native
      // decoder as they are.
      const b = bytesOf(input);
      if (this._ignoreBOM || b.length < 3 || b[0] !== 0xef || b[1] !== 0xbb || b[2] !== 0xbf) {
        return decodeUtf8(b, this._fatal);
      }
      return decodeUtf8(b.subarray(3), this._fatal);
    }
    let b = bytesOf(input);
    if (this._pending !== null) {
      const joined = new Uint8Array(this._pending.length + b.length);
      joined.set(this._pending);
      joined.set(b, this._pending.length);
      b = joined;
      this._pending = null;
    }
    let start = 0;
    if (!this._started && b.length > 0) {
      const bom = this._encoding === UTF8 ? [0xef, 0xbb, 0xbf] : this._encoding === UTF16LE ? [0xff, 0xfe]
        : this._encoding === UTF16BE ? [0xfe, 0xff] : [];
      let prefix = bom.length > 0;
      for (let i = 0; i < bom.length && i < b.length; i++) if (b[i] !== bom[i]) prefix = false;
      if (prefix && b.length < bom.length && stream) {
        // Not yet known whether this is a byte order mark.
        this._pending = b.slice();
        return "";
      }
      if (prefix && b.length >= bom.length && !this._ignoreBOM) start = bom.length;
      this._started = true;
    }
    let end = b.length;
    if (stream) {
      const keep = this._encoding === UTF8 ? utf8Tail(b, start, end) : this._encoding === WINDOWS1252 ? 0 : utf16Tail(b, start, end, this._encoding === UTF16BE);
      if (keep > 0) {
        end -= keep;
        this._pending = b.slice(end);
      }
    } else {
      this._started = false;
    }
    if (this._encoding === UTF8) return decodeUtf8(start === 0 && end === b.length ? b : b.subarray(start, end), this._fatal);
    if (this._encoding === WINDOWS1252) return decode1252(b, start, end);
    return decode16(b, start, end, this._encoding === UTF16BE, this._fatal);
  }

  get [Symbol.toStringTag](): string {
    return "TextDecoder";
  }

  [describe](f: Formatter): void {
    f.record("TextDecoder", [
      ["decode", TextDecoder.prototype.decode],
      ["encoding", this.encoding],
      ["fatal", this._fatal],
      ["ignoreBOM", this._ignoreBOM],
    ]);
  }
}

function decode1252(b: Uint8Array, start: number, end: number): string {
  const codes: number[] = [];
  for (let i = start; i < end; i++) {
    const c = b[i];
    codes.push(c >= 0x80 && c <= 0x9f ? CP1252[c - 0x80] : c);
  }
  return fromCodes(codes);
}

/** How many bytes at the end of UTF-16 `b[start..end]` to keep for more. */
function utf16Tail(b: Uint8Array, start: number, end: number, be: boolean): number {
  const odd = (end - start) % 2;
  const last = end - odd - 2;
  if (last >= start) {
    const u = be ? (b[last] << 8) | b[last + 1] : b[last] | (b[last + 1] << 8);
    // A lead surrogate waits for its trail.
    if (u >= 0xd800 && u <= 0xdbff) return 2 + odd;
  }
  return odd;
}

function decode16(b: Uint8Array, start: number, end: number, be: boolean, fatal: boolean): string {
  const codes: number[] = [];
  let i = start;
  for (; i + 1 < end; i += 2) {
    const u = be ? (b[i] << 8) | b[i + 1] : b[i] | (b[i + 1] << 8);
    if (u >= 0xd800 && u <= 0xdbff) {
      const j = i + 2;
      const v = j + 1 < end ? (be ? (b[j] << 8) | b[j + 1] : b[j] | (b[j + 1] << 8)) : -1;
      if (v >= 0xdc00 && v <= 0xdfff) {
        codes.push(u, v);
        i = j;
        continue;
      }
      if (fatal) invalid(be ? "utf-16be" : "utf-16le");
      codes.push(0xfffd);
    } else if (u >= 0xdc00 && u <= 0xdfff) {
      if (fatal) invalid(be ? "utf-16be" : "utf-16le");
      codes.push(0xfffd);
    } else {
      codes.push(u);
    }
  }
  if (i < end) {
    // An odd byte.
    if (fatal) invalid(be ? "utf-16be" : "utf-16le");
    codes.push(0xfffd);
  }
  return fromCodes(codes);
}

// ---- TextEncoderStream and TextDecoderStream ----

/** A TransformStream of strings to their UTF-8. */
export class TextEncoderStream {
  _transform: TransformStream<string, Uint8Array>;
  // (A lead surrogate at the end of a chunk, waiting for its trail.)
  _lead = "";

  constructor() {
    this._transform = new TransformStream<string, Uint8Array>({
      transform: (chunk, controller) => {
        let s = this._lead + String(chunk);
        this._lead = "";
        const last = s.charCodeAt(s.length - 1);
        if (last >= 0xd800 && last <= 0xdbff) {
          this._lead = s.slice(-1);
          s = s.slice(0, -1);
        }
        if (s !== "") controller.enqueue(encodeUtf8(s));
      },
      flush: (controller) => {
        if (this._lead !== "") controller.enqueue(new Uint8Array([0xef, 0xbf, 0xbd]));
      },
    });
  }

  get encoding(): string {
    return "utf-8";
  }

  get readable(): ReadableStream<Uint8Array> {
    return this._transform.readable;
  }

  get writable(): WritableStream<string> {
    return this._transform.writable;
  }

  get [Symbol.toStringTag](): string {
    return "TextEncoderStream";
  }
}

/** A TransformStream of bytes to the text they encode. */
export class TextDecoderStream {
  _decoder: TextDecoder;
  _transform: TransformStream<BufferSource, string>;

  constructor(label: string = "utf-8", options?: TextDecoderOptions) {
    const decoder = new TextDecoder(label, options);
    this._decoder = decoder;
    this._transform = new TransformStream<BufferSource, string>({
      transform: (chunk, controller) => {
        if (!(chunk instanceof ArrayBuffer) && !ArrayBuffer.isView(chunk)) {
          throw new TypeError("TextDecoderStream's chunks must be ArrayBuffers or ArrayBufferViews");
        }
        const s = decoder.decode(chunk, { stream: true });
        if (s !== "") controller.enqueue(s);
      },
      flush: (controller) => {
        const s = decoder.decode();
        if (s !== "") controller.enqueue(s);
      },
    });
  }

  get encoding(): string {
    return this._decoder.encoding;
  }

  get fatal(): boolean {
    return this._decoder.fatal;
  }

  get ignoreBOM(): boolean {
    return this._decoder.ignoreBOM;
  }

  get readable(): ReadableStream<string> {
    return this._transform.readable;
  }

  get writable(): WritableStream<BufferSource> {
    return this._transform.writable;
  }

  get [Symbol.toStringTag](): string {
    return "TextDecoderStream";
  }
}

describeAs(TextEncoderStream, (s: TextEncoderStream) => [
  "TextEncoderStream",
  [
    ["encoding", "utf-8"],
    ["readable", s.readable],
    ["writable", s.writable],
  ],
]);
describeAs(TextDecoderStream, (s: TextDecoderStream) => [
  "TextDecoderStream",
  [
    ["encoding", s.encoding],
    ["fatal", s.fatal],
    ["ignoreBOM", s.ignoreBOM],
    ["readable", s.readable],
    ["writable", s.writable],
  ],
]);
