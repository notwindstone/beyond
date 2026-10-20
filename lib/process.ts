// The global `process` (node:process), as Node's and Bun's: its arguments,
// environment, working directory, exit, standard output, `nextTick` and
// `hrtime`; events through an EventEmitter.

import {
  chdir as nativeChdir,
  cwd as nativeCwd,
  exit as nativeExit,
  hrtime as nativeHrtime,
  now,
  processGroups,
  processIds,
  processInfo,
  processUmask,
  setProcessHooks,
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

  /** Whether 'exit' was emitted (Node's `_exiting`). */
  _exiting = false;

  exit(code?: number): never {
    if (code !== undefined) this.exitCode = code;
    if (!this._exiting) {
      this._exiting = true;
      try {
        this.emit("exit", this.exitCode ?? 0);
      } finally {
        nativeExit(this.exitCode ?? 0);
      }
    }
    nativeExit(this.exitCode ?? 0);
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

  /** The file mode creation mask; with `mask`, set (Bun's checks: a
   * 32-bit unsigned integer, or an octal string). */
  umask(mask?: number | string): number {
    if (mask === undefined) return processUmask(-1) as number;
    let m: number;
    if (typeof mask === "string") {
      if (!/^[0-7]+$/.test(mask)) {
        const e: any = new TypeError(`The argument 'mask' must be a 32-bit unsigned integer or an octal string. Received '${mask}'`);
        e.code = "ERR_INVALID_ARG_VALUE";
        throw e;
      }
      m = parseInt(mask, 8);
    } else {
      if (typeof mask !== "number") {
        const e: any = new TypeError(`The "mask" argument must be of type number. Received ${typeof mask}`);
        e.code = "ERR_INVALID_ARG_TYPE";
        throw e;
      }
      if (!(mask % 1 === 0 && mask >= 0 && mask <= 4294967295)) {
        const must = mask % 1 !== 0 ? "an integer" : ">= 0 && <= 4294967295";
        const e: any = new RangeError(`The value of "mask" is out of range. It must be ${must}. Received ${mask}`);
        e.code = "ERR_OUT_OF_RANGE";
        throw e;
      }
      m = mask;
    }
    return processUmask(m) as number;
  }

  getuid(): number {
    return (processIds() as number[])[0];
  }

  geteuid(): number {
    return (processIds() as number[])[1];
  }

  getgid(): number {
    return (processIds() as number[])[2];
  }

  getegid(): number {
    return (processIds() as number[])[3];
  }

  getgroups(): number[] {
    return processGroups() as number[];
  }

  // (Bun's are stubs: no handles or requests are listed.)
  _getActiveHandles(): unknown[] {
    return [];
  }

  _getActiveRequests(): unknown[] {
    return [];
  }

  getActiveResourcesInfo(): string[] {
    return [];
  }

  emitWarning(warning: string | Error, type?: string | { type?: string }): void {
    const name = typeof type === "string" ? type : type?.type ?? (warning instanceof Error ? warning.name : "Warning");
    const message = warning instanceof Error ? warning.message : warning;
    writeOut(2, `(beyond) ${name}: ${message}\n`);
  }

  getBuiltinModule(name: string): unknown {
    return (globalThis as any)[Symbol.for("beyond.builtin")]?.(name);
  }

  /** Sends a signal (SIGTERM by default) to process `pid`. */
  kill(pid: number, signal?: string | number): true {
    return import.meta.require("./spawn.ts").killProcess(pid, signal);
  }

  /** Node's internal modules, the few Bun has (node:internal/bindings/process_binding). */
  binding(name: string): unknown {
    return import.meta.require("node:internal/bindings/process_binding").binding(name);
  }
}

export const process = new Process();

// The event loop's ends, as Bun's: 'beforeExit' when it has nothing left
// to do (it goes on if a listener gives it work), then 'exit' with
// process.exitCode, and that code (after an uncaught error: 'exit' with
// process.exitCode, 1 if unset, and 1); an error nothing caught to the
// listeners of 'unhandledRejection' (a rejection) or 'uncaughtException'
// (an exception), when there are any.
setProcessHooks(
  (): boolean => {
    if (process.listenerCount("beforeExit") === 0) return false;
    process.emit("beforeExit", process.exitCode ?? 0);
    return true;
  },
  (code: number): number => {
    if (code >= 0 && process.exitCode === undefined) process.exitCode = code;
    if (!process._exiting) {
      process._exiting = true;
      process.emit("exit", process.exitCode ?? 0);
    }
    return code >= 0 ? code : (process.exitCode ?? 0);
  },
  (err: unknown, origin: string, promise: unknown): boolean => {
    if (origin === "unhandledRejection") {
      if (process.listenerCount("unhandledRejection") === 0) return false;
      process.emit("unhandledRejection", err, promise);
      return true;
    }
    if (process.listenerCount("uncaughtException") === 0) return false;
    process.emit("uncaughtException", err, origin);
    return true;
  },
);

// A child its parent gave an IPC channel (fork(), Bun.spawn's `ipc`):
// process.send and the like.
if (info.env.NODE_CHANNEL_FD !== undefined) import.meta.require("./spawn.ts").setupChildChannel(process);
export default process;
