// Natives of Bun's node_util_binding (src/runtime/node/node_util_binding.rs):
// libuv's errors as node:util names them, a fast split of lines, encoding
// names, and util.parseEnv's .env parser.

import { validateString } from "node:internal/validators";
import { uvErrors } from "./uv.ts";

const UV_ECANCELED = -125;
const UV_ENOBUFS = -105;
const UV_ETIMEDOUT = -110;
const UV_EINVAL = -22;

/** util.getSystemErrorName's: the name of libuv error `err`. */
export function internalErrorName(err: unknown): string {
  if (arguments.length === 0) throw new TypeError("Not enough arguments to 'internalErrorName': expected 1, got 0");
  const n = (err as number) | 0;
  for (const [code, name] of uvErrors) if (code === n) return name;
  return `Unknown system error ${n}`;
}

/** libuv's errors, as [code, name, code, name, ...] (getSystemErrorMap). */
export function internalErrorEntries(): (number | string)[] {
  const out: (number | string)[] = [];
  for (const [code, name] of uvErrors) out.push(code, name);
  return out;
}

export function etimedoutErrorCode(): number {
  return UV_ETIMEDOUT;
}

export function enobufsErrorCode(): number {
  return UV_ENOBUFS;
}

export function ecanceledErrorCode(): number {
  return UV_ECANCELED;
}

/** The libuv error of system error `n` (on POSIX, -errno). */
export function uvTranslateSysError(n: unknown): number {
  if (typeof n !== "number") return UV_EINVAL;
  const i = n | 0;
  return i <= 0 ? i : -i;
}

/** `value` split after each "\n" (no empty last line), as
 * `value.split(/(?<=\n)/)`. */
export function extractedSplitNewLinesFastPathStringsOnly(value: string): string[] {
  const lines: string[] = [];
  let start = 0;
  for (;;) {
    if (start === value.length && start !== 0) break;
    const nl = value.indexOf("\n", start);
    if (nl === -1) {
      lines.push(value.slice(start));
      break;
    }
    lines.push(value.slice(start, nl + 1));
    start = nl + 1;
  }
  return lines;
}

/** The canonical name of encoding `enc` (utf8 for ""), or undefined. */
export function normalizeEncoding(enc: unknown): string | undefined {
  const s = `${enc}`;
  if (s.length === 0) return "utf8";
  switch (s.toLowerCase()) {
    case "utf8":
    case "utf-8":
      return "utf8";
    case "ucs2":
    case "ucs-2":
    case "utf16le":
    case "utf-16le":
      return "utf16le";
    case "latin1":
    case "binary":
      return "latin1";
    case "base64":
      return "base64";
    case "base64url":
      return "base64url";
    case "hex":
      return "hex";
    case "ascii":
      return "ascii";
    default:
      return undefined;
  }
}

/** util.parseEnv: the variables of .env text `content` (`KEY=value`,
 * `export KEY=value`, quoted values over lines, `#` comments; in double
 * quotes, `\n` is a newline). */
export function parseEnv(content: unknown): Record<string, string> {
  validateString(content, "content");
  const text = `${content}`.replace(/\r\n?/g, "\n");
  const out: Record<string, string> = {};
  let i = 0;
  while (i < text.length) {
    // (A line: skip blank ones and comments.)
    const lineEnd = text.indexOf("\n", i) === -1 ? text.length : text.indexOf("\n", i);
    let line = text.slice(i, lineEnd).trim();
    if (line === "" || line.startsWith("#")) {
      i = lineEnd + 1;
      continue;
    }
    if (line.startsWith("export ")) line = line.slice(7).trimStart();
    const eq = line.indexOf("=");
    if (eq === -1) {
      i = lineEnd + 1;
      continue;
    }
    const key = line.slice(0, eq).trim();
    // (The value starts after the `=` in the text: a quoted one may span lines.)
    let at = text.indexOf("=", i) + 1;
    while (at < text.length && (text[at] === " " || text[at] === "\t")) at++;
    const q = text[at];
    let value: string;
    if (q === '"' || q === "'" || q === "`") {
      const close = text.indexOf(q, at + 1);
      if (close === -1) {
        value = text.slice(at, lineEnd).trim();
        i = lineEnd + 1;
      } else {
        value = text.slice(at + 1, close);
        if (q === '"') value = value.replace(/\\n/g, "\n");
        const next = text.indexOf("\n", close);
        i = next === -1 ? text.length : next + 1;
      }
    } else {
      value = text.slice(at, lineEnd);
      const hash = value.indexOf(" #");
      if (hash !== -1) value = value.slice(0, hash);
      if (value.startsWith("#")) value = "";
      value = value.trim();
      i = lineEnd + 1;
    }
    if (key !== "") out[key] = value;
  }
  return out;
}
