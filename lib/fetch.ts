// Headers, Request and Response (the Fetch standard), as Bun's behave
// (Bun's are in src/runtime/webcore: Request.rs, Response.rs, Body.rs, and
// WebKit's FetchHeaders). A body is kept as it was given while it can be (a
// string or bytes) and becomes a stream only when `body` is read; a body
// made of a stream is read from it.
//
// Internal state is in `_` fields rather than private (`#`) ones, and the
// checks avoid regular expressions: so that Luminous compiles these
// classes' constructors and methods to native code, the hot path of every
// request the server answers.

import { decodeUtf8, encodeUtf8 } from "beyond:native";
import { Blob } from "./blob.ts";
import { encodeMultipart, FormData, parseForm } from "./formdata.ts";
import { describe, Formatter } from "./inspect.ts";
import { readableStreamCancel, readAllBytes, ReadableStream, streamOfBytes } from "./streams.ts";
import { URLSearchParams } from "./url.ts";

export type HeadersInit = Headers | [string, string][] | Record<string, string>;
export type BodyInit =
  | string
  | ArrayBuffer
  | ArrayBufferView
  | Blob
  | FormData
  | URLSearchParams
  | ReadableStream<any>
  | AsyncIterable<any>
  | null;

/** Whether the character code `c` may be in an HTTP token (a header name). */
function tokenChar(c: number): boolean {
  if (c >= 97 && c <= 122) return true; // a-z
  if (c >= 65 && c <= 90) return true; // A-Z
  if (c >= 48 && c <= 57) return true; // 0-9
  // ! # $ % & ' * + - . ^ _ ` | ~
  return (
    c === 33 || (c >= 35 && c <= 39) || c === 42 || c === 43 || c === 45 || c === 46 ||
    c === 94 || c === 95 || c === 96 || c === 124 || c === 126
  );
}

/** A header name as the standard allows it (an HTTP token), in lower case. */
function checkName(name: string): string {
  const n = String(name);
  let upper = false;
  for (let i = 0; i < n.length; i++) {
    const c = n.charCodeAt(i);
    if (!tokenChar(c)) throw new TypeError(`Invalid header name: "${n}"`);
    if (c >= 65 && c <= 90) upper = true;
  }
  if (n.length === 0) throw new TypeError(`Invalid header name: "${n}"`);
  return upper ? n.toLowerCase() : n;
}

function isSpace(c: number): boolean {
  return c === 32 || c === 9 || c === 10 || c === 13;
}

/** A header value: without leading and trailing whitespace. */
function normalizeValue(value: string): string {
  let v = String(value);
  let start = 0;
  let end = v.length;
  while (start < end && isSpace(v.charCodeAt(start))) start++;
  while (end > start && isSpace(v.charCodeAt(end - 1))) end--;
  if (start > 0 || end < v.length) v = v.slice(start, end);
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    if (c === 0 || c === 10 || c === 13) throw new TypeError(`Invalid header value: "${v}"`);
  }
  return v;
}

export class Headers {
  // Lower-case names and their values, in the order they were added.
  _names: string[] = [];
  _values: string[] = [];

  constructor(init?: HeadersInit) {
    if (init === undefined || init === null) return;
    if (init instanceof Headers) {
      this._names = init._names.slice();
      this._values = init._values.slice();
    } else if (Array.isArray(init) || typeof (init as any)[Symbol.iterator] === "function") {
      for (const pair of init as Iterable<[string, string]>) {
        const p = Array.from(pair as any);
        if (p.length !== 2) throw new TypeError("A header must be a [name, value] pair");
        this.append(p[0] as string, p[1] as string);
      }
    } else {
      for (const name of Object.keys(init)) this.append(name, (init as Record<string, string>)[name]);
    }
  }

  /** From the server: [name, value, ...], names in lower case. */
  static _fromFlat(flat: string[]): Headers {
    const h = new Headers();
    for (let i = 0; i < flat.length; i += 2) {
      h._names.push(flat[i]);
      h._values.push(flat[i + 1]);
    }
    return h;
  }

  /** [name, value, ...], as the server writes them. */
  _flat(): string[] {
    const out: string[] = [];
    for (let i = 0; i < this._names.length; i++) out.push(this._names[i], this._values[i]);
    return out;
  }

  append(name: string, value: string): void {
    this._names.push(checkName(name));
    this._values.push(normalizeValue(value));
  }

  delete(name: string): void {
    const n = checkName(name);
    for (let i = this._names.length - 1; i >= 0; i--) {
      if (this._names[i] === n) {
        this._names.splice(i, 1);
        this._values.splice(i, 1);
      }
    }
  }

  get(name: string): string | null {
    const n = checkName(name);
    let out: string | null = null;
    for (let i = 0; i < this._names.length; i++) {
      if (this._names[i] === n) out = out === null ? this._values[i] : `${out}, ${this._values[i]}`;
    }
    return out;
  }

  getSetCookie(): string[] {
    const out: string[] = [];
    for (let i = 0; i < this._names.length; i++) if (this._names[i] === "set-cookie") out.push(this._values[i]);
    return out;
  }

  has(name: string): boolean {
    return this._names.includes(checkName(name));
  }

  set(name: string, value: string): void {
    const n = checkName(name);
    const v = normalizeValue(value);
    const i = this._names.indexOf(n);
    if (i < 0) {
      this._names.push(n);
      this._values.push(v);
      return;
    }
    this._values[i] = v;
    for (let j = this._names.length - 1; j > i; j--) {
      if (this._names[j] === n) {
        this._names.splice(j, 1);
        this._values.splice(j, 1);
      }
    }
  }

  get count(): number {
    return this._names.length;
  }

  /** In order of name, values of a name combined (but `set-cookie`'s). */
  *entries(): IterableIterator<[string, string]> {
    const names = [...new Set(this._names)].sort();
    for (const n of names) {
      if (n === "set-cookie") {
        for (const v of this.getSetCookie()) yield [n, v];
      } else {
        yield [n, this.get(n) as string];
      }
    }
  }

  *keys(): IterableIterator<string> {
    for (const [k] of this.entries()) yield k;
  }

  *values(): IterableIterator<string> {
    for (const [, v] of this.entries()) yield v;
  }

  forEach(callback: (value: string, name: string, headers: Headers) => void, thisArg?: any): void {
    for (const [k, v] of this.entries()) callback.call(thisArg, v, k, this);
  }

  [Symbol.iterator](): IterableIterator<[string, string]> {
    return this.entries();
  }

  toJSON(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of this.entries()) out[k] = v;
    return out;
  }

  get [Symbol.toStringTag](): string {
    return "Headers";
  }

  [describe](f: Formatter): void {
    f.record("Headers", [...this.entries()], { quoteKeys: true });
  }
}

/** A body as stored: a string, the bytes, or none. */
type Stored = string | ArrayBuffer | null;

// The content type the last body `store` took has, if any, and the stream
// it is (set by `store`).
let extractedType: string | null = null;
let extractedStream: ReadableStream<any> | null = null;

/** The bytes of a Uint8Array, as an ArrayBuffer (the same one if it is whole). */
function bufferOf(b: Uint8Array): ArrayBuffer {
  return b.byteOffset === 0 && b.byteLength === b.buffer.byteLength ? (b.buffer as ArrayBuffer) : (b.slice().buffer as ArrayBuffer);
}

/**
 * A body as stored, from what a Request or Response is made with; its
 * content type (a Blob's, a form's) in `extractedType`.
 */
function store(body: BodyInit | undefined): Stored {
  extractedType = null;
  extractedStream = null;
  if (body === undefined || body === null) return null;
  if (typeof body === "string") return body;
  if (body instanceof ArrayBuffer) return body;
  if (ArrayBuffer.isView(body)) {
    return (body.buffer as ArrayBuffer).slice(body.byteOffset, body.byteOffset + body.byteLength);
  }
  if (body instanceof Blob) {
    if (body.type !== "") extractedType = body.type;
    return bufferOf(body._bytes);
  }
  if (body instanceof FormData) {
    const [bytes, type] = encodeMultipart(body);
    extractedType = type;
    return bufferOf(bytes);
  }
  if (body instanceof URLSearchParams) {
    extractedType = "application/x-www-form-urlencoded;charset=UTF-8";
    return body.toString();
  }
  if (body instanceof ReadableStream) {
    if (body._disturbed || body._reader !== undefined) throw new TypeError("Body object should not be disturbed or locked");
    extractedStream = body;
    return null;
  }
  // (As Bun: an async generator function, or an async iterable, is read
  // as a stream.)
  let b: any = body;
  if (typeof b === "function" && Object.prototype.toString.call(b) === "[object AsyncGeneratorFunction]") b = b();
  if (typeof b === "object" && b !== null && typeof b[Symbol.asyncIterator] === "function") {
    extractedStream = ReadableStream.from(b);
    return null;
  }
  return String(body);
}

/** A stored body's size in bytes. */
function bodySize(b: Stored): number {
  if (b === null) return 0;
  return typeof b === "string" ? encodeUtf8(b).length : b.byteLength;
}

/** A stored body's bytes. */
function storedBytes(b: Stored): Uint8Array {
  if (b === null) return new Uint8Array(0);
  return typeof b === "string" ? encodeUtf8(b) : new Uint8Array(b);
}

function bodyUsedError(): TypeError {
  const e = new TypeError("Body already used");
  (e as any).code = "ERR_BODY_ALREADY_USED";
  return e;
}

/** How Bun names a body's size: "(N bytes)", or "(0 KB)" when empty. */
function sizeLabel(n: number): string {
  return n === 0 ? "(0 KB)" : `(${n} bytes)`;
}

/** What `fetch`'s bodies have in common (Body mixin). */
class Body {
  _body: Stored;
  // A body that is a stream, or the stream `body` made of the stored body
  // (`_streamOfBody`: its bytes are still those of `_body` until read).
  _stream: ReadableStream<any> | null = null;
  _streamOfBody = false;
  _used = false;

  constructor(body: Stored) {
    this._body = body;
  }

  get body(): ReadableStream<Uint8Array> | null {
    let s = this._stream;
    if (s === null) {
      if (this._body === null && !this._used) return null;
      s = streamOfBytes(this._used ? new Uint8Array(0) : storedBytes(this._body));
      if (this._used) s._disturbed = true;
      this._stream = s;
      this._streamOfBody = true;
    }
    return s;
  }

  get bodyUsed(): boolean {
    if (this._used) return true;
    const s = this._stream;
    // (As Bun's: a locked stream is used.)
    return s !== null && (s._disturbed || s._reader !== undefined);
  }

  /** The whole body: as stored, or a promise of a stream's bytes. */
  _consume(): Stored | Promise<Uint8Array> {
    if (this.bodyUsed) throw bodyUsedError();
    this._used = true;
    const s = this._stream;
    if (s === null) return this._body;
    if (this._streamOfBody) {
      // (Not read: the stored body, the stream done with.)
      readableStreamCancel(s, undefined);
      return this._body;
    }
    return readAllBytes(s);
  }

  async text(): Promise<string> {
    const c = this._consume();
    const b = c instanceof Promise ? await c : c;
    if (b === null) return "";
    if (typeof b === "string") return b;
    return decodeUtf8(b, false);
  }

  async json(): Promise<any> {
    return JSON.parse(await this.text());
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    const c = this._consume();
    if (c instanceof Promise) return bufferOf(await c);
    if (c === null) return new ArrayBuffer(0);
    return typeof c === "string" ? (encodeUtf8(c).buffer as ArrayBuffer) : c.slice(0);
  }

  async bytes(): Promise<Uint8Array> {
    const c = this._consume();
    if (c instanceof Promise) return await c;
    if (c === null) return new Uint8Array(0);
    return typeof c === "string" ? encodeUtf8(c) : new Uint8Array(c.slice(0));
  }

  /** The body's content type (overridden: Request's and Response's headers). */
  _mime(): string | null {
    return null;
  }

  async blob(): Promise<Blob> {
    const type = this._mime() ?? "";
    return Blob._of(await this.bytes(), type.toLowerCase());
  }

  async formData(): Promise<FormData> {
    const type = this._mime();
    return parseForm(await this.bytes(), type);
  }

  /** Gives `to` a copy of this body (a stream body is teed). */
  _cloneBodyTo(to: Body): void {
    if (this.bodyUsed) throw bodyUsedError();
    to._body = this._body;
    const s = this._stream;
    if (s !== null && !this._streamOfBody) {
      const [a, b] = s.tee();
      this._stream = a;
      to._stream = b;
    }
  }
}

export interface ResponseInit {
  status?: number;
  statusText?: string;
  headers?: HeadersInit;
}

const TEXT = "text/plain;charset=utf-8";
const JSON_TYPE = "application/json;charset=utf-8";

export class Response extends Body {
  readonly status: number;
  readonly statusText: string;
  // The headers; null until read when the init had none (most responses).
  _headers: Headers | null = null;
  // A content type the headers have but are not made with yet
  // (Response.json), and the one a string body is sent with if the
  // headers have none (as Bun's, not in the headers).
  _contentType: string | null = null;
  _defaultType: string | null = null;

  constructor(body?: BodyInit, init?: ResponseInit) {
    super(store(body));
    this._stream = extractedStream;
    let status = 200;
    let statusText = "";
    let headers: HeadersInit | undefined = undefined;
    if (init !== undefined && init !== null) {
      if (init.status !== undefined) status = init.status;
      if (init.statusText !== undefined) statusText = String(init.statusText);
      headers = init.headers;
    }
    if (!Number.isInteger(status) || status < 200 || status > 599) {
      throw new RangeError(`The status provided (${status}) must be an integer in the range 200 to 599`);
    }
    this.status = status;
    this.statusText = statusText;
    const type = extractedType;
    if (headers !== undefined) {
      const h = new Headers(headers);
      if (type !== null && !h.has("content-type")) h.append("content-type", type);
      this._headers = h;
    } else if (type !== null) {
      this._contentType = type;
    } else if (typeof this._body === "string") {
      this._defaultType = TEXT;
    }
  }

  _mime(): string | null {
    const h = this._headers;
    if (h !== null) return h.get("content-type") ?? this._defaultType;
    return this._contentType ?? this._defaultType;
  }

  get headers(): Headers {
    let h = this._headers;
    if (h === null) {
      h = new Headers();
      if (this._contentType !== null) h.append("content-type", this._contentType);
      this._headers = h;
      this._contentType = null;
    }
    return h;
  }

  /** The headers as the server writes them: [name, value, ...]. */
  _flat(): string[] {
    const h = this._headers;
    if (h === null) {
      const type = this._contentType ?? this._defaultType;
      return type === null ? [] : ["content-type", type];
    }
    const flat = h._flat();
    if (this._defaultType !== null && !h.has("content-type")) flat.push("content-type", this._defaultType);
    return flat;
  }

  get type(): string {
    return "default";
  }

  get url(): string {
    return "";
  }

  get redirected(): boolean {
    return false;
  }

  get ok(): boolean {
    return this.status >= 200 && this.status < 300;
  }

  clone(): Response {
    if (this.bodyUsed) throw bodyUsedError();
    const r = new Response(null, { status: this.status, statusText: this.statusText, headers: this.headers });
    this._cloneBodyTo(r);
    r._defaultType = this._defaultType;
    return r;
  }

  static json(data: any, init?: ResponseInit): Response {
    const r = new Response(JSON.stringify(data), init);
    r._defaultType = null;
    if (r._headers === null) r._contentType = JSON_TYPE;
    else if (!r._headers.has("content-type")) r._headers.set("content-type", JSON_TYPE);
    return r;
  }

  static redirect(url: string | URL, status = 302): Response {
    if (status !== 301 && status !== 302 && status !== 303 && status !== 307 && status !== 308) {
      throw new RangeError(`Invalid redirect status: ${status}`);
    }
    return new Response(null, { status, headers: { location: String(url) } });
  }

  static error(): Response {
    const r = new Response(null);
    Object.defineProperty(r, "type", { value: "error" });
    Object.defineProperty(r, "status", { value: 0 });
    return r;
  }

  get [Symbol.toStringTag](): string {
    return "Response";
  }

  [describe](f: Formatter): void {
    const size = bodySize(this._body);
    f.record(
      `Response ${sizeLabel(size)}`,
      [
        ["ok", this.ok],
        ["url", this.url],
        ["status", this.status],
        ["statusText", this.statusText],
        ["headers", this.headers],
        ["redirected", this.redirected],
        ["bodyUsed", this.bodyUsed],
      ],
      { tail: size > 0 ? `Blob (${size} bytes)` : undefined },
    );
  }
}

export interface RequestInit {
  method?: string;
  headers?: HeadersInit;
  body?: BodyInit;
}

/** A method as the standard normalizes it: the common ones in upper case. */
function normalizeMethod(method: string): string {
  const m = String(method);
  if (m.length < 3 || m.length > 7) return m;
  const u = m.toUpperCase();
  if (u === "GET" || u === "HEAD" || u === "POST" || u === "PUT" || u === "DELETE" || u === "OPTIONS" || u === "PATCH") {
    return u;
  }
  return m;
}

/** The body of `new Request(input, init)` (a stream in `extractedStream`). */
function requestBody(input: string | Request, init: RequestInit | undefined): Stored {
  if (init !== undefined && init.body !== undefined) return store(init.body);
  extractedType = null;
  extractedStream = null;
  if (!(input instanceof Request)) return null;
  if (input.bodyUsed) throw bodyUsedError();
  // (A stream body moves to the new request.)
  if (input._stream !== null && !input._streamOfBody) {
    extractedStream = input._stream;
    input._used = true;
  }
  return input._body;
}

export class Request extends Body {
  readonly method: string;
  readonly url: string;
  // (From the server: the fields, until `headers` is read.)
  _flat: string[] | null = null;
  _headers: Headers | null = null;

  constructor(input: string | Request, init?: RequestInit) {
    super(requestBody(input, init));
    this._stream = extractedStream;
    const from = input instanceof Request ? input : null;
    this.url = from !== null ? from.url : String(input);
    let method = from !== null ? from.method : "GET";
    if (init !== undefined && init.method !== undefined) method = normalizeMethod(init.method);
    this.method = method;
    const type = extractedType;
    if (init !== undefined && init.headers !== undefined) this._headers = new Headers(init.headers);
    else if (from !== null) this._headers = new Headers(from.headers);
    if (type !== null && init !== undefined && init.body !== undefined) {
      if (this._headers === null) this._headers = new Headers();
      if (!this._headers.has("content-type")) this._headers.append("content-type", type);
    }
    if ((method === "GET" || method === "HEAD") && (this._body !== null || this._stream !== null)) {
      throw new TypeError("Request with GET/HEAD method cannot have body.");
    }
  }

  /** A request the server received. */
  static _fromServer(method: string, url: string, flat: string[], body: ArrayBuffer | undefined): Request {
    const r = new Request(url);
    if (method !== "GET") (r as any).method = method;
    if (body !== undefined) r._body = body;
    r._flat = flat;
    return r;
  }

  _mime(): string | null {
    return this.headers.get("content-type");
  }

  get headers(): Headers {
    let h = this._headers;
    if (h === null) {
      h = this._flat !== null ? Headers._fromFlat(this._flat) : new Headers();
      this._headers = h;
      this._flat = null;
    }
    return h;
  }

  clone(): Request {
    if (this.bodyUsed) throw bodyUsedError();
    const r = new Request(this.url, { headers: this.headers });
    (r as any).method = this.method;
    this._cloneBodyTo(r);
    return r;
  }

  get [Symbol.toStringTag](): string {
    return "Request";
  }

  [describe](f: Formatter): void {
    const size = bodySize(this._body);
    f.record(
      `Request ${sizeLabel(size)}`,
      [
        ["method", this.method],
        ["url", this.url],
        ["headers", this.headers],
      ],
      { tail: size > 0 ? `Blob (${size} bytes)` : undefined, lastComma: false },
    );
  }
}
