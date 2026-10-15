// Blob and File (the File API): bytes in memory, with a MIME type.

import { decodeUtf8, encodeUtf8 } from "beyond:native";
import { describe, Formatter } from "./inspect.ts";
import { ReadableStream, setBlobMaker, streamOfBytes } from "./streams.ts";

export type BlobPart = string | ArrayBuffer | ArrayBufferView | Blob;

export interface BlobPropertyBag {
  type?: string;
  endings?: "transparent" | "native";
}

/**
 * A type as Blob keeps it: lower case (empty if not printable ASCII), and
 * the few that Bun's MIME table has a canonical form of in that form
 * (MimeType.rs: `by_name_static`).
 */
function normalizeType(t: string | undefined): string {
  if (t === undefined) return "";
  const s = String(t);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c > 0x7e) return "";
  }
  // (The table's names match as they are; the rest is lower case.)
  switch (s) {
    case "text/plain":
      return "text/plain;charset=utf-8";
    case "text/html":
      return "text/html;charset=utf-8";
    case "text/css":
      return "text/css;charset=utf-8";
    case "application/javascript":
    case "text/javascript":
    case "text/jsx":
      return "text/javascript;charset=utf-8";
    case "application/json":
      return "application/json;charset=utf-8";
    case "application/x-www-form-urlencoded":
      return "application/x-www-form-urlencoded;charset=UTF-8";
    case "application/webassembly":
      return "application/wasm";
  }
  return s.toLowerCase();
}

/** The bytes of a part. */
function bytesOf(part: BlobPart, native: boolean): Uint8Array {
  if (part instanceof Blob) return part._bytes;
  if (part instanceof ArrayBuffer) return new Uint8Array(part.slice(0));
  if (ArrayBuffer.isView(part)) return new Uint8Array(part.buffer.slice(part.byteOffset, part.byteOffset + part.byteLength));
  let s = String(part);
  if (native) s = s.replace(/\r\n|\r|\n/g, "\n");
  return encodeUtf8(s);
}

export class Blob {
  _bytes: Uint8Array;
  _type: string;

  constructor(parts?: Iterable<BlobPart>, options?: BlobPropertyBag) {
    if (parts !== undefined && parts !== null && (typeof parts !== "object" || typeof (parts as any)[Symbol.iterator] !== "function")) {
      throw new TypeError("The \"blobParts\" argument must be an iterable");
    }
    const native = options?.endings === "native";
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (parts !== undefined && parts !== null) {
      for (const p of parts) {
        const b = bytesOf(p, native);
        chunks.push(b);
        size += b.length;
      }
    }
    if (chunks.length === 1) {
      this._bytes = chunks[0];
    } else {
      const all = new Uint8Array(size);
      let at = 0;
      for (const c of chunks) {
        all.set(c, at);
        at += c.length;
      }
      this._bytes = all;
    }
    this._type = normalizeType(options?.type);
  }

  /** A Blob over `bytes` (not copied). */
  static _of(bytes: Uint8Array, type: string): Blob {
    const b = new Blob();
    b._bytes = bytes;
    b._type = type;
    return b;
  }

  get size(): number {
    return this._bytes.length;
  }

  get type(): string {
    return this._type;
  }

  slice(start?: number, end?: number, contentType?: string): Blob {
    const size = this._bytes.length;
    const clamp = (v: number | undefined, d: number): number => {
      if (v === undefined) return d;
      const n = Math.trunc(Number(v)) || 0;
      return n < 0 ? Math.max(size + n, 0) : Math.min(n, size);
    };
    const s = clamp(start, 0);
    const e = clamp(end, size);
    return Blob._of(this._bytes.slice(s, Math.max(s, e)), normalizeType(contentType));
  }

  async text(): Promise<string> {
    return decodeUtf8(this._bytes, false);
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    return this._bytes.slice().buffer as ArrayBuffer;
  }

  async bytes(): Promise<Uint8Array> {
    return this._bytes.slice();
  }

  async json(): Promise<any> {
    return JSON.parse(decodeUtf8(this._bytes, false));
  }

  stream(): ReadableStream<Uint8Array> {
    const s = streamOfBytes(this._bytes.slice());
    // (As Bun's: its type, else text; sent as an octet stream without one.)
    s._blobType = this._type !== "" ? this._type : "text/plain;charset=utf-8";
    s._sendType = this._type !== "" ? this._type : "application/octet-stream";
    return s;
  }

  get [Symbol.toStringTag](): string {
    return "Blob";
  }

  [describe](f: Formatter): void {
    const size = this.size === 0 ? "0 KB" : `${this.size} bytes`;
    if (this._type === "") f.write(`Blob (${size})`);
    else f.record(`Blob (${size})`, [["type", this._type]], { lastComma: false, full: true });
  }
}

export interface FilePropertyBag extends BlobPropertyBag {
  lastModified?: number;
}

export class File extends Blob {
  _name: string;
  _lastModified: number;
  // (Printed, unless the File was made from a Blob by FormData, as Bun's.)
  _showModified = true;

  constructor(parts: Iterable<BlobPart>, name: string, options?: FilePropertyBag) {
    super(parts, options);
    this._name = String(name);
    this._lastModified = options?.lastModified !== undefined ? Number(options.lastModified) : Date.now();
  }

  get name(): string {
    return this._name;
  }

  get lastModified(): number {
    return this._lastModified;
  }

  get webkitRelativePath(): string {
    return "";
  }

  get [Symbol.toStringTag](): string {
    return "File";
  }

  [describe](f: Formatter): void {
    const entries: [string, unknown][] = [["name", this._name]];
    if (this._type !== "") entries.push(["type", this._type]);
    if (this._showModified) entries.push(["lastModified", this._lastModified]);
    f.record(`File (${this.size === 0 ? "0 KB" : `${this.size} bytes`})`, entries, { lastComma: false, full: true });
  }
}

// (ReadableStream's `blob()`, Bun's.)
setBlobMaker((b) => Blob._of(b, ""));
