// Bun.file and Bun.write: a file as a lazily read Blob (BunFile), and
// writing strings, bytes, Blobs and Responses to files.

import { readFile, stat, unlink, writeFile } from "beyond:native";
import { Blob } from "./blob.ts";
import { describe, Formatter } from "./inspect.ts";
import { mkdirp } from "./sys/fs.ts";
import { dirname } from "./sys/path.ts";
import { fileURLToPath } from "./sys/url.ts";
import { ReadableStream, streamOfBytes } from "./streams.ts";

/** MIME types by extension (Bun's for the common ones). */
const MIME: Record<string, string> = {
  txt: "text/plain;charset=utf-8",
  html: "text/html;charset=utf-8",
  htm: "text/html;charset=utf-8",
  css: "text/css;charset=utf-8",
  js: "text/javascript;charset=utf-8",
  mjs: "text/javascript;charset=utf-8",
  cjs: "text/javascript;charset=utf-8",
  jsx: "text/javascript;charset=utf-8",
  ts: "text/javascript;charset=utf-8",
  mts: "text/javascript;charset=utf-8",
  tsx: "text/javascript;charset=utf-8",
  json: "application/json;charset=utf-8",
  map: "application/json;charset=utf-8",
  xml: "text/xml",
  csv: "text/csv",
  md: "text/markdown",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/vnd.microsoft.icon",
  wasm: "application/wasm",
  pdf: "application/pdf",
  zip: "application/zip",
  gz: "application/gzip",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
  webm: "video/webm",
  wav: "audio/wav",
};

/** The MIME type of a file by its extension. */
export function mimeOf(path: string): string {
  const slash = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  if (dot <= slash + 1) return "application/octet-stream";
  return MIME[path.slice(dot + 1).toLowerCase()] ?? "application/octet-stream";
}

function pathOf(p: string | URL): string {
  return p instanceof URL ? fileURLToPath(p) : String(p);
}

/** Bun.file(path): a Blob whose bytes are the file's, read when asked. */
export class BunFile extends Blob {
  #name: string;
  #path: string;
  #explicitType: string | undefined;

  constructor(path: string | URL, options?: { type?: string }) {
    super();
    this.#path = pathOf(path);
    this.#name = typeof path === "string" ? path : this.#path;
    this.#explicitType = options?.type;
    // (What reads a Blob's bytes reads the file.)
    Object.defineProperty(this, "_bytes", {
      get: () => new Uint8Array(readFile(this.#path, false) as ArrayBuffer),
      set: () => {},
      enumerable: false,
      configurable: true,
    });
  }

  get name(): string {
    return this.#name;
  }

  override get size(): number {
    const st = stat(this.#path, true, false);
    return st === undefined ? 0 : st.size;
  }

  override get type(): string {
    return this.#explicitType ?? mimeOf(this.#path);
  }

  get lastModified(): number {
    const st = stat(this.#path, true, false);
    return st === undefined ? 0 : Math.trunc(st.mtimeMs);
  }

  override async text(): Promise<string> {
    return readFile(this.#path, true) as string;
  }

  override async arrayBuffer(): Promise<ArrayBuffer> {
    return readFile(this.#path, false) as ArrayBuffer;
  }

  override async bytes(): Promise<Uint8Array> {
    return new Uint8Array(readFile(this.#path, false) as ArrayBuffer);
  }

  override async json(): Promise<any> {
    return JSON.parse(readFile(this.#path, true) as string);
  }

  override stream(): ReadableStream<Uint8Array> {
    const s = streamOfBytes(new Uint8Array(readFile(this.#path, false) as ArrayBuffer));
    s._blobType = this.type;
    s._sendType = this.type;
    return s;
  }

  override slice(start?: number, end?: number, contentType?: string): Blob {
    return Blob._of(this._bytes, this.type).slice(start, end, contentType ?? this.type);
  }

  async exists(): Promise<boolean> {
    const st = stat(this.#path, true, false);
    return st !== undefined && (st.mode & 0o170000) !== 0o040000;
  }

  async stat(): Promise<any> {
    return import.meta.require("node:fs").default.statSync(this.#path);
  }

  write(data: unknown): Promise<number> {
    return write(this, data);
  }

  async unlink(): Promise<void> {
    unlink(this.#path);
  }

  delete(): Promise<void> {
    return this.unlink();
  }

  get [Symbol.toStringTag](): string {
    return "Blob";
  }

  [describe](f: Formatter): void {
    f.record(`FileRef (${JSON.stringify(this.name)})`, [["type", this.type]], { lastComma: false, full: true });
  }
}

export function file(path: string | URL, options?: { type?: string }): BunFile {
  return new BunFile(path, options);
}

/** The bytes (or text) to write of what Bun.write takes. */
async function contentOf(data: unknown): Promise<string | Uint8Array> {
  if (typeof data === "string") return data;
  if (data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (data && typeof (data as any).arrayBuffer === "function") return new Uint8Array(await (data as any).arrayBuffer());
  return String(data);
}

/** Bun.write(destination, data): the number of bytes written (the file's
 * directories made if they are missing). */
export async function write(dest: unknown, data: unknown, options?: { createPath?: boolean; mode?: number }): Promise<number> {
  const path = dest instanceof BunFile ? (dest as any).name : pathOf(dest as string | URL);
  const content = await contentOf(data);
  if (options?.createPath !== false) mkdirp(dirname(path));
  return writeFile(path, content, false, options?.mode) as number;
}
