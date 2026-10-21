// setTimeout, setInterval and their kin (HTML's timers, with Node's and Bun's
// `Timeout` objects: `ref`, `unref`, `refresh`). The native core keeps the
// deadlines (crates/beyond-rt); the callbacks are kept here.

import { clearTimer, onTimer, refTimer, setTimer } from "beyond:native";
import { describe, Formatter } from "./inspect.ts";

type Callback = (...args: any[]) => void;

interface Entry {
  callback: Callback;
  args: any[];
  repeat: boolean;
  delay: number;
  timer: Timeout | undefined;
}

const entries = new Map<number, Entry>();
let nextId = 1;

onTimer((id: number) => {
  const e = entries.get(id);
  if (e === undefined) return;
  if (!e.repeat) entries.delete(id);
  // (Called on its Timeout, as Node's and Bun's.)
  e.callback.apply(e.timer, e.args);
});

export class Timeout {
  _id: number;
  _ref = true;
  constructor(id: number) {
    this._id = id;
  }
  /** Keep the program alive while the timer is set (the default). */
  ref(): this {
    this._ref = true;
    refTimer(this._id, true);
    return this;
  }
  /** Let the program exit even though the timer is set. */
  unref(): this {
    this._ref = false;
    refTimer(this._id, false);
    return this;
  }
  hasRef(): boolean {
    return this._ref;
  }
  /** Start the delay over. */
  refresh(): this {
    const e = entries.get(this._id);
    if (e !== undefined) setTimer(this._id, e.delay, e.repeat);
    return this;
  }
  close(): this {
    clear(this._id);
    return this;
  }
  [Symbol.toPrimitive](): number {
    return this._id;
  }
  [describe](f: Formatter): void {
    f.write(`Timeout (#${this._id})`);
  }
}

function set(callback: Callback, delay: number, args: any[], repeat: boolean): Timeout {
  if (typeof callback !== "function") {
    throw new TypeError("The callback must be a function");
  }
  const id = nextId++;
  const ms = Number(delay) || 0;
  const timer = new Timeout(id);
  entries.set(id, { callback, args, repeat, delay: ms, timer });
  setTimer(id, ms, repeat);
  return timer;
}

function clear(timer: Timeout | number | undefined | null): void {
  if (timer === undefined || timer === null) return;
  const id = typeof timer === "number" ? timer : Number(timer);
  if (entries.delete(id)) clearTimer(id);
}

export function setTimeout(callback: Callback, delay = 0, ...args: any[]): Timeout {
  return set(callback, delay, args, false);
}

export function setInterval(callback: Callback, delay = 0, ...args: any[]): Timeout {
  return set(callback, delay, args, true);
}

export function clearTimeout(timer: Timeout | number | undefined | null): void {
  clear(timer);
}

export function clearInterval(timer: Timeout | number | undefined | null): void {
  clear(timer);
}

// ---- setImmediate: Node's check phase ----
// Immediates run in turns, after the timers due: each turn runs those set
// before it began (one set by an immediate waits for the next turn). A
// zero-delay timer starts a turn; it keeps the program alive while an
// immediate that is ref'd waits.

export class Immediate {
  _onImmediate: Callback | null;
  _args: any[];
  _ref = true;
  constructor(callback: Callback, args: any[]) {
    this._onImmediate = callback;
    this._args = args;
  }
  ref(): this {
    if (!this._ref && this._onImmediate !== null) {
      this._ref = true;
      refs++;
      keepAlive();
    }
    this._ref = true;
    return this;
  }
  unref(): this {
    if (this._ref && this._onImmediate !== null) {
      this._ref = false;
      refs--;
      keepAlive();
    }
    this._ref = false;
    return this;
  }
  hasRef(): boolean {
    return this._ref;
  }
  [Symbol.dispose](): void {
    clearImmediate(this);
  }
}

let queue: Immediate[] = [];
let turn: Timeout | undefined;
/** How many waiting immediates are ref'd. */
let refs = 0;

function keepAlive(): void {
  if (turn !== undefined) refs > 0 ? turn.ref() : turn.unref();
}

function runImmediates(): void {
  turn = undefined;
  const batch = queue;
  queue = [];
  let i = 0;
  try {
    for (; i < batch.length; i++) {
      const im = batch[i];
      const callback = im._onImmediate;
      if (callback === null) continue;
      im._onImmediate = null;
      if (im._ref) refs--;
      callback(...im._args);
    }
  } finally {
    // (After one that threw: the rest in the next turn, first.)
    if (i < batch.length) {
      queue = batch.slice(i + 1).concat(queue);
      if (queue.length > 0) startTurn();
    }
  }
  if (queue.length > 0 && turn === undefined) startTurn();
}

function startTurn(): void {
  turn = set(runImmediates, 0, [], false);
  keepAlive();
}

/** How Node's errors describe a value they did not take. */
function received(v: unknown): string {
  if (v === undefined || v === null) return String(v);
  if (typeof v === "object") return v.constructor?.name ? `an instance of ${v.constructor.name}` : "[Object: null prototype]";
  let shown = typeof v === "string" ? `'${v.length > 25 ? v.slice(0, 25) + "..." : v}'` : String(v);
  if (typeof v === "bigint") shown += "n";
  return `type ${typeof v} (${shown})`;
}

export function setImmediate(callback: Callback, ...args: any[]): Immediate {
  if (typeof callback !== "function") {
    const e = new TypeError(`The "callback" argument must be of type function. Received ${received(callback)}`) as TypeError & { code: string };
    e.code = "ERR_INVALID_ARG_TYPE";
    throw e;
  }
  const im = new Immediate(callback, args);
  queue.push(im);
  refs++;
  if (turn === undefined) startTurn();
  else keepAlive();
  return im;
}

export function clearImmediate(im: Immediate | undefined | null): void {
  if (!(im instanceof Immediate) || im._onImmediate === null) return;
  im._onImmediate = null;
  if (im._ref) {
    refs--;
    keepAlive();
  }
}
