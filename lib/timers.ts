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
}

const entries = new Map<number, Entry>();
let nextId = 1;

onTimer((id: number) => {
  const e = entries.get(id);
  if (e === undefined) return;
  if (!e.repeat) entries.delete(id);
  e.callback(...e.args);
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
  entries.set(id, { callback, args, repeat, delay: ms });
  setTimer(id, ms, repeat);
  return new Timeout(id);
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
