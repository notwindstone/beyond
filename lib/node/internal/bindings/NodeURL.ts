// Natives of Bun's NodeURL (src/jsc/bindings/NodeURL.cpp), on Beyond's URL
// host parser (lib/url.ts): url.domainToASCII and domainToUnicode (a WHATWG
// host parse of the domain), url.parse's IDNA step, and internalBinding('icu')
// toASCII / toUnicode.

import { $ERR_MISSING_ARGS, codedTypeError } from "node:internal/intrinsics";
import { idnaToASCII as toASCIIOrNull, idnaToUnicode, parseSpecialHost } from "../../../url.ts";

/** The host Node's hostname setter parses `domain` to (on a "ws://x" URL),
 * or null: up to a path, query, fragment or backslash; no port or
 * userinfo; a bracketed IPv6 literal whole. */
function parseDomainAsHost(domain: string): string | null {
  let end = domain.length;
  for (let i = 0; i < domain.length; i++) {
    const c = domain.charCodeAt(i);
    if (c === 0x2f || c === 0x3f || c === 0x23 || c === 0x5c) {
      end = i;
      break;
    }
  }
  const host = domain.slice(0, end);
  if (host === "") return null;
  if (host.charCodeAt(0) === 0x5b) {
    if (host.charCodeAt(host.length - 1) !== 0x5d) return null;
  } else if (host.includes(":") || host.includes("@")) {
    return null;
  }
  return parseSpecialHost(host);
}

function domainToASCII(domain: unknown): string {
  if (arguments.length < 1) throw $ERR_MISSING_ARGS("domain");
  return parseDomainAsHost(`${domain}`) ?? "";
}

function domainToUnicode(domain: unknown): string {
  if (arguments.length < 1) throw $ERR_MISSING_ARGS("domain");
  const host = parseDomainAsHost(`${domain}`);
  return host === null ? "" : idnaToUnicode(host);
}

/** UTS #46 ToASCII without a host parse (url.parse): "" on failure. */
function idnaToASCII(input: unknown): string {
  return toASCIIOrNull(`${input}`) ?? "";
}

export const Bun__createNodeURLBinding = [domainToASCII, domainToUnicode, idnaToASCII];

export const Bun__createNodeICUBinding = {
  toASCII(input: unknown, lenient?: unknown): string {
    const s = `${input}`;
    const r = toASCIIOrNull(s);
    if (r !== null) return r;
    if (lenient) return s.toLowerCase();
    throw codedTypeError("ERR_INVALID_ARG_VALUE", "Cannot convert name to ASCII");
  },
  toUnicode(input: unknown): string {
    return idnaToUnicode(`${input}`);
  },
};
