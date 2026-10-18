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

import { decodeUtf8, encodeUtf8, parseJson, parseJsonAs, promiseNew, promiseSettle, setJsonHook } from "beyond:native";
import { Blob } from "./blob.ts";
import { encodeMultipart, FormData, parseForm } from "./formdata.ts";
import { describe, Formatter } from "./inspect.ts";
import {
  controllerClose,
  controllerEnqueue,
  controllerError,
  createReadableStream,
  readableStreamCancel,
  readAllBytes,
  ReadableStream,
  ReadableStreamDefaultController,
  ReadableStreamDefaultReader,
  streamOfBytes,
} from "./streams.ts";
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

// Header names already checked, and their lower case (programs and
// frameworks give the same few names to every response).
const checkedNames = new Map<string, string>();

/** A header name as the standard allows it (an HTTP token), in lower case. */
function checkName(name: string): string {
  const known = checkedNames.get(name);
  if (known !== undefined) return known;
  const n = String(name);
  let upper = false;
  for (let i = 0; i < n.length; i++) {
    const c = n.charCodeAt(i);
    if (!tokenChar(c)) throw new TypeError(`Invalid header name: "${n}"`);
    if (c >= 65 && c <= 90) upper = true;
  }
  if (n.length === 0) throw new TypeError(`Invalid header name: "${n}"`);
  const lower = upper ? n.toLowerCase() : n;
  // (At most 256 of them: the names a program uses, not every one it is sent.)
  if (typeof name === "string" && checkedNames.size < 256) checkedNames.set(name, lower);
  return lower;
}

function isSpace(c: number): boolean {
  return c === 32 || c === 9 || c === 10 || c === 13;
}

/** A header value: without leading and trailing whitespace. */
function normalizeValue(value: string): string {
  let v = String(value);
  // (Most values: nothing to trim and no byte to refuse, found by the
  // engine's searches rather than a loop over the characters.)
  const n = v.length;
  if (n > 0 && !isSpace(v.charCodeAt(0)) && !isSpace(v.charCodeAt(n - 1)) && v.indexOf("\n") < 0 && v.indexOf("\r") < 0 && v.indexOf("\0") < 0) {
    return v;
  }
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

// The names WebKit's header map knows (HTTPHeaderNames.in, but set-cookie):
// Bun's Headers show them first, then set-cookie, then the others, each in
// the order it was first added.
const COMMON_NAMES = new Set<string>([
  "accept", "accept-charset", "accept-language", "accept-encoding", "accept-ranges",
  "access-control-allow-credentials", "access-control-allow-headers",
  "access-control-allow-methods", "access-control-allow-origin", "access-control-expose-headers",
  "access-control-max-age", "access-control-request-headers", "access-control-request-method",
  "age", "authorization", "cache-control", "connection", "content-disposition", "content-encoding",
  "content-language", "content-length", "content-location", "content-security-policy",
  "content-security-policy-report-only", "content-type", "content-range", "cookie", "cookie2",
  "cross-origin-embedder-policy", "cross-origin-embedder-policy-report-only",
  "cross-origin-opener-policy", "cross-origin-opener-policy-report-only",
  "cross-origin-resource-policy", "date", "dnt", "default-style", "etag", "expect", "expires",
  "host", "if-match", "if-modified-since", "if-none-match", "if-range", "if-unmodified-since",
  "keep-alive", "last-event-id", "last-modified", "link", "location", "origin", "ping-from",
  "ping-to", "purpose", "pragma", "proxy-authorization", "proxy-connection", "range", "referer",
  "referrer-policy", "refresh", "report-to", "sec-fetch-dest", "sec-fetch-mode",
  "sec-websocket-accept", "sec-websocket-extensions", "sec-websocket-key",
  "sec-websocket-protocol", "sec-websocket-version", "server-timing", "service-worker",
  "service-worker-allowed", "service-worker-navigation-preload", "set-cookie2", "sourcemap", "te",
  "timing-allow-origin", "trailer", "transfer-encoding", "upgrade", "upgrade-insecure-requests",
  "user-agent", "vary", "via", "x-content-type-options", "x-dns-prefetch-control",
  "x-frame-options", "x-sourcemap", "x-xss-protection", "x-temp-tablet", "icy-metaint",
  "icy-metadata",
]);

/** How the values of a header name are combined (cookies: "; "). */
function combine(name: string, a: string, b: string): string {
  return name === "cookie" ? `${a}; ${b}` : `${a}, ${b}`;
}

export class Headers {
  // Lower-case names and their values, in the order they were added.
  _names: string[];
  _values: string[];

  constructor(init?: HeadersInit) {
    if (init instanceof Headers) {
      this._names = init._names.slice();
      this._values = init._values.slice();
      return;
    }
    this._names = [];
    this._values = [];
    if (init === undefined || init === null) return;
    if (Array.isArray(init) || typeof (init as any)[Symbol.iterator] === "function") {
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
      if (this._names[i] === n) out = out === null ? this._values[i] : combine(n, out, this._values[i]);
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

  /**
   * [name, value, ...] in order of name, the values of a name combined (but
   * `set-cookie`'s).
   */
  _sorted(): string[] {
    const names = this._names;
    const values = this._values;
    const out: string[] = [];
    if (names.length === 0) return out;
    const unique = names.length === 1 ? names.slice() : [...new Set(names)].sort();
    for (let u = 0; u < unique.length; u++) {
      const n = unique[u];
      let combined: string | null = null;
      for (let i = 0; i < names.length; i++) {
        if (names[i] !== n) continue;
        if (n === "set-cookie") out.push(n, values[i]);
        else combined = combined === null ? values[i] : combine(n, combined, values[i]);
      }
      if (combined !== null) out.push(n, combined);
    }
    return out;
  }

  /** In order of name, values of a name combined (but `set-cookie`'s). */
  *entries(): IterableIterator<[string, string]> {
    const flat = this._sorted();
    for (let i = 0; i < flat.length; i += 2) yield [flat[i], flat[i + 1]];
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

  /**
   * The headers as Bun shows them (toJSON, console.log): the names its
   * header map knows, set-cookie's values, then the others, each name where
   * it was first added, its values combined.
   */
  _shown(): [string, string | string[]][] {
    const names = this._names;
    const values = this._values;
    const common: [string, string][] = [];
    const other: [string, string][] = [];
    const cookies: string[] = [];
    for (let i = 0; i < names.length; i++) {
      const n = names[i];
      if (n === "set-cookie") {
        cookies.push(values[i]);
        continue;
      }
      const list = COMMON_NAMES.has(n) ? common : other;
      let found = false;
      for (let k = 0; k < list.length; k++) {
        if (list[k][0] === n) {
          list[k][1] = combine(n, list[k][1], values[i]);
          found = true;
          break;
        }
      }
      if (!found) list.push([n, values[i]]);
    }
    const out: [string, string | string[]][] = common;
    if (cookies.length > 0) out.push(["set-cookie", cookies]);
    for (let k = 0; k < other.length; k++) out.push(other[k]);
    return out;
  }

  toJSON(): Record<string, string | string[]> {
    const out: Record<string, string | string[]> = {};
    for (const [k, v] of this._shown()) out[k] = v;
    return out;
  }

  get [Symbol.toStringTag](): string {
    return "Headers";
  }

  [describe](f: Formatter): void {
    // (Bun shows its toJSON object: past the depth, `[Object ...]`.)
    if (f.tooDeep()) f.write("Headers [Object ...]");
    else f.record("Headers", this._shown(), { quoteKeys: true });
  }
}

/** A body as stored: a string, the bytes, or none. */
type Stored = string | ArrayBuffer | null;

// The content type the last body `store` took has, if any, the stream it
// is, and the type it is sent with when the response has none (set by
// `store`).
let extractedType: string | null = null;
let extractedStream: ReadableStream<any> | null = null;
let extractedDefault: string | null = null;

const OCTET = "application/octet-stream";

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
  extractedDefault = null;
  if (body === undefined || body === null) return null;
  // (As Bun's: text for a string or a Blob without a type, an octet stream
  // for bytes.)
  if (typeof body === "string") {
    extractedDefault = TEXT;
    return body;
  }
  if (body instanceof ArrayBuffer) {
    extractedDefault = OCTET;
    return body;
  }
  if (ArrayBuffer.isView(body)) {
    extractedDefault = OCTET;
    return (body.buffer as ArrayBuffer).slice(body.byteOffset, body.byteOffset + body.byteLength);
  }
  if (body instanceof Blob) {
    if (body.type !== "") extractedType = body.type;
    else extractedDefault = TEXT;
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
  extractedDefault = TEXT;
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

/** A promise fulfilled with `v` (made settled: no resolving functions). */
function resolved<T>(v: T): Promise<T> {
  const p = promiseNew() as Promise<T>;
  promiseSettle(p, v, false);
  return p;
}

/** A promise rejected with `e`. */
function rejected<T>(e: unknown): Promise<T> {
  const p = promiseNew() as Promise<T>;
  promiseSettle(p, e, true);
  return p;
}

/** A body's text: as stored, or its bytes decoded (UTF-8 decode: a byte order mark dropped). */
function textOf(b: Stored | Uint8Array): string {
  if (b === null) return "";
  if (typeof b === "string") return b;
  const t = decodeUtf8(b, false);
  return t.charCodeAt(0) === 0xfeff ? t.slice(1) : t;
}

function jsonOf(b: Stored | Uint8Array): any {
  if (b !== null && typeof b !== "string") {
    // (From the bytes, not decoded first: the same value.)
    const v = parseJson(b);
    if (v !== undefined) return v;
  }
  return JSON.parse(textOf(b));
}

/**
 * `jsonOf` where the result is converted to the `aot type` `desc` names:
 * bytes parsed to it directly when they can be (only its fields read).
 */
function jsonAsOf(b: Stored | Uint8Array, desc: number): any {
  if (b !== null && typeof b !== "string") {
    const v = parseJsonAs(b, desc);
    if (v !== undefined) return v;
  }
  return jsonOf(b);
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

// (Read ahead of a consumer: past it, the connection is paused.)
const INCOMING_LIMIT = 1 << 20;

/** What an arriving body comes from (fetch()'s request). */
export interface IncomingOwner {
  _pause(paused: boolean): void;
  _cancel(): void;
}

/**
 * A body arriving over a connection (fetch()'s responses), as Bun's
 * (Body.Value.Locked): its chunks kept until it is read whole, and a
 * stream made only if `body` is read.
 */
export class Incoming {
  chunks: Uint8Array[] = [];
  size = 0;
  done = false;
  failed = false;
  error: unknown = undefined;
  paused = false;
  // Waiting for all of it (`text()` and the like).
  resolve: ((b: Uint8Array) => void) | null = null;
  reject: ((e: unknown) => void) | null = null;
  // Once it is a stream.
  controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  // What pauses the connection, or ends it when the body is canceled.
  owner: IncomingOwner;

  constructor(owner: IncomingOwner) {
    this.owner = owner;
  }

  push(chunk: Uint8Array): void {
    const c = this.controller;
    if (c !== null) {
      controllerEnqueue(c, chunk);
      const size = c._strategyHWM - c._queueTotalSize;
      if (size <= 0 && !this.paused) this.setPaused(true);
      return;
    }
    this.chunks.push(chunk);
    this.size += chunk.length;
    if (this.size > INCOMING_LIMIT && this.resolve === null && !this.paused) this.setPaused(true);
  }

  end(): void {
    this.done = true;
    if (this.controller !== null) controllerClose(this.controller);
    else if (this.resolve !== null) this.resolve(this.joined());
  }

  fail(e: unknown): void {
    this.failed = true;
    this.error = e;
    if (this.controller !== null) controllerError(this.controller, e);
    else if (this.reject !== null) this.reject(e);
  }

  setPaused(p: boolean): void {
    this.paused = p;
    this.owner._pause(p);
  }

  joined(): Uint8Array {
    const chunks = this.chunks;
    this.chunks = [];
    if (chunks.length === 1) return chunks[0];
    const all = new Uint8Array(this.size);
    let at = 0;
    for (const c of chunks) {
      all.set(c, at);
      at += c.length;
    }
    return all;
  }

  /** All of it, when it has arrived. */
  all(): Promise<Uint8Array> {
    if (this.failed) return Promise.reject(this.error);
    if (this.done) return Promise.resolve(this.joined());
    if (this.paused) this.setPaused(false);
    return new Promise<Uint8Array>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }

  /** The stream of it: what arrived, then what arrives. */
  stream(): ReadableStream<Uint8Array> {
    const s = createReadableStream<Uint8Array>(
      (): undefined => undefined,
      () => {
        if (this.paused && !this.done) this.setPaused(false);
        return Promise.resolve();
      },
      () => {
        if (!this.done && !this.failed) this.owner._cancel();
        return Promise.resolve();
      },
      65536,
      (chunk: Uint8Array) => chunk.byteLength,
    );
    const c = s._controller as ReadableStreamDefaultController<Uint8Array>;
    this.controller = c;
    for (const chunk of this.chunks) controllerEnqueue(c, chunk);
    this.chunks = [];
    if (this.failed) controllerError(c, this.error);
    else if (this.done) controllerClose(c);
    return s;
  }
}

/** What `fetch`'s bodies have in common (Body mixin). */
class Body {
  _body: Stored;
  // A body that is a stream, or the stream `body` made of the stored body
  // (`_streamOfBody`: its bytes are still those of `_body` until read).
  _stream: ReadableStream<any> | null = null;
  _streamOfBody = false;
  _used = false;
  // A body arriving (no stream made of it yet).
  _incoming: Incoming | null = null;
  // The content type that comes with the stored body (a Blob's, a form's).
  _bodyType: string | null = null;
  // A request the server received: its body's stream is read from the
  // connection, as Bun's (never sent whole, as a stored body's is).
  _received = false;

  constructor(body: Stored) {
    this._body = body;
  }

  get body(): ReadableStream<Uint8Array> | null {
    let s = this._stream;
    if (s === null) {
      const incoming = this._incoming;
      if (incoming !== null) {
        s = incoming.stream();
        this._incoming = null;
      } else {
        // (No body: null, read or not, as Bun's.)
        if (this._body === null) return null;
        s = streamOfBytes(this._used ? new Uint8Array(0) : storedBytes(this._body));
        this._streamOfBody = true;
        if (!this._received) {
          // (As Bun's, a stream of the body's Blob: its type, else text,
          // and sent as an octet stream when it has none.)
          const t = this._bodyType;
          s._blobType = t ?? TEXT;
          s._sendType = t ?? OCTET;
          this._bodyStreamMade();
        }
      }
      if (this._received) s._received = true;
      // (A body already read: its stream is locked, as Bun's.)
      if (this._used) {
        s._disturbed = true;
        new ReadableStreamDefaultReader(s);
      }
      this._stream = s;
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
    if (s === null) {
      const incoming = this._incoming;
      if (incoming !== null) return incoming.all();
      return this._body;
    }
    if (this._streamOfBody) {
      // (Not read: the stored body. The stream is done with, and locked, as
      // Bun 1.4.3's is.)
      new ReadableStreamDefaultReader(s);
      readableStreamCancel(s, undefined);
      return this._body;
    }
    return readAllBytes(s);
  }

  // (Not async functions: a stored body's promise is made settled, as
  // Bun's are.)
  text(): Promise<string> {
    // (A stored body, not read yet.)
    if (this._stream === null && this._incoming === null && !this._used) {
      this._used = true;
      return Promise.resolve(textOf(this._body));
    }
    let c: Stored | Promise<Uint8Array>;
    try {
      c = this._consume();
    } catch (e) {
      return rejected(e);
    }
    if (c instanceof Promise) return c.then(textOf);
    return Promise.resolve(textOf(c));
  }

  json(): Promise<any> {
    let c: Stored | Promise<Uint8Array>;
    try {
      c = this._consume();
    } catch (e) {
      return rejected(e);
    }
    if (c instanceof Promise) return c.then(jsonOf);
    let v: any;
    try {
      v = jsonOf(c);
    } catch (e) {
      return rejected(e);
    }
    return resolved(v);
  }

  /** `json()` whose result is converted to an `aot type` (see `jsonAsOf`). */
  _jsonAs(desc: number): Promise<any> {
    let c: Stored | Promise<Uint8Array>;
    try {
      c = this._consume();
    } catch (e) {
      return rejected(e);
    }
    if (c instanceof Promise) return c.then((b) => jsonAsOf(b, desc));
    let v: any;
    try {
      v = jsonAsOf(c, desc);
    } catch (e) {
      return rejected(e);
    }
    return resolved(v);
  }

  arrayBuffer(): Promise<ArrayBuffer> {
    let c: Stored | Promise<Uint8Array>;
    try {
      c = this._consume();
    } catch (e) {
      return rejected(e);
    }
    if (c instanceof Promise) return c.then(bufferOf);
    if (c === null) return resolved(new ArrayBuffer(0));
    return resolved(typeof c === "string" ? (encodeUtf8(c).buffer as ArrayBuffer) : c.slice(0));
  }

  bytes(): Promise<Uint8Array> {
    let c: Stored | Promise<Uint8Array>;
    try {
      c = this._consume();
    } catch (e) {
      return rejected(e);
    }
    if (c instanceof Promise) return c;
    if (c === null) return resolved(new Uint8Array(0));
    return resolved(typeof c === "string" ? encodeUtf8(c) : new Uint8Array(c.slice(0)));
  }

  /** The body's content type (overridden: Request's and Response's headers). */
  _mime(): string | null {
    return null;
  }

  /** After `body` made a stream of the stored body (overridden: Response). */
  _bodyStreamMade(): void {}

  /** The content type the body was given (overridden: Response). */
  _givenType(): string | null {
    return this._mime();
  }

  async blob(): Promise<Blob> {
    // (As Bun's: the type the body was given, as given; else a stored
    // body's is text, and a stream's that of the Blob it is of.)
    const type = this._givenType() ?? (this._body !== null ? TEXT : (this._stream?._blobType ?? ""));
    return Blob._of(await this.bytes(), type);
  }

  async formData(): Promise<FormData> {
    const type = this._mime();
    return parseForm(await this.bytes(), type);
  }

  /** Gives `to` a copy of this body (a stream body is teed). */
  _cloneBodyTo(to: Body): void {
    if (this.bodyUsed) throw bodyUsedError();
    // (An arriving body: as a stream, teed.)
    if (this._incoming !== null) this.body;
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

// `await r.json()` where Luminous converts the result to an `aot type`: a
// body read and parsed to it directly.
setJsonHook((r: unknown, desc: number) => (r instanceof Body ? r._jsonAs(desc) : undefined));

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
  // The content type the body is sent with when the response has none (a
  // string's, a Blob's, bytes'; not an empty body's), as Bun's.
  _sendDefault: string | null = null;
  // (fetch()'s: the URL it answers, whether redirects led there, and the
  // headers as they came, [name, value, ...], until `headers` is read.)
  _url = "";
  _redirected = false;
  _rawHeaders: string[] | null = null;

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
    this._bodyType = type;
    if (headers !== undefined) {
      const h = new Headers(headers);
      if (type !== null && !h.has("content-type")) h.append("content-type", type);
      this._headers = h;
    } else if (type !== null) {
      this._contentType = type;
    }
    // (A string's type, not in the headers, as Bun's: sent if they have
    // none, and its Blob's.)
    if (type === null && typeof this._body === "string") this._defaultType = TEXT;
    if (type === null) this._sendDefault = extractedDefault;
  }

  /** The content type sent when the headers have none. */
  _sendType(): string | null {
    const b = this._body;
    if (b === null || (typeof b === "string" ? b.length === 0 : b.byteLength === 0)) return null;
    return this._sendDefault;
  }

  _givenType(): string | null {
    const h = this._headers ?? (this._rawHeaders !== null ? this.headers : null);
    return h !== null ? h.get("content-type") : this._contentType;
  }

  _bodyStreamMade(): void {
    // (As Bun's: the body's content type, not in the headers yet, goes with
    // its stream; the headers made after it do not have it.)
    if (this._headers === null && this._contentType !== null && this._contentType === this._bodyType) this._contentType = null;
  }

  _mime(): string | null {
    const h = this._headers ?? (this._rawHeaders !== null ? this.headers : null);
    if (h !== null) return h.get("content-type") ?? this._defaultType;
    return this._contentType ?? this._defaultType;
  }

  get headers(): Headers {
    let h = this._headers;
    if (h === null) {
      const raw = this._rawHeaders;
      if (raw !== null) {
        h = Headers._fromFlat(raw);
        this._rawHeaders = null;
      } else {
        h = new Headers();
        if (this._contentType !== null) h.append("content-type", this._contentType);
        this._contentType = null;
      }
      this._headers = h;
    }
    return h;
  }

  /** The headers as the server writes them: [name, value, ...]. */
  _flat(): string[] {
    const h = this._headers ?? (this._rawHeaders !== null ? this.headers : null);
    if (h === null) {
      const type = this._contentType ?? this._sendType();
      return type === null ? [] : ["content-type", type];
    }
    const flat = h._flat();
    const type = this._sendType();
    if (type !== null && !h.has("content-type")) flat.push("content-type", type);
    return flat;
  }

  get type(): string {
    return "default";
  }

  get url(): string {
    return this._url;
  }

  get redirected(): boolean {
    return this._redirected;
  }

  get ok(): boolean {
    return this.status >= 200 && this.status < 300;
  }

  clone(): Response {
    if (this.bodyUsed) throw bodyUsedError();
    const r = new Response(null, { status: this.status, statusText: this.statusText, headers: this.headers });
    this._cloneBodyTo(r);
    r._defaultType = this._defaultType;
    r._sendDefault = this._sendDefault;
    r._url = this._url;
    r._redirected = this._redirected;
    return r;
  }

  static json(data: any, init?: ResponseInit): Response {
    const r = new Response(JSON.stringify(data), init);
    r._defaultType = null;
    r._sendDefault = null;
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
    // (As Bun's: a used body has no size.)
    const size = this.bodyUsed ? 0 : bodySize(this._body);
    const tail = size > 0 ? `Blob (${size} bytes)` : undefined;
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
      { tail, lastComma: tail !== undefined, full: true },
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

/** [name, value, ...] of a request's packed fields (Request._fields). */
export function unpackFields(fields: string): string[] {
  return fields === "" ? [] : fields.split("\r");
}

export class Request extends Body {
  readonly method: string;
  readonly url: string;
  // (From the server: its fields, until `headers` is read, packed as
  // "name\rvalue\rname\rvalue": a field holds no CR.)
  _fields: string | null = null;
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
    if (init !== undefined && init.body !== undefined) this._bodyType = type;
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
  static _fromServer(method: string, url: string, fields: string, body: ArrayBuffer | undefined): Request {
    const r = new Request(url);
    if (method !== "GET") (r as any).method = method;
    if (body !== undefined) r._body = body;
    r._fields = fields;
    r._received = true;
    return r;
  }

  _mime(): string | null {
    return this.headers.get("content-type");
  }

  get headers(): Headers {
    let h = this._headers;
    if (h === null) {
      h = this._fields !== null ? Headers._fromFlat(unpackFields(this._fields)) : new Headers();
      this._headers = h;
      this._fields = null;
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
    const size = this.bodyUsed ? 0 : bodySize(this._body);
    f.record(
      `Request ${sizeLabel(size)}`,
      [
        ["method", this.method],
        ["url", this.url],
        ["headers", this.headers],
      ],
      { tail: size > 0 ? `Blob (${size} bytes)` : undefined, lastComma: false, full: true },
    );
  }
}
