// FormData (XMLHttpRequest standard), and the form encodings of bodies:
// multipart/form-data (written and read) and
// application/x-www-form-urlencoded (read).

import { decodeUtf8, encodeUtf8, randomUUID } from "beyond:native";
import { Blob, File } from "./blob.ts";
import { describe, Formatter } from "./inspect.ts";
import { URLSearchParams } from "./url.ts";

export type FormDataEntryValue = string | File;

/** A Blob as a File (named `filename`, or "blob"; a File keeps its name unless given one). */
function toFile(value: Blob, filename: string | undefined): File {
  if (value instanceof File && filename === undefined) return value;
  const name = filename !== undefined ? String(filename) : value instanceof File ? value.name : "blob";
  const f = new File([], name, { type: value.type, lastModified: value instanceof File ? value.lastModified : Date.now() });
  f._bytes = value._bytes;
  if (!(value instanceof File)) f._showModified = false;
  return f;
}

function entryValue(value: string | Blob, filename: string | undefined): FormDataEntryValue {
  if (value instanceof Blob) return toFile(value, filename);
  return String(value);
}

export class FormData {
  _entries: [string, FormDataEntryValue][] = [];

  constructor(form?: unknown) {
    if (form !== undefined) throw new TypeError("FormData does not take a form element");
  }

  append(name: string, value: string | Blob, filename?: string): void {
    this._entries.push([String(name), entryValue(value, filename)]);
  }

  delete(name: string): void {
    const n = String(name);
    this._entries = this._entries.filter((e) => e[0] !== n);
  }

  get(name: string): FormDataEntryValue | null {
    const n = String(name);
    for (const e of this._entries) if (e[0] === n) return e[1];
    return null;
  }

  getAll(name: string): FormDataEntryValue[] {
    const n = String(name);
    return this._entries.filter((e) => e[0] === n).map((e) => e[1]);
  }

  has(name: string): boolean {
    const n = String(name);
    return this._entries.some((e) => e[0] === n);
  }

  set(name: string, value: string | Blob, filename?: string): void {
    const n = String(name);
    const v = entryValue(value, filename);
    const i = this._entries.findIndex((e) => e[0] === n);
    if (i < 0) {
      this._entries.push([n, v]);
    } else {
      this._entries[i] = [n, v];
      this._entries = this._entries.filter((e, j) => j <= i || e[0] !== n);
    }
  }

  *entries(): IterableIterator<[string, FormDataEntryValue]> {
    for (let i = 0; i < this._entries.length; i++) yield [this._entries[i][0], this._entries[i][1]];
  }

  *keys(): IterableIterator<string> {
    for (let i = 0; i < this._entries.length; i++) yield this._entries[i][0];
  }

  *values(): IterableIterator<FormDataEntryValue> {
    for (let i = 0; i < this._entries.length; i++) yield this._entries[i][1];
  }

  forEach(callback: (value: FormDataEntryValue, name: string, form: FormData) => void, thisArg?: any): void {
    for (let i = 0; i < this._entries.length; i++) callback.call(thisArg, this._entries[i][1], this._entries[i][0], this);
  }

  [Symbol.iterator](): IterableIterator<[string, FormDataEntryValue]> {
    return this.entries();
  }

  get [Symbol.toStringTag](): string {
    return "FormData";
  }

  [describe](f: Formatter): void {
    f.record("FormData", this._entries.map((e) => [e[0], e[1]]), { quoteKeys: true });
  }
}

/** A name or filename in a multipart header (", CR and LF escaped). */
function escapeName(s: string): string {
  return s.replaceAll("\"", "%22").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}

/** The multipart/form-data encoding of `form`: its bytes and content type. */
export function encodeMultipart(form: FormData): [Uint8Array, string] {
  const boundary = `----BeyondFormBoundary${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const parts: Uint8Array[] = [];
  let size = 0;
  const add = (b: Uint8Array) => {
    parts.push(b);
    size += b.length;
  };
  for (const [name, value] of form._entries) {
    if (typeof value === "string") {
      add(encodeUtf8(`--${boundary}\r\nContent-Disposition: form-data; name="${escapeName(name)}"\r\n\r\n`));
      add(encodeUtf8(value.replace(/\r\n|\r|\n/g, "\r\n")));
    } else {
      const type = value.type === "" ? "application/octet-stream" : value.type;
      add(
        encodeUtf8(
          `--${boundary}\r\nContent-Disposition: form-data; name="${escapeName(name)}"; filename="${escapeName(value.name)}"\r\nContent-Type: ${type}\r\n\r\n`,
        ),
      );
      add(value._bytes);
    }
    add(encodeUtf8("\r\n"));
  }
  add(encodeUtf8(`--${boundary}--\r\n`));
  const all = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.length;
  }
  return [all, `multipart/form-data; boundary=${boundary}`];
}

/** A parameter of a header value (`boundary=...`, `name="..."`). */
function param(header: string, key: string): string | null {
  const re = new RegExp(`(?:^|;)\\s*${key}\\s*=\\s*(?:"((?:[^"\\\\]|\\\\.)*)"|([^;\\s]*))`, "i");
  const m = re.exec(header);
  if (m === null) return null;
  return m[1] !== undefined ? m[1].replace(/\\(.)/g, "$1") : m[2];
}

function indexOf(hay: Uint8Array, needle: Uint8Array, from: number): number {
  const first = needle[0];
  outer: for (let i = from; i <= hay.length - needle.length; i++) {
    if (hay[i] !== first) continue;
    for (let j = 1; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

/** Parses a body as FormData, by its content type. */
export function parseForm(bytes: Uint8Array, contentType: string | null): FormData {
  const type = (contentType ?? "").toLowerCase();
  const form = new FormData();
  if (type.startsWith("application/x-www-form-urlencoded")) {
    for (const [k, v] of new URLSearchParams(decodeUtf8(bytes, false))) form.append(k, v);
    return form;
  }
  if (!type.startsWith("multipart/form-data")) {
    throw new TypeError(`Can't parse a body of type "${contentType ?? ""}" as FormData`);
  }
  const boundary = param(contentType as string, "boundary");
  if (boundary === null || boundary === "") throw new TypeError("The multipart body has no boundary");
  const delimiter = encodeUtf8(`--${boundary}`);
  let at = indexOf(bytes, delimiter, 0);
  if (at < 0) throw new TypeError("The multipart body has no parts");
  const headerEnd = encodeUtf8("\r\n\r\n");
  for (;;) {
    at += delimiter.length;
    // "--" after the delimiter: the end.
    if (bytes[at] === 0x2d && bytes[at + 1] === 0x2d) break;
    // (The line break after the delimiter.)
    if (bytes[at] === 0x0d && bytes[at + 1] === 0x0a) at += 2;
    const he = indexOf(bytes, headerEnd, at);
    if (he < 0) throw new TypeError("A multipart part has no end of headers");
    const headers = decodeUtf8(bytes.subarray(at, he), false).split("\r\n");
    const next = indexOf(bytes, delimiter, he + 4);
    if (next < 0) throw new TypeError("A multipart part has no end");
    // (The line break before the next delimiter is the delimiter's.)
    const content = bytes.subarray(he + 4, next >= 2 && bytes[next - 2] === 0x0d && bytes[next - 1] === 0x0a ? next - 2 : next);
    let name: string | null = null;
    let filename: string | null = null;
    let partType = "";
    for (const h of headers) {
      const colon = h.indexOf(":");
      if (colon < 0) continue;
      const key = h.slice(0, colon).trim().toLowerCase();
      const value = h.slice(colon + 1).trim();
      if (key === "content-disposition") {
        name = param(value, "name");
        filename = param(value, "filename");
      } else if (key === "content-type") {
        partType = value;
      }
    }
    if (name !== null) {
      if (filename !== null) {
        const f = new File([], filename, { type: partType });
        f._bytes = content.slice();
        form.append(name, f);
      } else {
        form.append(name, decodeUtf8(content, false));
      }
    }
    at = next;
  }
  return form;
}
