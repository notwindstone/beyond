// Beyond.serve: an HTTP server whose `fetch` answers each request with a
// Response (or a promise of one), as Bun.serve. The native core
// (crates/beyond-rt/native/server.c) runs uWebSockets.

import { endStream, listen, respond, respondStart, serverPort, stopServer, whenWritable, writeChunk } from "beyond:native";
import { Request, Response } from "./fetch.ts";
import { chunkBytes, ReadableStream, ReadableStreamDefaultReader, readableStreamCancel } from "./streams.ts";

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

  /** Stop accepting connections (those open finish). */
  stop(): void {
    if (this._stopped) return;
    this._stopped = true;
    stopServer(this._id);
  }
}

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
    if (res._headers === null && res._rawHeaders === null) respond(handle, res.status, res.statusText, null, res._body, res._contentType ?? res._defaultType);
    else respond(handle, res.status, res.statusText, res._flat(), res._body, null);
    return;
  }
  sendStream(handle, res, stream);
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
  const handler = (handle: number, method: string, url: string, flat: string[], body: ArrayBuffer | undefined) => {
    const request = Request._fromServer(method, url, flat, body);
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
  };
  const id = listen(hostname, port, handler);
  if (id < 0) throw new Error(`Failed to start server. Is port ${port} in use?`);
  server = new Server(id, hostname);
  return server;
}
