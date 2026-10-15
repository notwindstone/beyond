// fetch(), as Bun's: HTTP/1.1 over the native client
// (crates/beyond-rt/native/client.c), which pools keep-alive connections
// and decodes gzip, deflate, br and zstd. The response's body is a stream
// the connection fills; while nothing reads it past its high-water mark,
// the connection is paused. Redirects are followed (up to 20) unless
// `redirect` says otherwise; an AbortSignal aborts the request, or the
// body being read.

import { fetchAbort, fetchPause, fetchRequest } from "beyond:native";
import { Headers, Incoming, Request, Response } from "./fetch.ts";
import { URL } from "./url.ts";

const EV_HEAD = 1;
const EV_DATA = 2;
const EV_END = 3;
const EV_ERROR = 4;

const USER_AGENT = "Beyond/0.1.0";

/** An error as Bun's fetch() throws them: a TypeError with a code. */
function fetchError(message: string, code: string, extra?: Record<string, unknown>): TypeError {
  const e = new TypeError(message);
  (e as any).code = code;
  if (extra !== undefined) Object.assign(e, extra);
  return e;
}

export interface FetchInit {
  method?: string;
  headers?: any;
  body?: any;
  redirect?: "follow" | "manual" | "error";
  signal?: AbortSignal | null;
  [key: string]: unknown;
}

/** The request's head: its request line and headers, Bun's defaults added. */
function head(method: string, url: URL, headers: Headers, bodyLength: number): string {
  let out = `${method} ${url.pathname}${url.search} HTTP/1.1\r\n`;
  let host = false;
  let ua = false;
  let accept = false;
  let encoding = false;
  let connection = false;
  for (const [name, value] of headers) {
    if (name === "host") host = true;
    else if (name === "user-agent") ua = true;
    else if (name === "accept") accept = true;
    else if (name === "accept-encoding") encoding = true;
    else if (name === "connection") connection = true;
    else if (name === "content-length" || name === "transfer-encoding") continue;
    out += `${name}: ${value}\r\n`;
  }
  if (!connection) out += "Connection: keep-alive\r\n";
  if (!ua) out += `User-Agent: ${USER_AGENT}\r\n`;
  if (!accept) out += "Accept: */*\r\n";
  if (!host) out += `Host: ${url.host}\r\n`;
  if (!encoding) out += "Accept-Encoding: gzip, deflate, br, zstd\r\n";
  if (bodyLength > 0 || (method !== "GET" && method !== "HEAD" && method !== "OPTIONS")) {
    out += `Content-Length: ${bodyLength}\r\n`;
  }
  return out + "\r\n";
}

// The URLs fetched recently, parsed (only read here: shared).
const urls = new Map<string, URL>();

function parsedURL(s: string): URL {
  let u = urls.get(s);
  if (u === undefined) {
    u = new URL(s);
    if (urls.size >= 64) urls.delete(urls.keys().next().value as string);
    urls.set(s, u);
  }
  return u;
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

export function fetch(input: string | URL | Request, init?: FetchInit): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    let request: Request;
    try {
      const method = init?.method !== undefined ? String(init.method).toUpperCase() : input instanceof Request ? input.method : "GET";
      if ((method === "GET" || method === "HEAD") && init?.body !== undefined && init.body !== null) {
        throw fetchError(`fetch() request with GET/HEAD method cannot have body.`, "ERR_INVALID_ARG_VALUE");
      }
      request = input instanceof Request && init === undefined ? input : new Request(input instanceof URL ? input.href : (input as any), init as any);
    } catch (e) {
      reject(e);
      return;
    }
    let url: URL;
    try {
      url = parsedURL(request.url);
    } catch {
      reject(fetchError("fetch() URL is invalid", "ERR_INVALID_URL"));
      return;
    }
    if (url.protocol !== "http:") {
      if (url.protocol === "https:") reject(fetchError("https: is not supported yet", "ERR_INVALID_ARG_VALUE"));
      else reject(fetchError("protocol must be http:, https: or s3:", "ERR_INVALID_ARG_VALUE"));
      return;
    }
    const signal = init?.signal ?? null;
    if (signal !== null && signal.aborted) {
      reject(signal.reason);
      return;
    }
    const redirect = init?.redirect ?? "follow";
    // The request's body, read whole.
    const body = request._body === null && request._stream === null ? Promise.resolve(null) : request.bytes();
    body.then(
      (bytes) => send(request, url, bytes, redirect, signal, resolve, reject),
      (e) => reject(e),
    );
  });
}

function send(
  request: Request,
  first: URL,
  bytes: Uint8Array | null,
  redirect: string,
  signal: AbortSignal | null,
  resolve: (r: Response) => void,
  reject: (e: unknown) => void,
): void {
  let url = first;
  let method = request.method;
  let body = bytes;
  const headers = new Headers(request.headers);
  let redirects = 0;
  let handle = -1;
  let response: Response | null = null;
  let incoming: Incoming | null = null;
  let done = false;

  const onAbort = (): void => {
    if (done) return;
    done = true;
    if (handle >= 0) fetchAbort(handle);
    const reason = (signal as AbortSignal).reason;
    if (response === null) reject(reason);
    else if (incoming !== null) incoming.fail(reason);
  };
  if (signal !== null) signal.addEventListener("abort", onAbort, { once: true });
  const settle = (): void => {
    done = true;
    if (signal !== null) signal.removeEventListener("abort", onAbort);
  };

  const begin = (): void => {
    const port = url.port === "" ? 80 : Number(url.port);
    // (An IPv6 host without its brackets.)
    const host = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
    const text = head(method, url, headers, body === null ? 0 : body.length);
    handle = fetchRequest(host, port, text, body, method === "HEAD", onEvent);
  };

  const onEvent = (type: number, a: any, b: any, c: any): void => {
    if (done) return;
    if (type === EV_HEAD) {
      const status = a as number;
      const flat = c as string[];
      if (isRedirect(status) && redirect !== "manual") {
        let location: string | null = null;
        for (let i = 0; i < flat.length; i += 2) if (flat[i] === "location") location = flat[i + 1];
        if (location !== null) {
          if (redirect === "error") {
            fetchAbort(handle);
            settle();
            reject(
              fetchError(
                `UnexpectedRedirect fetching "${url.href}". For more information, pass \`verbose: true\` in the second argument to fetch()`,
                "UnexpectedRedirect",
                { path: url.href, errno: 0 },
              ),
            );
            return;
          }
          fetchAbort(handle);
          if (++redirects > 20) {
            settle();
            reject(
              fetchError(
                "The response redirected too many times. For more information, pass `verbose: true` in the second argument to fetch()",
                "TooManyRedirects",
                { path: url.href, errno: 0 },
              ),
            );
            return;
          }
          let next: URL;
          try {
            next = new URL(location, url);
          } catch {
            settle();
            reject(fetchError("fetch() URL is invalid", "ERR_INVALID_URL"));
            return;
          }
          // (303, and 301/302 of a POST: a GET without the body.)
          if (status === 303 || ((status === 301 || status === 302) && method === "POST")) {
            if (method !== "HEAD") method = "GET";
            body = null;
            headers.delete("content-type");
          }
          if (next.host !== url.host) headers.delete("authorization");
          url = next;
          begin();
          return;
        }
      }
      const r = new Response(null);
      (r as any).status = status;
      (r as any).statusText = b as string;
      r._headers = Headers._fromFlat(flat);
      // (A response that cannot have a body has none: its body is null.)
      if (method !== "HEAD" && status !== 204 && status !== 205 && status !== 304) {
        incoming = new Incoming(
          (p) => {
            if (!done) fetchPause(handle, p);
          },
          () => {
            if (!done) {
              settle();
              fetchAbort(handle);
            }
          },
        );
        r._incoming = incoming;
      }
      r._url = url.href;
      r._redirected = redirects > 0;
      response = r;
      resolve(r);
      return;
    }
    if (type === EV_DATA) {
      (incoming as Incoming).push(a as Uint8Array);
      return;
    }
    if (type === EV_END) {
      settle();
      if (incoming !== null) incoming.end();
      return;
    }
    if (type === EV_ERROR) {
      settle();
      const code = a as string;
      const extra: Record<string, unknown> = { path: url.href };
      if (code === "ConnectionRefused") extra.errno = 0;
      const e = fetchError(b as string, code, extra);
      if (response === null) reject(e);
      else if (incoming !== null) incoming.fail(e);
    }
  };
  begin();
}
