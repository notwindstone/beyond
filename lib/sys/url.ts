// Node's conversions between `file:` URLs and paths, for Beyond's own
// modules (node:url is Bun's, which a program loads only if it uses it).

import { URL, URLSearchParams } from "../url.ts";
import { resolve } from "./path.ts";

function invalid(code: string, message: string): TypeError {
  const e = new TypeError(message);
  (e as any).code = code;
  return e;
}

/** The path of a `file:` URL (a string or a URL). */
export function fileURLToPath(url: string | URL): string {
  const u = typeof url === "string" ? new URL(url) : url;
  if (!(u instanceof URL) && typeof (u as any)?.href !== "string") {
    throw invalid("ERR_INVALID_ARG_TYPE", `The "path" argument must be of type string or an instance of URL. Received ${typeof url}`);
  }
  if (u.protocol !== "file:") throw invalid("ERR_INVALID_URL_SCHEME", "The URL must be of scheme file");
  if (u.hostname !== "" && u.hostname !== "localhost") {
    throw invalid("ERR_INVALID_FILE_URL_HOST", `File URL host must be "localhost" or empty on linux`);
  }
  const pathname = u.pathname;
  if (/%2f/i.test(pathname)) throw invalid("ERR_INVALID_FILE_URL_PATH", "File URL path must not include encoded / characters");
  return decodeURIComponent(pathname);
}

/** The `file:` URL of a path (resolved against the working directory). */
export function pathToFileURL(path: string): URL {
  let p = resolve(path);
  if (path.endsWith("/") && !p.endsWith("/")) p += "/";
  const encoded = p
    .replace(/%/g, "%25")
    .replace(/\\/g, "%5C")
    .replace(/\n/g, "%0A")
    .replace(/\r/g, "%0D")
    .replace(/\t/g, "%09")
    .replace(/#/g, "%23")
    .replace(/\?/g, "%3F");
  return new URL(`file://${encoded}`);
}

/** Node's legacy `url.format`: of a URL, or of a URL-like object. */
export function format(u: any): string {
  if (typeof u === "string") return u;
  if (u instanceof URL) return u.href;
  const protocol = u.protocol ? (u.protocol.endsWith(":") ? u.protocol : u.protocol + ":") : "";
  const auth = u.auth ? u.auth + "@" : "";
  const host = u.host ?? (u.hostname ? u.hostname + (u.port ? ":" + u.port : "") : "");
  const slashes = u.slashes || /^(https?|ftp|file|wss?):$/.test(protocol) ? "//" : "";
  let search = u.search ?? "";
  if (!search && u.query && typeof u.query === "object") {
    const q = new URLSearchParams(u.query).toString();
    if (q) search = "?" + q;
  }
  if (search && !search.startsWith("?")) search = "?" + search;
  const hash = u.hash ? (u.hash.startsWith("#") ? u.hash : "#" + u.hash) : "";
  return `${protocol}${host || slashes ? slashes : ""}${auth}${host}${u.pathname ?? ""}${search}${hash}`;
}

/** Node's legacy `url.parse` (through the WHATWG parser). */
export function parse(s: string, parseQuery = false): any {
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    u = new URL(s, "relative:///");
    const query = u.search.slice(1);
    return {
      protocol: null,
      slashes: null,
      auth: null,
      host: null,
      port: null,
      hostname: null,
      hash: u.hash || null,
      search: u.search || null,
      query: parseQuery ? Object.fromEntries(new URLSearchParams(query)) : query || null,
      pathname: s.startsWith("/") ? u.pathname : u.pathname.slice(1),
      path: (s.startsWith("/") ? u.pathname : u.pathname.slice(1)) + u.search,
      href: s,
    };
  }
  const query = u.search.slice(1);
  return {
    protocol: u.protocol,
    slashes: true,
    auth: u.username ? decodeURIComponent(u.username) + (u.password ? ":" + decodeURIComponent(u.password) : "") : null,
    host: u.host,
    port: u.port || null,
    hostname: u.hostname,
    hash: u.hash || null,
    search: u.search || null,
    query: parseQuery ? Object.fromEntries(new URLSearchParams(query)) : query || null,
    pathname: u.pathname,
    path: u.pathname + u.search,
    href: u.href,
  };
}

export function domainToASCII(domain: string): string {
  try {
    return new URL(`http://${domain}`).hostname;
  } catch {
    return "";
  }
}

export { URL, URLSearchParams };
export default { URL, URLSearchParams, fileURLToPath, pathToFileURL, format, parse, domainToASCII };
