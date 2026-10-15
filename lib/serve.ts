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
} from "beyond:native";
import { Incoming, IncomingOwner, Request, Response } from "./fetch.ts";
import { chunkBytes, ReadableStream, ReadableStreamDefaultReader, readableStreamCancel, takeWholeStream } from "./streams.ts";

export interface ServeOptions {
  port?: number | string;
  hostname?: string;
  fetch(request: Request, server: Server): Response | Promise<Response>;
  error?(error: unknown): Response | Promise<Response>;
}

export class Server {
  readonly hostname: string;
  readonly _id: number;
  _stopped = false;
  pendingRequests = 0;

  constructor(id: number, hostname: string) {
    this._id = id;
    this.hostname = hostname;
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

function send(handle: number, res: unknown): void {
  if (!(res instanceof Response)) {
    send(handle, internalError(new TypeError("Expected a Response object from the fetch handler")));
    return;
  }
  const stream = res._stream;
  // (A stream `body` made of the stored body, unread: the stored body.)
  if (stream === null || (res._streamOfBody && !stream._disturbed && stream._reader === undefined)) {
    // (Most responses have no headers object: only a content type.)
    if (res._headers === null && res._rawHeaders === null) respond(handle, res.status, res.statusText, null, res._body, res._contentType ?? res._sendType());
    else respond(handle, res.status, res.statusText, res._flat(), res._body, null);
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
      send(handle, internalError(e));
      return;
    }
    res._used = true;
    if (res._headers === null && res._rawHeaders === null) {
      respond(handle, res.status, res.statusText, null, body, res._contentType ?? stream._sendType);
      return;
    }
    const flat = res._flat();
    if (stream._sendType !== null && !hasContentType(flat)) flat.push("content-type", stream._sendType);
    respond(handle, res.status, res.statusText, flat, body, null);
    return;
  }
  sendStream(handle, res, stream);
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
    send(handle, internalError(new TypeError("The response's body stream is locked or disturbed")));
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
    else send(handle, new Response("Internal Server Error", { status: 500 }));
    return;
  }
  if (started) endStream(handle, true);
  else respond(handle, res.status, res.statusText, res._flat(), null, null);
}

export function serve(options: ServeOptions): Server {
  if (typeof options?.fetch !== "function") throw new TypeError("Expected `fetch` to be a function");
  const env = (globalThis as any).process?.env;
  const port = Number(options.port ?? env?.PORT ?? 3000);
  const hostname = options.hostname ?? "0.0.0.0";
  let server: Server;
  const onError = (e: unknown): Response | Promise<Response> => {
    if (options.error) {
      try {
        return options.error(e);
      } catch (e2) {
        return internalError(e2);
      }
    }
    return internalError(e);
  };
  // `body`: all of it, none, or `true` when it is still arriving (what came
  // of it in `first`): the handler is then called with it as a stream, and
  // the Incoming it is read from is returned for the rest.
  const handler = (
    handle: number,
    method: string,
    url: string,
    flat: string[],
    body: ArrayBuffer | true | undefined,
    first: Uint8Array | undefined,
  ): Incoming | undefined => {
    const request = Request._fromServer(method, url, flat, body === true ? undefined : body);
    let incoming: Incoming | undefined = undefined;
    if (body === true) {
      incoming = new Incoming(new Arriving(handle));
      if (first !== undefined) incoming.push(first);
      request._incoming = incoming;
    }
    let res: Response | Promise<Response>;
    try {
      res = options.fetch(request, server);
    } catch (e) {
      res = onError(e);
    }
    if (res instanceof Response) {
      send(handle, res);
    } else {
      Promise.resolve(res).then(
        (r) => send(handle, r),
        (e) => Promise.resolve(onError(e)).then((r) => send(handle, r), (e2) => send(handle, internalError(e2))),
      );
    }
    return incoming;
  };
  const id = listen(hostname, port, handler);
  if (id < 0) throw new Error(`Failed to start server. Is port ${port} in use?`);
  server = new Server(id, hostname);
  return server;
}
