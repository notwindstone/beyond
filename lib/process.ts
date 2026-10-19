// The global `process` (node:process), as Node's and Bun's: its arguments,
// environment, working directory, exit, standard output, `nextTick` and
// `hrtime`; events through an EventEmitter.

import {
  chdir as nativeChdir,
  cwd as nativeCwd,
  exit as nativeExit,
  hrtime as nativeHrtime,
  now,
  processInfo,
  writeOut,
} from "beyond:native";
import { EventEmitter } from "./node/events.ts";

const info = processInfo() as {
  argv: string[];
  execPath: string;
  pid: number;
  ppid: number;
  env: Record<string, string>;
  release?: string;
  machine?: string;
};

const arch = info.machine === "aarch64" ? "arm64" : info.machine === "x86_64" || info.machine === undefined ? "x64" : info.machine;

/** A writable standard stream (as far as programs write to it). */
class StdStream extends EventEmitter {
  fd: number;
  isTTY: boolean;
  writable = true;
  constructor(fd: number) {
    super();
    this.fd = fd;
    this.isTTY = false;
  }
  write(chunk: string | Uint8Array, encoding?: any, cb?: () => void): boolean {
    if (typeof encoding === "function") cb = encoding;
    writeOut(this.fd, typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
    if (cb) queueMicrotask(cb);
    return true;
  }
  end(chunk?: string | Uint8Array, cb?: () => void): this {
    if (chunk !== undefined && typeof chunk !== "function") this.write(chunk);
    if (typeof chunk === "function") (chunk as () => void)();
    else if (cb) cb();
    return this;
  }
  get columns(): number {
    return 80;
  }
  get rows(): number {
    return 24;
  }
}

const startNs = nativeHrtime() as bigint;

function hrtime(previous?: [number, number]): [number, number] {
  const ns = nativeHrtime() as bigint;
  let s = Number(ns / 1000000000n);
  let n = Number(ns % 1000000000n);
  if (previous) {
    s -= previous[0];
    n -= previous[1];
    if (n < 0) {
      s--;
      n += 1e9;
    }
  }
  return [s, n];
}
hrtime.bigint = (): bigint => nativeHrtime() as bigint;

class Process extends EventEmitter {
  title = "beyond";
  argv = info.argv;
  argv0 = info.argv[0] ?? "beyond";
  execArgv: string[] = [];
  execPath = info.execPath;
  env = info.env;
  pid = info.pid;
  ppid = info.ppid;
  platform = "linux";
  arch = arch;
  version = "v24.3.0";
  versions: Record<string, string> = { node: "24.3.0", bun: "1.4.3", beyond: "0.1.0" };
  release = { name: "node" };
  config = { variables: {} };
  features = { inspector: false, typescript: "strip" };
  exitCode: number | undefined = undefined;
  stdout = new StdStream(1);
  stderr = new StdStream(2);
  stdin = { fd: 0, isTTY: false, on() {}, once() {}, resume() {}, pause() {}, setEncoding() {} };
  hrtime = hrtime;
  browser = false;

  cwd(): string {
    return nativeCwd() as string;
  }

  chdir(dir: string): void {
    nativeChdir(dir);
  }

  exit(code?: number): never {
    if (code !== undefined) this.exitCode = code;
    try {
      this.emit("exit", this.exitCode ?? 0);
    } finally {
      nativeExit(this.exitCode ?? 0);
    }
    throw new Error("unreachable");
  }

  abort(): never {
    nativeExit(134);
    throw new Error("unreachable");
  }

  nextTick(fn: (...args: any[]) => void, ...args: any[]): void {
    queueMicrotask(() => fn(...args));
  }

  uptime(): number {
    return Number((nativeHrtime() as bigint) - startNs) / 1e9;
  }

  memoryUsage(): { rss: number; heapTotal: number; heapUsed: number; external: number; arrayBuffers: number } {
    return { rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 };
  }

  cpuUsage(): { user: number; system: number } {
    return { user: Math.round(now() * 1000), system: 0 };
  }

  umask(): number {
    return 0o22;
  }

  emitWarning(warning: string | Error, type?: string | { type?: string }): void {
    const name = typeof type === "string" ? type : type?.type ?? (warning instanceof Error ? warning.name : "Warning");
    const message = warning instanceof Error ? warning.message : warning;
    writeOut(2, `(beyond) ${name}: ${message}\n`);
  }

  getBuiltinModule(name: string): unknown {
    return (globalThis as any)[Symbol.for("beyond.builtin")]?.(name);
  }

  binding(): never {
    throw new Error("process.binding is not supported");
  }
}

export const process = new Process();
export default process;
