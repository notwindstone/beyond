// Beyond.serve: an HTTP server whose `fetch` answers each request with a
// Response (or a promise of one), as Bun.serve. The native core
// (crates/beyond-rt/native/server.c) runs uWebSockets.

import {
  bodyHandler,
  endStream,
  listen,
  requestDrop,
  requestPause,
  respond,
  respondStart,
  serverPort,
  stopServer,
  whenWritable,
  writeChunk,
  xxh64Hex,
} from "beyond:native";
import { Incoming, IncomingOwner, Request, Response, unpackFields } from "./fetch.ts";
import { chunkBytes, ReadableStream, ReadableStreamDefaultReader, readableStreamCancel, takeWholeStream } from "./streams.ts";

type Handler = (request: Request, server: Server) => Response | Promise<Response>;

/**
 * What a path of `routes` answers, as Bun.serve's: a Response (sent as it
 * is to every method, with an etag), a handler (`request.params` set), or
 * either per method (the others go to `fetch`).
 */
type RouteValue = Response | Handler | Record<string, Response | Handler>;

export interface ServeOptions {
  port?: number | string;
  hostname?: string;
  fetch?: Handler;
  routes?: Record<string, RouteValue>;
  error?(error: unknown): Response | Promise<Response>;
}

/** A static route's response, ready to send. */
class StaticResponse {
  status: number;
  statusText: string;
  flat: string[];
  body: any;
  etag: string;

  constructor(res: Response) {
    if (res._stream !== null && !res._streamOfBody) {
      throw new TypeError("A static route's Response must have a buffered body (not a stream)");
    }
    this.status = res.status;
    this.statusText = res.statusText;
    const body = res._body;
    this.body = body;
    this.etag = '"' + (body === null || body === undefined ? xxh64Hex("") : xxh64Hex(body)) + '"';
    // (Its content type first, then its other headers and the etag, as Bun's.)
    const headers = res._flat();
    let type: string | null = res._contentType ?? res._sendType();
    const flat: string[] = [];
    for (let i = 0; i < headers.length; i += 2) {
      if (headers[i] === "content-type") type = headers[i + 1];
      else flat.push(headers[i], headers[i + 1]);
    }
    if (type !== null) flat.unshift("content-type", type);
    flat.push("etag", this.etag);
    this.flat = flat;
  }
}

type Target = StaticResponse | Handler;

/** One path's targets: for every method, or by method. */
class RouteEntry {
  all: Target | null = null;
  methods: Record<string, Target> | null = null;

  target(method: string): Target | null {
    if (this.all !== null) return this.all;
    const m = this.methods!;
    const t = m[method];
    if (t !== undefined) return t;
    // (A HEAD request: the GET route, without its body.)
    if (method === "HEAD" && m.GET !== undefined) return m.GET;
    return null;
  }
}

/** A path pattern of `routes`: its segments (`:name` a parameter, a last `*` the rest). */
class Pattern {
  segments: string[];
  entry: RouteEntry;
  rank: number[];

  constructor(segments: string[], entry: RouteEntry) {
    this.segments = segments;
    this.entry = entry;
    // (A literal segment before a parameter before `*`, as Bun's router.)
    this.rank = segments.map((s) => (s === "*" ? 2 : s.charCodeAt(0) === 58 ? 1 : 0));
  }

  match(parts: string[]): Record<string, string> | null {
    const segs = this.segments;
    let params: Record<string, string> | null = null;
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      if (i >= parts.length) return null;
      if (s === "*") return params ?? {};
      const p = parts[i];
      if (s.charCodeAt(0) === 58) {
        if (p === "") return null;
        if (params === null) params = {};
        params[s.slice(1)] = decodeParam(p);
      } else if (s !== p) {
        return null;
      }
    }
    return parts.length === segs.length ? (params ?? {}) : null;
  }
}

function decodeParam(s: string): string {
  if (s.indexOf("%") < 0) return s;
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function compareRanks(a: Pattern, b: Pattern): number {
  const n = Math.min(a.rank.length, b.rank.length);
  for (let i = 0; i < n; i++) if (a.rank[i] !== b.rank[i]) return a.rank[i] - b.rank[i];
  return b.rank.length - a.rank.length;
}

/** Bun.serve's `routes`: exact paths first, then patterns, most specific first. */
class Router {
  exact = new Map<string, RouteEntry>();
  patterns: Pattern[] = [];

  constructor(routes: Record<string, RouteValue>) {
    for (const path of Object.keys(routes)) {
      if (path.charCodeAt(0) !== 47) throw new TypeError(`Route paths must start with '/' (got ${JSON.stringify(path)})`);
      const entry = routeEntry(routes[path], path);
      const segments = path.slice(1).split("/");
      if (segments.every((s) => s !== "*" && s.charCodeAt(0) !== 58)) this.exact.set(path, entry);
      else this.patterns.push(new Pattern(segments, entry));
    }
    this.patterns.sort(compareRanks);
  }

  /** The target for `method` at `path` (params in `out[0]`), or null. */
  match(method: string, path: string, out: any[]): Target | null {
    const e = this.exact.get(path);
    if (e !== undefined) {
      const t = e.target(method);
      if (t !== null) {
        out[0] = {};
        return t;
      }
    }
    if (this.patterns.length === 0) return null;
    const parts = path.slice(1).split("/");
    for (const p of this.patterns) {
      const params = p.match(parts);
      if (params === null) continue;
      const t = p.entry.target(method);
      if (t === null) continue;
      out[0] = params;
      return t;
    }
    return null;
  }
}

function routeTarget(v: unknown, path: string): Target {
  if (v instanceof Response) return new StaticResponse(v);
  if (typeof v === "function") return v as Handler;
  throw new TypeError(`Route ${JSON.stringify(path)}: expected a Response or a function`);
}

function routeEntry(v: RouteValue, path: string): RouteEntry {
  const e = new RouteEntry();
  if (v instanceof Response || typeof v === "function") {
    e.all = routeTarget(v, path);
    return e;
  }
  if (v === null || typeof v !== "object") throw new TypeError(`Route ${JSON.stringify(path)}: expected a Response, a function or an object of methods`);
  const methods: Record<string, Target> = {};
  for (const m of Object.keys(v)) methods[m.toUpperCase()] = routeTarget((v as any)[m], path);
  e.methods = methods;
  return e;
}

export class Server {
  readonly hostname: string;
  readonly _id: number;
  _stopped = false;
  pendingRequests = 0;
  _fetch: Handler | null = null;
  _error: ((error: unknown) => Response | Promise<Response>) | null = null;
  _router: Router | null = null;

  constructor(id: number, hostname: string) {
    this._id = id;
    this.hostname = hostname;
  }

  /** New handlers (`fetch`, `routes`, `error`) for the requests to come, as Bun's. */
  reload(options: ServeOptions): void {
    const router = options.routes !== undefined ? new Router(options.routes) : null;
    if (typeof options.fetch !== "function" && router === null) {
      throw new TypeError("Expected `fetch` to be a function, or `routes`");
    }
    this._router = router;
    this._fetch = typeof options.fetch === "function" ? options.fetch : null;
    this._error = typeof options.error === "function" ? options.error : null;
  }

  get port(): number {
    return serverPort(this._id);
  }

  get url(): URL | string {
    const host = this.hostname === "0.0.0.0" || this.hostname === "::" ? "localhost" : this.hostname;
    return `http://${host}:${this.port}/`;
  }

  /**
   * Stop accepting connections: idle ones are closed, the others once their
   * request is answered, or all of them now with `closeActiveConnections`.
   */
  stop(closeActiveConnections?: boolean): void {
    if (this._stopped && !closeActiveConnections) return;
    this._stopped = true;
    stopServer(this._id, closeActiveConnections === true);
  }
}

/** A request's body still arriving (the owner of its Incoming). */
class Arriving implements IncomingOwner {
  handle: number;

  constructor(handle: number) {
    this.handle = handle;
  }

  _pause(paused: boolean): void {
    requestPause(this.handle, paused);
  }

  _cancel(): void {
    requestDrop(this.handle);
  }
}

const BODY_DATA = 0;
const BODY_END = 1;

/** The native server's events of the bodies still arriving. */
function onBody(incoming: Incoming, chunk: Uint8Array | null, kind: number): void {
  if (kind === BODY_DATA) incoming.push(chunk as Uint8Array);
  else if (kind === BODY_END) incoming.end();
  else {
    const e = new Error("The connection was closed before the request body was read");
    (e as any).code = "ECONNRESET";
    incoming.fail(e);
  }
}

bodyHandler(onBody);

function internalError(e: unknown): Response {
  console.error(e);
  return new Response("Internal Server Error", { status: 500 });
}

/** A 500 response (a body stream that could not be sent). */
function respondInternal(handle: number): void {
  respond(handle, 500, "Internal Server Error", null, "Internal Server Error", "text/plain;charset=utf-8");
}

/** Sends `res` for request `handle`, then calls `done` (once it is all sent). */
function send(handle: number, res: unknown, done: () => void): void {
  if (!(res instanceof Response)) {
    send(handle, internalError(new TypeError("Expected a Response object from the fetch handler")), done);
    return;
  }
  const stream = res._stream;
  // (A stream `body` made of the stored body, unread: the stored body.)
  if (stream === null || (res._streamOfBody && !stream._disturbed && stream._reader === undefined)) {
    // (Most responses have no headers object: only a content type.)
    if (res._headers === null && res._rawHeaders === null) respond(handle, res.status, res.statusText, null, res._body, res._contentType ?? res._sendType());
    else respond(handle, res.status, res.statusText, res._flat(), res._body, null);
    done();
    return;
  }
  // (A stream that holds its whole body, as one made of another body
  // (`new Response(res.body, res)`, as middleware re-making a response
  // does) or of a Blob: sent whole, with its length, as Bun's. A stream of
  // a body has the content type of its Blob.)
  const whole = takeWholeStream(stream);
  if (whole !== null) {
    let body: Uint8Array;
    try {
      body = joinChunks(whole);
    } catch (e) {
      send(handle, internalError(e), done);
      return;
    }
    res._used = true;
    if (res._headers === null && res._rawHeaders === null) {
      respond(handle, res.status, res.statusText, null, body, res._contentType ?? stream._sendType);
      done();
      return;
    }
    const flat = res._flat();
    if (stream._sendType !== null && !hasContentType(flat)) flat.push("content-type", stream._sendType);
    respond(handle, res.status, res.statusText, flat, body, null);
    done();
    return;
  }
  sendStream(handle, res, stream).then(done, done);
}

/** A whole stream's chunks as one body. */
function joinChunks(chunks: any[]): Uint8Array {
  if (chunks.length === 1) return chunkBytes(chunks[0]);
  const parts: Uint8Array[] = [];
  let size = 0;
  for (const c of chunks) {
    const b = chunkBytes(c);
    parts.push(b);
    size += b.length;
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const b of parts) {
    all.set(b, at);
    at += b.length;
  }
  return all;
}

function hasContentType(flat: string[]): boolean {
  for (let i = 0; i < flat.length; i += 2) if (flat[i] === "content-type") return true;
  return false;
}

/** Waits until the connection takes more (false: the request is gone). */
function drained(handle: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (!whenWritable(handle, resolve)) resolve(false);
  });
}

/**
 * Sends a response whose body is a stream: its head, then each chunk as
 * it is read (chunked), waiting while the connection is backpressured (as
 * Bun's server does with its HTTPServerWritable sink).
 */
async function sendStream(handle: number, res: Response, stream: ReadableStream<any>): Promise<void> {
  if (stream._reader !== undefined || stream._disturbed) {
    console.error(new TypeError("The response's body stream is locked or disturbed"));
    respondInternal(handle);
    return;
  }
  res._used = true;
  const reader = new ReadableStreamDefaultReader<any>(stream);
  let started = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const bytes = chunkBytes(value);
      if (bytes.length === 0) continue;
      if (!started) {
        started = true;
        if (!respondStart(handle, res.status, res.statusText, res._flat())) {
          readableStreamCancel(stream, undefined);
          return;
        }
      }
      const written = writeChunk(handle, bytes);
      if (written < 0 || (written === 0 && !(await drained(handle)))) {
        // (The client went away.)
        readableStreamCancel(stream, undefined);
        return;
      }
    }
  } catch (e) {
    console.error(e);
    if (started) endStream(handle, false);
    else respondInternal(handle);
    return;
  }
  if (started) endStream(handle, true);
  else respond(handle, res.status, res.statusText, res._flat(), null, null);
}

/** A static route's response (304 when the client's etag is its). */
function sendStatic(handle: number, request: Request, r: StaticResponse): void {
  const inm =
    request._fields !== null ? flatGet(unpackFields(request._fields), "if-none-match") : request.headers.get("if-none-match");
  if (inm !== null && etagMatches(inm, r.etag)) {
    respond(handle, 304, "Not Modified", r.flat, null, null);
    return;
  }
  respond(handle, r.status, r.statusText, r.flat, r.body, null);
}

function flatGet(flat: string[], name: string): string | null {
  for (let i = 0; i < flat.length; i += 2) if (flat[i] === name) return flat[i + 1];
  return null;
}

function etagMatches(header: string, etag: string): boolean {
  if (header === etag || header.trim() === "*") return true;
  for (const t of header.split(",")) {
    const v = t.trim();
    if (v === etag || (v.startsWith("W/") && v.slice(2) === etag)) return true;
  }
  return false;
}

/** The path of a server request's URL (`http://host/path?query`). */
function pathOf(url: string): string {
  const start = url.indexOf("/", 7);
  if (start < 0) return "/";
  const q = url.indexOf("?", start);
  return q < 0 ? url.slice(start) : url.slice(start, q);
}

export function serve(options: ServeOptions): Server {
  if (typeof options?.fetch !== "function" && (options === null || typeof options !== "object" || options.routes === undefined)) {
    throw new TypeError("Expected `fetch` to be a function, or `routes`");
  }
  const env = (globalThis as any).process?.env;
  const port = Number(options.port ?? env?.PORT ?? 3000);
  const hostname = options.hostname ?? "0.0.0.0";
  let server: Server;
  const onError = (e: unknown): Response | Promise<Response> => {
    const error = server._error;
    if (error !== null) {
      try {
        return error(e);
      } catch (e2) {
        return internalError(e2);
      }
    }
    return internalError(e);
  };
  const done = (): void => {
    server.pendingRequests--;
  };
  // `body`: all of it, none, or `true` when it is still arriving (what came
  // of it in `first`): the handler is then called with it as a stream, and
  // the Incoming it is read from is returned for the rest.
  const handler = (
    handle: number,
    method: string,
    url: string,
    fields: string,
    body: ArrayBuffer | true | undefined,
    first: Uint8Array | undefined,
  ): Incoming | undefined => {
    const request = Request._fromServer(method, url, fields, body === true ? undefined : body);
    let incoming: Incoming | undefined = undefined;
    if (body === true) {
      incoming = new Incoming(new Arriving(handle));
      if (first !== undefined) incoming.push(first);
      request._incoming = incoming;
    }
    server.pendingRequests++;
    let res: Response | Promise<Response>;
    try {
      const router = server._router;
      let target: Target | null = null;
      if (router !== null) {
        const out: any[] = [undefined];
        target = router.match(method, pathOf(url), out);
        if (target !== null) (request as any).params = out[0];
      }
      if (target instanceof StaticResponse) {
        sendStatic(handle, request, target);
        done();
        return incoming;
      }
      if (target !== null) {
        res = target(request, server);
      } else {
        const fetch = server._fetch;
        res = fetch !== null ? fetch(request, server) : new Response("Not Found", { status: 404 });
      }
    } catch (e) {
      res = onError(e);
    }
    if (res instanceof Response) {
      send(handle, res, done);
    } else {
      Promise.resolve(res).then(
        (r) => send(handle, r, done),
        (e) =>
          Promise.resolve(onError(e)).then(
            (r) => send(handle, r, done),
            (e2) => send(handle, internalError(e2), done),
          ),
      );
    }
    return incoming;
  };
  const id = listen(hostname, port, handler);
  if (id < 0) throw new Error(`Failed to start server. Is port ${port} in use?`);
  server = new Server(id, hostname);
  server.reload(options);
  return server;
}
