// node:events: Node's EventEmitter (and the web's Event classes Beyond has).

import { CustomEvent, Event, EventTarget } from "../events.ts";

type Listener = (...args: any[]) => void;

const kOnce = Symbol("once");

export class EventEmitter {
  static defaultMaxListeners = 10;
  static captureRejections = false;
  #events = new Map<string | symbol, Listener[]>();
  #max = EventEmitter.defaultMaxListeners;

  #add(name: string | symbol, listener: Listener, prepend: boolean): this {
    if (typeof listener !== "function") {
      const e = new TypeError(`The "listener" argument must be of type function. Received ${typeof listener}`);
      (e as any).code = "ERR_INVALID_ARG_TYPE";
      throw e;
    }
    if (this.#events.has("newListener")) this.emit("newListener", name, (listener as any)[kOnce] ?? listener);
    const list = this.#events.get(name);
    if (list === undefined) this.#events.set(name, [listener]);
    else if (prepend) list.unshift(listener);
    else list.push(listener);
    return this;
  }

  on(name: string | symbol, listener: Listener): this {
    return this.#add(name, listener, false);
  }

  addListener(name: string | symbol, listener: Listener): this {
    return this.#add(name, listener, false);
  }

  prependListener(name: string | symbol, listener: Listener): this {
    return this.#add(name, listener, true);
  }

  #wrapOnce(name: string | symbol, listener: Listener): Listener {
    const self = this;
    const wrapped = function (this: unknown, ...args: any[]) {
      self.removeListener(name, wrapped);
      return listener.apply(this, args);
    };
    (wrapped as any)[kOnce] = listener;
    return wrapped;
  }

  once(name: string | symbol, listener: Listener): this {
    return this.#add(name, this.#wrapOnce(name, listener), false);
  }

  prependOnceListener(name: string | symbol, listener: Listener): this {
    return this.#add(name, this.#wrapOnce(name, listener), true);
  }

  removeListener(name: string | symbol, listener: Listener): this {
    const list = this.#events.get(name);
    if (list === undefined) return this;
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i] === listener || (list[i] as any)[kOnce] === listener) {
        list.splice(i, 1);
        if (list.length === 0) this.#events.delete(name);
        if (this.#events.has("removeListener")) this.emit("removeListener", name, listener);
        break;
      }
    }
    return this;
  }

  off(name: string | symbol, listener: Listener): this {
    return this.removeListener(name, listener);
  }

  removeAllListeners(name?: string | symbol): this {
    if (name === undefined) this.#events.clear();
    else this.#events.delete(name);
    return this;
  }

  emit(name: string | symbol, ...args: any[]): boolean {
    const list = this.#events.get(name);
    if (list === undefined || list.length === 0) {
      if (name === "error") {
        const err = args[0];
        if (err instanceof Error) throw err;
        const e = new Error(`Unhandled error. (${String(err)})`);
        (e as any).code = "ERR_UNHANDLED_ERROR";
        (e as any).context = err;
        throw e;
      }
      return false;
    }
    for (const l of list.slice()) l.apply(this, args);
    return true;
  }

  listeners(name: string | symbol): Listener[] {
    return (this.#events.get(name) ?? []).map((l) => (l as any)[kOnce] ?? l);
  }

  rawListeners(name: string | symbol): Listener[] {
    return (this.#events.get(name) ?? []).slice();
  }

  listenerCount(name: string | symbol): number {
    return this.#events.get(name)?.length ?? 0;
  }

  eventNames(): (string | symbol)[] {
    return [...this.#events.keys()];
  }

  setMaxListeners(n: number): this {
    this.#max = n;
    return this;
  }

  getMaxListeners(): number {
    return this.#max;
  }
}

/** A promise of the next `name` event's arguments. */
export function once(emitter: EventEmitter, name: string | symbol): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const onError = (e: unknown) => {
      emitter.removeListener(name, onEvent);
      reject(e);
    };
    const onEvent = (...args: any[]) => {
      if (name !== "error") emitter.removeListener("error", onError);
      resolve(args);
    };
    emitter.once(name, onEvent);
    if (name !== "error") emitter.once("error", onError);
  });
}

export const defaultMaxListeners = 10;
(EventEmitter as any).EventEmitter = EventEmitter;
(EventEmitter as any).once = once;
export { CustomEvent, Event, EventTarget };
export default EventEmitter;
