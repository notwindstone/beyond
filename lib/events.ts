// Event, CustomEvent and EventTarget, AbortController and AbortSignal (the
// DOM standard's, without a tree: an event reaches only its target), and
// reportError.

import { now, reportError as nativeReportError } from "beyond:native";
import { describe, Formatter } from "./inspect.ts";
import { setTimeout } from "./timers.ts";

const NONE = 0;
const CAPTURING_PHASE = 1;
const AT_TARGET = 2;
const BUBBLING_PHASE = 3;

/**
 * Reports an error as uncaught (an error a listener threw, and the dispatch
 * goes on): printed, and the program exits with 1 after the current task,
 * as Bun's does.
 */
export function reportError(e: unknown): void {
  nativeReportError(e);
}

export interface EventInit {
  bubbles?: boolean;
  cancelable?: boolean;
  composed?: boolean;
}

export class Event {
  _type: string;
  _bubbles: boolean;
  _cancelable: boolean;
  _composed: boolean;
  _target: EventTarget | null = null;
  _currentTarget: EventTarget | null = null;
  _phase = NONE;
  _canceled = false;
  _stop = false;
  _stopImmediate = false;
  _passive = false;
  _dispatching = false;
  _timeStamp: number;

  constructor(type: string, init?: EventInit) {
    this._type = String(type);
    const i = init === undefined || init === null ? null : init;
    this._bubbles = i !== null && Boolean(i.bubbles);
    this._cancelable = i !== null && Boolean(i.cancelable);
    this._composed = i !== null && Boolean(i.composed);
    this._timeStamp = now();
  }

  get type(): string {
    return this._type;
  }
  get target(): EventTarget | null {
    return this._target;
  }
  get srcElement(): EventTarget | null {
    return this._target;
  }
  get currentTarget(): EventTarget | null {
    return this._currentTarget;
  }
  get eventPhase(): number {
    return this._phase;
  }
  get bubbles(): boolean {
    return this._bubbles;
  }
  get cancelable(): boolean {
    return this._cancelable;
  }
  get composed(): boolean {
    return this._composed;
  }
  get defaultPrevented(): boolean {
    return this._canceled;
  }
  get isTrusted(): boolean {
    return false;
  }
  get timeStamp(): number {
    return this._timeStamp;
  }
  get returnValue(): boolean {
    return !this._canceled;
  }
  set returnValue(value: boolean) {
    if (!value) this.preventDefault();
  }
  get cancelBubble(): boolean {
    return this._stop;
  }
  set cancelBubble(value: boolean) {
    if (value) this._stop = true;
  }

  preventDefault(): void {
    if (this._cancelable && !this._passive) this._canceled = true;
  }

  stopPropagation(): void {
    this._stop = true;
  }

  stopImmediatePropagation(): void {
    this._stop = true;
    this._stopImmediate = true;
  }

  composedPath(): EventTarget[] {
    return this._dispatching && this._currentTarget !== null ? [this._currentTarget] : [];
  }

  initEvent(type: string, bubbles = false, cancelable = false): void {
    if (this._dispatching) return;
    this._type = String(type);
    this._bubbles = Boolean(bubbles);
    this._cancelable = Boolean(cancelable);
    this._canceled = false;
    this._stop = false;
    this._stopImmediate = false;
    this._target = null;
  }

  static readonly NONE = NONE;
  static readonly CAPTURING_PHASE = CAPTURING_PHASE;
  static readonly AT_TARGET = AT_TARGET;
  static readonly BUBBLING_PHASE = BUBBLING_PHASE;

  get [Symbol.toStringTag](): string {
    return "Event";
  }

  [describe](f: Formatter): void {
    const p = Event.prototype;
    f.record(this.constructor.name, [
      ["isTrusted", this.isTrusted],
      ["type", this._type],
      ["target", this._target],
      ["currentTarget", this._currentTarget],
      ["eventPhase", this._phase],
      ["cancelBubble", this._stop],
      ["bubbles", this._bubbles],
      ["cancelable", this._cancelable],
      ["defaultPrevented", this._canceled],
      ["composed", this._composed],
      ["timeStamp", this._timeStamp],
      ["srcElement", this._target],
      ["returnValue", !this._canceled],
      ["composedPath", p.composedPath],
      ["stopPropagation", p.stopPropagation],
      ["stopImmediatePropagation", p.stopImmediatePropagation],
      ["preventDefault", p.preventDefault],
      ["initEvent", p.initEvent],
      ["NONE", NONE],
      ["CAPTURING_PHASE", CAPTURING_PHASE],
      ["AT_TARGET", AT_TARGET],
      ["BUBBLING_PHASE", BUBBLING_PHASE],
    ]);
  }
}

for (const [k, v] of [["NONE", NONE], ["CAPTURING_PHASE", CAPTURING_PHASE], ["AT_TARGET", AT_TARGET], ["BUBBLING_PHASE", BUBBLING_PHASE]] as const) {
  Object.defineProperty(Event.prototype, k, { value: v, enumerable: true });
}

export interface CustomEventInit<T = any> extends EventInit {
  detail?: T;
}

export class CustomEvent<T = any> extends Event {
  _detail: T | null;

  constructor(type: string, init?: CustomEventInit<T>) {
    super(type, init);
    this._detail = init === undefined || init === null || init.detail === undefined ? null : init.detail;
  }

  get detail(): T | null {
    return this._detail;
  }

  initCustomEvent(type: string, bubbles = false, cancelable = false, detail: T | null = null): void {
    if (this._dispatching) return;
    this.initEvent(type, bubbles, cancelable);
    this._detail = detail;
  }

  get [Symbol.toStringTag](): string {
    return "CustomEvent";
  }
}

export type EventListener = (event: Event) => void;
export interface EventListenerObject {
  handleEvent(event: Event): void;
}
export type EventListenerOrEventListenerObject = EventListener | EventListenerObject;

export interface EventListenerOptions {
  capture?: boolean;
}

export interface AddEventListenerOptions extends EventListenerOptions {
  once?: boolean;
  passive?: boolean;
  signal?: AbortSignal;
}

interface Listener {
  callback: EventListenerOrEventListenerObject;
  capture: boolean;
  once: boolean;
  passive: boolean;
  removed: boolean;
}

function captureOf(options: boolean | EventListenerOptions | undefined | null): boolean {
  if (typeof options === "boolean") return options;
  return options !== undefined && options !== null && Boolean(options.capture);
}

export class EventTarget {
  // Listeners by event type, in the order they were added (made when the
  // first is added).
  _listeners: Map<string, Listener[]> | null = null;

  addEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ): void {
    if (callback === null || callback === undefined) return;
    const capture = captureOf(options);
    let once = false;
    let passive = false;
    let signal: AbortSignal | undefined = undefined;
    if (typeof options === "object" && options !== null) {
      once = Boolean(options.once);
      passive = Boolean(options.passive);
      signal = options.signal;
      if (signal !== undefined && !(signal instanceof AbortSignal)) {
        throw new TypeError("The \"signal\" option must be an AbortSignal");
      }
      if (signal !== undefined && signal._aborted) return;
    }
    const t = String(type);
    if (this._listeners === null) this._listeners = new Map();
    let list = this._listeners.get(t);
    if (list === undefined) {
      list = [];
      this._listeners.set(t, list);
    }
    for (const l of list) if (l.callback === callback && l.capture === capture) return;
    list.push({ callback, capture, once, passive, removed: false });
    if (signal !== undefined) signal._onAbort(() => this.removeEventListener(t, callback, capture));
  }

  removeEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions,
  ): void {
    if (this._listeners === null || callback === null || callback === undefined) return;
    const list = this._listeners.get(String(type));
    if (list === undefined) return;
    const capture = captureOf(options);
    for (let i = 0; i < list.length; i++) {
      const l = list[i];
      if (l.callback === callback && l.capture === capture) {
        l.removed = true;
        list.splice(i, 1);
        return;
      }
    }
  }

  /** Runs the listeners for `event`; false if one canceled it. */
  dispatchEvent(event: Event): boolean {
    if (!(event instanceof Event)) throw new TypeError("The \"event\" argument must be an instance of Event");
    if (event._dispatching) throw new DOMException("The event is already being dispatched.", "InvalidStateError");
    event._dispatching = true;
    event._target = this;
    event._currentTarget = this;
    event._phase = AT_TARGET;
    const list = this._listeners === null ? undefined : this._listeners.get(event._type);
    if (list !== undefined && list.length > 0) {
      // Capturing listeners, then the others (as at the target of a tree).
      const snapshot = list.slice();
      invoke(this, event, list, snapshot, true);
      if (!event._stop) invoke(this, event, list, snapshot, false);
    }
    event._dispatching = false;
    event._phase = NONE;
    event._currentTarget = null;
    event._stop = false;
    event._stopImmediate = false;
    return !event._canceled;
  }

  get [Symbol.toStringTag](): string {
    return "EventTarget";
  }

  [describe](f: Formatter): void {
    const p = EventTarget.prototype;
    f.record(this.constructor.name, [
      ["addEventListener", p.addEventListener],
      ["removeEventListener", p.removeEventListener],
      ["dispatchEvent", p.dispatchEvent],
    ]);
  }
}

function invoke(target: EventTarget, event: Event, list: Listener[], snapshot: Listener[], capture: boolean): void {
  for (const l of snapshot) {
    if (l.removed || l.capture !== capture) continue;
    if (l.once) {
      l.removed = true;
      const i = list.indexOf(l);
      if (i >= 0) list.splice(i, 1);
    }
    event._passive = l.passive;
    try {
      const cb = l.callback as any;
      if (typeof cb === "function") {
        cb.call(target, event);
      } else {
        const handle = cb.handleEvent;
        if (typeof handle !== "function") throw new TypeError("The listener's handleEvent is not a function");
        handle.call(cb, event);
      }
    } catch (e) {
      reportError(e);
    }
    event._passive = false;
    if (event._stopImmediate) return;
  }
}

// AbortSignal's constructor is not for programs (`new AbortSignal()` throws).
const KEY = Symbol("AbortSignal");

function abortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}

export class AbortSignal extends EventTarget {
  _aborted = false;
  _reason: any = undefined;
  // What runs when it aborts, before the `abort` event (listeners added
  // with this signal are removed).
  _algorithms: (() => void)[] | null = null;
  // The signals of AbortSignal.any() that follow this one.
  _dependents: WeakRef<AbortSignal>[] | null = null;
  _handler: ((this: AbortSignal, event: Event) => any) | null = null;
  _handlerAdded = false;

  constructor(key?: symbol) {
    super();
    if (key !== KEY) throw new TypeError("Illegal constructor");
  }

  get aborted(): boolean {
    return this._aborted;
  }

  get reason(): any {
    return this._reason;
  }

  throwIfAborted(): void {
    if (this._aborted) throw this._reason;
  }

  get onabort(): ((this: AbortSignal, event: Event) => any) | null {
    return this._handler;
  }

  set onabort(handler: ((this: AbortSignal, event: Event) => any) | null) {
    this._handler = typeof handler === "function" || (typeof handler === "object" && handler !== null) ? handler : null;
    if (this._handler !== null && !this._handlerAdded) {
      // The handler's place among the listeners is where it was first set.
      this._handlerAdded = true;
      this.addEventListener("abort", (event: Event) => {
        const h = this._handler;
        if (typeof h === "function") h.call(this, event);
      });
    }
  }

  _onAbort(algorithm: () => void): void {
    if (this._algorithms === null) this._algorithms = [];
    this._algorithms.push(algorithm);
  }

  static abort(reason?: any): AbortSignal {
    const s = new AbortSignal(KEY);
    s._aborted = true;
    s._reason = reason === undefined ? abortError() : reason;
    return s;
  }

  /** A signal that aborts after `ms` milliseconds (without keeping the program alive). */
  static timeout(ms: number): AbortSignal {
    const n = Number(ms);
    if (!Number.isFinite(n) || n < 0 || n > Number.MAX_SAFE_INTEGER) {
      throw new TypeError(`The "milliseconds" argument must be a non-negative integer (got ${ms})`);
    }
    const s = new AbortSignal(KEY);
    setTimeout(() => signalAbort(s, new DOMException("The operation timed out.", "TimeoutError")), Math.trunc(n)).unref();
    return s;
  }

  /** A signal that aborts when any of `signals` does. */
  static any(signals: Iterable<AbortSignal>): AbortSignal {
    const s = new AbortSignal(KEY);
    const all = Array.from(signals);
    for (const x of all) {
      if (!(x instanceof AbortSignal)) throw new TypeError("AbortSignal.any expects AbortSignals");
      if (x._aborted) {
        s._aborted = true;
        s._reason = x._reason;
        return s;
      }
    }
    for (const x of all) {
      if (x._dependents === null) x._dependents = [];
      x._dependents.push(new WeakRef(s));
    }
    return s;
  }

  get [Symbol.toStringTag](): string {
    return "AbortSignal";
  }

  [describe](f: Formatter): void {
    const p = AbortSignal.prototype;
    const t = EventTarget.prototype;
    f.record("AbortSignal", [
      ["aborted", this._aborted],
      ["reason", this._reason],
      ["onabort", this._handler],
      ["throwIfAborted", p.throwIfAborted],
      ["addEventListener", t.addEventListener],
      ["removeEventListener", t.removeEventListener],
      ["dispatchEvent", t.dispatchEvent],
    ]);
  }
}

function signalAbort(s: AbortSignal, reason: any): void {
  if (s._aborted) return;
  s._aborted = true;
  s._reason = reason;
  // The signals that follow this one abort with it, after it.
  const follow: AbortSignal[] = [];
  if (s._dependents !== null) {
    for (const r of s._dependents) {
      const d = r.deref();
      if (d !== undefined && !d._aborted) {
        d._aborted = true;
        d._reason = reason;
        follow.push(d);
      }
    }
    s._dependents = null;
  }
  runAbortSteps(s);
  for (const d of follow) runAbortSteps(d);
}

function runAbortSteps(s: AbortSignal): void {
  const algorithms = s._algorithms;
  s._algorithms = null;
  if (algorithms !== null) for (const a of algorithms) a();
  s.dispatchEvent(new Event("abort"));
}

export class AbortController {
  _signal: AbortSignal = new AbortSignal(KEY);

  get signal(): AbortSignal {
    return this._signal;
  }

  abort(reason?: any): void {
    signalAbort(this._signal, reason === undefined ? abortError() : reason);
  }

  get [Symbol.toStringTag](): string {
    return "AbortController";
  }

  [describe](f: Formatter): void {
    f.record("AbortController", [
      ["signal", this._signal],
      ["abort", AbortController.prototype.abort],
    ]);
  }
}
