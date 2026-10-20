// Bun.spawn and Bun.spawnSync, as Bun's (src/runtime/api/bun/
// js_bun_spawn_bindings.rs, subprocess.rs), which node:child_process is
// built on: a child process whose stdio slots are inherited, ignored,
// files, descriptors, bytes, or pipes the parent reads (as ReadableStreams,
// or node:child_process's native readables through `$bunNativePtr`) and
// writes (a FileSink); its exit as a promise and a callback; and an IPC
// channel (Node's: JSON lines on a socket) when one is asked for.
// native/spawn.c starts the child, and watches its exit and its pipes in
// the program's loop.

import {
  decodeUtf8,
  encodeUtf8,
  spawnClose,
  spawnDup,
  spawnError,
  spawnInit,
  spawnKill,
  spawnProcess,
  spawnReap,
  spawnSync as nativeSpawnSync,
  spawnWatch,
  spawnWatchClose,
  spawnWatchPoll,
  spawnWatchRef,
  spawnWrite,
} from "beyond:native";
import { Blob } from "./blob.ts";
import { BunFile } from "./file.ts";
import { Buffer } from "./node/buffer.ts";
import { process } from "./process.ts";
import {
  controllerClose,
  controllerEnqueue,
  controllerError,
  createReadableStream,
  ReadableStream,
  ReadableStreamDefaultReader,
} from "./streams.ts";
import { clearTimeout, setTimeout } from "./timers.ts";

// The watch events native/spawn.c hands over.
const EV_EXIT = 1;
const EV_DATA = 2;
const EV_EOF = 3;
const EV_ERROR = 4;
const EV_WRITABLE = 5;

// What a stdio slot is, as spawnProcess takes it (else a descriptor, a
// file's path, or bytes for stdin).
const IO_INHERIT = -1;
const IO_IGNORE = -2;
const IO_PIPE = -3;
const IO_SOCKET = -4;

const EAGAIN = 11;
const ESRCH = 3;

/** What a watch's events go to. */
interface Task {
  event(kind: number, a: any, b: any, c: any): void;
}

const tasks = new Map<number, Task>();
let initialized = false;

function init(): void {
  if (initialized) return;
  initialized = true;
  spawnInit((h: number, kind: number, a: any, b: any, c: any) => {
    const t = tasks.get(h);
    if (t !== undefined) t.event(kind, a, b, c);
  }, Buffer.prototype);
}

function invalidArg(message: string, code = "ERR_INVALID_ARG_TYPE"): TypeError {
  const e = new TypeError(message) as TypeError & { code: string };
  e.code = code;
  return e;
}

// ---- Signals (Linux's) ----

const SIGNALS = [
  "",
  "SIGHUP",
  "SIGINT",
  "SIGQUIT",
  "SIGILL",
  "SIGTRAP",
  "SIGABRT",
  "SIGBUS",
  "SIGFPE",
  "SIGKILL",
  "SIGUSR1",
  "SIGSEGV",
  "SIGUSR2",
  "SIGPIPE",
  "SIGALRM",
  "SIGTERM",
  "SIGSTKFLT",
  "SIGCHLD",
  "SIGCONT",
  "SIGSTOP",
  "SIGTSTP",
  "SIGTTIN",
  "SIGTTOU",
  "SIGURG",
  "SIGXCPU",
  "SIGXFSZ",
  "SIGVTALRM",
  "SIGPROF",
  "SIGWINCH",
  "SIGIO",
  "SIGPWR",
  "SIGSYS",
];
const SIGNAL_ALIASES: Record<string, number> = { SIGIOT: 6, SIGPOLL: 29 };

/** A signal's number, of its name or number (as Bun's SignalCode.fromJS). */
export function signalNumber(sig: unknown): number {
  if (typeof sig === "number") {
    if (!Number.isInteger(sig) || sig < 0) throw invalidArg("Invalid signal: must be a non-negative integer");
    if (sig >= 32) throw invalidArg("Invalid signal: must be < 32");
    return sig;
  }
  if (typeof sig === "string") {
    const n = SIGNALS.indexOf(sig);
    if (n > 0) return n;
    if (SIGNAL_ALIASES[sig] !== undefined) return SIGNAL_ALIASES[sig];
  }
  if (sig === undefined || sig === null) return 15;
  throw invalidArg(
    `signal must be one of ${SIGNALS.slice(1, -1)
      .map((s) => `'${s}'`)
      .join(", ")} or '${SIGNALS[SIGNALS.length - 1]}'`,
  );
}

/** A signal's name, or its number if it has none. */
export function signalName(n: number): string | number {
  return SIGNALS[n] || n;
}

/** process.kill(pid, signal), as Node's. */
export function killProcess(pid: unknown, signal?: unknown): true {
  if (typeof pid !== "number") throw invalidArg(`The "pid" argument must be of type number. Received ${describeArg(pid)}`);
  let sig = 15;
  if (typeof signal === "number") {
    sig = signal | 0;
  } else if (signal !== undefined) {
    const s = String(signal);
    const n = SIGNALS.indexOf(s);
    sig = n > 0 ? n : SIGNAL_ALIASES[s] ?? -1;
    if (sig < 0) {
      const e = new TypeError(`Unknown signal: ${s}`) as TypeError & { code: string };
      e.code = "ERR_UNKNOWN_SIGNAL";
      throw e;
    }
  }
  const r = spawnKill(pid, sig) as number;
  if (r < 0) {
    const e = spawnError(-r, "kill") as Error & { code: string };
    e.message = `kill ${e.code}`;
    throw e;
  }
  return true;
}

function describeArg(v: unknown): string {
  if (v === null) return "null";
  if (v === undefined) return "undefined";
  if (typeof v === "string") return `type string (${JSON.stringify(v)})`;
  return `type ${typeof v} (${String(v)})`;
}

// ---- Pipes the parent reads ----

/** Uint8Array → Buffer (the same bytes). */
function asBuffer(u8: Uint8Array): Buffer {
  Object.setPrototypeOf(u8, Buffer.prototype);
  return u8 as Buffer;
}

function concat(chunks: Uint8Array[], size: number): Uint8Array {
  if (chunks.length === 1) return chunks[0];
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.length;
  }
  return all;
}

/**
 * A pipe from the child (its stdout or stderr), read as the program's loop
 * finds bytes in it once started: what is read is kept until it is asked
 * for, by a ReadableStream or node:child_process's readable (whose reads
 * pause it while it has enough).
 */
class PipeReader implements Task {
  fd: number;
  watch = 0;
  chunks: Uint8Array[] = [];
  size = 0;
  // Read to its end (or an error): the descriptor is closed.
  done = false;
  error: any = undefined;
  started = false;
  paused = false;
  refd = true;
  // What waits for the next event (a pull of a stream that had nothing).
  waiter: ((kind: number, a: any) => void) | null = null;
  stream: ReadableStream<Uint8Array> | undefined = undefined;
  // Bytes read so far, and what is told past `limit` (maxBuffer).
  total = 0;
  limit = 0;
  onLimit: (() => void) | null = null;
  onEnd: (() => void) | null = null;

  constructor(fd: number) {
    this.fd = fd;
  }

  start(): void {
    if (this.started || this.done) return;
    this.started = true;
    init();
    this.watch = spawnWatch(this.fd, false);
    tasks.set(this.watch, this);
    if (!this.refd) spawnWatchRef(this.watch, false);
    if (!this.paused) spawnWatchPoll(this.watch, true);
  }

  setPaused(paused: boolean): void {
    if (paused === this.paused) return;
    this.paused = paused;
    if (this.watch !== 0) spawnWatchPoll(this.watch, !paused);
  }

  setRef(refd: boolean): void {
    this.refd = refd;
    if (this.watch !== 0) spawnWatchRef(this.watch, refd);
  }

  event(kind: number, a: any): void {
    if (kind === EV_DATA) {
      this.total += a.length;
      const w = this.waiter;
      if (w !== null) {
        this.waiter = null;
        w(kind, a);
      } else {
        this.chunks.push(a);
        this.size += a.length;
      }
      if (this.limit > 0 && this.total > this.limit && this.onLimit !== null) {
        const f = this.onLimit;
        this.onLimit = null;
        f();
      }
      return;
    }
    tasks.delete(this.watch);
    this.watch = 0;
    this.done = true;
    if (kind === EV_ERROR) this.error = spawnError(a, "read");
    const w = this.waiter;
    if (w !== null) {
      this.waiter = null;
      w(kind, this.error);
    }
    const f = this.onEnd;
    this.onEnd = null;
    if (f !== null) f();
  }

  /** What was read and not taken yet, all of it (null if none). */
  takeAll(): Uint8Array | null {
    if (this.chunks.length === 0) return null;
    const all = concat(this.chunks, this.size);
    this.chunks = [];
    this.size = 0;
    return all;
  }

  /** Reading is over (cancelled): the descriptor is closed. */
  close(): void {
    if (this.watch !== 0) {
      tasks.delete(this.watch);
      spawnWatchClose(this.watch, true);
      this.watch = 0;
    } else if (!this.done && !this.started) {
      spawnClose(this.fd);
    }
    this.started = true;
    this.done = true;
    this.chunks = [];
    this.size = 0;
    this.waiter = null;
    const f = this.onEnd;
    this.onEnd = null;
    if (f !== null) f();
  }

  /** The next event, once there is one (reading if it was not). */
  next(f: (kind: number, a: any) => void): void {
    this.waiter = f;
    this.start();
    this.setPaused(false);
  }

  /** The pipe as a ReadableStream (Bun's subprocess.stdout), once. */
  toStream(): ReadableStream<Uint8Array> {
    if (this.stream !== undefined) return this.stream;
    const reader = this;
    let transferred = false;
    const stream: ReadableStream<Uint8Array> = createReadableStream<Uint8Array>(
      () => undefined,
      () => {
        const c = stream._controller as any;
        if (transferred) return Promise.resolve();
        if (reader.chunks.length > 0) {
          for (const chunk of reader.chunks) controllerEnqueue(c, chunk);
          reader.chunks = [];
          reader.size = 0;
          return Promise.resolve();
        }
        if (reader.done) {
          if (reader.error !== undefined) controllerError(c, reader.error);
          else controllerClose(c);
          return Promise.resolve();
        }
        return new Promise<void>((resolve) => {
          reader.next((kind, a) => {
            if (kind === EV_DATA) controllerEnqueue(c, a);
            else if (kind === EV_EOF) controllerClose(c);
            else controllerError(c, a);
            resolve();
          });
        });
      },
      () => {
        reader.close();
        return Promise.resolve();
      },
      0,
    );
    // node:child_process reads the pipe itself (native-readable.ts), and
    // Readable.fromWeb takes this path too: the stream is then done with
    // (transferToNativeReadable).
    const source = {
      start(_hwm?: number): undefined {
        reader.start();
        return undefined;
      },
      drain(): Buffer | undefined {
        const all = reader.takeAll();
        return all === null ? undefined : asBuffer(all);
      },
      pull(_view: Uint8Array, closer: [boolean]): any {
        if (reader.chunks.length > 0) {
          const chunk = reader.chunks.shift()!;
          reader.size -= chunk.length;
          return asBuffer(chunk);
        }
        if (reader.done) {
          closer[0] = true;
          return reader.error !== undefined ? Promise.reject(reader.error) : 0;
        }
        return new Promise((resolve, reject) => {
          reader.next((kind, a) => {
            if (kind === EV_DATA) {
              resolve(asBuffer(a));
            } else if (kind === EV_EOF) {
              closer[0] = true;
              resolve(0);
            } else {
              closer[0] = true;
              reject(a);
            }
          });
        });
      },
      updateRef(refd: boolean): void {
        reader.setRef(refd);
      },
      setFlowing(flowing: boolean): void {
        if (reader.started) reader.setPaused(!flowing);
      },
      cancel(_reason?: any): void {
        reader.close();
      },
      transfer(): void {
        transferred = true;
      },
    };
    Object.defineProperty(stream, "$bunNativePtr", { value: source, writable: true, configurable: true });
    this.stream = stream;
    return stream;
  }
}

/** transferToNativeReadable: the stream's pipe is read by a Node readable from now on. */
export function transferToNativeReadable(stream: any): void {
  const source = stream?.$bunNativePtr;
  if (source !== undefined && typeof source.transfer === "function") source.transfer();
}

// ---- Pipes the parent writes ----

/**
 * Bytes written to a pipe (a child's stdin, an IPC channel) as it takes
 * them: what it does not take at once is queued, and written as the loop
 * finds it writable again.
 */
class FdWriter implements Task {
  fd: number;
  watch = 0;
  queue: Uint8Array[] = [];
  offset = 0;
  pending = 0;
  waiters: [() => void, (e: any) => void][] = [];
  closed = false;
  ending = false;
  error: any = undefined;
  refd = true;
  onClose: (() => void) | null = null;

  constructor(fd: number) {
    this.fd = fd;
  }

  /** Writes `bytes` after what is queued: whether all of it is written. */
  push(bytes: Uint8Array): boolean {
    if (this.closed) return false;
    if (this.queue.length === 0) {
      if (bytes.length === 0) return true;
      const n = spawnWrite(this.fd, bytes, 0) as number;
      if (n === bytes.length) return true;
      if (n < 0 && n !== -EAGAIN) {
        this.fail(-n);
        return false;
      }
      this.offset = n > 0 ? n : 0;
      this.queue.push(bytes);
      this.pending = bytes.length - this.offset;
      this.poll();
      return false;
    }
    this.queue.push(bytes);
    this.pending += bytes.length;
    return false;
  }

  poll(): void {
    if (this.watch === 0) {
      init();
      this.watch = spawnWatch(this.fd, true);
      tasks.set(this.watch, this);
      if (!this.refd) spawnWatchRef(this.watch, false);
    }
    spawnWatchPoll(this.watch, true);
  }

  setRef(refd: boolean): void {
    this.refd = refd;
    if (this.watch !== 0) spawnWatchRef(this.watch, refd);
  }

  event(kind: number): void {
    if (kind !== EV_WRITABLE) return;
    while (this.queue.length > 0) {
      const b = this.queue[0];
      const n = spawnWrite(this.fd, b, this.offset) as number;
      if (n < 0) {
        if (n === -EAGAIN) return this.poll();
        return this.fail(-n);
      }
      this.offset += n;
      this.pending -= n;
      if (this.offset < b.length) return this.poll();
      this.queue.shift();
      this.offset = 0;
    }
    const ws = this.waiters;
    this.waiters = [];
    for (const [resolve] of ws) resolve();
    if (this.ending) this.close();
  }

  /** Once what is queued is written. */
  drained(): Promise<void> {
    if (this.queue.length === 0) return this.error !== undefined ? Promise.reject(this.error) : Promise.resolve();
    return new Promise((resolve, reject) => this.waiters.push([resolve, reject]));
  }

  fail(no: number): void {
    this.error = spawnError(no, "write");
    const ws = this.waiters;
    this.waiters = [];
    this.close();
    for (const [, reject] of ws) reject(this.error);
  }

  /** Closes the pipe once what is queued is written. */
  end(): void {
    if (this.queue.length > 0 && !this.closed) this.ending = true;
    else this.close();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.watch !== 0) {
      tasks.delete(this.watch);
      spawnWatchClose(this.watch, true);
      this.watch = 0;
    } else {
      spawnClose(this.fd);
    }
    this.queue = [];
    this.pending = 0;
    const ws = this.waiters;
    this.waiters = [];
    for (const [resolve] of ws) resolve();
    const f = this.onClose;
    this.onClose = null;
    if (f !== null) f();
  }
}

/** The bytes of what FileSink.write takes. */
function bytesOf(chunk: unknown): Uint8Array {
  if (typeof chunk === "string") return encodeUtf8(chunk) as Uint8Array;
  if (chunk instanceof Uint8Array) return chunk;
  if (ArrayBuffer.isView(chunk)) return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  if (chunk instanceof ArrayBuffer || chunk instanceof SharedArrayBuffer) return new Uint8Array(chunk);
  throw invalidArg("write() expects a string, ArrayBufferView, or ArrayBuffer");
}

/** Bun's FileSink: a child's stdin ("pipe"), written as it takes bytes. */
export class FileSink {
  #w: FdWriter;
  #written = 0;

  constructor(w: FdWriter) {
    this.#w = w;
  }

  /** Writes `chunk`: its size, or a promise of it if the pipe could not take it all now. */
  write(chunk: unknown): number | Promise<number> {
    const bytes = bytesOf(chunk);
    const w = this.#w;
    if (w.closed) return w.error !== undefined ? handled(Promise.reject(w.error)) : 0;
    this.#written += bytes.length;
    if (w.push(bytes)) return bytes.length;
    const n = bytes.length;
    return handled(w.drained().then(() => n));
  }

  /** Once what was written is: how much was. */
  flush(): number | Promise<number> {
    const w = this.#w;
    if (w.queue.length === 0) return w.error !== undefined && !w.closed ? Promise.reject(w.error) : 0;
    const n = w.pending;
    return w.drained().then(() => n);
  }

  /** Ends the pipe (once what was written is). */
  end(_error?: unknown): number | Promise<number> {
    const w = this.#w;
    if (w.closed) return 0;
    if (w.queue.length === 0) {
      w.close();
      return 0;
    }
    const n = w.pending;
    const p = w.drained();
    w.end();
    return p.then(() => n);
  }

  close(error?: unknown): number | Promise<number> {
    return this.end(error);
  }

  start(_options?: unknown): void {}

  ref(): void {
    this.#w.setRef(true);
  }

  unref(): void {
    this.#w.setRef(false);
  }

  _getFd(): number {
    return this.#w.fd;
  }

  get [Symbol.toStringTag](): string {
    return "FileSink";
  }
}

/** A promise whose rejection nothing has to handle (a write's whose writer reports its error otherwise too). */
function handled<T>(p: Promise<T>): Promise<T> {
  p.catch(() => {});
  return p;
}

// ---- IPC: Node's channel of JSON lines ----

/**
 * The IPC channel (a socket): messages are JSON, one a line (an internal
 * one, of node:cluster's, after a byte 2), read as the loop finds them;
 * a message sent is written after those before it.
 */
class IpcChannel implements Task {
  watch = 0;
  writer: FdWriter;
  connected = true;
  partial: Uint8Array | null = null;
  refd = true;
  onMessage: (message: unknown, internal: boolean) => void;
  onClose: () => void;

  constructor(fd: number, onMessage: (message: unknown, internal: boolean) => void, onClose: () => void) {
    init();
    this.onMessage = onMessage;
    this.onClose = onClose;
    // (Writing has a descriptor of its own: the loop polls each once.)
    this.writer = new FdWriter(spawnDup(fd) as number);
    this.watch = spawnWatch(fd, false);
    tasks.set(this.watch, this);
    spawnWatchPoll(this.watch, true);
  }

  setRef(refd: boolean): void {
    this.refd = refd;
    if (this.watch !== 0) spawnWatchRef(this.watch, refd);
  }

  event(kind: number, a: any): void {
    if (kind === EV_DATA) return this.feed(a);
    tasks.delete(this.watch);
    this.watch = 0;
    this.close();
  }

  feed(chunk: Uint8Array): void {
    let data = chunk;
    if (this.partial !== null) {
      data = concat([this.partial, chunk], this.partial.length + chunk.length);
      this.partial = null;
    }
    let start = 0;
    for (;;) {
      const nl = data.indexOf(10, start);
      if (nl < 0) break;
      let s = start;
      const internal = data[s] === 2;
      if (internal) s++;
      start = nl + 1;
      if (nl === s) continue;
      let message: unknown;
      try {
        message = JSON.parse(decodeUtf8(data.subarray(s, nl), false) as string);
      } catch {
        continue;
      }
      this.onMessage(message, internal);
      if (!this.connected) return;
    }
    if (start < data.length) this.partial = data.slice(start);
  }

  /** Sends `message`: whether it was written at once. */
  send(message: unknown, internal: boolean, callback?: (err: any) => void): boolean {
    const json = JSON.stringify(message);
    const bytes = encodeUtf8((internal ? "\x02" : "") + json + "\n") as Uint8Array;
    const now = this.writer.push(bytes);
    if (callback !== undefined) {
      if (now) process.nextTick(callback, null);
      else this.writer.drained().then(() => callback(null), (e) => callback(e));
    }
    return true;
  }

  /** Closes the channel (once what was sent is written). */
  disconnect(): void {
    if (!this.connected) return;
    if (this.watch !== 0) {
      tasks.delete(this.watch);
      spawnWatchClose(this.watch, true);
      this.watch = 0;
    }
    this.close();
  }

  close(): void {
    if (!this.connected) return;
    this.connected = false;
    this.writer.end();
    this.onClose();
  }
}

// ---- Bun.spawn ----

/** Bun's ResourceUsage, of [user µs, system µs, maxRSS, shared memory,
 * swaps, blocks in, out, messages sent, received, signals, voluntary and
 * involuntary context switches]. */
class ResourceUsage {
  contextSwitches: { voluntary: number; involuntary: number };
  cpuTime: { user: bigint; system: bigint; total: bigint };
  maxRSS: number;
  messages: { sent: number; received: number };
  ops: { in: number; out: number };
  shmSize: number;
  signalCount: number;
  swapCount: number;

  constructor(r: number[]) {
    this.contextSwitches = Object.assign(Object.create(null), { voluntary: r[10], involuntary: r[11] });
    const user = BigInt(r[0]);
    const system = BigInt(r[1]);
    this.cpuTime = Object.assign(Object.create(null), { user, system, total: user + system });
    this.maxRSS = r[2];
    this.messages = Object.assign(Object.create(null), { sent: r[7], received: r[8] });
    this.ops = Object.assign(Object.create(null), { in: r[5], out: r[6] });
    this.shmSize = r[3];
    this.signalCount = r[9];
    this.swapCount = r[4];
  }
}

/** A spawn's options, read as Bun reads them. */
interface Parsed {
  file: string;
  argv: string[];
  env: object | null;
  path: string | undefined;
  cwd: string | undefined;
  stdio: any[];
  flags: number;
  uid: number | undefined;
  gid: number | undefined;
  options: any;
  // The extra slots that are "socket-fd" (the caller owns them).
  ipcSlot: number;
}

function nullBytes(s: string, what: string): void {
  if (s.indexOf("\0") >= 0) {
    throw invalidArg(`The ${what} must be a string without null bytes. Received ${JSON.stringify(s)}`, "ERR_INVALID_ARG_VALUE");
  }
}

/** A stdio slot's value (Bun's Stdio.extract): what spawnProcess takes, or
 * the slot's default if `value` is undefined. */
function stdioOf(i: number, value: unknown, sync: boolean, current: any): any {
  if (value === undefined) return current;
  if (value === null) return IO_IGNORE;
  if (typeof value === "string") {
    switch (value) {
      case "inherit":
        return IO_INHERIT;
      case "ignore":
        return IO_IGNORE;
      case "pipe":
      case "overlapped":
        return IO_PIPE;
      case "socket-fd":
        if (i < 3) throw invalidArg("stdio: 'socket-fd' is only supported at indices >= 3");
        if (sync) throw invalidArg("stdio: 'socket-fd' cannot be used with spawnSync");
        return IO_SOCKET;
      case "ipc":
        return "ipc";
    }
    throw invalidArg("stdio must be an array of 'inherit', 'pipe', 'ignore', Bun.file(pathOrFd), number, or null");
  }
  if (typeof value === "number") {
    const fd = value | 0;
    if (fd < 0) throw invalidArg("file descriptor must be a positive integer");
    if (fd === 0 && (i === 1 || i === 2)) throw invalidArg("stdin cannot be used for stdout or stderr");
    if ((fd === 1 || fd === 2) && i === 0) throw invalidArg("stdout and stderr cannot be used for stdin");
    return fd === i ? IO_INHERIT : fd;
  }
  if (value instanceof BunFile) return (value as any).name;
  if (value instanceof Blob) {
    if (i === 1 || i === 2) throw invalidArg("Blobs are immutable, and cannot be used for stdout/stderr");
    const bytes = (value as any)._bytes as Uint8Array;
    if (bytes.length === 0) return IO_IGNORE;
    if (i !== 0) throw invalidArg(`Blob cannot be used for stdio[${i}] yet`);
    return bytes;
  }
  if (value instanceof ReadableStream) {
    const name = i === 0 ? "stdin" : i === 1 ? "stdout" : i === 2 ? "stderr" : undefined;
    if (name === undefined) throw invalidArg(`ReadableStream cannot be used for stdio[${i}] yet`);
    if (sync) throw invalidArg(`'${name}' ReadableStream cannot be used in sync mode`);
    if (i !== 0) throw invalidArg(`ReadableStream cannot be used for ${name} yet. For now, do .${name}`);
    return value;
  }
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    if (bytes.length === 0) return IO_IGNORE;
    if (i === 1 || i === 2) throw invalidArg("ArrayBufferView cannot be used for stdout/stderr yet");
    return bytes;
  }
  if (value !== null && typeof value === "object" && typeof (value as any).arrayBuffer === "function" && (value as any).body !== undefined) {
    // A Request or Response: its body.
    const body = (value as any).body;
    if (body === null) return IO_IGNORE;
    return stdioOf(i, body, sync, current);
  }
  throw invalidArg("stdio must be an array of 'inherit', 'ignore', or null");
}

function parse(cmdOrOptions: any, maybeOptions: any, sync: boolean): Parsed {
  let cmd: any;
  let o: any;
  if (Array.isArray(cmdOrOptions)) {
    cmd = cmdOrOptions;
    o = maybeOptions;
  } else if (cmdOrOptions !== null && typeof cmdOrOptions === "object") {
    o = cmdOrOptions;
    cmd = o.cmd;
    if (!cmd) throw invalidArg("cmd must be an array");
  } else {
    throw invalidArg("cmd must be an array");
  }
  if (cmd === undefined || cmd === null || typeof cmd !== "object") throw invalidArg("cmd must be an array of strings");
  const n = cmd.length >>> 0;
  if (n === 0) throw invalidArg("cmd must not be empty");
  if (o === null || typeof o !== "object") o = {};
  const argv: string[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const s = String(cmd[i]);
    nullBytes(s, `argument 'args[${i}]'`);
    argv[i] = s;
  }
  const file = argv[0];
  const argv0 = o.argv0;
  if (argv0) {
    const s = String(argv0);
    nullBytes(s, "property 'options.argv0'");
    if (s.length > 0) argv[0] = s;
  }
  let cwd: string | undefined;
  if (o.cwd) {
    cwd = String(o.cwd);
    nullBytes(cwd, "property 'options.cwd'");
    if (cwd.length === 0) cwd = undefined;
  }
  let env: any = process.env;
  let path: string | undefined;
  const envOption = o.env;
  if (envOption) {
    if (typeof envOption !== "object") throw invalidArg("env must be an object");
    env = envOption;
    for (const k in envOption) {
      const v = envOption[k];
      if (v === undefined) continue;
      nullBytes(k, `property 'options.env['${k}']'`);
      nullBytes(String(v), `property 'options.env['${k}']'`);
    }
    path = envOption.PATH === undefined ? undefined : String(envOption.PATH);
  } else {
    path = env.PATH;
  }
  // The slots: [stdin, stdout, stderr, ...].
  const stdio: any[] = sync ? [IO_IGNORE, IO_PIPE, IO_PIPE] : [IO_IGNORE, IO_PIPE, IO_INHERIT];
  let ipcSlot = -1;
  const s = o.stdio;
  if (s !== undefined && s !== null) {
    if (!Array.isArray(s)) throw invalidArg("stdio must be an array");
    for (let i = 0; i < s.length; i++) {
      const v = stdioOf(i, s[i], sync, i < 3 ? stdio[i] : IO_IGNORE);
      if (v === "ipc") {
        if (i >= 3 && ipcSlot < 0) ipcSlot = i;
        stdio[i] = i < 3 ? IO_IGNORE : IO_SOCKET;
      } else {
        stdio[i] = v;
      }
    }
  } else {
    stdio[0] = stdioOf(0, o.stdin, sync, stdio[0]);
    stdio[2] = stdioOf(2, o.stderr, sync, stdio[2]);
    stdio[1] = stdioOf(1, o.stdout, sync, stdio[1]);
  }
  // (Piping an empty stdin to a child that runs to its end: as ignore.)
  if (sync && stdio[0] === IO_PIPE) stdio[0] = IO_IGNORE;
  let flags = 0;
  if (o.detached === true) flags |= 1;
  let uid: number | undefined;
  let gid: number | undefined;
  if (o.uid !== undefined && o.uid !== null) uid = int32Of(o.uid, "uid");
  if (o.gid !== undefined && o.gid !== null) gid = int32Of(o.gid, "gid");
  return { file, argv, env, path, cwd, stdio, flags, uid, gid, options: o, ipcSlot };
}

function int32Of(v: unknown, name: string): number {
  if (typeof v !== "number") throw invalidArg(`The "${name}" property must be of type number. Received ${typeof v}`);
  if (!Number.isInteger(v) || v < -2147483648 || v > 2147483647) {
    const e = new RangeError(`The value of "${name}" is out of range. It must be an integer. Received ${v}`) as RangeError & { code: string };
    e.code = "ERR_OUT_OF_RANGE";
    throw e;
  }
  return v;
}

function timeoutOf(o: any): number {
  const t = o.timeout;
  if (t === undefined || t === null) return 0;
  if (typeof t === "number") {
    if (Number.isNaN(t)) {
      const e = new RangeError(`The value of "timeout" is out of range. It must be a non-negative integer. Received NaN`) as RangeError & { code: string };
      e.code = "ERR_OUT_OF_RANGE";
      throw e;
    }
    if (t === Infinity) return 0;
    if (t < 0 || !Number.isFinite(t)) {
      const e = new RangeError(`The value of "timeout" is out of range. It must be >= 0. Received ${t}`) as RangeError & { code: string };
      e.code = "ERR_OUT_OF_RANGE";
      throw e;
    }
    return Math.trunc(t) & 0x7fffffff;
  }
  throw invalidArg(`The "timeout" property must be of type number. Received ${typeof t}`);
}

function killSignalOf(o: any): number {
  if (o.killSignal === undefined) return 15;
  const n = signalNumber(o.killSignal);
  if (n === 0) {
    const e = new TypeError("Unknown signal: 0") as TypeError & { code: string };
    e.code = "ERR_UNKNOWN_SIGNAL";
    throw e;
  }
  return n;
}

function maxBufferOf(o: any, stdio: any[]): number {
  const m = o.maxBuffer;
  if (typeof m !== "number" || !Number.isFinite(m) || m <= 0) return 0;
  if (stdio[0] !== IO_PIPE && stdio[1] !== IO_PIPE && stdio[2] !== IO_PIPE) return 0;
  return Math.trunc(m);
}

/** A copy of `env` with the IPC channel's variables. */
function withChannel(env: any, slot: number, mode: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k in env) {
    const v = env[k];
    if (v !== undefined) out[k] = v;
  }
  out.NODE_CHANNEL_FD = String(slot);
  out.NODE_CHANNEL_SERIALIZATION_MODE = mode;
  return out;
}

/** Bun's Subprocess: a child Bun.spawn started. */
export class Subprocess implements Task {
  #pid: number;
  #watch: number;
  #exited = false;
  #code: number | null = null;
  #signal = 0;
  #exitedPromise: Promise<number> | undefined;
  #resolveExited: ((n: number) => void) | undefined;
  #rusage: number[] | undefined;
  #onExit: ((p: Subprocess, code: number | null, signal: string | number | null, err?: any) => void) | undefined;
  #stdinValue: any;
  #stdin: FdWriter | undefined;
  #stdout: PipeReader | undefined;
  #stderr: PipeReader | undefined;
  #stdoutValue: any;
  #stderrValue: any;
  #stdio: (number | null)[];
  #ipc: IpcChannel | undefined;
  #onDisconnect: ((ok: boolean) => void) | undefined;
  #killSignal: number;
  #timer: any;
  #abort: { signal: AbortSignal; listener: () => void } | undefined;
  #gotStdin = false;
  #gotStdout = false;
  #gotStderr = false;
  #refd = true;

  /** (Made by spawn.) */
  constructor(p: Parsed, fds: any[], killSignal: number) {
    this.#watch = fds[0];
    this.#pid = fds[1];
    this.#killSignal = killSignal;
    const o = p.options;
    if (typeof o.onExit === "function") this.#onExit = o.onExit;
    const lazy = o.lazy === true;
    // stdin
    const s0 = p.stdio[0];
    const fd0 = fds[2];
    if (s0 === IO_PIPE) {
      this.#stdin = new FdWriter(fd0);
      this.#stdinValue = new FileSink(this.#stdin);
    } else if (s0 instanceof ReadableStream) {
      this.#stdin = new FdWriter(fd0);
      this.#stdinValue = s0;
      pump(s0, this.#stdin);
    } else if (s0 instanceof Uint8Array) {
      // (Bytes no memfd could hold: written to a pipe.)
      if (fd0 >= 0) {
        this.#stdin = new FdWriter(fd0);
        this.#stdin.push(s0);
        this.#stdin.end();
      }
    } else if (typeof s0 === "number" && s0 >= 0) {
      this.#stdinValue = s0;
    }
    // stdout, stderr
    const maxBuffer = maxBufferOf(o, p.stdio);
    for (let i = 1; i <= 2; i++) {
      const v = p.stdio[i];
      let value: any;
      if (v === IO_PIPE) {
        const r = new PipeReader(fds[i + 2]);
        if (maxBuffer > 0) {
          r.limit = maxBuffer;
          r.onLimit = () => this.#overflow();
        }
        if (!lazy) r.start();
        if (i === 1) this.#stdout = r;
        else this.#stderr = r;
      } else if (typeof v === "number" && v >= 0) {
        value = v;
      }
      if (i === 1) this.#stdoutValue = value;
      else this.#stderrValue = value;
    }
    // The extra slots: the parent's ends of their sockets.
    this.#stdio = [null, null, null];
    for (let i = 3; i < p.stdio.length; i++) {
      const fd = fds[i + 2];
      this.#stdio.push(i === p.ipcSlot || fd < 0 ? null : fd);
    }
    // The IPC channel.
    if (p.ipcSlot >= 0 && typeof o.ipc === "function") {
      const ipc = o.ipc;
      if (typeof o.onDisconnect === "function") this.#onDisconnect = o.onDisconnect;
      this.#ipc = new IpcChannel(
        fds[p.ipcSlot + 2],
        (message) => ipc(message, this, undefined),
        () => {
          const f = this.#onDisconnect;
          this.#onDisconnect = undefined;
          if (f !== undefined) process.nextTick(f, true);
        },
      );
    }
    if (this.#watch !== 0) {
      tasks.set(this.#watch, this);
    } else {
      // (A child whose exit cannot be watched: looked for now and then.)
      const poll = () => {
        const r = spawnReap(this.#pid) as any[] | undefined;
        if (r === undefined) return void (this.#timer = setTimeout(poll, 10));
        this.#timer = undefined;
        this.#exit(r[0], r[1], r[2]);
      };
      this.#timer = setTimeout(poll, 10);
    }
    const timeout = timeoutOf(o);
    if (timeout > 0) {
      this.#timer = setTimeout(() => {
        this.#timer = undefined;
        this.#tryKill(this.#killSignal);
      }, timeout);
    }
    const signal = o.signal;
    if (signal !== undefined && signal !== null) {
      const listener = () => this.#tryKill(this.#killSignal);
      this.#abort = { signal, listener };
      signal.addEventListener("abort", listener, { once: true });
    }
  }

  event(kind: number, a: any, b: any, c: any): void {
    if (kind === EV_EXIT) {
      tasks.delete(this.#watch);
      this.#watch = 0;
      this.#exit(a, b, c);
    }
  }

  #overflow(): void {
    this.#tryKill(this.#killSignal);
  }

  #tryKill(sig: number): void {
    if (this.#exited) return;
    spawnKill(this.#pid, sig);
  }

  #exit(code: number, signal: number, rusage: number[]): void {
    this.#exited = true;
    this.#code = code < 0 ? null : code;
    this.#signal = signal;
    this.#rusage = rusage;
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    if (this.#abort !== undefined) {
      this.#abort.signal.removeEventListener("abort", this.#abort.listener);
      this.#abort = undefined;
    }
    // No more is sent to it.
    if (this.#stdin !== undefined && this.#stdinValue instanceof FileSink) this.#stdin.end();
    const status = signal ? 128 + signal : code;
    const resolve = this.#resolveExited;
    if (resolve !== undefined) {
      this.#resolveExited = undefined;
      resolve(status);
    }
    const onExit = this.#onExit;
    if (onExit !== undefined) {
      this.#onExit = undefined;
      onExit(this, this.#code, signal ? signalName(signal) : null, undefined);
    }
  }

  get pid(): number {
    return this.#pid;
  }

  get stdin(): any {
    this.#gotStdin = true;
    return this.#stdinValue;
  }

  get writable(): any {
    return this.stdin;
  }

  get stdout(): any {
    this.#gotStdout = true;
    const r = this.#stdout;
    return r !== undefined ? r.toStream() : this.#stdoutValue;
  }

  get readable(): any {
    return this.stdout;
  }

  get stderr(): any {
    this.#gotStderr = true;
    const r = this.#stderr;
    return r !== undefined ? r.toStream() : this.#stderrValue;
  }

  get stdio(): (number | null)[] {
    return this.#stdio;
  }

  get terminal(): undefined {
    return undefined;
  }

  get exited(): Promise<number> {
    if (this.#exitedPromise === undefined) {
      if (this.#exited) {
        this.#exitedPromise = Promise.resolve(this.#signal ? 128 + this.#signal : (this.#code as number));
      } else {
        this.#exitedPromise = new Promise((resolve) => (this.#resolveExited = resolve));
      }
    }
    return this.#exitedPromise;
  }

  get exitCode(): number | null {
    return this.#code;
  }

  get signalCode(): string | number | null {
    return this.#signal ? signalName(this.#signal) : null;
  }

  /** Whether it has ended (exited, or been killed). */
  get killed(): boolean {
    return this.#exited;
  }

  kill(signal?: number | string): void {
    const sig = signalNumber(signal === undefined ? this.#killSignal : signal);
    if (this.#exited) return;
    const r = spawnKill(this.#pid, sig) as number;
    if (r < 0 && r !== -ESRCH) throw spawnError(-r, "kill");
  }

  ref(): void {
    this.#refd = true;
    if (this.#watch !== 0) spawnWatchRef(this.#watch, true);
    if (!this.#gotStdin) this.#stdin?.setRef(true);
    if (!this.#gotStdout) this.#stdout?.setRef(true);
    if (!this.#gotStderr) this.#stderr?.setRef(true);
    this.#ipc?.setRef(true);
  }

  unref(): void {
    this.#refd = false;
    if (this.#watch !== 0) spawnWatchRef(this.#watch, false);
    if (!this.#gotStdin) this.#stdin?.setRef(false);
    if (!this.#gotStdout) this.#stdout?.setRef(false);
    if (!this.#gotStderr) this.#stderr?.setRef(false);
    this.#ipc?.setRef(false);
  }

  get connected(): boolean {
    return this.#ipc !== undefined && this.#ipc.connected;
  }

  send(message: unknown, handle?: unknown, options?: unknown, callback?: (err: any) => void): boolean {
    if (typeof handle === "function") {
      callback = handle as any;
      handle = undefined;
    } else if (typeof options === "function") {
      callback = options as any;
      options = undefined;
    }
    let internal = false;
    if (options !== undefined && options !== null) {
      if (typeof options !== "object") throw invalidArg(`The "options" argument must be of type object.`);
      internal = !!(options as any).internal;
    }
    const ipc = this.#ipc;
    if (ipc === undefined || !ipc.connected) {
      const e = new Error(
        this.#exited
          ? "Subprocess.send() cannot be used after the process has exited."
          : "Subprocess.send() can only be used if an IPC channel is open.",
      ) as Error & { code: string };
      e.code = "ERR_IPC_CHANNEL_CLOSED";
      if (typeof callback === "function") {
        process.nextTick(callback, e);
        return false;
      }
      throw e;
    }
    checkMessage(message);
    return ipc.send(message, internal, callback);
  }

  disconnect(): void {
    this.#ipc?.disconnect();
  }

  resourceUsage(): ResourceUsage | undefined {
    return this.#rusage === undefined ? undefined : new ResourceUsage(this.#rusage);
  }

  async [Symbol.asyncDispose](): Promise<void> {
    if (this.#exited) return;
    this.#stdout?.setRef(false);
    this.#stderr?.setRef(false);
    this.kill(this.#killSignal);
    await this.exited;
  }

  get [Symbol.toStringTag](): string {
    return "Subprocess";
  }
}

function checkMessage(message: unknown): void {
  if (message === undefined) {
    const e = new TypeError('The "message" argument must be specified') as TypeError & { code: string };
    e.code = "ERR_MISSING_ARGS";
    throw e;
  }
  const t = typeof message;
  if (t !== "string" && t !== "object" && t !== "number" && t !== "boolean") {
    throw invalidArg(`The "message" argument must be one of type string, object, number, or boolean. Received type ${t}`);
  }
}

/** Writes a stream's chunks to the pipe, then ends it. */
async function pump(stream: ReadableStream<any>, w: FdWriter): Promise<void> {
  const reader = new ReadableStreamDefaultReader<any>(stream);
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done || w.closed) break;
      if (!w.push(bytesOf(value))) await w.drained();
    }
  } catch {
    // (The child gets what was written.)
  }
  w.end();
}

/** Bun.spawn(cmd, options) or Bun.spawn({ cmd, ...options }). */
export function spawn(cmdOrOptions: any, maybeOptions?: any): Subprocess {
  const p = parse(cmdOrOptions, maybeOptions, false);
  const o = p.options;
  if (o.onExit !== undefined && o.onExit !== null && typeof o.onExit !== "function") {
    throw invalidArg("onExit must be a function or undefined");
  }
  if (o.onDisconnect !== undefined && o.onDisconnect !== null && typeof o.onDisconnect !== "function") {
    throw invalidArg("onDisconnect must be a function or undefined");
  }
  const signal = o.signal;
  if (signal !== undefined && signal !== null) {
    if (!(signal instanceof AbortSignal)) throw invalidArg(`The "signal" argument must be an instance of AbortSignal.`);
    if (signal.aborted) {
      const e = new Error("The operation was aborted", { cause: signal.reason }) as Error & { code: string };
      e.name = "AbortError";
      e.code = "ABORT_ERR";
      throw e;
    }
  }
  const killSignal = killSignalOf(o);
  // An IPC channel: a socket in the first "ipc" slot (else one after them all).
  let env = p.env;
  if (typeof o.ipc === "function") {
    const mode = o.serialization === undefined ? "advanced" : String(o.serialization);
    if (mode !== "json" && mode !== "advanced") throw invalidArg('serialization must be "json" or "advanced"');
    if (p.ipcSlot < 0) {
      p.ipcSlot = p.stdio.length;
      p.stdio.push(IO_SOCKET);
    }
    // (Beyond's channel is JSON lines either way.)
    env = withChannel(env, p.ipcSlot, "json");
  }
  init();
  const fds = spawnProcess(p.file, p.argv, env, p.path, p.cwd, p.stdio, p.flags, p.uid, p.gid) as any[];
  return new Subprocess(p, fds, killSignal);
}

// ---- Bun.spawnSync ----

/** Bun.spawnSync(cmd, options) or Bun.spawnSync({ cmd, ...options }): the child run to its end. */
export function spawnSync(cmdOrOptions: any, maybeOptions?: any): any {
  const p = parse(cmdOrOptions, maybeOptions, true);
  const o = p.options;
  const timeout = timeoutOf(o);
  const killSignal = killSignalOf(o);
  const maxBuffer = maxBufferOf(o, p.stdio);
  init();
  const r = nativeSpawnSync(p.file, p.argv, p.env, p.path, p.cwd, p.stdio, p.flags, p.uid, p.gid, timeout, maxBuffer, killSignal) as any[];
  const code: number | null = r[0] < 0 ? null : r[0];
  const sig: number = r[1];
  const result: any = { exitCode: code };
  if (sig) result.signalCode = signalName(sig);
  result.stdout = typeof p.stdio[1] === "number" && p.stdio[1] >= 0 ? p.stdio[1] : r[2];
  result.stderr = typeof p.stdio[2] === "number" && p.stdio[2] >= 0 ? p.stdio[2] : r[3];
  result.success = code === 0;
  result.resourceUsage = new ResourceUsage(r[7]);
  if (timeout > 0) result.exitedDueToTimeout = r[5];
  if (maxBuffer > 0) result.exitedDueToMaxBuffer = r[6];
  result.pid = r[4];
  const onExit = o.onExit;
  if (typeof onExit === "function") onExit(undefined, code, sig ? signalName(sig) : null, undefined);
  return result;
}

// ---- The child's end of an IPC channel (process.send) ----

/** Sets up process.send, process.channel and the like when the parent
 * gave this process an IPC channel (NODE_CHANNEL_FD), as Node does. */
export function setupChildChannel(proc: any): void {
  const env = proc.env;
  const fd = parseInt(env.NODE_CHANNEL_FD, 10);
  delete env.NODE_CHANNEL_FD;
  delete env.NODE_CHANNEL_SERIALIZATION_MODE;
  if (!(fd >= 0)) return;
  const channel = new IpcChannel(
    fd,
    (message, internal) => proc.emit(internal ? "internalMessage" : "message", message, undefined),
    () => {
      proc.connected = false;
      process.nextTick(() => proc.emit("disconnect"));
    },
  );
  // The channel keeps the process alive while it listens for messages
  // (as Node's: a 'message' or 'disconnect' listener refs it).
  let listening = 0;
  channel.setRef(false);
  proc.on("newListener", (name: string) => {
    if ((name === "message" || name === "disconnect") && listening++ === 0) channel.setRef(true);
  });
  proc.on("removeListener", (name: string) => {
    if ((name === "message" || name === "disconnect") && --listening === 0) channel.setRef(false);
  });
  proc.connected = true;
  proc.channel = {
    fd,
    ref(): void {
      channel.setRef(true);
    },
    unref(): void {
      channel.setRef(false);
    },
  };
  proc.send = (message: unknown, handle?: unknown, options?: unknown, callback?: (err: any) => void): boolean => {
    if (typeof handle === "function") {
      callback = handle as any;
      handle = undefined;
    } else if (typeof options === "function") {
      callback = options as any;
      options = undefined;
    }
    let internal = false;
    if (options !== undefined && options !== null) {
      if (typeof options !== "object") throw invalidArg(`The "options" argument must be of type object.`);
      internal = !!(options as any).internal;
    }
    if (!channel.connected) {
      const e = new Error("Channel closed") as Error & { code: string };
      e.code = "ERR_IPC_CHANNEL_CLOSED";
      if (typeof callback === "function") process.nextTick(callback, e);
      else process.nextTick(() => proc.emit("error", e));
      return false;
    }
    checkMessage(message);
    return channel.send(message, internal, callback);
  };
  proc.disconnect = (): void => {
    if (!channel.connected) {
      const e = new Error("IPC channel is already disconnected") as Error & { code: string };
      e.code = "ERR_IPC_DISCONNECTED";
      proc.emit("error", e);
      return;
    }
    channel.disconnect();
  };
}
