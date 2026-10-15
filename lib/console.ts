// The console, as Bun's: log, info and debug to standard output; warn,
// error, trace and failed asserts to standard error; values formatted by
// inspect.ts; group indentation, counters and timers.

import { now, writeOut } from "beyond:native";
import { formatArgs, inspect, InspectOptions } from "./inspect.ts";

const STDOUT = 1;
const STDERR = 2;

let groupIndent = 0;
const counts = new Map<string, number>();
const timers = new Map<string, number>();

function out(fd: number, args: unknown[]): void {
  writeOut(fd, formatArgs(args, groupIndent) + "\n");
}

function label(l: unknown): string {
  return l === undefined ? "default" : String(l);
}

/** Milliseconds as Bun's timers print them: "[1.23ms]", "[1.50s]". */
function elapsed(ms: number): string {
  return ms >= 1000 ? `[${(ms / 1000).toFixed(2)}s]` : `[${ms.toFixed(2)}ms]`;
}

/** The current stack without this module's frames. */
function stackHere(): string {
  const lines = (new Error().stack ?? "").split("\n");
  return lines.slice(2).filter((l) => l.trim() !== "").join("\n");
}

export const console = {
  log(...args: unknown[]): void {
    out(STDOUT, args);
  },
  info(...args: unknown[]): void {
    out(STDOUT, args);
  },
  debug(...args: unknown[]): void {
    out(STDOUT, args);
  },
  warn(...args: unknown[]): void {
    out(STDERR, args);
  },
  error(...args: unknown[]): void {
    out(STDERR, args);
  },
  trace(...args: unknown[]): void {
    const text = formatArgs(args, 0);
    writeOut(STDERR, `${"  ".repeat(groupIndent)}Trace${text === "" ? "" : `: ${text}`}\n${stackHere()}\n`);
  },
  assert(condition?: unknown, ...args: unknown[]): void {
    if (condition) return;
    if (args.length === 0) out(STDERR, ["Assertion failed"]);
    else if (typeof args[0] === "string") out(STDERR, [`Assertion failed: ${args[0]}`, ...args.slice(1)]);
    else out(STDERR, ["Assertion failed:", ...args]);
  },
  dir(value: unknown, options?: InspectOptions): void {
    writeOut(STDOUT, "  ".repeat(groupIndent) + inspect(value, options) + "\n");
  },
  dirxml(...args: unknown[]): void {
    out(STDOUT, args);
  },
  table(...args: unknown[]): void {
    out(STDOUT, args);
  },
  count(l?: unknown): void {
    const k = label(l);
    const n = (counts.get(k) ?? 0) + 1;
    counts.set(k, n);
    out(STDOUT, [`${k}: ${n}`]);
  },
  countReset(l?: unknown): void {
    counts.set(label(l), 0);
  },
  group(...args: unknown[]): void {
    if (args.length > 0) out(STDOUT, args);
    groupIndent++;
  },
  groupCollapsed(...args: unknown[]): void {
    if (args.length > 0) out(STDOUT, args);
    groupIndent++;
  },
  groupEnd(): void {
    if (groupIndent > 0) groupIndent--;
  },
  time(l?: unknown): void {
    const k = label(l);
    if (timers.has(k)) {
      out(STDERR, [`Warning: Label '${k}' already exists for console.time()`]);
      return;
    }
    timers.set(k, now());
  },
  timeEnd(l?: unknown): void {
    const k = label(l);
    const t = timers.get(k);
    if (t === undefined) {
      out(STDERR, [`Warning: No such label '${k}' for console.timeEnd()`]);
      return;
    }
    timers.delete(k);
    out(STDOUT, [`${elapsed(now() - t)} ${k}`]);
  },
  timeLog(l?: unknown, ...args: unknown[]): void {
    const k = label(l);
    const t = timers.get(k);
    if (t === undefined) {
      out(STDERR, [`Warning: No such label '${k}' for console.timeLog()`]);
      return;
    }
    out(STDOUT, [`${elapsed(now() - t)} ${k}`, ...args]);
  },
  clear(): void {},
};
