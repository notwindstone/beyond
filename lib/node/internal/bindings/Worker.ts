// Natives of Bun's Worker (node:worker_threads' binding), for one thread:
// MessagePort, MessageChannel and BroadcastChannel deliver their messages
// (structured clones) in later tasks of this thread, as the web's do across
// threads; Beyond does not run Workers yet, so making one throws.

import { setTimeout } from "beyond:timers";

/** The event a message comes in (the web's MessageEvent). */
export class MessageEvent extends Event {
  readonly data: unknown;
  readonly origin: string;
  readonly lastEventId: string;
  readonly source: unknown;
  readonly ports: readonly MessagePort[];
  constructor(type: string, init?: { data?: unknown; origin?: string; lastEventId?: string; source?: unknown; ports?: MessagePort[] } & EventInit) {
    super(type, init);
    this.data = init?.data ?? null;
    this.origin = init?.origin ?? "";
    this.lastEventId = init?.lastEventId ?? "";
    this.source = init?.source ?? null;
    this.ports = Object.freeze([...(init?.ports ?? [])]);
  }
}

const untransferable = new WeakSet<object>();
const uncloneable = new WeakSet<object>();

export class MessagePort extends EventTarget {
  #other: MessagePort | null = null;
  #queue: unknown[] = [];
  #started = false;
  #closed = false;
  #ref = true;
  #scheduled = false;
  #onmessage: ((e: MessageEvent) => unknown) | null = null;
  #onmessageerror: ((e: MessageEvent) => unknown) | null = null;

  /** (Entangles two new ports: MessageChannel's.) */
  static _entangle(a: MessagePort, b: MessagePort): void {
    a.#other = b;
    b.#other = a;
  }

  postMessage(value: unknown, transferOrOptions?: unknown): void {
    if (this.#closed) return;
    const data = structuredClone(value, transferOptions(transferOrOptions));
    const other = this.#other;
    if (other === null || other.#closed) return;
    other.#queue.push(data);
    other.#schedule();
  }

  start(): void {
    if (this.#closed) return;
    this.#started = true;
    this.#schedule();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    const other = this.#other;
    this.#other = null;
    // (A close event on both, in a later task.)
    setTimeout(() => this.dispatchEvent(new Event("close")), 0);
    if (other !== null && !other.#closed) other.close();
  }

  ref(): this {
    this.#ref = true;
    return this;
  }

  unref(): this {
    this.#ref = false;
    return this;
  }

  hasRef(): boolean {
    return this.#ref && !this.#closed;
  }

  get onmessage(): ((e: MessageEvent) => unknown) | null {
    return this.#onmessage;
  }

  set onmessage(f: ((e: MessageEvent) => unknown) | null) {
    if (this.#onmessage !== null) this.removeEventListener("message", this.#onmessage as EventListener);
    this.#onmessage = typeof f === "function" ? f : null;
    if (this.#onmessage !== null) {
      this.addEventListener("message", this.#onmessage as EventListener);
      this.start();
    }
  }

  get onmessageerror(): ((e: MessageEvent) => unknown) | null {
    return this.#onmessageerror;
  }

  set onmessageerror(f: ((e: MessageEvent) => unknown) | null) {
    if (this.#onmessageerror !== null) this.removeEventListener("messageerror", this.#onmessageerror as EventListener);
    this.#onmessageerror = typeof f === "function" ? f : null;
    if (this.#onmessageerror !== null) this.addEventListener("messageerror", this.#onmessageerror as EventListener);
  }

  /** The next queued message, taken now (receiveMessageOnPort). */
  _receive(): { message: unknown } | undefined {
    if (this.#queue.length === 0) return undefined;
    return { message: this.#queue.shift() };
  }

  _active(): boolean {
    return this.#started && !this.#closed;
  }

  #schedule(): void {
    if (this.#scheduled || !this.#started || this.#queue.length === 0) return;
    this.#scheduled = true;
    setTimeout(() => this.#deliver(), 0);
  }

  #deliver(): void {
    this.#scheduled = false;
    // (Those queued now; one posted meanwhile waits for the next task.)
    const n = this.#queue.length;
    for (let i = 0; i < n && this.#started && !this.#closed; i++) {
      const data = this.#queue.shift();
      this.dispatchEvent(new MessageEvent("message", { data }));
    }
    this.#schedule();
  }
}

function transferOptions(transferOrOptions: unknown): StructuredSerializeOptions | undefined {
  const transfer = Array.isArray(transferOrOptions) ? transferOrOptions : (transferOrOptions as { transfer?: unknown[] } | undefined)?.transfer;
  if (transfer === undefined) return undefined;
  for (const t of transfer) {
    if (t !== null && typeof t === "object" && untransferable.has(t)) {
      throw new DOMException("An ArrayBuffer is marked as untransferable", "DataCloneError");
    }
  }
  return { transfer: transfer.filter((t) => !(t instanceof MessagePort)) as Transferable[] };
}

export class MessageChannel {
  readonly port1: MessagePort;
  readonly port2: MessagePort;
  constructor() {
    this.port1 = new MessagePort();
    this.port2 = new MessagePort();
    MessagePort._entangle(this.port1, this.port2);
  }
}

/** The open channels of each name (in this thread). */
const channels = new Map<string, Set<BroadcastChannel>>();

export class BroadcastChannel extends EventTarget {
  readonly #name: string;
  #closed = false;
  #ref = true;
  #onmessage: ((e: MessageEvent) => unknown) | null = null;

  constructor(name: unknown) {
    super();
    if (arguments.length === 0) throw new TypeError("BroadcastChannel requires a name");
    this.#name = `${name}`;
    let set = channels.get(this.#name);
    if (set === undefined) channels.set(this.#name, (set = new Set()));
    set.add(this);
  }

  get name(): string {
    return this.#name;
  }

  postMessage(value: unknown): void {
    if (this.#closed) throw new DOMException("BroadcastChannel is closed.", "InvalidStateError");
    const data = structuredClone(value);
    for (const c of channels.get(this.#name) ?? []) {
      if (c === this) continue;
      setTimeout(() => {
        if (!c.#closed) c.dispatchEvent(new MessageEvent("message", { data: structuredClone(data) }));
      }, 0);
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    channels.get(this.#name)?.delete(this);
  }

  ref(): this {
    this.#ref = true;
    return this;
  }

  unref(): this {
    this.#ref = false;
    return this;
  }

  hasRef(): boolean {
    return this.#ref;
  }

  get onmessage(): ((e: MessageEvent) => unknown) | null {
    return this.#onmessage;
  }

  set onmessage(f: ((e: MessageEvent) => unknown) | null) {
    if (this.#onmessage !== null) this.removeEventListener("message", this.#onmessage as EventListener);
    this.#onmessage = typeof f === "function" ? f : null;
    if (this.#onmessage !== null) this.addEventListener("message", this.#onmessage as EventListener);
  }
}

/** A Worker (Bun's web Worker, which node:worker_threads' wraps). */
class WebWorker extends EventTarget {
  constructor(..._args: unknown[]) {
    super();
    const e = new Error("Beyond does not run Worker threads yet") as Error & { code: string };
    e.code = "ERR_NOT_SUPPORTED";
    throw e;
  }
}

const environmentData = new Map<unknown, unknown>();

/** node:worker_threads' binding, as Bun's createNodeWorkerThreadsBinding
 * makes it (by index). */
export const createNodeWorkerThreadsBinding = [
  /* 0 workerData */ null,
  /* 1 threadId */ 0,
  /* 2 receiveMessageOnPort */ (port: unknown) => {
    if (!(port instanceof MessagePort)) {
      const e = new TypeError('The "port" argument must be a MessagePort instance') as TypeError & { code: string };
      e.code = "ERR_INVALID_ARG_TYPE";
      throw e;
    }
    return port._receive();
  },
  /* 3 environmentData */ environmentData,
  /* 4 threadName */ "main",
  /* 5 isMessagePortActive */ (port: unknown) => port instanceof MessagePort && port._active(),
  /* 6 markAsUntransferable */ (value: unknown) => {
    if (value !== null && (typeof value === "object" || typeof value === "function")) untransferable.add(value);
  },
  /* 7 isMarkedAsUntransferable */ (value: unknown) => value !== null && typeof value === "object" && untransferable.has(value),
  /* 8 markAsUncloneable */ (value: unknown) => {
    if (value !== null && typeof value === "object") uncloneable.add(value);
  },
  /* 9 setEntryEvaluatedHook */ (_hook: () => void) => {},
  /* 10 isNodeWorker */ false,
  /* 11 setParentPort */ (_port: unknown) => {},
  /* 12 setStdioPorts */ (_ports: unknown) => {},
  /* 13 */ MessagePort,
  /* 14 */ MessageChannel,
  /* 15 */ BroadcastChannel,
  /* 16 */ WebWorker,
];

/** A worker's postMessage to its parent: there is no parent here. */
export function jsFunctionPostMessage(_value: unknown): void {}
