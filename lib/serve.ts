// Beyond.serve: an HTTP server whose `fetch` answers each request with a
// Response (or a promise of one), as Bun.serve. The native core
// (crates/beyond-rt/native/server.c) runs uWebSockets.

import { listen, respond, serverPort, stopServer } from "beyond:native";
import { Request, Response } from "./fetch.ts";

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
  respond(handle, res.status, res.statusText, res._flat(), res._body);
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
  const handler = (handle: number, method: string, path: string, flat: string[], body: ArrayBuffer | undefined) => {
    let host = "localhost";
    for (let i = 0; i < flat.length; i += 2) {
      if (flat[i] === "host") {
        host = flat[i + 1];
        break;
      }
    }
    const request = Request._fromServer(method, `http://${host}${path}`, flat, body);
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
