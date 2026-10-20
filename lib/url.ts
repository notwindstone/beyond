// URL and URLSearchParams (the WHATWG URL standard): its parser, a state
// machine over the input's code units, and its serializers, written for
// Beyond (Bun's are WebKit's, in C++). Hosts: domains (ASCII, and Unicode
// through punycode with an approximation of UTS #46's mapping: NFKC and
// lower case), IPv4 and IPv6 addresses, and opaque hosts.

import { decodeUtf8, encodeUtf8 } from "beyond:native";
import { describe, Formatter, inspectCustom } from "./inspect.ts";

// ---- Code points and percent-encoding ----

function isAlpha(c: number): boolean {
  return (c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a);
}

function isDigit(c: number): boolean {
  return c >= 0x30 && c <= 0x39;
}

function isHex(c: number): boolean {
  return isDigit(c) || (c >= 0x61 && c <= 0x66) || (c >= 0x41 && c <= 0x46);
}

function hexValue(c: number): number {
  return c <= 0x39 ? c - 0x30 : (c | 0x20) - 0x61 + 10;
}

// The percent-encode sets, each containing the ones before it (in code
// units < 0x80; all others are always encoded).
const C0 = 0; // C0 controls and above ~
const FRAGMENT = 1; // and space " < > `
const QUERY = 2; // and space " # < >
const SPECIAL_QUERY = 3; // and '
const PATH = 4; // query, and ? ^ ` { }
const USERINFO = 5; // path, and / : ; = @ [ \ ] |
const COMPONENT = 6; // userinfo, and $ % & + ,
const FORM = 7; // component, and ! ' ( ) ~

/** Whether ASCII code `c` is in percent-encode set `set`. */
function inSet(c: number, set: number): boolean {
  if (c < 0x20 || c > 0x7e) return true;
  if (set === C0) return false;
  if (set === FRAGMENT) return c === 0x20 || c === 0x22 || c === 0x3c || c === 0x3e || c === 0x60;
  if (c === 0x20 || c === 0x22 || c === 0x23 || c === 0x3c || c === 0x3e) return true;
  if (set === QUERY) return false;
  if (set === SPECIAL_QUERY) return c === 0x27;
  if (c === 0x3f || c === 0x5e || c === 0x60 || c === 0x7b || c === 0x7d) return true;
  if (set === PATH) return false;
  if (c === 0x2f || c === 0x3a || c === 0x3b || c === 0x3d || c === 0x40 || (c >= 0x5b && c <= 0x5d) || c === 0x7c) {
    return true;
  }
  if (set === USERINFO) return false;
  if ((c >= 0x24 && c <= 0x26) || c === 0x2b || c === 0x2c) return true;
  if (set === COMPONENT) return false;
  return c === 0x21 || (c >= 0x27 && c <= 0x29) || c === 0x7e;
}

const HEX = "0123456789ABCDEF";

function pct(byte: number): string {
  return "%" + HEX[byte >> 4] + HEX[byte & 15];
}

/** The UTF-8 percent-encoding of code point `cp` in set `set`. */
function encodeCodePoint(cp: number, set: number): string {
  if (cp < 0x80) return inSet(cp, set) ? pct(cp) : String.fromCharCode(cp);
  if (cp < 0x800) return pct(0xc0 | (cp >> 6)) + pct(0x80 | (cp & 63));
  if (cp < 0x10000) return pct(0xe0 | (cp >> 12)) + pct(0x80 | ((cp >> 6) & 63)) + pct(0x80 | (cp & 63));
  return pct(0xf0 | (cp >> 18)) + pct(0x80 | ((cp >> 12) & 63)) + pct(0x80 | ((cp >> 6) & 63)) + pct(0x80 | (cp & 63));
}

/** UTF-8 percent-encodes all of `s` (well-formed) with `set`. */
function encodeString(s: string, set: number, spaceAsPlus: boolean): string {
  let i = 0;
  // Unchanged up to the first code unit to encode.
  for (; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0x80 || inSet(c, set) || (spaceAsPlus && c === 0x20)) break;
  }
  if (i === s.length) return s;
  let out = s.slice(0, i);
  for (; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (spaceAsPlus && c === 0x20) {
      out += "+";
      continue;
    }
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
        i++;
      }
    }
    out += encodeCodePoint(c, set);
  }
  return out;
}

/** The bytes `s` percent-decodes to, as a string (UTF-8 decoded, lossy). */
function percentDecode(s: string, plusAsSpace: boolean): string {
  let simple = true;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x25 || (plusAsSpace && c === 0x2b)) {
      simple = false;
      break;
    }
  }
  if (simple) return s;
  const bytes = encodeUtf8(s);
  const out = new Uint8Array(bytes.length);
  let n = 0;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b === 0x25 && i + 2 < bytes.length && isHex(bytes[i + 1]) && isHex(bytes[i + 2])) {
      out[n++] = (hexValue(bytes[i + 1]) << 4) | hexValue(bytes[i + 2]);
      i += 2;
    } else if (plusAsSpace && b === 0x2b) {
      out[n++] = 0x20;
    } else {
      out[n++] = b;
    }
  }
  return decodeUtf8(out.subarray(0, n), false);
}

/** A USVString: lone surrogates replaced with U+FFFD. */
function usv(v: unknown): string {
  const s = String(v);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdfff) return s.toWellFormed();
  }
  return s;
}

// ---- Hosts ----

/** A forbidden host code point (or, for domains, also a forbidden domain one). */
function forbiddenHost(c: number): boolean {
  return (
    c === 0 || c === 9 || c === 0xa || c === 0xd || c === 0x20 || c === 0x23 || c === 0x2f || c === 0x3a ||
    c === 0x3c || c === 0x3e || c === 0x3f || c === 0x40 || c === 0x5b || c === 0x5c || c === 0x5d ||
    c === 0x5e || c === 0x7c
  );
}

function forbiddenDomain(c: number): boolean {
  return forbiddenHost(c) || c <= 0x1f || c === 0x25 || c === 0x7f;
}

/** Parses an IPv4 number (decimal, octal with a leading 0, or 0x hex): -1 if invalid. */
function ipv4Number(s: string): number {
  if (s.length === 0) return -1;
  let radix = 10;
  let i = 0;
  if (s.length >= 2 && s.charCodeAt(0) === 0x30 && (s.charCodeAt(1) | 0x20) === 0x78) {
    radix = 16;
    i = 2;
  } else if (s.length >= 2 && s.charCodeAt(0) === 0x30) {
    radix = 8;
    i = 1;
  }
  if (i === s.length) return 0;
  let n = 0;
  for (; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let d: number;
    if (radix === 16 && isHex(c)) d = hexValue(c);
    else if (isDigit(c) && c - 0x30 < radix) d = c - 0x30;
    else return -1;
    n = n * radix + d;
  }
  return n;
}

/** Whether a domain's last label is a number (then it must be an IPv4 address). */
function endsInNumber(s: string): boolean {
  const parts = s.split(".");
  if (parts[parts.length - 1] === "") {
    if (parts.length === 1) return false;
    parts.pop();
  }
  const last = parts[parts.length - 1];
  if (last.length > 0) {
    let digits = true;
    for (let i = 0; i < last.length; i++) if (!isDigit(last.charCodeAt(i))) digits = false;
    if (digits) return true;
  }
  return ipv4Number(last) >= 0 && last.length >= 2 && (last.charCodeAt(1) | 0x20) === 0x78;
}

/** An IPv4 address as its 32-bit number, or -1 (failure). */
function parseIPv4(s: string): number {
  const parts = s.split(".");
  if (parts[parts.length - 1] === "" && parts.length > 1) parts.pop();
  if (parts.length > 4) return -1;
  const numbers: number[] = [];
  for (const p of parts) {
    const n = ipv4Number(p);
    if (n < 0) return -1;
    numbers.push(n);
  }
  for (let i = 0; i < numbers.length - 1; i++) if (numbers[i] > 255) return -1;
  const last = numbers[numbers.length - 1];
  if (last >= 256 ** (5 - numbers.length)) return -1;
  let ipv4 = last;
  for (let i = 0; i < numbers.length - 1; i++) ipv4 += numbers[i] * 256 ** (3 - i);
  return ipv4;
}

function serializeIPv4(n: number): string {
  return `${Math.floor(n / 16777216) % 256}.${Math.floor(n / 65536) % 256}.${Math.floor(n / 256) % 256}.${n % 256}`;
}

/** An IPv6 address as its eight pieces, or null (failure). */
function parseIPv6(s: string): number[] | null {
  const address = [0, 0, 0, 0, 0, 0, 0, 0];
  let pieceIndex = 0;
  let compress = -1;
  let p = 0;
  const at = (k: number): number => (k < s.length ? s.charCodeAt(k) : -1);
  if (at(p) === 0x3a) {
    if (at(p + 1) !== 0x3a) return null;
    p += 2;
    pieceIndex++;
    compress = pieceIndex;
  }
  while (at(p) !== -1) {
    if (pieceIndex === 8) return null;
    if (at(p) === 0x3a) {
      if (compress !== -1) return null;
      p++;
      pieceIndex++;
      compress = pieceIndex;
      continue;
    }
    let value = 0;
    let length = 0;
    while (length < 4 && isHex(at(p))) {
      value = value * 16 + hexValue(at(p));
      p++;
      length++;
    }
    if (at(p) === 0x2e) {
      if (length === 0) return null;
      p -= length;
      if (pieceIndex > 6) return null;
      let numbersSeen = 0;
      while (at(p) !== -1) {
        let ipv4Piece = -1;
        if (numbersSeen > 0) {
          if (at(p) === 0x2e && numbersSeen < 4) p++;
          else return null;
        }
        if (!isDigit(at(p))) return null;
        while (isDigit(at(p))) {
          const n = at(p) - 0x30;
          if (ipv4Piece === -1) ipv4Piece = n;
          else if (ipv4Piece === 0) return null;
          else ipv4Piece = ipv4Piece * 10 + n;
          if (ipv4Piece > 255) return null;
          p++;
        }
        address[pieceIndex] = address[pieceIndex] * 0x100 + ipv4Piece;
        numbersSeen++;
        if (numbersSeen === 2 || numbersSeen === 4) pieceIndex++;
      }
      if (numbersSeen !== 4) return null;
      break;
    } else if (at(p) === 0x3a) {
      p++;
      if (at(p) === -1) return null;
    } else if (at(p) !== -1) {
      return null;
    }
    address[pieceIndex] = value;
    pieceIndex++;
  }
  if (compress !== -1) {
    let swaps = pieceIndex - compress;
    pieceIndex = 7;
    while (pieceIndex !== 0 && swaps > 0) {
      const t = address[compress + swaps - 1];
      address[compress + swaps - 1] = address[pieceIndex];
      address[pieceIndex] = t;
      pieceIndex--;
      swaps--;
    }
  } else if (pieceIndex !== 8) {
    return null;
  }
  return address;
}

function serializeIPv6(address: number[]): string {
  // The first longest run of two or more zeros becomes "::".
  let compress = -1;
  let best = 1;
  for (let i = 0; i < 8; ) {
    if (address[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && address[j] === 0) j++;
    if (j - i > best) {
      best = j - i;
      compress = i;
    }
    i = j;
  }
  let out = "[";
  let ignore0 = false;
  for (let i = 0; i < 8; i++) {
    if (ignore0 && address[i] === 0) continue;
    ignore0 = false;
    if (compress === i) {
      out += i === 0 ? "::" : ":";
      ignore0 = true;
      continue;
    }
    out += address[i].toString(16);
    if (i !== 7) out += ":";
  }
  return out + "]";
}

// Punycode (RFC 3492), for the labels of internationalized domains.
const BASE = 36;
const TMIN = 1;
const TMAX = 26;
const SKEW = 38;
const DAMP = 700;

function adapt(delta: number, numPoints: number, first: boolean): number {
  delta = first ? Math.floor(delta / DAMP) : delta >> 1;
  delta += Math.floor(delta / numPoints);
  let k = 0;
  while (delta > ((BASE - TMIN) * TMAX) >> 1) {
    delta = Math.floor(delta / (BASE - TMIN));
    k += BASE;
  }
  return k + Math.floor(((BASE - TMIN + 1) * delta) / (delta + SKEW));
}

function digitChar(d: number): string {
  return String.fromCharCode(d < 26 ? d + 0x61 : d - 26 + 0x30);
}

function punycodeEncode(input: string): string | null {
  const cps = Array.from(input, (ch) => ch.codePointAt(0) as number);
  let out = "";
  for (const c of cps) if (c < 0x80) out += String.fromCharCode(c);
  const basic = out.length;
  let h = basic;
  if (basic > 0) out += "-";
  let n = 0x80;
  let delta = 0;
  let bias = 72;
  while (h < cps.length) {
    let m = 0x7fffffff;
    for (const c of cps) if (c >= n && c < m) m = c;
    delta += (m - n) * (h + 1);
    if (delta > 0x7fffffff) return null;
    n = m;
    for (const c of cps) {
      if (c < n) delta++;
      if (c === n) {
        let q = delta;
        for (let k = BASE; ; k += BASE) {
          const t = k <= bias ? TMIN : k >= bias + TMAX ? TMAX : k - bias;
          if (q < t) break;
          out += digitChar(t + ((q - t) % (BASE - t)));
          q = Math.floor((q - t) / (BASE - t));
        }
        out += digitChar(q);
        bias = adapt(delta, h + 1, h === basic);
        delta = 0;
        h++;
      }
    }
    delta++;
    n++;
  }
  return out;
}

function punycodeDecode(input: string): string | null {
  const output: number[] = [];
  const dash = input.lastIndexOf("-");
  const basic = dash < 0 ? 0 : dash;
  for (let j = 0; j < basic; j++) {
    const c = input.charCodeAt(j);
    if (c >= 0x80) return null;
    output.push(c);
  }
  let n = 0x80;
  let i = 0;
  let bias = 72;
  for (let p = basic > 0 ? basic + 1 : 0; p < input.length; ) {
    const oldi = i;
    let w = 1;
    for (let k = BASE; ; k += BASE) {
      if (p >= input.length) return null;
      const c = input.charCodeAt(p++);
      const digit = c >= 0x30 && c <= 0x39 ? c - 22 : c >= 0x41 && c <= 0x5a ? c - 0x41 : c >= 0x61 && c <= 0x7a ? c - 0x61 : BASE;
      if (digit >= BASE) return null;
      i += digit * w;
      if (i > 0x7fffffff) return null;
      const t = k <= bias ? TMIN : k >= bias + TMAX ? TMAX : k - bias;
      if (digit < t) break;
      w *= BASE - t;
      if (w > 0x7fffffff) return null;
    }
    bias = adapt(i - oldi, output.length + 1, oldi === 0);
    n += Math.floor(i / (output.length + 1));
    if (n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return null;
    i %= output.length + 1;
    output.splice(i, 0, n);
    i++;
  }
  return String.fromCodePoint(...output);
}

/** Code points UTS #46 maps to nothing. */
function ignored(c: number): boolean {
  return (
    c === 0xad || c === 0x34f || c === 0x17b4 || c === 0x17b5 || c === 0x115f || c === 0x1160 || c === 0x3164 || c === 0xffa0 ||
    (c >= 0x1d173 && c <= 0x1d17a) || (c >= 0x180b && c <= 0x180f) || c === 0x200b || c === 0x2060 ||
    c === 0x2064 || (c >= 0x206a && c <= 0x206f) || (c >= 0xfe00 && c <= 0xfe0f) || c === 0xfeff ||
    (c >= 0x1bca0 && c <= 0x1bca3) || (c >= 0xe0100 && c <= 0xe01ef)
  );
}

const DISALLOWED = /[\p{Cc}\p{Cf}\p{Cn}\p{Co}\p{Z}]/u;

/** Code points UTS #46 disallows (approximately: by general category). */
function disallowed(c: number, ch: string): boolean {
  if ((c & 0xfffe) === 0xfffe || (c >= 0xfdd0 && c <= 0xfdef) || (c >= 0x2ff0 && c <= 0x2fff) || c === 0xfffd) {
    return true;
  }
  // (The joiners are valid in context: CheckJoiners.)
  if (c === 0x200c || c === 0x200d) return false;
  return DISALLOWED.test(ch);
}

/** The viramas (canonical combining class 9): a joiner may follow one. */
const VIRAMAS = new Set([
  0x94d, 0x9cd, 0xa4d, 0xacd, 0xb4d, 0xbcd, 0xc4d, 0xccd, 0xd3b, 0xd3c, 0xd4d, 0xdca, 0xe3a, 0xeba, 0xf84, 0x1039,
  0x103a, 0x1714, 0x1715, 0x1734, 0x17d2, 0x1a60, 0x1b44, 0x1baa, 0x1bab, 0x1bf2, 0x1bf3, 0x2d7f, 0xa806, 0xa82c,
  0xa8c4, 0xa953, 0xa9c0, 0xaaf6, 0xabed, 0x10a3f, 0x11046, 0x11070, 0x1107f, 0x110b9, 0x11133, 0x11134, 0x111c0,
  0x11235, 0x112ea, 0x1134d, 0x11442, 0x114c2, 0x115bf, 0x1163f, 0x116b6, 0x1172b, 0x11839, 0x1193d, 0x1193e,
  0x119e0, 0x11a34, 0x11a47, 0x11a99, 0x11c3f, 0x11d44, 0x11d45, 0x11d97,
]);

/** Arabic letters that join only to the preceding letter, or to none (Joining_Type R or U). */
function rightJoining(c: number): boolean {
  return (
    (c >= 0x621 && c <= 0x625) || c === 0x627 || c === 0x629 || (c >= 0x62f && c <= 0x632) || c === 0x648 ||
    (c >= 0x671 && c <= 0x673) || (c >= 0x675 && c <= 0x677) || (c >= 0x688 && c <= 0x699) || c === 0x6c0 ||
    (c >= 0x6c3 && c <= 0x6cb) || c === 0x6cd || c === 0x6cf || c === 0x6d2 || c === 0x6d3 || c === 0x6d5 ||
    c === 0x6ee || c === 0x6ef
  );
}

function arabicLetter(c: number): boolean {
  return (c >= 0x620 && c <= 0x64a) || (c >= 0x66e && c <= 0x6d5) || (c >= 0x6ee && c <= 0x6ff) ||
    (c >= 0x710 && c <= 0x74f) || (c >= 0x750 && c <= 0x77f) || (c >= 0x8a0 && c <= 0x8c9);
}

/**
 * CheckJoiners (RFC 5892, A.1 and A.2): a joiner after a virama, or a
 * ZWNJ between letters that join (approximately: Arabic letters, the one
 * before joining to the next), skipping marks.
 */
function joinerAllowed(cps: number[], i: number): boolean {
  if (i > 0 && VIRAMAS.has(cps[i - 1])) return true;
  if (cps[i] !== 0x200c) return false;
  const mark = (c: number) => NSM.test(String.fromCodePoint(c));
  let b = i - 1;
  while (b >= 0 && mark(cps[b])) b--;
  let a = i + 1;
  while (a < cps.length && mark(cps[a])) a++;
  return b >= 0 && a < cps.length && arabicLetter(cps[b]) && !rightJoining(cps[b]) && arabicLetter(cps[a]) &&
    cps[a] !== 0x621;
}

/** UTS #46's mapping, approximately (ignored code points out, NFKC, lower case, NFC): null if disallowed. */
function uts46Map(s: string): string | null {
  let kept = "";
  let dots = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0) as number;
    if (ignored(c)) continue;
    if (c === 0x2e || c === 0x3002 || c === 0xff0e || c === 0xff61) {
      kept += ".";
      dots++;
    } else {
      // (Σ maps to σ, also at the end of a word, unlike toLowerCase.)
      kept += c === 0x3a3 ? "\u03C3" : ch;
    }
  }
  let mapped = kept.normalize("NFKC").toLowerCase().normalize("NFC");
  // (Full stops that NFKC made, as from U+FE12, are disallowed: counted below.)
  if (mapped.indexOf("\u3002") >= 0) mapped = mapped.replaceAll("\u3002", ".");
  let after = 0;
  const cps = Array.from(mapped, (ch) => ch.codePointAt(0) as number);
  for (let i = 0; i < cps.length; i++) {
    const c = cps[i];
    if (c === 0x2e) after++;
    else if (c >= 0x80 && disallowed(c, String.fromCodePoint(c))) return null;
    if ((c === 0x200c || c === 0x200d) && !joinerAllowed(cps, i)) return null;
  }
  // (Code points that map to full stops, as U+2025, are disallowed.)
  return after === dots ? mapped : null;
}

const MARK = /^\p{M}/u;
const NSM = /^[\p{Mn}\p{Me}]$/u;
const LETTER = /^[\p{L}\p{Mc}\p{Nd}\p{Nl}\p{No}]$/u;

const L = 0;
const R = 1;
const AL = 2;
const AN = 3;
const EN = 4;
const NSM_CLASS = 5;
const NEUTRAL = 6;

/** A code point's bidirectional class, approximately (by ranges and categories). */
function bidiClass(c: number, ch: string): number {
  if (c >= 0x30 && c <= 0x39) return EN;
  if (c < 0x80) return isAlpha(c) ? L : NEUTRAL;
  if (NSM.test(ch)) return NSM_CLASS;
  if ((c >= 0x600 && c <= 0x605) || (c >= 0x660 && c <= 0x669) || c === 0x66b || c === 0x66c || c === 0x6dd ||
      c === 0x890 || c === 0x891 || c === 0x8e2 || (c >= 0x10e60 && c <= 0x10e7e)) {
    return AN;
  }
  if ((c >= 0x6f0 && c <= 0x6f9)) return EN;
  if ((c >= 0x600 && c <= 0x7bf) || (c >= 0x860 && c <= 0x8ff) || (c >= 0xfb50 && c <= 0xfdff) ||
      (c >= 0xfe70 && c <= 0xfeff) || (c >= 0x10d00 && c <= 0x10d3f) || (c >= 0x10f30 && c <= 0x10f6f) ||
      (c >= 0x1ec70 && c <= 0x1efff)) {
    return AL;
  }
  if ((c >= 0x590 && c <= 0x5ff) || (c >= 0x7c0 && c <= 0x85f) || (c >= 0xfb1d && c <= 0xfb4f) ||
      (c >= 0x10800 && c <= 0x10fff) || (c >= 0x1e800 && c <= 0x1ec6f)) {
    return R;
  }
  return LETTER.test(ch) ? L : NEUTRAL;
}

/** CheckBidi (RFC 5893's rule) for the labels of a domain with right-to-left text. */
function checkBidi(labels: string[]): boolean {
  const classes = labels.map((l) => Array.from(l, (ch) => bidiClass(ch.codePointAt(0) as number, ch)));
  if (!classes.some((cs) => cs.some((k) => k === R || k === AL || k === AN))) return true;
  for (const cs of classes) {
    if (cs.length === 0) continue;
    const first = cs[0];
    let last = cs.length - 1;
    while (last > 0 && cs[last] === NSM_CLASS) last--;
    if (first === R || first === AL) {
      if (cs.includes(L)) return false;
      if (cs[last] !== R && cs[last] !== AL && cs[last] !== EN && cs[last] !== AN) return false;
      if (cs.includes(EN) && cs.includes(AN)) return false;
    } else if (first === L) {
      if (cs.includes(R) || cs.includes(AL) || cs.includes(AN)) return false;
      if (cs[last] !== L && cs[last] !== EN) return false;
    } else {
      return false;
    }
  }
  return true;
}

/** Whether `label` (decoded from punycode) is a valid label. */
function validLabel(label: string): boolean {
  return label.length > 0 && !MARK.test(label) && uts46Map(label) === label;
}

/**
 * UTS #46 ToASCII as the URL standard has it (CheckHyphens and the DNS
 * length checks off): null on failure. An ASCII domain is only lower-cased.
 */
function domainToASCII(domain: string): string | null {
  let ascii = true;
  for (let i = 0; i < domain.length; i++) if (domain.charCodeAt(i) >= 0x80) ascii = false;
  if (ascii) return domain.toLowerCase();
  const mapped = uts46Map(domain);
  if (mapped === null) return null;
  const labels = mapped.split(".");
  const unicode = labels.slice();
  for (let i = 0; i < labels.length; i++) {
    const label = labels[i];
    if (label.startsWith("xn--")) {
      for (let j = 0; j < label.length; j++) if (label.charCodeAt(j) >= 0x80) return null;
      const decoded = punycodeDecode(label.slice(4));
      if (decoded === null || decoded.length === 0) return null;
      let allAscii = true;
      for (let j = 0; j < decoded.length; j++) if (decoded.charCodeAt(j) >= 0x80) allAscii = false;
      if (allAscii || !validLabel(decoded)) return null;
      unicode[i] = decoded;
    } else {
      let nonAscii = false;
      for (let j = 0; j < label.length; j++) if (label.charCodeAt(j) >= 0x80) nonAscii = true;
      if (nonAscii) {
        if (MARK.test(label)) return null;
        const encoded = punycodeEncode(label);
        if (encoded === null) return null;
        labels[i] = "xn--" + encoded;
      }
    }
  }
  if (!checkBidi(unicode)) return null;
  return labels.join(".");
}

/** Parses a host: the serialized host, or null (failure). */
function parseHost(input: string, isOpaque: boolean): string | null {
  if (input.charCodeAt(0) === 0x5b) {
    if (input.charCodeAt(input.length - 1) !== 0x5d) return null;
    const address = parseIPv6(input.slice(1, -1));
    return address === null ? null : serializeIPv6(address);
  }
  if (isOpaque) {
    for (let i = 0; i < input.length; i++) {
      const c = input.charCodeAt(i);
      if (forbiddenHost(c)) return null;
    }
    return encodeString(input, C0, false);
  }
  const domain = percentDecode(input, false);
  const asciiDomain = domainToASCII(domain);
  if (asciiDomain === null || asciiDomain.length === 0) return null;
  for (let i = 0; i < asciiDomain.length; i++) if (forbiddenDomain(asciiDomain.charCodeAt(i))) return null;
  if (endsInNumber(asciiDomain)) {
    const ipv4 = parseIPv4(asciiDomain);
    return ipv4 < 0 ? null : serializeIPv4(ipv4);
  }
  return asciiDomain;
}

// ---- URL records and the parser ----

const SPECIAL = new Map<string, number>([
  ["ftp", 21],
  ["file", -1],
  ["http", 80],
  ["https", 443],
  ["ws", 80],
  ["wss", 443],
]);

/**
 * The special scheme `input[0..end]` is (in lower case), or null: a
 * constant, so that the fast path makes no string for it.
 */
function specialScheme(input: string, end: number): string | null {
  const a = input.charCodeAt(0);
  const b = input.charCodeAt(1);
  const c = input.charCodeAt(2);
  if (a === 0x68 && b === 0x74 && c === 0x74 && input.charCodeAt(3) === 0x70) {
    if (end === 4) return "http";
    if (end === 5 && input.charCodeAt(4) === 0x73) return "https";
  } else if (a === 0x77 && b === 0x73) {
    if (end === 2) return "ws";
    if (end === 3 && c === 0x73) return "wss";
  } else if (end === 3 && a === 0x66 && b === 0x74 && c === 0x70) {
    return "ftp";
  }
  return null;
}

// The path of a record made by the fast path (which sets `pathText`, or a
// path of its own): never changed, replaced by `segments`.
const NO_PATH: string[] = [];

/** A URL record. */
class Record {
  scheme = "";
  // Whether the scheme is special (kept with it: see setScheme).
  isSpecial = false;
  username = "";
  password = "";
  host: string | null = null;
  port: number | null = null;
  path: string[] = NO_PATH;
  // When not null, the URL has this opaque path instead of `path`.
  opaque: string | null = null;
  query: string | null = null;
  fragment: string | null = null;
  // The serialization, when it is known: the input of a URL that serializes
  // as it was written (see fastParse). Whatever changes the URL clears it.
  serialized: string | null = null;
  // A fast-parsed URL's path as it serializes ("/a/b"), until its segments
  // are needed (`segments`): `path` is empty while this is not null.
  pathText: string | null = null;

  /** The path's segments (made from `pathText` first, if need be). */
  segments(): string[] {
    const t = this.pathText;
    if (t !== null) {
      this.path = t.slice(1).split("/");
      this.pathText = null;
    } else if (this.path === NO_PATH) {
      this.path = [];
    }
    return this.path;
  }

  special(): boolean {
    return this.isSpecial;
  }

  setScheme(scheme: string): void {
    this.scheme = scheme;
    this.isSpecial = SPECIAL.has(scheme);
  }

  credentials(): boolean {
    return this.username !== "" || this.password !== "";
  }

  /** Whether it cannot have a username, password or port. */
  noCredentials(): boolean {
    return this.host === null || this.host === "" || this.scheme === "file";
  }

  clone(): Record {
    const r = new Record();
    r.scheme = this.scheme;
    r.isSpecial = this.isSpecial;
    r.username = this.username;
    r.password = this.password;
    r.host = this.host;
    r.port = this.port;
    r.path = this.path.slice();
    r.pathText = this.pathText;
    r.opaque = this.opaque;
    r.query = this.query;
    r.fragment = this.fragment;
    return r;
  }

  shortenPath(): void {
    const p = this.path;
    if (this.scheme === "file" && p.length === 1 && normalizedDriveLetter(p[0])) return;
    p.pop();
  }

  pathname(): string {
    if (this.pathText !== null) return this.pathText;
    if (this.opaque !== null) return this.opaque;
    let out = "";
    for (const s of this.path) out += "/" + s;
    return out;
  }

  href(excludeFragment = false): string {
    if (this.serialized !== null && !excludeFragment) return this.serialized;
    let out = this.scheme + ":";
    if (this.host !== null) {
      out += "//";
      if (this.credentials()) {
        out += this.username;
        if (this.password !== "") out += ":" + this.password;
        out += "@";
      }
      out += this.host;
      if (this.port !== null) out += ":" + this.port;
    } else if (this.opaque === null && this.segments().length > 1 && this.path[0] === "") {
      out += "/.";
    }
    out += this.pathname();
    if (this.query !== null) out += "?" + this.query;
    if (!excludeFragment && this.fragment !== null) out += "#" + this.fragment;
    return out;
  }
}

function driveLetter(s: string): boolean {
  return s.length === 2 && isAlpha(s.charCodeAt(0)) && (s.charCodeAt(1) === 0x3a || s.charCodeAt(1) === 0x7c);
}

function normalizedDriveLetter(s: string): boolean {
  return s.length === 2 && isAlpha(s.charCodeAt(0)) && s.charCodeAt(1) === 0x3a;
}

/** Whether `s` from `i` starts with a Windows drive letter (then the end, / \ ? or #). */
function startsWithDriveLetter(s: string, i: number): boolean {
  if (s.length - i < 2) return false;
  if (!isAlpha(s.charCodeAt(i)) || (s.charCodeAt(i + 1) !== 0x3a && s.charCodeAt(i + 1) !== 0x7c)) return false;
  if (s.length - i === 2) return true;
  const c = s.charCodeAt(i + 2);
  return c === 0x2f || c === 0x5c || c === 0x3f || c === 0x23;
}

function singleDot(s: string): boolean {
  return s === "." || s === "%2e" || s === "%2E";
}

function doubleDot(s: string): boolean {
  switch (s.length) {
    case 2:
      return s === "..";
    case 4:
      return s === ".%2e" || s === ".%2E" || s === "%2e." || s === "%2E.";
    case 6:
      return s === "%2e%2e" || s === "%2E%2E" || s === "%2e%2E" || s === "%2E%2e";
    default:
      return false;
  }
}

const SCHEME_START = 1;
const SCHEME = 2;
const NO_SCHEME = 3;
const SPECIAL_RELATIVE_OR_AUTHORITY = 4;
const PATH_OR_AUTHORITY = 5;
const RELATIVE = 6;
const RELATIVE_SLASH = 7;
const SPECIAL_AUTHORITY_SLASHES = 8;
const SPECIAL_AUTHORITY_IGNORE_SLASHES = 9;
const AUTHORITY = 10;
const HOST = 11;
const HOSTNAME = 12;
const PORT = 13;
const FILE = 14;
const FILE_SLASH = 15;
const FILE_HOST = 16;
const PATH_START = 17;
const PATH_STATE = 18;
const OPAQUE_PATH = 19;
const QUERY_STATE = 20;
const FRAGMENT_STATE = 21;

function isC0OrSpace(c: number): boolean {
  return c <= 0x20;
}

/** The input without leading and trailing C0 controls and spaces, and without tabs and newlines. */
function clean(input: string, trim: boolean): string {
  let start = 0;
  let end = input.length;
  if (trim) {
    while (start < end && isC0OrSpace(input.charCodeAt(start))) start++;
    while (end > start && isC0OrSpace(input.charCodeAt(end - 1))) end--;
  }
  let tabs = false;
  for (let i = start; i < end; i++) {
    const c = input.charCodeAt(i);
    if (c === 9 || c === 0xa || c === 0xd) tabs = true;
  }
  const s = start > 0 || end < input.length ? input.slice(start, end) : input;
  if (!tabs) return s;
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c !== 9 && c !== 0xa && c !== 0xd) out += s[i];
  }
  return out;
}

/**
 * The path, query and fragment of a fast-parsed URL from `input[start..]`
 * (which starts with "/", or is empty) into `url`, as the path, query and
 * fragment states would (nothing in them needs encoding): whether they
 * serialize as they are written (no dot segments, and a path).
 */
function fastPath(input: string, start: number, url: Record): boolean {
  const len = input.length;
  let end = start;
  // (Whether a segment starts with "." or "%": it may be a dot segment.)
  let dots = false;
  while (end < len) {
    const c = input.charCodeAt(end);
    if (c === 0x3f || c === 0x23) break;
    if (c === 0x2f) {
      const d = input.charCodeAt(end + 1);
      if (d === 0x2e || d === 0x25) dots = true;
    }
    end++;
  }
  let same = true;
  if (start === end) {
    url.pathText = "/";
    same = false;
  } else if (!dots) {
    url.pathText = input.slice(start, end);
  } else {
    const path: string[] = [];
    let seg = start + 1;
    for (let i = seg; i <= end; i++) {
      if (i === end || input.charCodeAt(i) === 0x2f) {
        // (A dot segment: ".", "..", or with "%2e" for a dot.)
        const first = input.charCodeAt(seg);
        if ((first === 0x2e || first === 0x25) && i - seg <= 6 && dotSegment(input, seg, i)) {
          same = false;
          if (i - seg === 1 || i - seg === 3) {
            if (i === end) path.push("");
          } else {
            path.pop();
            if (i === end) path.push("");
          }
        } else {
          path.push(input.slice(seg, i));
        }
        seg = i + 1;
      }
    }
    url.path = path;
  }
  if (end < len && input.charCodeAt(end) === 0x3f) {
    let q = end + 1;
    while (q < len && input.charCodeAt(q) !== 0x23) q++;
    url.query = input.slice(end + 1, q);
    end = q;
  }
  if (end < len) url.fragment = input.slice(end + 1);
  return same;
}

/** Whether `input[seg..end]` is a single-dot (length 1 or 3) or double-dot path segment. */
function dotSegment(input: string, seg: number, end: number): boolean {
  const s = input.slice(seg, end);
  return singleDot(s) || doubleDot(s);
}

/** Whether `s[start..end]` is an IPv4 address as it serializes: four decimal parts, 0 to 255, without leading zeros. */
function canonicalIPv4(s: string, start: number, end: number): boolean {
  let parts = 0;
  let i = start;
  while (i <= end) {
    let n = 0;
    let digits = 0;
    while (i < end && isDigit(s.charCodeAt(i))) {
      n = n * 10 + (s.charCodeAt(i) - 0x30);
      digits++;
      i++;
    }
    if (digits === 0 || digits > 3 || n > 255 || (digits > 1 && s.charCodeAt(i - digits) === 0x30)) return false;
    parts++;
    if (i === end) break;
    if (s.charCodeAt(i) !== 0x2e) return false;
    i++;
  }
  return parts === 4;
}

/**
 * The common URL, parsed without the state machine: printable ASCII that
 * needs no encoding, a special scheme other than file with "//",
 * credentials, a host that is a plain domain (no IPv6, an IPv4 address only
 * as it serializes), a port, and a path, query and fragment; or such a path
 * (from "/") against such a base. Null when the general parser is needed
 * (not a failure). A URL that serializes as it is written keeps the input
 * as its serialization.
 */
function fastParse(input: string, base: Record | null): Record | null {
  // (Not: controls and non-ASCII, space " ' < > \\ ^ ` { | }, which need
  // trimming, encoding or the reverse-solidus rules. A "%" is kept as it is
  // but in the host.)
  const len = input.length;
  for (let i = 0; i < len; i++) {
    // (fastUnsafe, inline: this loop runs for every character.)
    const c = input.charCodeAt(i);
    if (
      c <= 0x20 || c >= 0x7f || c === 0x22 || c === 0x27 || c === 0x3c || c === 0x3e || c === 0x5c ||
      c === 0x5e || c === 0x60 || c === 0x7b || c === 0x7c || c === 0x7d
    ) {
      return null;
    }
  }
  if (base !== null) {
    // A path from the root, against a special base with a host.
    if (len === 0 || input.charCodeAt(0) !== 0x2f || (len > 1 && input.charCodeAt(1) === 0x2f)) return null;
    if (!base.isSpecial || base.scheme === "file" || base.host === null) return null;
    const url = new Record();
    url.scheme = base.scheme;
    url.isSpecial = true;
    url.username = base.username;
    url.password = base.password;
    url.host = base.host;
    url.port = base.port;
    fastPath(input, 0, url);
    return url;
  }
  // The scheme: a special one but file, with "//".
  let i = 0;
  let same = true;
  while (i < len) {
    const c = input.charCodeAt(i);
    if (c === 0x3a) break;
    if (c >= 0x41 && c <= 0x5a) same = false;
    i++;
  }
  if (i + 2 >= len || input.charCodeAt(i + 1) !== 0x2f || input.charCodeAt(i + 2) !== 0x2f) return null;
  const scheme = specialScheme(same ? input : input.slice(0, i).toLowerCase(), i);
  if (scheme === null) return null;
  const defaultPort = scheme === "http" || scheme === "ws" ? 80 : scheme === "ftp" ? 21 : 443;
  // The host and port, after the credentials if there is an "@": a
  // username, and a password after a ":", neither with what they encode
  // (; = @ [ ] and another ":").
  const authStart = i + 3;
  let hostStart = authStart;
  let hostEnd = hostStart;
  let portStart = -1;
  let upper = false;
  let percent = false;
  let encode = false;
  // (The "@", and the ":" before it.)
  let at = -1;
  let colon = -1;
  while (hostEnd < len) {
    const c = input.charCodeAt(hostEnd);
    if (c === 0x2f || c === 0x3f || c === 0x23) break;
    if (c === 0x40) {
      if (at >= 0 || encode) return null;
      at = hostEnd;
      colon = portStart;
      hostStart = hostEnd + 1;
      portStart = -1;
      upper = false;
      percent = false;
    } else if (c === 0x5b || c === 0x5d) {
      return null;
    } else if (c === 0x3a) {
      if (portStart >= 0) return null;
      portStart = hostEnd;
    } else if (c === 0x25) {
      percent = true;
    } else if (c === 0x3b || c === 0x3d) {
      encode = true;
    } else if (c >= 0x41 && c <= 0x5a && portStart < 0) {
      upper = true;
    }
    hostEnd++;
  }
  // (A "%" in the host is decoded.)
  if (percent) return null;
  let username = "";
  let password = "";
  if (at >= 0) {
    username = input.slice(authStart, colon >= 0 ? colon : at);
    if (colon >= 0) password = input.slice(colon + 1, at);
    // (An empty password loses its ":", empty credentials their "@".)
    if ((colon >= 0 && password === "") || (username === "" && password === "")) same = false;
  }
  const nameEnd = portStart >= 0 ? portStart : hostEnd;
  if (nameEnd === hostStart) return null;
  // (A last label that starts with a digit may make it an IPv4 address:
  // only the canonical dotted decimal form is taken as it is.)
  let labelStart = nameEnd - 1;
  if (input.charCodeAt(labelStart) === 0x2e) labelStart--;
  while (labelStart > hostStart && input.charCodeAt(labelStart - 1) !== 0x2e) labelStart--;
  if (isDigit(input.charCodeAt(labelStart)) && !canonicalIPv4(input, hostStart, nameEnd)) return null;
  let host = input.slice(hostStart, nameEnd);
  if (upper) {
    host = host.toLowerCase();
    same = false;
  }
  let port: number | null = null;
  if (portStart >= 0) {
    // (Written as it serializes: not empty, not the default, without
    // leading zeros.)
    let written = false;
    if (portStart + 1 < hostEnd) {
      let n = 0;
      for (let k = portStart + 1; k < hostEnd; k++) {
        const c = input.charCodeAt(k);
        if (!isDigit(c)) return null;
        n = n * 10 + (c - 0x30);
        if (n > 65535) return null;
      }
      port = n === defaultPort ? null : n;
      written = port !== null && (input.charCodeAt(portStart + 1) !== 0x30 || hostEnd - portStart === 2);
    }
    if (!written) same = false;
  }
  const url = new Record();
  url.scheme = scheme;
  url.isSpecial = true;
  url.username = username;
  url.password = password;
  url.host = host;
  url.port = port;
  if (fastPath(input, hostEnd, url) && same) url.serialized = input;
  return url;
}

/**
 * The basic URL parser: a new record parsed from `input` (against `base`),
 * or with `override`, `url` changed by a setter. Returns the record, or
 * null on failure.
 */
function parse(rawInput: string, base: Record | null, url: Record | null, override: number): Record | null {
  if (url === null) {
    const fast = fastParse(rawInput, base);
    if (fast !== null) return fast;
  } else {
    url.serialized = null;
    url.segments();
  }
  if (base !== null) base.segments();
  const input = clean(rawInput, url === null);
  if (url === null) {
    url = new Record();
    url.path = [];
  }
  let state = override !== 0 ? override : SCHEME_START;
  let buffer = "";
  let atSignSeen = false;
  let insideBrackets = false;
  let passwordTokenSeen = false;
  const len = input.length;
  for (let p = 0; ; p++) {
    const c = p < len ? input.charCodeAt(p) : -1;
    switch (state) {
      case SCHEME_START:
        if (isAlpha(c)) {
          buffer += String.fromCharCode(c | 0x20);
          state = SCHEME;
        } else if (override === 0) {
          state = NO_SCHEME;
          p--;
        } else {
          return null;
        }
        break;
      case SCHEME:
        if (isAlpha(c) || isDigit(c) || c === 0x2b || c === 0x2d || c === 0x2e) {
          buffer += String.fromCharCode(c >= 0x41 && c <= 0x5a ? c | 0x20 : c);
        } else if (c === 0x3a) {
          if (override !== 0) {
            const newSpecial = SPECIAL.has(buffer);
            if (url.special() !== newSpecial) return url;
            if ((url.credentials() || url.port !== null) && buffer === "file") return url;
            if (url.scheme === "file" && url.host === "") return url;
          }
          url.setScheme(buffer);
          if (override !== 0) {
            if (url.port === SPECIAL.get(url.scheme)) url.port = null;
            return url;
          }
          buffer = "";
          if (url.scheme === "file") {
            state = FILE;
          } else if (url.special() && base !== null && base.scheme === url.scheme) {
            state = SPECIAL_RELATIVE_OR_AUTHORITY;
          } else if (url.special()) {
            state = SPECIAL_AUTHORITY_SLASHES;
          } else if (p + 1 < len && input.charCodeAt(p + 1) === 0x2f) {
            state = PATH_OR_AUTHORITY;
            p++;
          } else {
            url.opaque = "";
            state = OPAQUE_PATH;
          }
        } else if (override === 0) {
          buffer = "";
          state = NO_SCHEME;
          p = -1;
        } else {
          return null;
        }
        break;
      case NO_SCHEME:
        if (base === null || (base.opaque !== null && c !== 0x23)) return null;
        if (base.opaque !== null && c === 0x23) {
          url.setScheme(base.scheme);
          url.path = base.path.slice();
          url.opaque = base.opaque;
          url.query = base.query;
          url.fragment = "";
          state = FRAGMENT_STATE;
        } else if (base.scheme !== "file") {
          state = RELATIVE;
          p--;
        } else {
          state = FILE;
          p--;
        }
        break;
      case SPECIAL_RELATIVE_OR_AUTHORITY:
        if (c === 0x2f && p + 1 < len && input.charCodeAt(p + 1) === 0x2f) {
          state = SPECIAL_AUTHORITY_IGNORE_SLASHES;
          p++;
        } else {
          state = RELATIVE;
          p--;
        }
        break;
      case PATH_OR_AUTHORITY:
        if (c === 0x2f) {
          state = AUTHORITY;
        } else {
          state = PATH_STATE;
          p--;
        }
        break;
      case RELATIVE: {
        const b = base as Record;
        url.setScheme(b.scheme);
        if (c === 0x2f) {
          state = RELATIVE_SLASH;
        } else if (url.special() && c === 0x5c) {
          state = RELATIVE_SLASH;
        } else {
          url.username = b.username;
          url.password = b.password;
          url.host = b.host;
          url.port = b.port;
          url.path = b.path.slice();
          url.query = b.query;
          if (c === 0x3f) {
            url.query = "";
            state = QUERY_STATE;
          } else if (c === 0x23) {
            url.fragment = "";
            state = FRAGMENT_STATE;
          } else if (c !== -1) {
            url.query = null;
            url.shortenPath();
            state = PATH_STATE;
            p--;
          }
        }
        break;
      }
      case RELATIVE_SLASH:
        if (url.special() && (c === 0x2f || c === 0x5c)) {
          state = SPECIAL_AUTHORITY_IGNORE_SLASHES;
        } else if (c === 0x2f) {
          state = AUTHORITY;
        } else {
          const b = base as Record;
          url.username = b.username;
          url.password = b.password;
          url.host = b.host;
          url.port = b.port;
          state = PATH_STATE;
          p--;
        }
        break;
      case SPECIAL_AUTHORITY_SLASHES:
        if (c === 0x2f && p + 1 < len && input.charCodeAt(p + 1) === 0x2f) {
          state = SPECIAL_AUTHORITY_IGNORE_SLASHES;
          p++;
        } else {
          state = SPECIAL_AUTHORITY_IGNORE_SLASHES;
          p--;
        }
        break;
      case SPECIAL_AUTHORITY_IGNORE_SLASHES:
        if (c !== 0x2f && c !== 0x5c) {
          state = AUTHORITY;
          p--;
        }
        break;
      case AUTHORITY:
        if (c === 0x40) {
          if (atSignSeen) buffer = "%40" + buffer;
          atSignSeen = true;
          for (let i = 0; i < buffer.length; i++) {
            let cp = buffer.charCodeAt(i);
            if (cp === 0x3a && !passwordTokenSeen) {
              passwordTokenSeen = true;
              continue;
            }
            if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < buffer.length) {
              cp = 0x10000 + ((cp - 0xd800) << 10) + (buffer.charCodeAt(i + 1) - 0xdc00);
              i++;
            }
            const encoded = encodeCodePoint(cp, USERINFO);
            if (passwordTokenSeen) url.password += encoded;
            else url.username += encoded;
          }
          buffer = "";
        } else if (c === -1 || c === 0x2f || c === 0x3f || c === 0x23 || (url.special() && c === 0x5c)) {
          if (atSignSeen && buffer === "") return null;
          p -= buffer.length + 1;
          buffer = "";
          state = HOST;
        } else {
          buffer += input[p];
        }
        break;
      case HOST:
      case HOSTNAME:
        if (override !== 0 && url.scheme === "file") {
          p--;
          state = FILE_HOST;
        } else if (c === 0x3a && !insideBrackets) {
          if (buffer === "") return null;
          if (override === HOSTNAME) return null;
          const host = parseHost(buffer, !url.special());
          if (host === null) return null;
          url.host = host;
          buffer = "";
          state = PORT;
        } else if (c === -1 || c === 0x2f || c === 0x3f || c === 0x23 || (url.special() && c === 0x5c)) {
          p--;
          if (url.special() && buffer === "") return null;
          if (override !== 0 && buffer === "" && (url.credentials() || url.port !== null)) return null;
          const host = parseHost(buffer, !url.special());
          if (host === null) return null;
          url.host = host;
          buffer = "";
          state = PATH_START;
          if (override !== 0) return url;
        } else {
          if (c === 0x5b) insideBrackets = true;
          if (c === 0x5d) insideBrackets = false;
          buffer += input[p];
        }
        break;
      case PORT:
        if (isDigit(c)) {
          buffer += input[p];
        } else if (c === -1 || c === 0x2f || c === 0x3f || c === 0x23 || (url.special() && c === 0x5c) || override !== 0) {
          if (buffer !== "") {
            const port = Number(buffer);
            if (port > 65535) return null;
            url.port = port === SPECIAL.get(url.scheme) ? null : port;
            buffer = "";
            if (override !== 0) return url;
          }
          if (override !== 0) return null;
          state = PATH_START;
          p--;
        } else {
          return null;
        }
        break;
      case FILE:
        url.setScheme("file");
        url.host = "";
        if (c === 0x2f || c === 0x5c) {
          state = FILE_SLASH;
        } else if (base !== null && base.scheme === "file") {
          url.host = base.host;
          url.path = base.path.slice();
          url.query = base.query;
          if (c === 0x3f) {
            url.query = "";
            state = QUERY_STATE;
          } else if (c === 0x23) {
            url.fragment = "";
            state = FRAGMENT_STATE;
          } else if (c !== -1) {
            url.query = null;
            if (!startsWithDriveLetter(input, p)) url.shortenPath();
            else url.path = [];
            state = PATH_STATE;
            p--;
          }
        } else {
          state = PATH_STATE;
          p--;
        }
        break;
      case FILE_SLASH:
        if (c === 0x2f || c === 0x5c) {
          state = FILE_HOST;
        } else {
          if (base !== null && base.scheme === "file") {
            url.host = base.host;
            if (!startsWithDriveLetter(input, p) && base.path.length > 0 && normalizedDriveLetter(base.path[0])) {
              url.path.push(base.path[0]);
            }
          }
          state = PATH_STATE;
          p--;
        }
        break;
      case FILE_HOST:
        if (c === -1 || c === 0x2f || c === 0x5c || c === 0x3f || c === 0x23) {
          p--;
          if (override === 0 && driveLetter(buffer)) {
            state = PATH_STATE;
          } else if (buffer === "") {
            url.host = "";
            if (override !== 0) return url;
            state = PATH_START;
          } else {
            let host = parseHost(buffer, !url.special());
            if (host === null) return null;
            if (host === "localhost") host = "";
            url.host = host;
            if (override !== 0) return url;
            buffer = "";
            state = PATH_START;
          }
        } else {
          buffer += input[p];
        }
        break;
      case PATH_START:
        if (url.special()) {
          state = PATH_STATE;
          if (c !== 0x2f && c !== 0x5c) p--;
        } else if (override === 0 && c === 0x3f) {
          url.query = "";
          state = QUERY_STATE;
        } else if (override === 0 && c === 0x23) {
          url.fragment = "";
          state = FRAGMENT_STATE;
        } else if (c !== -1) {
          state = PATH_STATE;
          if (c !== 0x2f) p--;
        } else if (override !== 0 && url.host === null) {
          url.path.push("");
        }
        break;
      case PATH_STATE:
        if (c === -1 || c === 0x2f || (url.special() && c === 0x5c) || (override === 0 && (c === 0x3f || c === 0x23))) {
          const slash = c === 0x2f || (url.special() && c === 0x5c);
          if (doubleDot(buffer)) {
            url.shortenPath();
            if (!slash) url.path.push("");
          } else if (singleDot(buffer) && !slash) {
            url.path.push("");
          } else if (!singleDot(buffer)) {
            if (url.scheme === "file" && url.path.length === 0 && driveLetter(buffer)) {
              buffer = buffer[0] + ":";
            }
            url.path.push(buffer);
          }
          buffer = "";
          if (c === 0x3f) {
            url.query = "";
            state = QUERY_STATE;
          }
          if (c === 0x23) {
            url.fragment = "";
            state = FRAGMENT_STATE;
          }
        } else {
          buffer += encodeAt(input, p, PATH);
          if (c >= 0xd800 && c <= 0xdbff) p++;
        }
        break;
      case OPAQUE_PATH:
        if (c === 0x3f) {
          url.query = "";
          state = QUERY_STATE;
        } else if (c === 0x23) {
          url.fragment = "";
          state = FRAGMENT_STATE;
        } else if (c === 0x20) {
          const next = p + 1 < len ? input.charCodeAt(p + 1) : -1;
          url.opaque += next === 0x3f || next === 0x23 ? "%20" : " ";
        } else if (c !== -1) {
          url.opaque += encodeAt(input, p, C0);
          if (c >= 0xd800 && c <= 0xdbff) p++;
        }
        break;
      case QUERY_STATE:
        if ((override === 0 && c === 0x23) || c === -1) {
          url.query += encodeString(buffer, url.special() ? SPECIAL_QUERY : QUERY, false);
          buffer = "";
          if (c === 0x23) {
            url.fragment = "";
            state = FRAGMENT_STATE;
          }
        } else if (c !== -1) {
          buffer += input[p];
        }
        break;
      case FRAGMENT_STATE:
        if (c !== -1) {
          url.fragment += encodeAt(input, p, FRAGMENT);
          if (c >= 0xd800 && c <= 0xdbff) p++;
        }
        break;
    }
    if (p >= len) break;
  }
  return url;
}

/** The code point at `input[p]`, UTF-8 percent-encoded with `set`. */
function encodeAt(input: string, p: number, set: number): string {
  let c = input.charCodeAt(p);
  if (c < 0x80) return inSet(c, set) ? pct(c) : input[p];
  if (c >= 0xd800 && c <= 0xdbff && p + 1 < input.length) {
    c = 0x10000 + ((c - 0xd800) << 10) + (input.charCodeAt(p + 1) - 0xdc00);
  }
  return encodeCodePoint(c, set);
}

// ---- URLSearchParams ----

/** application/x-www-form-urlencoded: name-value pairs. */
function parseForm(s: string): [string, string][] {
  const out: [string, string][] = [];
  let start = 0;
  while (start <= s.length) {
    let end = s.indexOf("&", start);
    if (end < 0) end = s.length;
    if (end > start) {
      const eq = s.indexOf("=", start);
      const nameEnd = eq >= 0 && eq < end ? eq : end;
      const name = percentDecode(s.slice(start, nameEnd), true);
      const value = nameEnd < end ? percentDecode(s.slice(nameEnd + 1, end), true) : "";
      out.push([name, value]);
    }
    start = end + 1;
  }
  return out;
}

function serializeForm(list: [string, string][]): string {
  let out = "";
  for (let i = 0; i < list.length; i++) {
    if (i > 0) out += "&";
    out += encodeString(list[i][0], FORM, true) + "=" + encodeString(list[i][1], FORM, true);
  }
  return out;
}

export type URLSearchParamsInit = string | [string, string][] | Record<string, string> | URLSearchParams;

export class URLSearchParams {
  _list: [string, string][] = [];
  // The URL whose query this is, if any.
  _url: URL | null = null;

  constructor(init?: URLSearchParamsInit) {
    if (init === undefined || init === null) return;
    if (typeof init === "object" || typeof init === "function") {
      const iterator = (init as any)[Symbol.iterator];
      if (iterator !== undefined) {
        if (typeof iterator !== "function") throw new TypeError("The init's Symbol.iterator is not a function");
        for (const pair of init as Iterable<any>) {
          if (typeof pair !== "object" && typeof pair !== "function" || pair === null) {
            throw new TypeError("Each query pair must be an iterable [name, value] tuple");
          }
          const p = Array.from(pair as Iterable<any>);
          if (p.length !== 2) throw new TypeError("Each query pair must be an iterable [name, value] tuple");
          this._list.push([usv(p[0]), usv(p[1])]);
        }
      } else {
        for (const key of Reflect.ownKeys(init)) {
          if (typeof key === "symbol") continue;
          const d = Object.getOwnPropertyDescriptor(init, key);
          if (d !== undefined && d.enumerable) this._list.push([usv(key), usv((init as any)[key])]);
        }
      }
      return;
    }
    let s = usv(init);
    if (s.charCodeAt(0) === 0x3f) s = s.slice(1);
    this._list = parseForm(s);
  }

  _update(): void {
    const url = this._url;
    if (url === null) return;
    const s = serializeForm(this._list);
    url._url.serialized = null;
    url._url.query = s === "" ? null : s;
  }

  get size(): number {
    return this._list.length;
  }

  append(name: string, value: string): void {
    this._list.push([usv(name), usv(value)]);
    this._update();
  }

  delete(name: string, value?: string): void {
    const n = usv(name);
    const v = value === undefined ? undefined : usv(value);
    this._list = this._list.filter((p) => !(p[0] === n && (v === undefined || p[1] === v)));
    this._update();
  }

  get(name: string): string | null {
    const n = usv(name);
    for (const p of this._list) if (p[0] === n) return p[1];
    return null;
  }

  getAll(name: string): string[] {
    const n = usv(name);
    const out: string[] = [];
    for (const p of this._list) if (p[0] === n) out.push(p[1]);
    return out;
  }

  has(name: string, value?: string): boolean {
    const n = usv(name);
    const v = value === undefined ? undefined : usv(value);
    for (const p of this._list) if (p[0] === n && (v === undefined || p[1] === v)) return true;
    return false;
  }

  set(name: string, value: string): void {
    const n = usv(name);
    const v = usv(value);
    const i = this._list.findIndex((p) => p[0] === n);
    if (i < 0) {
      this._list.push([n, v]);
    } else {
      this._list[i] = [n, v];
      this._list = this._list.filter((p, j) => j <= i || p[0] !== n);
    }
    this._update();
  }

  /** Sorts by name (by code units), keeping the order of equal names. */
  sort(): void {
    const indexed = this._list.map((p, i) => [p, i] as [[string, string], number]);
    indexed.sort((a, b) => (a[0][0] < b[0][0] ? -1 : a[0][0] > b[0][0] ? 1 : a[1] - b[1]));
    this._list = indexed.map((x) => x[0]);
    this._update();
  }

  toString(): string {
    return serializeForm(this._list);
  }

  *entries(): IterableIterator<[string, string]> {
    for (let i = 0; i < this._list.length; i++) yield [this._list[i][0], this._list[i][1]];
  }

  *keys(): IterableIterator<string> {
    for (let i = 0; i < this._list.length; i++) yield this._list[i][0];
  }

  *values(): IterableIterator<string> {
    for (let i = 0; i < this._list.length; i++) yield this._list[i][1];
  }

  forEach(callback: (value: string, name: string, params: URLSearchParams) => void, thisArg?: any): void {
    if (typeof callback !== "function") throw new TypeError("The callback must be a function");
    for (let i = 0; i < this._list.length; i++) callback.call(thisArg, this._list[i][1], this._list[i][0], this);
  }

  [Symbol.iterator](): IterableIterator<[string, string]> {
    return this.entries();
  }

  get [Symbol.toStringTag](): string {
    return "URLSearchParams";
  }

  [describe](f: Formatter): void {
    f.record("URLSearchParams", this._list.map((p) => [p[0], p[1]]), { quoteKeys: true });
  }
}

/** A string as Node's util.inspect quotes it. */
function nodeQuote(s: string): string {
  return `'${s.replaceAll("\\", "\\\\").replaceAll("'", "\\'").replaceAll("\n", "\\n")}'`;
}

// ---- URL ----

function invalidURL(input: string): TypeError {
  const e = new TypeError(`"${input}" cannot be parsed as a URL.`);
  (e as any).code = "ERR_INVALID_URL";
  return e;
}

/** `url` against `base`: the record, or null. */
function parseWithBase(url: string, base: string | URL | undefined): Record | null {
  let b: Record | null = null;
  if (base !== undefined) {
    if (base instanceof URL) {
      b = base._url;
    } else {
      // (fastParse takes only ASCII, which usv leaves as it is.)
      const s = String(base);
      b = fastParse(s, null) ?? parse(usv(s), null, null, 0);
      if (b === null) return null;
    }
  }
  return fastParse(url, b) ?? parse(usv(url), b, null, 0);
}

export class URL {
  _url: Record;
  _params: URLSearchParams | null = null;

  constructor(url: string | URL, base?: string | URL) {
    const r = parseWithBase(String(url), base);
    if (r === null) throw invalidURL(String(url));
    this._url = r;
  }

  static canParse(url: string, base?: string | URL): boolean {
    return parseWithBase(String(url), base) !== null;
  }

  static parse(url: string, base?: string | URL): URL | null {
    const r = parseWithBase(String(url), base);
    if (r === null) return null;
    const u = Object.create(URL.prototype) as URL;
    u._url = r;
    u._params = null;
    return u;
  }

  _setQuery(query: string | null): void {
    this._url.serialized = null;
    this._url.query = query;
    if (this._params !== null) this._params._list = query === null ? [] : parseForm(query);
  }

  get href(): string {
    return this._url.href();
  }

  set href(value: string) {
    const r = parse(usv(value), null, null, 0);
    if (r === null) throw invalidURL(String(value));
    this._url = r;
    if (this._params !== null) this._params._list = r.query === null ? [] : parseForm(r.query);
  }

  get origin(): string {
    const u = this._url;
    switch (u.scheme) {
      case "blob": {
        if (u.opaque === null && u.segments().length === 0) return "null";
        const inner = parse(u.pathname(), null, null, 0);
        if (inner !== null && (inner.scheme === "http" || inner.scheme === "https")) {
          return inner.scheme + "://" + inner.host + (inner.port !== null ? ":" + inner.port : "");
        }
        return "null";
      }
      case "ftp":
      case "http":
      case "https":
      case "ws":
      case "wss":
        return u.scheme + "://" + u.host + (u.port !== null ? ":" + u.port : "");
      default:
        return "null";
    }
  }

  get protocol(): string {
    return this._url.scheme + ":";
  }

  set protocol(value: string) {
    parse(usv(value) + ":", null, this._url, SCHEME_START);
  }

  get username(): string {
    return this._url.username;
  }

  set username(value: string) {
    if (this._url.noCredentials()) return;
    this._url.serialized = null;
    this._url.username = encodeString(usv(value), USERINFO, false);
  }

  get password(): string {
    return this._url.password;
  }

  set password(value: string) {
    if (this._url.noCredentials()) return;
    this._url.serialized = null;
    this._url.password = encodeString(usv(value), USERINFO, false);
  }

  get host(): string {
    const u = this._url;
    if (u.host === null) return "";
    return u.port === null ? u.host : u.host + ":" + u.port;
  }

  set host(value: string) {
    if (this._url.opaque !== null) return;
    parse(usv(value), null, this._url, HOST);
  }

  get hostname(): string {
    return this._url.host ?? "";
  }

  set hostname(value: string) {
    if (this._url.opaque !== null) return;
    parse(usv(value), null, this._url, HOSTNAME);
  }

  get port(): string {
    return this._url.port === null ? "" : String(this._url.port);
  }

  set port(value: string) {
    if (this._url.noCredentials()) return;
    const v = usv(value);
    if (v === "") {
      this._url.serialized = null;
      this._url.port = null;
      return;
    }
    parse(v, null, this._url, PORT);
  }

  get pathname(): string {
    return this._url.pathname();
  }

  set pathname(value: string) {
    if (this._url.opaque !== null) return;
    this._url.serialized = null;
    this._url.pathText = null;
    this._url.path = [];
    parse(usv(value), null, this._url, PATH_START);
  }

  get search(): string {
    const q = this._url.query;
    return q === null || q === "" ? "" : "?" + q;
  }

  set search(value: string) {
    let v = usv(value);
    if (v === "") {
      this._setQuery(null);
      return;
    }
    if (v.charCodeAt(0) === 0x3f) v = v.slice(1);
    this._url.serialized = null;
    this._url.query = "";
    parse(v, null, this._url, QUERY_STATE);
    if (this._params !== null) this._params._list = parseForm(v);
  }

  get searchParams(): URLSearchParams {
    let p = this._params;
    if (p === null) {
      p = new URLSearchParams(this._url.query ?? "");
      p._url = this;
      this._params = p;
    }
    return p;
  }

  get hash(): string {
    const f = this._url.fragment;
    return f === null || f === "" ? "" : "#" + f;
  }

  set hash(value: string) {
    let v = usv(value);
    if (v === "") {
      this._url.serialized = null;
      this._url.fragment = null;
      return;
    }
    if (v.charCodeAt(0) === 0x23) v = v.slice(1);
    this._url.serialized = null;
    this._url.fragment = "";
    parse(v, null, this._url, FRAGMENT_STATE);
  }

  toString(): string {
    return this._url.href();
  }

  toJSON(): string {
    return this._url.href();
  }

  get [Symbol.toStringTag](): string {
    return "URL";
  }

  /** As Bun prints a URL: Node's util.inspect format. */
  [inspectCustom](): string {
    const q = nodeQuote;
    const params = this.searchParams._list.map((p) => `${q(p[0])} => ${q(p[1])}`);
    const sp = params.length === 0 ? "URLSearchParams {}" : `URLSearchParams { ${params.join(", ")} }`;
    return (
      `URL {\n  href: ${q(this.href)},\n  origin: ${q(this.origin)},\n  protocol: ${q(this.protocol)},\n` +
      `  username: ${q(this.username)},\n  password: ${q(this.password)},\n  host: ${q(this.host)},\n` +
      `  hostname: ${q(this.hostname)},\n  port: ${q(this.port)},\n  pathname: ${q(this.pathname)},\n` +
      `  search: ${q(this.search)},\n  searchParams: ${sp},\n  hash: ${q(this.hash)}\n}`
    );
  }
}

// ---- Hosts, for node:url (lib/node/internal/bindings/NodeURL.ts) ----

/** A special URL's host parsed from `input` (the serialized host), or null. */
export function parseSpecialHost(input: string): string | null {
  return parseHost(input, false);
}

/** UTS #46 ToASCII (CheckHyphens and the DNS length checks off), or null. */
export function idnaToASCII(domain: string): string | null {
  return domainToASCII(domain);
}

/** UTS #46 ToUnicode: punycode labels decoded (those that do not decode are
 * kept), the others mapped. */
export function idnaToUnicode(domain: string): string {
  const labels = domain.split(".");
  for (let i = 0; i < labels.length; i++) {
    const label = labels[i];
    if (label.slice(0, 4).toLowerCase() === "xn--") {
      const decoded = punycodeDecode(label.slice(4));
      if (decoded !== null) labels[i] = decoded;
    } else {
      labels[i] = uts46Map(label) ?? label;
    }
  }
  return labels.join(".");
}
