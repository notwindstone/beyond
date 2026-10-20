// The web's Performance Timeline and User Timing (performance.mark and
// measure, PerformanceObserver), as Bun's WebCore has them: node:perf_hooks
// builds on these globals.

import { now } from "beyond:native";
import { structuredClone } from "./clone.ts";
import { EventTarget } from "./events.ts";
import { setTimeout } from "./timers.ts";

/** (Makes the entries the constructors throw for.) */
const internal = Symbol("internal");

function illegal(): never {
  throw new TypeError("Illegal constructor");
}

export class PerformanceEntry {
  #name: string;
  #entryType: string;
  #startTime: number;
  #duration: number;
  constructor(token?: symbol, name?: string, entryType?: string, startTime?: number, duration?: number) {
    if (token !== internal) illegal();
    this.#name = name!;
    this.#entryType = entryType!;
    this.#startTime = startTime!;
    this.#duration = duration!;
  }
  get name(): string {
    return this.#name;
  }
  get entryType(): string {
    return this.#entryType;
  }
  get startTime(): number {
    return this.#startTime;
  }
  get duration(): number {
    return this.#duration;
  }
  toJSON(): Record<string, unknown> {
    return { name: this.name, entryType: this.entryType, startTime: this.startTime, duration: this.duration };
  }
}

function cloneDetail(detail: unknown): unknown {
  return detail === undefined || detail === null ? null : structuredClone(detail);
}

export class PerformanceMark extends PerformanceEntry {
  #detail: unknown;
  constructor(name: unknown, options?: { startTime?: number; detail?: unknown }) {
    if (arguments.length === 0) throw new TypeError("Failed to construct 'PerformanceMark': 1 argument required, but only 0 present.");
    const startTime = options?.startTime === undefined ? now() : Number(options.startTime);
    if (startTime < 0) throw new TypeError(`'${startTime}' cannot have a negative start time.`);
    super(internal, `${name}`, "mark", startTime, 0);
    this.#detail = cloneDetail(options?.detail);
  }
  get detail(): unknown {
    return this.#detail;
  }
  override toJSON(): Record<string, unknown> {
    return { ...super.toJSON(), detail: this.#detail };
  }
}

export class PerformanceMeasure extends PerformanceEntry {
  #detail: unknown;
  constructor(token?: symbol, name?: string, startTime?: number, duration?: number, detail?: unknown) {
    super(token, name, "measure", startTime, duration);
    this.#detail = detail;
  }
  get detail(): unknown {
    return this.#detail;
  }
  override toJSON(): Record<string, unknown> {
    return { ...super.toJSON(), detail: this.#detail };
  }
}

export class PerformanceResourceTiming extends PerformanceEntry {
  constructor(token?: symbol, name?: string, startTime?: number, duration?: number) {
    super(token, name, "resource", startTime, duration);
  }
}

export class PerformanceObserverEntryList {
  #entries: PerformanceEntry[];
  constructor(token?: symbol, entries?: PerformanceEntry[]) {
    if (token !== internal) illegal();
    this.#entries = entries!;
  }
  getEntries(): PerformanceEntry[] {
    return this.#entries.slice();
  }
  getEntriesByType(type: string): PerformanceEntry[] {
    type = `${type}`;
    return this.#entries.filter((e) => e.entryType === type);
  }
  getEntriesByName(name: string, type?: string): PerformanceEntry[] {
    name = `${name}`;
    return this.#entries.filter((e) => e.name === name && (type === undefined || e.entryType === `${type}`));
  }
}

const supportedEntryTypes = Object.freeze(["mark", "measure", "resource"]);
const observers = new Set<PerformanceObserver>();
/** The timeline's entries (marks, measures and resources). */
const buffer: PerformanceEntry[] = [];

export class PerformanceObserver {
  #callback: (list: PerformanceObserverEntryList, observer: PerformanceObserver) => void;
  #types = new Set<string>();
  #queue: PerformanceEntry[] = [];
  #scheduled = false;
  constructor(callback: (list: PerformanceObserverEntryList, observer: PerformanceObserver) => void) {
    if (typeof callback !== "function") {
      throw new TypeError("Failed to construct 'PerformanceObserver': parameter 1 is not of type 'Function'.");
    }
    this.#callback = callback;
  }
  static get supportedEntryTypes(): readonly string[] {
    return supportedEntryTypes;
  }
  observe(options: { type?: string; entryTypes?: string[]; buffered?: boolean } = {}): void {
    const types = options.entryTypes !== undefined ? [...options.entryTypes].map(String) : options.type !== undefined ? [`${options.type}`] : [];
    if (options.entryTypes !== undefined && options.type !== undefined) {
      throw new TypeError("Failed to execute 'observe' on 'PerformanceObserver': An observe() call must not include both entryTypes and type arguments.");
    }
    if (types.length === 0) {
      throw new TypeError("Failed to execute 'observe' on 'PerformanceObserver': An observe() call must include either entryTypes or type arguments.");
    }
    if (options.entryTypes !== undefined) this.#types.clear();
    for (const t of types) if (supportedEntryTypes.includes(t)) this.#types.add(t);
    if (this.#types.size === 0) return;
    observers.add(this);
    if (options.buffered && options.type !== undefined) {
      for (const e of buffer) if (e.entryType === options.type) this._enqueue(e);
    }
  }
  disconnect(): void {
    observers.delete(this);
    this.#types.clear();
    this.#queue = [];
  }
  takeRecords(): PerformanceEntry[] {
    const records = this.#queue;
    this.#queue = [];
    return records;
  }
  /** (Queues an entry it observes, delivered in a later task.) */
  _enqueue(entry: PerformanceEntry): void {
    if (!this.#types.has(entry.entryType)) return;
    this.#queue.push(entry);
    if (this.#scheduled) return;
    this.#scheduled = true;
    setTimeout(() => {
      this.#scheduled = false;
      const records = this.takeRecords();
      if (records.length > 0) this.#callback(new PerformanceObserverEntryList(internal, records), this);
    }, 0);
  }
}

function record(entry: PerformanceEntry): void {
  buffer.push(entry);
  for (const o of observers) o._enqueue(entry);
}

function markTime(name: unknown, what: string): number {
  if (typeof name === "number") return name;
  const n = `${name}`;
  for (let i = buffer.length - 1; i >= 0; i--) {
    const e = buffer[i];
    if (e.entryType === "mark" && e.name === n) return e.startTime;
  }
  throw new DOMException(`The "${n}" performance mark has not been set${what}`, "SyntaxError");
}

export class Performance extends EventTarget {
  constructor(token?: symbol) {
    if (token !== internal) illegal();
    super();
  }
  get timeOrigin(): number {
    return timeOrigin;
  }
  now(): number {
    return now();
  }
  mark(name: unknown, options?: { startTime?: number; detail?: unknown }): PerformanceMark {
    const mark = new PerformanceMark(name, options);
    record(mark);
    return mark;
  }
  measure(name: unknown, startOrOptions?: unknown, endMark?: unknown): PerformanceMeasure {
    let start: number;
    let end: number;
    let detail: unknown = null;
    if (startOrOptions !== null && typeof startOrOptions === "object") {
      const o = startOrOptions as { start?: unknown; end?: unknown; duration?: number; detail?: unknown };
      if (endMark !== undefined) throw new TypeError("Options must not be given along with an end mark");
      end = o.end !== undefined ? markTime(o.end, "") : o.start !== undefined && o.duration !== undefined ? markTime(o.start, "") + Number(o.duration) : now();
      start = o.start !== undefined ? markTime(o.start, "") : o.duration !== undefined && o.end !== undefined ? end - Number(o.duration) : 0;
      detail = cloneDetail(o.detail);
    } else {
      start = startOrOptions === undefined ? 0 : markTime(startOrOptions, "");
      end = endMark === undefined ? now() : markTime(endMark, "");
    }
    const measure = new PerformanceMeasure(internal, `${name}`, start, end - start, detail);
    record(measure);
    return measure;
  }
  getEntries(): PerformanceEntry[] {
    return buffer.slice();
  }
  getEntriesByName(name: unknown, type?: unknown): PerformanceEntry[] {
    const n = `${name}`;
    return buffer.filter((e) => e.name === n && (type === undefined || e.entryType === `${type}`));
  }
  getEntriesByType(type: unknown): PerformanceEntry[] {
    const t = `${type}`;
    return buffer.filter((e) => e.entryType === t);
  }
  clearMarks(name?: unknown): void {
    clear("mark", name);
  }
  clearMeasures(name?: unknown): void {
    clear("measure", name);
  }
  clearResourceTimings(): void {
    clear("resource", undefined);
  }
  setResourceTimingBufferSize(_size: number): void {}
  toJSON(): Record<string, unknown> {
    return { timeOrigin: this.timeOrigin };
  }
}

function clear(type: string, name: unknown): void {
  const n = name === undefined ? undefined : `${name}`;
  for (let i = buffer.length - 1; i >= 0; i--) {
    const e = buffer[i];
    if (e.entryType === type && (n === undefined || e.name === n)) buffer.splice(i, 1);
  }
}

const timeOrigin = Date.now() - now();

export const performance = new Performance(internal);
