// fetch(), as Bun's: HTTP/1.1, over TLS for https:, on the native client
// (crates/beyond-rt/native/client.c), which pools keep-alive connections
// and decodes gzip, deflate, br and zstd. A response that arrives whole with
// its head (most do) is handed over at once, its body stored as bytes;
// otherwise its body is a stream the connection fills, paused while nothing
// reads it past its high-water mark. Redirects are followed (up to 20)
// unless `redirect` says otherwise; an AbortSignal aborts the request, or
// the body being read.

import { decodeUtf8, encodeUtf8, fetchAbort, fetchInit, fetchPause, fetchRequest, promiseNew, promiseSettle } from "beyond:native";
import { Headers, Incoming, Request, Response } from "./fetch.ts";
import { URL } from "./url.ts";

const EV_HEAD = 1;
const EV_DATA = 2;
const EV_END = 3;
const EV_ERROR = 4;
const EV_COMPLETE = 5;

// What failed (client.c): the connection or the response, connecting, or
// resolving the host.
const FAIL_CONNECT = 1;
const FAIL_DNS = 2;
const FAIL_TLS = 3;
const FAIL_CERT = 4;

// Bun's messages for certificate errors (FetchTasklet.rs).
const CERT_MESSAGES: Record<string, string> = {
  UNABLE_TO_GET_ISSUER_CERT: "unable to get issuer certificate",
  UNABLE_TO_GET_CRL: "unable to get certificate CRL",
  UNABLE_TO_DECRYPT_CERT_SIGNATURE: "unable to decrypt certificate's signature",
  UNABLE_TO_DECRYPT_CRL_SIGNATURE: "unable to decrypt CRL's signature",
  UNABLE_TO_DECODE_ISSUER_PUBLIC_KEY: "unable to decode issuer public key",
  CERT_SIGNATURE_FAILURE: "certificate signature failure",
  CRL_SIGNATURE_FAILURE: "CRL signature failure",
  CERT_NOT_YET_VALID: "certificate is not yet valid",
  CRL_NOT_YET_VALID: "CRL is not yet valid",
  CERT_HAS_EXPIRED: "certificate has expired",
  CRL_HAS_EXPIRED: "CRL has expired",
  ERROR_IN_CERT_NOT_BEFORE_FIELD: "format error in certificate's notBefore field",
  ERROR_IN_CERT_NOT_AFTER_FIELD: "format error in certificate's notAfter field",
  ERROR_IN_CRL_LAST_UPDATE_FIELD: "format error in CRL's lastUpdate field",
  ERROR_IN_CRL_NEXT_UPDATE_FIELD: "format error in CRL's nextUpdate field",
  OUT_OF_MEM: "out of memory",
  DEPTH_ZERO_SELF_SIGNED_CERT: "self signed certificate",
  SELF_SIGNED_CERT_IN_CHAIN: "self signed certificate in certificate chain",
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: "unable to get local issuer certificate",
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: "unable to verify the first certificate",
  CERT_CHAIN_TOO_LONG: "certificate chain too long",
  CERT_REVOKED: "certificate revoked",
  INVALID_CA: "invalid CA certificate",
  INVALID_NON_CA: "invalid non-CA certificate (has CA markings)",
  PATH_LENGTH_EXCEEDED: "path length constraint exceeded",
  PROXY_PATH_LENGTH_EXCEEDED: "proxy path length constraint exceeded",
  PROXY_CERTIFICATES_NOT_ALLOWED: "proxy certificates not allowed, please set the appropriate flag",
  INVALID_PURPOSE: "unsupported certificate purpose",
  CERT_UNTRUSTED: "certificate not trusted",
  CERT_REJECTED: "certificate rejected",
  APPLICATION_VERIFICATION: "application verification failure",
  SUBJECT_ISSUER_MISMATCH: "subject issuer mismatch",
  AKID_SKID_MISMATCH: "authority and subject key identifier mismatch",
  AKID_ISSUER_SERIAL_MISMATCH: "authority and issuer serial number mismatch",
  KEYUSAGE_NO_CERTSIGN: "key usage does not include certificate signing",
  UNABLE_TO_GET_CRL_ISSUER: "unable to get CRL issuer certificate",
  UNHANDLED_CRITICAL_EXTENSION: "unhandled critical extension",
  KEYUSAGE_NO_CRL_SIGN: "key usage does not include CRL signing",
  KEYUSAGE_NO_DIGITAL_SIGNATURE: "key usage does not include digital signature",
  UNHANDLED_CRITICAL_CRL_EXTENSION: "unhandled critical CRL extension",
  INVALID_EXTENSION: "invalid or inconsistent certificate extension",
  INVALID_POLICY_EXTENSION: "invalid or inconsistent certificate policy extension",
  NO_EXPLICIT_POLICY: "no explicit policy",
  DIFFERENT_CRL_SCOPE: "Different CRL scope",
  UNSUPPORTED_EXTENSION_FEATURE: "Unsupported extension feature",
  UNNESTED_RESOURCE: "RFC 3779 resource not subset of parent's resources",
  PERMITTED_VIOLATION: "permitted subtree violation",
  EXCLUDED_VIOLATION: "excluded subtree violation",
  SUBTREE_MINMAX: "name constraints minimum and maximum not supported",
  UNSUPPORTED_CONSTRAINT_TYPE: "unsupported name constraint type",
  UNSUPPORTED_CONSTRAINT_SYNTAX: "unsupported or invalid name constraint syntax",
  UNSUPPORTED_NAME_SYNTAX: "unsupported or invalid name syntax",
  CRL_PATH_VALIDATION_ERROR: "CRL path validation error",
  SUITE_B_INVALID_VERSION: "Suite B: certificate version invalid",
  SUITE_B_INVALID_ALGORITHM: "Suite B: invalid public key algorithm",
  SUITE_B_INVALID_CURVE: "Suite B: invalid ECC curve",
  SUITE_B_INVALID_SIGNATURE_ALGORITHM: "Suite B: invalid signature algorithm",
  SUITE_B_LOS_NOT_ALLOWED: "Suite B: curve not allowed for this LOS",
  SUITE_B_CANNOT_SIGN_P_384_WITH_P_256: "Suite B: cannot sign P-384 with P-256",
  EMAIL_MISMATCH: "Email address mismatch",
  IP_ADDRESS_MISMATCH: "IP address mismatch",
  INVALID_CALL: "Invalid certificate verification context",
  STORE_LOOKUP: "Issuer certificate lookup error",
  UNKNOWN_CERTIFICATE_VERIFICATION_ERROR: "unknown certificate verification error",
};

/** A TLS connection's options, as client.c takes them. */
interface TLSConfig {
  // The certificates to trust (PEM), or null for Bun's bundled roots.
  ca: string | null;
  // Whether to check the server's certificate (undefined: as
  // NODE_TLS_REJECT_UNAUTHORIZED says, else yes).
  reject: boolean | undefined;
  // The name to send and check, if not the host.
  servername: string | null;
}

const DEFAULT_TLS: TLSConfig = { ca: null, reject: undefined, servername: null };

/** PEM text of a `ca` option: a string, bytes, or an array of them. */
function pemOf(ca: unknown): string {
  if (Array.isArray(ca)) return ca.map(pemOf).join("\n");
  if (typeof ca === "string") return ca;
  if (ca instanceof Uint8Array) return decodeUtf8(ca, false);
  if (ca instanceof ArrayBuffer) return decodeUtf8(new Uint8Array(ca), false);
  return String(ca);
}

/** fetch()'s `tls` option, as client.c takes it. */
function tlsConfig(tls: any): TLSConfig {
  if (tls === undefined || tls === null) return DEFAULT_TLS;
  return {
    ca: tls.ca === undefined || tls.ca === null ? null : pemOf(tls.ca),
    reject: tls.rejectUnauthorized === undefined ? undefined : Boolean(tls.rejectUnauthorized),
    servername: typeof tls.serverName === "string" ? tls.serverName : typeof tls.servername === "string" ? tls.servername : null,
  };
}

const USER_AGENT = "Beyond/0.1.0";

/** Bun's message for most of fetch()'s errors. */
function failedMessage(code: string, path: string): string {
  return `${code} fetching "${path}". For more information, pass \`verbose: true\` in the second argument to fetch()`;
}

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
  tls?: { rejectUnauthorized?: boolean; ca?: unknown; serverName?: string };
  [key: string]: unknown;
}

/** A URL to fetch, parsed, with what its requests need of it. */
class Target {
  url: URL;
  href: string;
  protocol: string;
  // The host to connect to (an IPv6 one without its brackets), its port.
  host: string;
  port: number;
  // The head of a GET without headers of its own, once made.
  getHead: Uint8Array | null = null;

  constructor(url: URL) {
    this.url = url;
    this.href = url.href;
    this.protocol = url.protocol;
    const h = url.hostname;
    this.host = h.startsWith("[") ? h.slice(1, -1) : h;
    this.port = url.port !== "" ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  }
}

/** A request's head: its request line and headers, Bun's defaults added. */
function head(method: string, url: URL, headers: Headers | null, bodyLength: number): string {
  let out = `${method} ${url.pathname}${url.search} HTTP/1.1\r\n`;
  let host = false;
  let ua = false;
  let accept = false;
  let encoding = false;
  let connection = false;
  if (headers !== null && headers._names.length > 0) {
    const flat = headers._sorted();
    for (let i = 0; i < flat.length; i += 2) {
      const name = flat[i];
      if (name === "host") host = true;
      else if (name === "user-agent") ua = true;
      else if (name === "accept") accept = true;
      else if (name === "accept-encoding") encoding = true;
      else if (name === "connection") connection = true;
      else if (name === "content-length" || name === "transfer-encoding") continue;
      out += `${name}: ${flat[i + 1]}\r\n`;
    }
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

// The URLs fetched recently (only read here: shared).
const targets = new Map<string, Target>();

function target(s: string): Target {
  let t = targets.get(s);
  if (t === undefined) {
    t = new Target(new URL(s));
    if (targets.size >= 64) targets.delete(targets.keys().next().value as string);
    targets.set(s, t);
  }
  return t;
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/** A fetch() under way: its request, through its redirects, and its response. */
class Fetch {
  target: Target;
  method: string;
  headers: Headers | null;
  body: Uint8Array | null;
  redirect: string;
  signal: AbortSignal | null;
  tls: TLSConfig;
  // The promise fetch() returned (settled by `resolve` and `reject`).
  promise: Promise<Response> | null = null;
  redirects = 0;
  handle = -1;
  response: Response | null = null;
  incoming: Incoming | null = null;
  done = false;
  onAbort: (() => void) | null = null;

  constructor(
    target: Target,
    method: string,
    headers: Headers | null,
    body: Uint8Array | null,
    redirect: string,
    signal: AbortSignal | null,
    tls: TLSConfig,
  ) {
    this.target = target;
    this.method = method;
    this.headers = headers;
    this.body = body;
    this.redirect = redirect;
    this.signal = signal;
    this.tls = tls;
  }

  /** Sends the request; the promise of its response. */
  start(): Promise<Response> {
    const p = promiseNew() as Promise<Response>;
    this.promise = p;
    const signal = this.signal;
    if (signal !== null) {
      const onAbort = (): void => this.abort();
      this.onAbort = onAbort;
      signal.addEventListener("abort", onAbort, { once: true });
    }
    this.begin();
    return p;
  }

  begin(): void {
    const t = this.target;
    const method = this.method;
    const body = this.body;
    let bytes: string | Uint8Array;
    if (method === "GET" && this.headers === null && body === null) {
      let h = t.getHead;
      if (h === null) {
        h = encodeUtf8(head("GET", t.url, null, 0));
        t.getHead = h;
      }
      bytes = h;
    } else {
      bytes = head(method, t.url, this.headers, body === null ? 0 : body.length);
    }
    this.handle = fetchRequest(this, t.host, t.port, bytes, body, method === "HEAD", t.protocol === "https:" ? this.tls : null);
  }

  resolve(r: Response): void {
    promiseSettle(this.promise, r, false);
  }

  reject(e: unknown): void {
    promiseSettle(this.promise, e, true);
  }

  abort(): void {
    if (this.done) return;
    this.done = true;
    if (this.handle >= 0) fetchAbort(this.handle);
    const reason = (this.signal as AbortSignal).reason;
    if (this.response === null) this.reject(reason);
    else if (this.incoming !== null) this.incoming.fail(reason);
  }

  settle(): void {
    this.done = true;
    const signal = this.signal;
    if (signal !== null) signal.removeEventListener("abort", this.onAbort as () => void);
  }

  /** The response's head (and `body`, all of it, when complete). */
  head(status: number, statusText: string, raw: string[], body: ArrayBuffer | null, complete: boolean): void {
    if (isRedirect(status) && this.redirect !== "manual") {
      let location: string | null = null;
      for (let i = 0; i < raw.length; i += 2) if (raw[i] === "location") location = raw[i + 1];
      if (location !== null) {
        this.follow(status, location, complete);
        return;
      }
    }
    const method = this.method;
    const r = new Response(null);
    (r as any).status = status;
    (r as any).statusText = statusText;
    r._rawHeaders = raw;
    // (A response that cannot have a body has none: its body is null.)
    if (method !== "HEAD" && status !== 204 && status !== 205 && status !== 304) {
      if (complete) {
        r._body = body;
      } else {
        const incoming = new Incoming(this);
        this.incoming = incoming;
        r._incoming = incoming;
      }
    }
    r._url = this.target.href;
    r._redirected = this.redirects > 0;
    this.response = r;
    if (complete) this.settle();
    this.resolve(r);
  }

  /** Follows a redirect to `location`. */
  follow(status: number, location: string, complete: boolean): void {
    const url = this.target.url;
    if (this.redirect === "error") {
      if (!complete) fetchAbort(this.handle);
      this.settle();
      this.reject(fetchError(failedMessage("UnexpectedRedirect", url.href), "UnexpectedRedirect", { path: url.href, errno: 0 }));
      return;
    }
    if (!complete) fetchAbort(this.handle);
    if (++this.redirects > 20) {
      this.settle();
      this.reject(
        fetchError(
          "TooManyRedirects: The response redirected too many times. For more information, pass `verbose: true` in the second argument to fetch()",
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
      this.settle();
      this.reject(fetchError("fetch() URL is invalid", "ERR_INVALID_URL"));
      return;
    }
    // (303, and 301/302 of a POST: a GET without the body.)
    const method = this.method;
    if (status === 303 || ((status === 301 || status === 302) && method === "POST")) {
      if (method !== "HEAD") this.method = "GET";
      this.body = null;
      if (this.headers !== null) this.headers.delete("content-type");
    }
    if (next.host !== url.host && this.headers !== null) this.headers.delete("authorization");
    this.target = new Target(next);
    this.begin();
  }

  /** The request failed: an error as Bun's (FetchTasklet's `to_error`). */
  error(code: string, kind: number): void {
    this.settle();
    const path = this.target.href;
    let message: string;
    let extra: Record<string, unknown>;
    if (kind === FAIL_DNS) {
      const hostname = this.target.host;
      message = `getaddrinfo ${code} ${hostname}`;
      // (errno: c-ares's code for ENOTFOUND.)
      extra = { path, syscall: "getaddrinfo", hostname, errno: 4 };
    } else {
      if (kind === FAIL_CONNECT) message = `${code}: Unable to connect. Is the computer able to access the url?`;
      else if (kind === FAIL_TLS) message = `${code}: The TLS handshake failed. Does the server speak TLS on this port?`;
      else if (kind === FAIL_CERT) message = CERT_MESSAGES[code] ?? CERT_MESSAGES.UNKNOWN_CERTIFICATE_VERIFICATION_ERROR;
      else if (code === "ECONNRESET") {
        message = `${code}: The socket connection was closed unexpectedly. For more information, pass \`verbose: true\` in the second argument to fetch()`;
      } else message = failedMessage(code, path);
      extra = { path, errno: 0 };
    }
    const e = fetchError(message, code, extra);
    if (this.response === null) this.reject(e);
    else if (this.incoming !== null) this.incoming.fail(e);
  }

  // The body's reader's calls (Incoming's owner).
  _pause(paused: boolean): void {
    if (!this.done) fetchPause(this.handle, paused);
  }

  _cancel(): void {
    if (!this.done) {
      this.settle();
      fetchAbort(this.handle);
    }
  }
}

/** The native client's events, for every request. */
function onEvent(task: Fetch, type: number, a: any, b: any, c: any, d: any): void {
  if (task.done) return;
  if (type === EV_COMPLETE) task.head(a as number, b as string, c as string[], d as ArrayBuffer, true);
  else if (type === EV_HEAD) task.head(a as number, b as string, c as string[], null, false);
  else if (type === EV_DATA) (task.incoming as Incoming).push(a as Uint8Array);
  else if (type === EV_END) {
    task.settle();
    if (task.incoming !== null) task.incoming.end();
  } else if (type === EV_ERROR) task.error(a as string, b as number);
}

fetchInit(onEvent);

/** The request `input` and `init` make: its method, headers and body. */
function request(input: string | URL | Request, init: FetchInit | undefined): Request {
  const method = init?.method !== undefined ? String(init.method).toUpperCase() : input instanceof Request ? input.method : "GET";
  if ((method === "GET" || method === "HEAD") && init?.body !== undefined && init.body !== null) {
    throw fetchError(`fetch() request with GET/HEAD method cannot have body.`, "ERR_INVALID_ARG_VALUE");
  }
  return input instanceof Request && init === undefined ? input : new Request(input instanceof URL ? input.href : (input as any), init as any);
}

/** `s` as a URL to fetch (or why it is not one: thrown). */
function targetOf(s: string): Target {
  let t: Target;
  try {
    t = target(s);
  } catch {
    throw fetchError("fetch() URL is invalid", "ERR_INVALID_URL");
  }
  const protocol = t.protocol;
  if (protocol === "http:" || protocol === "https:") return t;
  throw fetchError("protocol must be http:, https: or s3:", "ERR_INVALID_ARG_VALUE");
}

export function fetch(input: string | URL | Request, init?: FetchInit): Promise<Response> {
  // (The most common call: a URL and nothing else.)
  if (init === undefined && (typeof input === "string" || input instanceof URL)) {
    let t: Target;
    try {
      t = targetOf(typeof input === "string" ? input : input.href);
    } catch (e) {
      return Promise.reject(e);
    }
    return new Fetch(t, "GET", null, null, "follow", null, DEFAULT_TLS).start();
  }
  let req: Request;
  let t: Target;
  try {
    req = request(input, init);
    t = targetOf(req.url);
  } catch (e) {
    return Promise.reject(e);
  }
  const signal = init?.signal ?? null;
  if (signal !== null && signal.aborted) return Promise.reject(signal.reason);
  const redirect = init?.redirect ?? "follow";
  const tls = tlsConfig(init?.tls);
  // (Copied: redirects change them.)
  const headers = req._headers === null && req._flat === null ? null : new Headers(req.headers);
  if (req._body === null && req._stream === null) {
    return new Fetch(t, req.method, headers, null, redirect, signal, tls).start();
  }
  // The request's body, read whole.
  return req.bytes().then((bytes) => new Fetch(t, req.method, headers, bytes, redirect, signal, tls).start());
}
