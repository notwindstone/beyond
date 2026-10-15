// Streams (the WHATWG Streams standard): ReadableStream, WritableStream,
// TransformStream, their readers, writers and controllers, and the
// queuing strategies. The standard's abstract operations, written as
// functions of the same names (without the prefixes).

/* eslint-disable @typescript-eslint/no-explicit-any */

import { decodeUtf8, encodeUtf8, promiseResult, promiseState } from "beyond:native";
import { AbortController, AbortSignal } from "./events.ts";
import { inspectCustom } from "./inspect.ts";

const noop = (): void => {};

// Promises are reacted to with the original `then` (a program's own
// Promise.prototype.then is not called), and made as Web IDL makes them: a
// new promise resolved with the value (a promise's state is adopted a
// couple of microtasks later, as the standard's algorithms expect).
const promiseThen = Promise.prototype.then;

function upon<T, U = any>(p: Promise<T>, onFulfilled?: ((v: T) => U | PromiseLike<U>) | undefined, onRejected?: (e: any) => U | PromiseLike<U>): Promise<U> {
  return promiseThen.call(p, onFulfilled, onRejected) as Promise<U>;
}

function resolved<T>(v?: T): Promise<T> {
  return new Promise<T>((r) => r(v as T));
}

/** Calls `f` with `thisArg` and `args` (not through `f.call`, which a program may replace). */
const apply = Reflect.apply;

function rejected<T = never>(e: unknown): Promise<T> {
  return Promise.reject(e);
}

/** Marks a promise as handled (no unhandled-rejection report). */
function handled(p: Promise<unknown>): void {
  upon(p, undefined, noop);
}

/** A promise with its resolving functions, and whether it has settled. */
interface Deferred<T> {
  promise: Promise<T>;
  pending: boolean;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let res!: (v: T) => void;
  let rej!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    res = a;
    rej = b;
  });
  const d: Deferred<T> = {
    promise,
    pending: true,
    resolve: (v: T) => {
      d.pending = false;
      res(v);
    },
    reject: (e: unknown) => {
      d.pending = false;
      rej(e);
    },
  };
  return d;
}

/** A deferred rejected with `e` (marked handled). */
function rejectedDeferred<T>(e: unknown): Deferred<T> {
  const d = deferred<T>();
  d.reject(e);
  handled(d.promise);
  return d;
}

/** A promise of all of `ps` (Promise.all, without calling their `then`). */
function all(ps: Promise<unknown>[]): Promise<void> {
  const d = deferred<void>();
  let left = ps.length;
  if (left === 0) d.resolve();
  for (const p of ps) {
    upon(
      p,
      () => {
        if (--left === 0) d.resolve();
      },
      (e) => d.reject(e),
    );
  }
  return d.promise;
}

/** Calls `f`, a promise of its result (rejected if it throws). */
function promiseCall(f: () => any): Promise<any> {
  try {
    return resolved(f());
  } catch (e) {
    return rejected(e);
  }
}

// ---- Queues with sizes ----

interface Sized {
  value: any;
  size: number;
}

interface Queued {
  _queue: Sized[];
  _queueTotalSize: number;
}

function enqueueValueWithSize(c: Queued, value: any, size: number): void {
  if (typeof size !== "number" || Number.isNaN(size) || size < 0 || size === Infinity) {
    throw new RangeError("The chunk size must be a finite, non-negative number");
  }
  c._queue.push({ value, size });
  c._queueTotalSize += size;
}

function dequeueValue(c: Queued): any {
  const pair = c._queue.shift() as Sized;
  c._queueTotalSize -= pair.size;
  if (c._queueTotalSize < 0) c._queueTotalSize = 0;
  return pair.value;
}

function peekQueueValue(c: Queued): any {
  return c._queue[0].value;
}

function resetQueue(c: Queued): void {
  c._queue = [];
  c._queueTotalSize = 0;
}

// ---- Strategies ----

export interface QueuingStrategy<T = any> {
  highWaterMark?: number;
  size?: (chunk: T) => number;
}

/** A queuing strategy as Web IDL converts one (before the constructor's own steps). */
interface Strategy {
  hwm: number | undefined;
  size: ((chunk: any) => number) | undefined;
}

function readStrategy(strategy: QueuingStrategy | null | undefined): Strategy {
  if (strategy === undefined || strategy === null) return { hwm: undefined, size: undefined };
  if (!isObject(strategy)) throw new TypeError("The strategy must be an object");
  const hwm = strategy.highWaterMark;
  const n = hwm === undefined ? undefined : Number(hwm);
  const size = strategy.size;
  if (size !== undefined && typeof size !== "function") throw new TypeError("The strategy's size must be a function");
  return { hwm: n, size };
}

function extractHighWaterMark(strategy: Strategy, defaultHWM: number): number {
  const n = strategy.hwm;
  if (n === undefined) return defaultHWM;
  if (Number.isNaN(n) || n < 0) throw new RangeError("The highWaterMark must be a non-negative number");
  return n;
}

function extractSizeAlgorithm(strategy: Strategy): (chunk: any) => number {
  const size = strategy.size;
  if (size === undefined) return () => 1;
  return (chunk) => apply(size, undefined, [chunk]);
}

/** A callback member of a dictionary (a function, or undefined). */
function callback(d: any, name: string): ((...args: any[]) => any) | undefined {
  const f = d[name];
  if (f !== undefined && typeof f !== "function") throw new TypeError(`${name} must be a function`);
  return f;
}

export class ByteLengthQueuingStrategy {
  _highWaterMark: number;
  constructor(init: { highWaterMark: number }) {
    if (init === undefined || init === null || init.highWaterMark === undefined) {
      throw new TypeError("ByteLengthQueuingStrategy needs a highWaterMark");
    }
    this._highWaterMark = Number(init.highWaterMark);
  }
  get highWaterMark(): number {
    return this._highWaterMark;
  }
  get size(): (chunk: ArrayBufferView) => number {
    return byteLengthSize;
  }
}

// (Methods: not constructors, as the standard's size functions.)
const byteLengthSize = {
  size(chunk: ArrayBufferView): number {
    return chunk.byteLength;
  },
}.size;

export class CountQueuingStrategy {
  _highWaterMark: number;
  constructor(init: { highWaterMark: number }) {
    if (init === undefined || init === null || init.highWaterMark === undefined) {
      throw new TypeError("CountQueuingStrategy needs a highWaterMark");
    }
    this._highWaterMark = Number(init.highWaterMark);
  }
  get highWaterMark(): number {
    return this._highWaterMark;
  }
  get size(): () => number {
    return countSize;
  }
}

const countSize = {
  size(): number {
    return 1;
  },
}.size;

// ---- ReadableStream ----

export interface UnderlyingSource<R = any> {
  start?: (controller: ReadableStreamDefaultController<R>) => any;
  pull?: (controller: ReadableStreamDefaultController<R>) => any;
  cancel?: (reason?: any) => any;
  type?: "bytes" | undefined;
  autoAllocateChunkSize?: number;
}

interface ReadRequest {
  chunk(v: any): void;
  close(): void;
  error(e: any): void;
}

// What makes a Blob of bytes (blob.ts, which depends on this module).
let blobMaker: ((bytes: Uint8Array) => any) | null = null;

export function setBlobMaker(f: (bytes: Uint8Array) => any): void {
  blobMaker = f;
}

// (Only ReadableStream's own code makes its controllers and readers.)
const KEY = Symbol("streams");

/** Whether `x` is a ReadableStream (made by its constructor, or the implementation). */
function isReadableStream(x: any): x is ReadableStream<any> {
  return x instanceof ReadableStream && x._controller !== undefined;
}

function isWritableStream(x: any): x is WritableStream<any> {
  return x instanceof WritableStream && x._controller !== undefined;
}

function isAbortSignal(x: any): x is AbortSignal {
  return x instanceof AbortSignal && typeof x._aborted === "boolean";
}

function illegalInvocation(): TypeError {
  return new TypeError("Illegal invocation");
}

export class ReadableStream<R = any> {
  _state: "readable" | "closed" | "errored" = "readable";
  _reader: ReadableStreamDefaultReader<R> | ReadableStreamBYOBReader | undefined = undefined;
  _storedError: any = undefined;
  _disturbed = false;
  _controller!: ReadableStreamDefaultController<R> | ReadableByteStreamController;

  constructor(underlyingSource?: UnderlyingSource<R> | null, strategy?: QueuingStrategy<R>) {
    if (underlyingSource !== undefined && !isObject(underlyingSource)) throw new TypeError("The underlying source must be an object");
    const s = readStrategy(strategy);
    // (The source's members, alphabetically.)
    const source = underlyingSource === undefined ? {} : (underlyingSource as UnderlyingSource<R>);
    const autoAllocate = (source as any).autoAllocateChunkSize;
    const cancel = callback(source, "cancel");
    const pull = callback(source, "pull");
    const start = callback(source, "start");
    const rawType = (source as any).type;
    const type = rawType === undefined ? undefined : String(rawType);
    if (type !== undefined && type !== "bytes") throw new TypeError(`Invalid stream type "${type}"`);
    // (Byte streams: chunks are views of bytes, read with a default reader.)
    if (type === "bytes" && s.size !== undefined) throw new RangeError("A byte stream's strategy cannot have a size");
    if (type === "bytes" && autoAllocate !== undefined && enforceRange(autoAllocate) === 0) {
      throw new TypeError("autoAllocateChunkSize must be positive");
    }
    const hwm = extractHighWaterMark(s, type === "bytes" ? 0 : 1);
    if (type === "bytes") {
      const bc = new ReadableByteStreamController(KEY);
      setUpByteController(
        this,
        bc,
        () => (start !== undefined ? apply(start, source, [bc]) : undefined),
        () => (pull !== undefined ? promiseCall(() => apply(pull, source, [bc])) : resolved()),
        (reason) => (cancel !== undefined ? promiseCall(() => apply(cancel, source, [reason])) : resolved()),
        hwm,
        autoAllocate === undefined ? undefined : enforceRange(autoAllocate),
      );
      return;
    }
    const size = extractSizeAlgorithm(s);
    const controller = new ReadableStreamDefaultController<R>(KEY);
    setUpDefaultController(
      this,
      controller,
      () => (start !== undefined ? apply(start, source, [controller]) : undefined),
      () => (pull !== undefined ? promiseCall(() => apply(pull, source, [controller])) : resolved()),
      (reason) => (cancel !== undefined ? promiseCall(() => apply(cancel, source, [reason])) : resolved()),
      hwm,
      size,
    );
  }

  get locked(): boolean {
    if (!isReadableStream(this)) throw illegalInvocation();
    return this._reader !== undefined;
  }

  cancel(reason?: any): Promise<void> {
    if (!isReadableStream(this)) return rejected(illegalInvocation());
    if (this._reader !== undefined) return rejected(new TypeError("Cannot cancel a locked stream"));
    return readableStreamCancel(this, reason);
  }

  getReader(options?: { mode?: "byob" }): ReadableStreamDefaultReader<R> | ReadableStreamBYOBReader {
    if (!isReadableStream(this)) throw illegalInvocation();
    if (options !== undefined && options !== null && !isObject(options)) throw new TypeError("The options must be an object");
    const mode = options === undefined || options === null ? undefined : options.mode;
    if (mode !== undefined) {
      if (String(mode) !== "byob") throw new TypeError(`Invalid reader mode "${mode}"`);
      return new ReadableStreamBYOBReader(this);
    }
    return new ReadableStreamDefaultReader<R>(this);
  }

  pipeThrough<T>(transform: { writable: WritableStream<R>; readable: ReadableStream<T> }, options?: StreamPipeOptions): ReadableStream<T> {
    if (!isReadableStream(this)) throw illegalInvocation();
    // (The arguments as the standard's IDL converts them: in order, each
    // dictionary's members alphabetically.)
    if (transform === undefined || transform === null || (typeof transform !== "object" && typeof transform !== "function")) {
      throw new TypeError("pipeThrough needs a { readable, writable } pair");
    }
    const readable = transform.readable;
    if (!isReadableStream(readable)) throw new TypeError("The pair's readable must be a ReadableStream");
    const writable = transform.writable;
    if (!isWritableStream(writable)) throw new TypeError("The pair's writable must be a WritableStream");
    const o = pipeOptions(options);
    if (this._reader !== undefined) throw new TypeError("Cannot pipe a locked stream");
    if (writable._writer !== undefined) throw new TypeError("Cannot pipe to a locked stream");
    handled(readableStreamPipeTo(this, writable, o));
    return readable;
  }

  pipeTo(destination: WritableStream<R>, options?: StreamPipeOptions): Promise<void> {
    if (!isReadableStream(this)) return rejected(illegalInvocation());
    if (!isWritableStream(destination)) return rejected(new TypeError("pipeTo needs a WritableStream"));
    let o: PipeOptions;
    try {
      o = pipeOptions(options);
    } catch (e) {
      return rejected(e);
    }
    if (this._reader !== undefined) return rejected(new TypeError("Cannot pipe a locked stream"));
    if (destination._writer !== undefined) return rejected(new TypeError("Cannot pipe to a locked stream"));
    return readableStreamPipeTo(this, destination, o);
  }

  tee(): [ReadableStream<R>, ReadableStream<R>] {
    if (!isReadableStream(this)) throw illegalInvocation();
    if (this._controller instanceof ReadableByteStreamController) return readableByteStreamTee(this) as any;
    return readableStreamTee(this);
  }

  values(options?: { preventCancel?: boolean }): AsyncIterableIterator<R> {
    if (!isReadableStream(this)) throw illegalInvocation();
    const preventCancel = options === undefined || options === null ? false : Boolean(options.preventCancel);
    return readableStreamIterator(this, preventCancel);
  }

  [Symbol.asyncIterator](options?: { preventCancel?: boolean }): AsyncIterableIterator<R> {
    return this.values(options);
  }

  // Bun's: the stream read whole, as a Blob, bytes, JSON or text.

  blob(): Promise<any> {
    if (!isReadableStream(this)) return rejected(illegalInvocation());
    const make = blobMaker as (b: Uint8Array) => any;
    return upon(readAllBytes(this), (b) => make(b));
  }

  bytes(): Promise<Uint8Array> {
    if (!isReadableStream(this)) return rejected(illegalInvocation());
    return readAllBytes(this);
  }

  json(): Promise<any> {
    if (!isReadableStream(this)) return rejected(illegalInvocation());
    return upon(readAllBytes(this), (b) => JSON.parse(decodeUtf8(b, false)));
  }

  text(): Promise<string> {
    if (!isReadableStream(this)) return rejected(illegalInvocation());
    return upon(readAllBytes(this), (b) => decodeUtf8(b, false));
  }

  static from<R>(asyncIterable: Iterable<R> | AsyncIterable<R>): ReadableStream<R> {
    return readableStreamFromIterable(asyncIterable);
  }

  get [Symbol.toStringTag](): string {
    return "ReadableStream";
  }
}

export interface StreamPipeOptions {
  preventClose?: boolean;
  preventAbort?: boolean;
  preventCancel?: boolean;
  signal?: AbortSignal;
}

interface PipeOptions {
  preventAbort: boolean;
  preventCancel: boolean;
  preventClose: boolean;
  signal: AbortSignal | undefined;
}

/** Pipe options, read once (alphabetically, as IDL dictionaries are). */
function pipeOptions(options: StreamPipeOptions | undefined | null): PipeOptions {
  if (options === undefined || options === null) {
    return { preventAbort: false, preventCancel: false, preventClose: false, signal: undefined };
  }
  if (typeof options !== "object" && typeof options !== "function") throw new TypeError("The options must be an object");
  const preventAbort = Boolean(options.preventAbort);
  const preventCancel = Boolean(options.preventCancel);
  const preventClose = Boolean(options.preventClose);
  const signal = options.signal;
  if (signal !== undefined && !isAbortSignal(signal)) throw new TypeError("The signal must be an AbortSignal");
  return { preventAbort, preventCancel, preventClose, signal };
}

/** A ReadableStream made by the implementation (no underlying source object). */
export function createReadableStream<R>(
  start: () => any,
  pull: () => Promise<void>,
  cancel: (reason: any) => Promise<void>,
  hwm = 1,
  size: (chunk: any) => number = () => 1,
): ReadableStream<R> {
  const stream = Object.create(ReadableStream.prototype) as ReadableStream<R>;
  initReadableStream(stream);
  const controller = new ReadableStreamDefaultController<R>(KEY);
  setUpDefaultController(stream, controller, start, pull, cancel, hwm, size);
  return stream;
}

function initReadableStream(stream: ReadableStream<any>): void {
  stream._state = "readable";
  stream._reader = undefined;
  stream._storedError = undefined;
  stream._disturbed = false;
}

export class ReadableStreamDefaultController<R = any> implements Queued {
  _stream!: ReadableStream<R>;
  _queue: Sized[] = [];
  _queueTotalSize = 0;
  _started = false;
  _closeRequested = false;
  _pullAgain = false;
  _pulling = false;
  _strategySize: ((chunk: any) => number) | undefined = undefined;
  _strategyHWM = 1;
  _pullAlgorithm: (() => Promise<void>) | undefined = undefined;
  _cancelAlgorithm: ((reason: any) => Promise<void>) | undefined = undefined;

  constructor(key?: symbol) {
    if (key !== KEY) throw new TypeError("Illegal constructor");
  }

  get desiredSize(): number | null {
    return controllerDesiredSize(this);
  }

  close(): void {
    if (!canCloseOrEnqueue(this)) throw new TypeError("The stream cannot be closed now");
    controllerClose(this);
  }

  enqueue(chunk?: R): void {
    if (!canCloseOrEnqueue(this)) throw new TypeError("The stream cannot take chunks now");
    controllerEnqueue(this, chunk);
  }

  error(e?: any): void {
    controllerError(this, e);
  }

  get [Symbol.toStringTag](): string {
    return "ReadableStreamDefaultController";
  }
}

function setUpDefaultController<R>(
  stream: ReadableStream<R>,
  c: ReadableStreamDefaultController<R>,
  start: () => any,
  pull: () => Promise<void>,
  cancel: (reason: any) => Promise<void>,
  hwm: number,
  size: (chunk: any) => number,
): void {
  c._stream = stream;
  resetQueue(c);
  c._started = false;
  c._closeRequested = false;
  c._pullAgain = false;
  c._pulling = false;
  c._strategySize = size;
  c._strategyHWM = hwm;
  c._pullAlgorithm = pull;
  c._cancelAlgorithm = cancel;
  stream._controller = c;
  const startResult = start();
  upon(resolved(startResult),
    () => {
      c._started = true;
      callPullIfNeeded(c);
    },
    (r) => controllerError(c, r),
  );
}

function controllerDesiredSize(c: ReadableStreamDefaultController<any>): number | null {
  const state = c._stream._state;
  if (state === "errored") return null;
  if (state === "closed") return 0;
  return c._strategyHWM - c._queueTotalSize;
}

function canCloseOrEnqueue(c: ReadableStreamDefaultController<any>): boolean {
  return !c._closeRequested && c._stream._state === "readable";
}

function clearAlgorithms(c: ReadableStreamDefaultController<any>): void {
  c._pullAlgorithm = undefined;
  c._cancelAlgorithm = undefined;
  c._strategySize = undefined;
}

function controllerClose(c: ReadableStreamDefaultController<any>): void {
  if (!canCloseOrEnqueue(c)) return;
  c._closeRequested = true;
  if (c._queue.length === 0) {
    clearAlgorithms(c);
    readableStreamClose(c._stream);
  }
}

function controllerEnqueue<R>(c: ReadableStreamDefaultController<R>, chunk: R): void {
  if (!canCloseOrEnqueue(c)) return;
  const stream = c._stream;
  if (numReadRequests(stream) > 0) {
    fulfillReadRequest(stream, chunk, false);
  } else {
    let size: number;
    try {
      size = (c._strategySize as (chunk: any) => number)(chunk);
    } catch (e) {
      controllerError(c, e);
      throw e;
    }
    try {
      enqueueValueWithSize(c, chunk, size);
    } catch (e) {
      controllerError(c, e);
      throw e;
    }
  }
  callPullIfNeeded(c);
}

function controllerError(c: ReadableStreamDefaultController<any>, e: any): void {
  const stream = c._stream;
  if (stream._state !== "readable") return;
  resetQueue(c);
  clearAlgorithms(c);
  readableStreamError(stream, e);
}

function shouldCallPull(c: ReadableStreamDefaultController<any>): boolean {
  if (!canCloseOrEnqueue(c) || !c._started) return false;
  if (numReadRequests(c._stream) > 0) return true;
  return (controllerDesiredSize(c) as number) > 0;
}

function callPullIfNeeded(c: ReadableStreamDefaultController<any>): void {
  if (!shouldCallPull(c)) return;
  if (c._pulling) {
    c._pullAgain = true;
    return;
  }
  c._pulling = true;
  upon((c._pullAlgorithm as () => Promise<void>)(),
    () => {
      c._pulling = false;
      if (c._pullAgain) {
        c._pullAgain = false;
        callPullIfNeeded(c);
      }
    },
    (e) => controllerError(c, e),
  );
}

function controllerCancelSteps(c: ReadableStreamDefaultController<any>, reason: any): Promise<void> {
  resetQueue(c);
  const result = (c._cancelAlgorithm as (r: any) => Promise<void>)(reason);
  clearAlgorithms(c);
  return result;
}

function controllerPullSteps(c: ReadableStreamDefaultController<any>, request: ReadRequest): void {
  const stream = c._stream;
  if (c._queue.length > 0) {
    const chunk = dequeueValue(c);
    if (c._closeRequested && c._queue.length === 0) {
      clearAlgorithms(c);
      readableStreamClose(stream);
    } else {
      callPullIfNeeded(c);
    }
    request.chunk(chunk);
  } else {
    (stream._reader as ReadableStreamDefaultReader<any>)._readRequests.push(request);
    callPullIfNeeded(c);
  }
}

function fulfillReadRequest(stream: ReadableStream<any>, chunk: any, done: boolean): void {
  const reader = stream._reader as ReadableStreamDefaultReader<any>;
  const request = reader._readRequests.shift() as ReadRequest;
  if (done) request.close();
  else request.chunk(chunk);
}

function readableStreamClose(stream: ReadableStream<any>): void {
  stream._state = "closed";
  const reader = stream._reader;
  if (reader === undefined) return;
  reader._closed.resolve(undefined);
  if (reader instanceof ReadableStreamDefaultReader) {
    const requests = reader._readRequests;
    reader._readRequests = [];
    for (const r of requests) r.close();
  }
}

function readableStreamError(stream: ReadableStream<any>, e: any): void {
  stream._state = "errored";
  stream._storedError = e;
  const reader = stream._reader;
  if (reader === undefined) return;
  reader._closed.reject(e);
  handled(reader._closed.promise);
  errorReadRequests(reader, e);
}

/** Errors a reader's pending reads (read requests, or read-into requests). */
function errorReadRequests(reader: ReadableStreamDefaultReader<any> | ReadableStreamBYOBReader, e: any): void {
  if (reader instanceof ReadableStreamDefaultReader) {
    const requests = reader._readRequests;
    reader._readRequests = [];
    for (const r of requests) r.error(e);
  } else {
    const requests = reader._readIntoRequests;
    reader._readIntoRequests = [];
    for (const r of requests) r.error(e);
  }
}

function numReadRequests(stream: ReadableStream<any>): number {
  const reader = stream._reader;
  return reader instanceof ReadableStreamDefaultReader ? reader._readRequests.length : 0;
}

function numReadIntoRequests(stream: ReadableStream<any>): number {
  const reader = stream._reader;
  return reader instanceof ReadableStreamBYOBReader ? reader._readIntoRequests.length : 0;
}

export function readableStreamCancel(stream: ReadableStream<any>, reason: any): Promise<void> {
  stream._disturbed = true;
  if (stream._state === "closed") return resolved();
  if (stream._state === "errored") return rejected(stream._storedError);
  readableStreamClose(stream);
  const reader = stream._reader;
  if (reader instanceof ReadableStreamBYOBReader) {
    const requests = reader._readIntoRequests;
    reader._readIntoRequests = [];
    for (const r of requests) r.close(undefined);
  }
  const c = stream._controller;
  const result = c instanceof ReadableByteStreamController ? byteCancelSteps(c, reason) : controllerCancelSteps(c, reason);
  return upon(result, () => undefined);
}

export class ReadableStreamDefaultReader<R = any> {
  _stream: ReadableStream<R> | undefined = undefined;
  _readRequests: ReadRequest[] = [];
  _closed: Deferred<undefined>;

  constructor(stream: ReadableStream<R>) {
    if (!(stream instanceof ReadableStream)) throw new TypeError("A reader needs a ReadableStream");
    if (stream._reader !== undefined) throw new TypeError("The stream is locked to another reader");
    this._closed = deferred<undefined>();
    this._stream = stream;
    stream._reader = this;
    if (stream._state === "closed") {
      this._closed.resolve(undefined);
    } else if (stream._state === "errored") {
      this._closed.reject(stream._storedError);
      handled(this._closed.promise);
    }
  }

  get closed(): Promise<undefined> {
    return this._closed.promise;
  }

  cancel(reason?: any): Promise<void> {
    if (this._stream === undefined) return rejected(new TypeError("The reader has been released"));
    return readableStreamCancel(this._stream, reason);
  }

  read(): Promise<ReadableStreamReadResult<R>> {
    const stream = this._stream;
    if (stream === undefined) return rejected(new TypeError("The reader has been released"));
    const d = deferred<ReadableStreamReadResult<R>>();
    readerRead(this, {
      chunk: (value) => d.resolve({ value, done: false }),
      close: () => d.resolve({ value: undefined, done: true }),
      error: (e) => d.reject(e),
    });
    return d.promise;
  }

  releaseLock(): void {
    if (this._stream === undefined) return;
    readerRelease(this);
  }

  get [Symbol.toStringTag](): string {
    return "ReadableStreamDefaultReader";
  }
}

export interface ReadableStreamReadResult<R> {
  value: R | undefined;
  done: boolean;
}

function readerRead(reader: ReadableStreamDefaultReader<any>, request: ReadRequest): void {
  const stream = reader._stream as ReadableStream<any>;
  stream._disturbed = true;
  if (stream._state === "closed") request.close();
  else if (stream._state === "errored") request.error(stream._storedError);
  else {
    const c = stream._controller;
    if (c instanceof ReadableByteStreamController) bytePullSteps(c, request);
    else controllerPullSteps(c, request);
  }
}

function readerRelease(reader: ReadableStreamDefaultReader<any> | ReadableStreamBYOBReader): void {
  const stream = reader._stream as ReadableStream<any>;
  const e = new TypeError("The reader was released");
  if (stream._state === "readable") {
    reader._closed.reject(e);
    handled(reader._closed.promise);
  } else {
    reader._closed = rejectedDeferred(e);
  }
  const c = stream._controller;
  if (c instanceof ReadableByteStreamController) byteReleaseSteps(c);
  stream._reader = undefined;
  reader._stream = undefined;
  errorReadRequests(reader, e);
}

function readableStreamTee<R>(stream: ReadableStream<R>): [ReadableStream<R>, ReadableStream<R>] {
  const reader = new ReadableStreamDefaultReader<R>(stream);
  let reading = false;
  let readAgain = false;
  let canceled1 = false;
  let canceled2 = false;
  let reason1: any;
  let reason2: any;
  let branch1!: ReadableStream<R>;
  let branch2!: ReadableStream<R>;
  const cancelPromise = deferred<void>();
  const pull = (): Promise<void> => {
    if (reading) {
      readAgain = true;
      return resolved();
    }
    reading = true;
    readerRead(reader, {
      chunk: (chunk) => {
        queueMicrotask(() => {
          readAgain = false;
          if (!canceled1) controllerEnqueue(branch1._controller, chunk);
          if (!canceled2) controllerEnqueue(branch2._controller, chunk);
          reading = false;
          if (readAgain) pull();
        });
      },
      close: () => {
        reading = false;
        if (!canceled1) controllerClose(branch1._controller);
        if (!canceled2) controllerClose(branch2._controller);
        if (!canceled1 || !canceled2) cancelPromise.resolve();
      },
      error: () => {
        reading = false;
      },
    });
    return resolved();
  };
  const cancel1 = (reason: any): Promise<void> => {
    canceled1 = true;
    reason1 = reason;
    if (canceled2) cancelPromise.resolve(readableStreamCancel(stream, [reason1, reason2]) as any);
    return cancelPromise.promise;
  };
  const cancel2 = (reason: any): Promise<void> => {
    canceled2 = true;
    reason2 = reason;
    if (canceled1) cancelPromise.resolve(readableStreamCancel(stream, [reason1, reason2]) as any);
    return cancelPromise.promise;
  };
  branch1 = createReadableStream<R>(noop, pull, cancel1);
  branch2 = createReadableStream<R>(noop, pull, cancel2);
  upon(reader._closed.promise, undefined, (r) => {
    controllerError(branch1._controller, r);
    controllerError(branch2._controller, r);
    if (!canceled1 || !canceled2) cancelPromise.resolve();
  });
  return [branch1, branch2];
}

// The async iterators of streams: their prototype extends
// %AsyncIteratorPrototype%, with `next` and `return` as Web IDL has them.
const AsyncIteratorPrototype = Object.getPrototypeOf(Object.getPrototypeOf(async function* () {}).prototype);

// (The end of iteration, as a read's result.)
const END = Symbol("end");

interface StreamIterator {
  _reader: ReadableStreamDefaultReader<any>;
  _preventCancel: boolean;
  _ongoing: Promise<IteratorResult<any>> | null;
  _finished: boolean;
}

function isStreamIterator(x: any): x is StreamIterator {
  return typeof x === "object" && x !== null && x._reader instanceof ReadableStreamDefaultReader;
}

/** The next chunk (or END), the reader released at the end. */
function iteratorRead(reader: ReadableStreamDefaultReader<any>): Promise<any> {
  const d = deferred<any>();
  readerRead(reader, {
    chunk: (value) => d.resolve(value),
    close: () => {
      readerRelease(reader);
      d.resolve(END);
    },
    error: (e) => {
      readerRelease(reader);
      d.reject(e);
    },
  });
  return d.promise;
}

const streamIteratorPrototype = Object.setPrototypeOf(
  {
    next(): Promise<IteratorResult<any>> {
      const it = this as unknown as StreamIterator;
      if (!isStreamIterator(it)) return rejected(illegalInvocation());
      const steps = (): Promise<IteratorResult<any>> => {
        if (it._finished) return resolved({ value: undefined, done: true });
        return upon(iteratorRead(it._reader),
          (v) => {
            it._ongoing = null;
            if (v === END) {
              it._finished = true;
              return { value: undefined, done: true };
            }
            return { value: v, done: false };
          },
          (e) => {
            it._ongoing = null;
            it._finished = true;
            throw e;
          },
        );
      };
      const p = it._ongoing !== null ? upon(it._ongoing, steps, steps) : steps();
      it._ongoing = p;
      return p;
    },
    return(value: any): Promise<IteratorResult<any>> {
      const it = this as unknown as StreamIterator;
      if (!isStreamIterator(it)) return rejected(illegalInvocation());
      const steps = (): Promise<any> => {
        if (it._finished) return resolved({ value, done: true });
        it._finished = true;
        const reader = it._reader;
        if (reader._stream === undefined) return resolved();
        if (!it._preventCancel) {
          const result = readableStreamCancel(reader._stream, value);
          readerRelease(reader);
          return result;
        }
        readerRelease(reader);
        return resolved();
      };
      const p = it._ongoing !== null ? upon(it._ongoing, steps, steps) : steps();
      it._ongoing = p;
      return upon(p, () => ({ value, done: true }));
    },
  },
  AsyncIteratorPrototype,
);

function readableStreamIterator<R>(stream: ReadableStream<R>, preventCancel: boolean): AsyncIterableIterator<R> {
  const it = Object.create(streamIteratorPrototype);
  it._reader = new ReadableStreamDefaultReader<R>(stream);
  it._preventCancel = preventCancel;
  it._ongoing = null;
  it._finished = false;
  return it;
}

function isObject(x: unknown): boolean {
  return (typeof x === "object" && x !== null) || typeof x === "function";
}

/** A method of `o` (undefined if it has none), as GetMethod. */
function getMethod(o: any, key: PropertyKey): ((...args: any[]) => any) | undefined {
  const f = o[key];
  if (f === undefined || f === null) return undefined;
  if (typeof f !== "function") throw new TypeError(`${String(key)} is not a function`);
  return f;
}

function readableStreamFromIterable<R>(iterable: Iterable<R> | AsyncIterable<R>): ReadableStream<R> {
  // (An async iterable as Web IDL converts one: an object with either
  // iterator method.)
  if (!isObject(iterable)) throw new TypeError("ReadableStream.from needs an iterable object");
  let method = getMethod(iterable, Symbol.asyncIterator);
  const sync = method === undefined;
  if (method === undefined) method = getMethod(iterable, Symbol.iterator);
  if (method === undefined) throw new TypeError("ReadableStream.from needs an iterable or async iterable");
  const iterator = apply(method, iterable, []);
  if (!isObject(iterator)) throw new TypeError("The iterator must be an object");
  const nextMethod = iterator.next;
  let stream!: ReadableStream<R>;
  const pull = (): Promise<void> => {
    let result: any;
    try {
      result = apply(nextMethod, iterator, []);
    } catch (e) {
      return rejected(e);
    }
    if (sync) {
      // (A sync iterator's values may be promises: awaited.)
      if (!isObject(result)) return rejected(new TypeError("The iterator's result must be an object"));
      let done: boolean;
      let value: Promise<any>;
      try {
        done = Boolean(result.done);
        value = Promise.resolve(result.value);
      } catch (e) {
        return rejected(e);
      }
      return upon(value, (v) => {
        if (done) controllerClose(stream._controller);
        else controllerEnqueue(stream._controller, v);
      });
    }
    return upon(resolved(result), (r: any) => {
      if (!isObject(r)) throw new TypeError("The iterator's result must be an object");
      if (r.done) controllerClose(stream._controller);
      else controllerEnqueue(stream._controller, r.value);
    });
  };
  const cancel = (reason: any): Promise<void> => {
    let result: any;
    try {
      const ret = getMethod(iterator, "return");
      if (ret === undefined) return resolved();
      result = apply(ret, iterator, [reason]);
    } catch (e) {
      return rejected(e);
    }
    return upon(resolved(result), (r: any) => {
      if (!isObject(r)) throw new TypeError("The iterator's return result must be an object");
    });
  };
  stream = createReadableStream<R>(noop, pull, cancel, 0);
  return stream;
}

// ---- Byte streams ----

/** An integer as Web IDL's [EnforceRange] unsigned long long converts one. */
function enforceRange(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new TypeError("The value must be a finite number");
  const i = Math.trunc(n);
  if (i < 0 || i > Number.MAX_SAFE_INTEGER) throw new TypeError("The value is out of range");
  return i;
}

function isDetached(b: ArrayBuffer): boolean {
  return (b as any).detached === true;
}

/** The buffer's memory in a new ArrayBuffer, `b` detached (TransferArrayBuffer). */
function transfer(b: ArrayBuffer): ArrayBuffer {
  if (!(b instanceof ArrayBuffer)) throw new TypeError("The buffer cannot be transferred");
  return (b as any).transfer() as ArrayBuffer;
}

/** The bytes `b[offset, offset + length)` in a new ArrayBuffer. */
function cloneBuffer(b: ArrayBuffer, offset: number, length: number): ArrayBuffer {
  return b.slice(offset, offset + length);
}

interface ReadIntoRequest {
  chunk(v: ArrayBufferView): void;
  close(v: ArrayBufferView | undefined): void;
  error(e: any): void;
}

interface ByteQueueEntry {
  buffer: ArrayBuffer;
  byteOffset: number;
  byteLength: number;
}

type ViewConstructor = new (buffer: ArrayBuffer, byteOffset: number, length: number) => ArrayBufferView;

interface PullIntoDescriptor {
  buffer: ArrayBuffer;
  bufferByteLength: number;
  byteOffset: number;
  byteLength: number;
  bytesFilled: number;
  minimumFill: number;
  elementSize: number;
  viewConstructor: ViewConstructor;
  readerType: "default" | "byob" | "none";
}

export class ReadableByteStreamController {
  _stream!: ReadableStream<any>;
  _queue: ByteQueueEntry[] = [];
  _queueTotalSize = 0;
  _started = false;
  _closeRequested = false;
  _pullAgain = false;
  _pulling = false;
  _strategyHWM = 0;
  _autoAllocateChunkSize: number | undefined = undefined;
  _byobRequest: ReadableStreamBYOBRequest | null = null;
  _pendingPullIntos: PullIntoDescriptor[] = [];
  _pullAlgorithm: (() => Promise<void>) | undefined = undefined;
  _cancelAlgorithm: ((reason: any) => Promise<void>) | undefined = undefined;

  constructor(key?: symbol) {
    if (key !== KEY) throw new TypeError("Illegal constructor");
  }

  get byobRequest(): ReadableStreamBYOBRequest | null {
    if (!(this instanceof ReadableByteStreamController)) throw illegalInvocation();
    return byteGetBYOBRequest(this);
  }

  get desiredSize(): number | null {
    if (!(this instanceof ReadableByteStreamController)) throw illegalInvocation();
    return byteDesiredSize(this);
  }

  close(): void {
    if (!(this instanceof ReadableByteStreamController)) throw illegalInvocation();
    if (this._closeRequested) throw new TypeError("The stream is already closing");
    if (this._stream._state !== "readable") throw new TypeError("The stream is not readable");
    byteClose(this);
  }

  enqueue(chunk: ArrayBufferView): void {
    if (!(this instanceof ReadableByteStreamController)) throw illegalInvocation();
    if (!ArrayBuffer.isView(chunk)) throw new TypeError("The chunk must be an ArrayBufferView");
    if (chunk.byteLength === 0) throw new TypeError("The chunk must not be empty");
    if (chunk.buffer.byteLength === 0) throw new TypeError("The chunk's buffer must not be empty");
    if (this._closeRequested) throw new TypeError("The stream is closing");
    if (this._stream._state !== "readable") throw new TypeError("The stream is not readable");
    byteEnqueue(this, chunk);
  }

  error(e?: any): void {
    if (!(this instanceof ReadableByteStreamController)) throw illegalInvocation();
    byteError(this, e);
  }

  get [Symbol.toStringTag](): string {
    return "ReadableByteStreamController";
  }
}

export class ReadableStreamBYOBRequest {
  _controller: ReadableByteStreamController | undefined = undefined;
  _view: Uint8Array | null = null;

  constructor(key?: symbol) {
    if (key !== KEY) throw new TypeError("Illegal constructor");
  }

  get view(): ArrayBufferView | null {
    if (!(this instanceof ReadableStreamBYOBRequest)) throw illegalInvocation();
    return this._view;
  }

  respond(bytesWritten: number): void {
    if (!(this instanceof ReadableStreamBYOBRequest)) throw illegalInvocation();
    const n = enforceRange(bytesWritten);
    if (this._controller === undefined) throw new TypeError("This BYOB request has been invalidated");
    if (isDetached((this._view as Uint8Array).buffer as ArrayBuffer)) throw new TypeError("The view's buffer has been detached");
    byteRespond(this._controller, n);
  }

  respondWithNewView(view: ArrayBufferView): void {
    if (!(this instanceof ReadableStreamBYOBRequest)) throw illegalInvocation();
    if (!ArrayBuffer.isView(view)) throw new TypeError("The view must be an ArrayBufferView");
    if (this._controller === undefined) throw new TypeError("This BYOB request has been invalidated");
    if (isDetached(view.buffer as ArrayBuffer)) throw new TypeError("The view's buffer has been detached");
    byteRespondWithNewView(this._controller, view);
  }

  get [Symbol.toStringTag](): string {
    return "ReadableStreamBYOBRequest";
  }
}

export class ReadableStreamBYOBReader {
  _stream: ReadableStream<any> | undefined = undefined;
  _readIntoRequests: ReadIntoRequest[] = [];
  _closed: Deferred<undefined>;

  constructor(stream: ReadableStream<any>) {
    if (!isReadableStream(stream)) throw new TypeError("A reader needs a ReadableStream");
    if (stream._reader !== undefined) throw new TypeError("The stream is locked to another reader");
    if (!(stream._controller instanceof ReadableByteStreamController)) {
      throw new TypeError("Only byte streams have BYOB readers");
    }
    this._closed = deferred<undefined>();
    this._stream = stream;
    stream._reader = this;
    if (stream._state === "closed") {
      this._closed.resolve(undefined);
    } else if (stream._state === "errored") {
      this._closed.reject(stream._storedError);
      handled(this._closed.promise);
    }
  }

  get closed(): Promise<undefined> {
    if (!(this instanceof ReadableStreamBYOBReader)) return rejected(illegalInvocation());
    return this._closed.promise;
  }

  cancel(reason?: any): Promise<void> {
    if (!(this instanceof ReadableStreamBYOBReader)) return rejected(illegalInvocation());
    if (this._stream === undefined) return rejected(new TypeError("The reader has been released"));
    return readableStreamCancel(this._stream, reason);
  }

  read<T extends ArrayBufferView>(view: T, options?: { min?: number }): Promise<ReadableStreamReadResult<T>> {
    if (!(this instanceof ReadableStreamBYOBReader)) return rejected(illegalInvocation());
    if (!ArrayBuffer.isView(view)) return rejected(new TypeError("read needs an ArrayBufferView"));
    let min: number;
    try {
      if (options !== undefined && options !== null && !isObject(options)) throw new TypeError("The options must be an object");
      const m = options === undefined || options === null ? undefined : options.min;
      min = m === undefined ? 1 : enforceRange(m);
    } catch (e) {
      return rejected(e);
    }
    if (view.byteLength === 0) return rejected(new TypeError("The view must not be empty"));
    if (view.buffer.byteLength === 0) return rejected(new TypeError("The view's buffer must not be empty"));
    if (isDetached(view.buffer as ArrayBuffer)) return rejected(new TypeError("The view's buffer has been detached"));
    if (min === 0) return rejected(new TypeError("min must be positive"));
    if (view instanceof DataView) {
      if (min > view.byteLength) return rejected(new RangeError("min is larger than the view"));
    } else if (min > (view as any).length) {
      return rejected(new RangeError("min is larger than the view"));
    }
    if (this._stream === undefined) return rejected(new TypeError("The reader has been released"));
    const d = deferred<ReadableStreamReadResult<T>>();
    byobReaderRead(this, view, min, {
      chunk: (v) => d.resolve({ value: v as T, done: false }),
      close: (v) => d.resolve({ value: v as T | undefined, done: true }),
      error: (e) => d.reject(e),
    });
    return d.promise;
  }

  releaseLock(): void {
    if (!(this instanceof ReadableStreamBYOBReader)) throw illegalInvocation();
    if (this._stream === undefined) return;
    readerRelease(this);
  }

  get [Symbol.toStringTag](): string {
    return "ReadableStreamBYOBReader";
  }
}

function byobReaderRead(reader: ReadableStreamBYOBReader, view: ArrayBufferView, min: number, request: ReadIntoRequest): void {
  const stream = reader._stream as ReadableStream<any>;
  stream._disturbed = true;
  if (stream._state === "errored") request.error(stream._storedError);
  else bytePullInto(stream._controller as ReadableByteStreamController, view, min, request);
}

function setUpByteController(
  stream: ReadableStream<any>,
  c: ReadableByteStreamController,
  start: () => any,
  pull: () => Promise<void>,
  cancel: (reason: any) => Promise<void>,
  hwm: number,
  autoAllocateChunkSize: number | undefined,
): void {
  c._stream = stream;
  c._pullAgain = false;
  c._pulling = false;
  c._byobRequest = null;
  c._queue = [];
  c._queueTotalSize = 0;
  c._closeRequested = false;
  c._started = false;
  c._strategyHWM = hwm;
  c._pullAlgorithm = pull;
  c._cancelAlgorithm = cancel;
  c._autoAllocateChunkSize = autoAllocateChunkSize;
  c._pendingPullIntos = [];
  stream._controller = c;
  const startResult = start();
  upon(
    resolved(startResult),
    () => {
      c._started = true;
      byteCallPullIfNeeded(c);
    },
    (r) => byteError(c, r),
  );
}

/** A byte stream made by the implementation. */
function createReadableByteStream(start: () => any, pull: () => Promise<void>, cancel: (reason: any) => Promise<void>): ReadableStream<Uint8Array> {
  const stream = Object.create(ReadableStream.prototype) as ReadableStream<Uint8Array>;
  initReadableStream(stream);
  setUpByteController(stream, new ReadableByteStreamController(KEY), start, pull, cancel, 0, undefined);
  return stream;
}

function byteDesiredSize(c: ReadableByteStreamController): number | null {
  const state = c._stream._state;
  if (state === "errored") return null;
  if (state === "closed") return 0;
  return c._strategyHWM - c._queueTotalSize;
}

function byteClearAlgorithms(c: ReadableByteStreamController): void {
  c._pullAlgorithm = undefined;
  c._cancelAlgorithm = undefined;
}

function byteInvalidateBYOBRequest(c: ReadableByteStreamController): void {
  const r = c._byobRequest;
  if (r === null) return;
  r._controller = undefined;
  r._view = null;
  c._byobRequest = null;
}

function byteClearPendingPullIntos(c: ReadableByteStreamController): void {
  byteInvalidateBYOBRequest(c);
  c._pendingPullIntos = [];
}

function byteError(c: ReadableByteStreamController, e: any): void {
  const stream = c._stream;
  if (stream._state !== "readable") return;
  byteClearPendingPullIntos(c);
  c._queue = [];
  c._queueTotalSize = 0;
  byteClearAlgorithms(c);
  readableStreamError(stream, e);
}

function byteShouldCallPull(c: ReadableByteStreamController): boolean {
  const stream = c._stream;
  if (stream._state !== "readable" || c._closeRequested || !c._started) return false;
  if (numReadRequests(stream) > 0) return true;
  if (numReadIntoRequests(stream) > 0) return true;
  return (byteDesiredSize(c) as number) > 0;
}

function byteCallPullIfNeeded(c: ReadableByteStreamController): void {
  if (!byteShouldCallPull(c)) return;
  if (c._pulling) {
    c._pullAgain = true;
    return;
  }
  c._pulling = true;
  upon(
    (c._pullAlgorithm as () => Promise<void>)(),
    () => {
      c._pulling = false;
      if (c._pullAgain) {
        c._pullAgain = false;
        byteCallPullIfNeeded(c);
      }
    },
    (e) => byteError(c, e),
  );
}

function byteCancelSteps(c: ReadableByteStreamController, reason: any): Promise<void> {
  byteClearPendingPullIntos(c);
  c._queue = [];
  c._queueTotalSize = 0;
  const result = (c._cancelAlgorithm as (r: any) => Promise<void>)(reason);
  byteClearAlgorithms(c);
  return result;
}

function bytePullSteps(c: ReadableByteStreamController, request: ReadRequest): void {
  const stream = c._stream;
  if (c._queueTotalSize > 0) {
    byteFillReadRequestFromQueue(c, request);
    return;
  }
  const size = c._autoAllocateChunkSize;
  if (size !== undefined) {
    let buffer: ArrayBuffer;
    try {
      buffer = new ArrayBuffer(size);
    } catch (e) {
      request.error(e);
      return;
    }
    c._pendingPullIntos.push({
      buffer,
      bufferByteLength: size,
      byteOffset: 0,
      byteLength: size,
      bytesFilled: 0,
      minimumFill: 1,
      elementSize: 1,
      viewConstructor: Uint8Array,
      readerType: "default",
    });
  }
  (stream._reader as ReadableStreamDefaultReader<any>)._readRequests.push(request);
  byteCallPullIfNeeded(c);
}

function byteReleaseSteps(c: ReadableByteStreamController): void {
  if (c._pendingPullIntos.length > 0) {
    const first = c._pendingPullIntos[0];
    first.readerType = "none";
    c._pendingPullIntos = [first];
  }
}

function byteFillReadRequestFromQueue(c: ReadableByteStreamController, request: ReadRequest): void {
  const entry = c._queue.shift() as ByteQueueEntry;
  c._queueTotalSize -= entry.byteLength;
  byteHandleQueueDrain(c);
  request.chunk(new Uint8Array(entry.buffer, entry.byteOffset, entry.byteLength));
}

function byteHandleQueueDrain(c: ReadableByteStreamController): void {
  if (c._queueTotalSize === 0 && c._closeRequested) {
    byteClearAlgorithms(c);
    readableStreamClose(c._stream);
  } else {
    byteCallPullIfNeeded(c);
  }
}

function byteClose(c: ReadableByteStreamController): void {
  const stream = c._stream;
  if (c._closeRequested || stream._state !== "readable") return;
  if (c._queueTotalSize > 0) {
    c._closeRequested = true;
    return;
  }
  if (c._pendingPullIntos.length > 0) {
    const first = c._pendingPullIntos[0];
    if (first.bytesFilled % first.elementSize !== 0) {
      const e = new TypeError("Insufficient bytes to fill elements in the given buffer");
      byteError(c, e);
      throw e;
    }
  }
  byteClearAlgorithms(c);
  readableStreamClose(stream);
}

function byteEnqueueChunkToQueue(c: ReadableByteStreamController, buffer: ArrayBuffer, byteOffset: number, byteLength: number): void {
  c._queue.push({ buffer, byteOffset, byteLength });
  c._queueTotalSize += byteLength;
}

function byteEnqueueClonedChunkToQueue(c: ReadableByteStreamController, buffer: ArrayBuffer, byteOffset: number, byteLength: number): void {
  let clone: ArrayBuffer;
  try {
    clone = cloneBuffer(buffer, byteOffset, byteLength);
  } catch (e) {
    byteError(c, e);
    throw e;
  }
  byteEnqueueChunkToQueue(c, clone, 0, byteLength);
}

function byteEnqueueDetachedPullIntoToQueue(c: ReadableByteStreamController, d: PullIntoDescriptor): void {
  if (d.bytesFilled > 0) byteEnqueueClonedChunkToQueue(c, d.buffer, d.byteOffset, d.bytesFilled);
  byteShiftPendingPullInto(c);
}

function byteShiftPendingPullInto(c: ReadableByteStreamController): PullIntoDescriptor {
  return c._pendingPullIntos.shift() as PullIntoDescriptor;
}

function byteEnqueue(c: ReadableByteStreamController, chunk: ArrayBufferView): void {
  const stream = c._stream;
  if (c._closeRequested || stream._state !== "readable") return;
  const buffer = chunk.buffer as ArrayBuffer;
  const byteOffset = chunk.byteOffset;
  const byteLength = chunk.byteLength;
  if (isDetached(buffer)) throw new TypeError("The chunk's buffer has been detached");
  const transferred = transfer(buffer);
  if (c._pendingPullIntos.length > 0) {
    const first = c._pendingPullIntos[0];
    if (isDetached(first.buffer)) throw new TypeError("The BYOB request's buffer has been detached");
    byteInvalidateBYOBRequest(c);
    first.buffer = transfer(first.buffer);
    if (first.readerType === "none") byteEnqueueDetachedPullIntoToQueue(c, first);
  }
  if (stream._reader instanceof ReadableStreamDefaultReader) {
    byteProcessReadRequestsUsingQueue(c);
    if (numReadRequests(stream) === 0) {
      byteEnqueueChunkToQueue(c, transferred, byteOffset, byteLength);
    } else {
      if (c._pendingPullIntos.length > 0) byteShiftPendingPullInto(c);
      fulfillReadRequest(stream, new Uint8Array(transferred, byteOffset, byteLength), false);
    }
  } else if (stream._reader instanceof ReadableStreamBYOBReader) {
    byteEnqueueChunkToQueue(c, transferred, byteOffset, byteLength);
    const filled = byteProcessPullIntoDescriptorsUsingQueue(c);
    for (const d of filled) byteCommitPullIntoDescriptor(stream, d);
  } else {
    byteEnqueueChunkToQueue(c, transferred, byteOffset, byteLength);
  }
  byteCallPullIfNeeded(c);
}

function byteProcessReadRequestsUsingQueue(c: ReadableByteStreamController): void {
  const reader = c._stream._reader as ReadableStreamDefaultReader<any>;
  while (reader._readRequests.length > 0) {
    if (c._queueTotalSize === 0) return;
    const request = reader._readRequests.shift() as ReadRequest;
    byteFillReadRequestFromQueue(c, request);
  }
}

function byteProcessPullIntoDescriptorsUsingQueue(c: ReadableByteStreamController): PullIntoDescriptor[] {
  const filled: PullIntoDescriptor[] = [];
  while (c._pendingPullIntos.length > 0) {
    if (c._queueTotalSize === 0) break;
    const d = c._pendingPullIntos[0];
    if (byteFillPullIntoDescriptorFromQueue(c, d)) {
      byteShiftPendingPullInto(c);
      filled.push(d);
    }
  }
  return filled;
}

function byteFillPullIntoDescriptorFromQueue(c: ReadableByteStreamController, d: PullIntoDescriptor): boolean {
  const maxBytesToCopy = Math.min(c._queueTotalSize, d.byteLength - d.bytesFilled);
  const maxBytesFilled = d.bytesFilled + maxBytesToCopy;
  let remaining = maxBytesToCopy;
  let ready = false;
  const remainder = maxBytesFilled % d.elementSize;
  const maxAlignedBytes = maxBytesFilled - remainder;
  if (maxAlignedBytes >= d.minimumFill) {
    remaining = maxAlignedBytes - d.bytesFilled;
    ready = true;
  }
  const queue = c._queue;
  while (remaining > 0) {
    const head = queue[0];
    const bytesToCopy = Math.min(remaining, head.byteLength);
    const destStart = d.byteOffset + d.bytesFilled;
    new Uint8Array(d.buffer).set(new Uint8Array(head.buffer, head.byteOffset, bytesToCopy), destStart);
    if (head.byteLength === bytesToCopy) {
      queue.shift();
    } else {
      head.byteOffset += bytesToCopy;
      head.byteLength -= bytesToCopy;
    }
    c._queueTotalSize -= bytesToCopy;
    d.bytesFilled += bytesToCopy;
    remaining -= bytesToCopy;
  }
  return ready;
}

function byteConvertPullIntoDescriptor(d: PullIntoDescriptor): ArrayBufferView {
  const buffer = transfer(d.buffer);
  return new d.viewConstructor(buffer, d.byteOffset, d.bytesFilled / d.elementSize);
}

function byteCommitPullIntoDescriptor(stream: ReadableStream<any>, d: PullIntoDescriptor): void {
  const done = stream._state === "closed";
  const view = byteConvertPullIntoDescriptor(d);
  if (d.readerType === "default") {
    fulfillReadRequest(stream, view, done);
  } else {
    const reader = stream._reader as ReadableStreamBYOBReader;
    const request = reader._readIntoRequests.shift() as ReadIntoRequest;
    if (done) request.close(view);
    else request.chunk(view);
  }
}

function byteGetBYOBRequest(c: ReadableByteStreamController): ReadableStreamBYOBRequest | null {
  if (c._byobRequest === null && c._pendingPullIntos.length > 0) {
    const first = c._pendingPullIntos[0];
    const view = new Uint8Array(first.buffer, first.byteOffset + first.bytesFilled, first.byteLength - first.bytesFilled);
    const r = new ReadableStreamBYOBRequest(KEY);
    r._controller = c;
    r._view = view;
    c._byobRequest = r;
  }
  return c._byobRequest;
}

/** The element size and view constructor of a view. */
function viewKind(view: ArrayBufferView): [number, ViewConstructor] {
  if (view instanceof DataView) return [1, DataView as unknown as ViewConstructor];
  const ctor = (view as any).constructor as ViewConstructor & { BYTES_PER_ELEMENT: number };
  return [(view as any).BYTES_PER_ELEMENT as number, ctor];
}

function bytePullInto(c: ReadableByteStreamController, view: ArrayBufferView, min: number, request: ReadIntoRequest): void {
  const stream = c._stream;
  const [elementSize, ctor] = viewKind(view);
  const minimumFill = min * elementSize;
  const byteOffset = view.byteOffset;
  const byteLength = view.byteLength;
  let buffer: ArrayBuffer;
  try {
    buffer = transfer(view.buffer as ArrayBuffer);
  } catch (e) {
    request.error(e);
    return;
  }
  const d: PullIntoDescriptor = {
    buffer,
    bufferByteLength: buffer.byteLength,
    byteOffset,
    byteLength,
    bytesFilled: 0,
    minimumFill,
    elementSize,
    viewConstructor: ctor,
    readerType: "byob",
  };
  if (c._pendingPullIntos.length > 0) {
    c._pendingPullIntos.push(d);
    (stream._reader as ReadableStreamBYOBReader)._readIntoRequests.push(request);
    return;
  }
  if (stream._state === "closed") {
    request.close(new ctor(d.buffer, d.byteOffset, 0));
    return;
  }
  if (c._queueTotalSize > 0) {
    if (byteFillPullIntoDescriptorFromQueue(c, d)) {
      const filled = byteConvertPullIntoDescriptor(d);
      byteHandleQueueDrain(c);
      request.chunk(filled);
      return;
    }
    if (c._closeRequested) {
      const e = new TypeError("Insufficient bytes to fill elements in the given buffer");
      byteError(c, e);
      request.error(e);
      return;
    }
  }
  c._pendingPullIntos.push(d);
  (stream._reader as ReadableStreamBYOBReader)._readIntoRequests.push(request);
  byteCallPullIfNeeded(c);
}

function byteRespond(c: ReadableByteStreamController, bytesWritten: number): void {
  const first = c._pendingPullIntos[0];
  if (c._stream._state === "closed") {
    if (bytesWritten !== 0) throw new TypeError("bytesWritten must be 0 when calling respond() on a closed stream");
  } else {
    if (bytesWritten === 0) throw new TypeError("bytesWritten must be greater than 0 when calling respond() on a readable stream");
    if (first.bytesFilled + bytesWritten > first.byteLength) throw new RangeError("bytesWritten out of range");
  }
  first.buffer = transfer(first.buffer);
  byteRespondInternal(c, bytesWritten);
}

function byteRespondInternal(c: ReadableByteStreamController, bytesWritten: number): void {
  const first = c._pendingPullIntos[0];
  byteInvalidateBYOBRequest(c);
  if (c._stream._state === "closed") byteRespondInClosedState(c, first);
  else byteRespondInReadableState(c, bytesWritten, first);
  byteCallPullIfNeeded(c);
}

function byteRespondInClosedState(c: ReadableByteStreamController, first: PullIntoDescriptor): void {
  if (first.readerType === "none") byteShiftPendingPullInto(c);
  const stream = c._stream;
  if (stream._reader instanceof ReadableStreamBYOBReader) {
    const filled: PullIntoDescriptor[] = [];
    while (filled.length < numReadIntoRequests(stream)) filled.push(byteShiftPendingPullInto(c));
    for (const d of filled) byteCommitPullIntoDescriptor(stream, d);
  }
}

function byteRespondInReadableState(c: ReadableByteStreamController, bytesWritten: number, d: PullIntoDescriptor): void {
  d.bytesFilled += bytesWritten;
  const stream = c._stream;
  if (d.readerType === "none") {
    byteEnqueueDetachedPullIntoToQueue(c, d);
    const filled = byteProcessPullIntoDescriptorsUsingQueue(c);
    for (const f of filled) byteCommitPullIntoDescriptor(stream, f);
    return;
  }
  if (d.bytesFilled < d.minimumFill) return;
  byteShiftPendingPullInto(c);
  const remainder = d.bytesFilled % d.elementSize;
  if (remainder > 0) {
    const end = d.byteOffset + d.bytesFilled;
    byteEnqueueClonedChunkToQueue(c, d.buffer, end - remainder, remainder);
  }
  d.bytesFilled -= remainder;
  const filled = byteProcessPullIntoDescriptorsUsingQueue(c);
  byteCommitPullIntoDescriptor(stream, d);
  for (const f of filled) byteCommitPullIntoDescriptor(stream, f);
}

function byteRespondWithNewView(c: ReadableByteStreamController, view: ArrayBufferView): void {
  const first = c._pendingPullIntos[0];
  if (c._stream._state === "closed") {
    if (view.byteLength !== 0) throw new TypeError("The view's length must be 0 when calling respondWithNewView() on a closed stream");
  } else if (view.byteLength === 0) {
    throw new TypeError("The view's length must be greater than 0 when calling respondWithNewView() on a readable stream");
  }
  if (first.byteOffset + first.bytesFilled !== view.byteOffset) throw new RangeError("The region specified by view does not match byobRequest");
  if (first.bufferByteLength !== view.buffer.byteLength) throw new RangeError("The buffer of view has different capacity than byobRequest");
  if (first.bytesFilled + view.byteLength > first.byteLength) throw new RangeError("The region specified by view is larger than byobRequest");
  const length = view.byteLength;
  first.buffer = transfer(view.buffer as ArrayBuffer);
  byteRespondInternal(c, length);
}

/** A copy of a view's bytes, as a Uint8Array. */
function cloneAsUint8Array(view: ArrayBufferView): Uint8Array {
  return new Uint8Array(cloneBuffer(view.buffer as ArrayBuffer, view.byteOffset, view.byteLength));
}

function readableByteStreamTee(stream: ReadableStream<any>): [ReadableStream<Uint8Array>, ReadableStream<Uint8Array>] {
  let reader: ReadableStreamDefaultReader<any> | ReadableStreamBYOBReader = new ReadableStreamDefaultReader<any>(stream);
  let reading = false;
  let readAgainForBranch1 = false;
  let readAgainForBranch2 = false;
  let canceled1 = false;
  let canceled2 = false;
  let reason1: any;
  let reason2: any;
  let branch1!: ReadableStream<Uint8Array>;
  let branch2!: ReadableStream<Uint8Array>;
  const cancelPromise = deferred<void>();
  const ctl = (b: ReadableStream<Uint8Array>): ReadableByteStreamController => b._controller as ReadableByteStreamController;
  const forwardReaderError = (thisReader: ReadableStreamDefaultReader<any> | ReadableStreamBYOBReader): void => {
    upon(thisReader._closed.promise, undefined, (r) => {
      if (thisReader !== reader) return;
      byteError(ctl(branch1), r);
      byteError(ctl(branch2), r);
      if (!canceled1 || !canceled2) cancelPromise.resolve();
    });
  };
  const pullWithDefaultReader = (): void => {
    if (reader instanceof ReadableStreamBYOBReader) {
      readerRelease(reader);
      reader = new ReadableStreamDefaultReader<any>(stream);
      forwardReaderError(reader);
    }
    readerRead(reader, {
      chunk: (chunk) => {
        queueMicrotask(() => {
          readAgainForBranch1 = false;
          readAgainForBranch2 = false;
          const chunk1 = chunk;
          let chunk2 = chunk;
          if (!canceled1 && !canceled2) {
            try {
              chunk2 = cloneAsUint8Array(chunk);
            } catch (e) {
              byteError(ctl(branch1), e);
              byteError(ctl(branch2), e);
              cancelPromise.resolve(readableStreamCancel(stream, e));
              return;
            }
          }
          if (!canceled1) byteEnqueue(ctl(branch1), chunk1);
          if (!canceled2) byteEnqueue(ctl(branch2), chunk2);
          reading = false;
          if (readAgainForBranch1) pull1();
          else if (readAgainForBranch2) pull2();
        });
      },
      close: () => {
        reading = false;
        if (!canceled1) byteClose(ctl(branch1));
        if (!canceled2) byteClose(ctl(branch2));
        if (ctl(branch1)._pendingPullIntos.length > 0) byteRespond(ctl(branch1), 0);
        if (ctl(branch2)._pendingPullIntos.length > 0) byteRespond(ctl(branch2), 0);
        if (!canceled1 || !canceled2) cancelPromise.resolve();
      },
      error: () => {
        reading = false;
      },
    });
  };
  const pullWithBYOBReader = (view: ArrayBufferView, forBranch2: boolean): void => {
    if (reader instanceof ReadableStreamDefaultReader) {
      readerRelease(reader);
      reader = new ReadableStreamBYOBReader(stream);
      forwardReaderError(reader);
    }
    const byobBranch = forBranch2 ? branch2 : branch1;
    const otherBranch = forBranch2 ? branch1 : branch2;
    byobReaderRead(reader as ReadableStreamBYOBReader, view, 1, {
      chunk: (chunk) => {
        queueMicrotask(() => {
          readAgainForBranch1 = false;
          readAgainForBranch2 = false;
          const byobCanceled = forBranch2 ? canceled2 : canceled1;
          const otherCanceled = forBranch2 ? canceled1 : canceled2;
          if (!otherCanceled) {
            let cloned: Uint8Array;
            try {
              cloned = cloneAsUint8Array(chunk);
            } catch (e) {
              byteError(ctl(byobBranch), e);
              byteError(ctl(otherBranch), e);
              cancelPromise.resolve(readableStreamCancel(stream, e));
              return;
            }
            if (!byobCanceled) byteRespondWithNewView(ctl(byobBranch), chunk);
            byteEnqueue(ctl(otherBranch), cloned);
          } else if (!byobCanceled) {
            byteRespondWithNewView(ctl(byobBranch), chunk);
          }
          reading = false;
          if (readAgainForBranch1) pull1();
          else if (readAgainForBranch2) pull2();
        });
      },
      close: (chunk) => {
        reading = false;
        const byobCanceled = forBranch2 ? canceled2 : canceled1;
        const otherCanceled = forBranch2 ? canceled1 : canceled2;
        if (!byobCanceled) byteClose(ctl(byobBranch));
        if (!otherCanceled) byteClose(ctl(otherBranch));
        if (chunk !== undefined) {
          if (!byobCanceled) byteRespondWithNewView(ctl(byobBranch), chunk);
          if (!otherCanceled && ctl(otherBranch)._pendingPullIntos.length > 0) byteRespond(ctl(otherBranch), 0);
        }
        if (!byobCanceled || !otherCanceled) cancelPromise.resolve();
      },
      error: () => {
        reading = false;
      },
    });
  };
  const pull1 = (): Promise<void> => {
    if (reading) {
      readAgainForBranch1 = true;
      return resolved();
    }
    reading = true;
    const request = byteGetBYOBRequest(ctl(branch1));
    if (request === null) pullWithDefaultReader();
    else pullWithBYOBReader(request._view as Uint8Array, false);
    return resolved();
  };
  const pull2 = (): Promise<void> => {
    if (reading) {
      readAgainForBranch2 = true;
      return resolved();
    }
    reading = true;
    const request = byteGetBYOBRequest(ctl(branch2));
    if (request === null) pullWithDefaultReader();
    else pullWithBYOBReader(request._view as Uint8Array, true);
    return resolved();
  };
  const cancel1 = (reason: any): Promise<void> => {
    canceled1 = true;
    reason1 = reason;
    if (canceled2) cancelPromise.resolve(readableStreamCancel(stream, [reason1, reason2]) as any);
    return cancelPromise.promise;
  };
  const cancel2 = (reason: any): Promise<void> => {
    canceled2 = true;
    reason2 = reason;
    if (canceled1) cancelPromise.resolve(readableStreamCancel(stream, [reason1, reason2]) as any);
    return cancelPromise.promise;
  };
  branch1 = createReadableByteStream(noop, pull1, cancel1);
  branch2 = createReadableByteStream(noop, pull2, cancel2);
  forwardReaderError(reader);
  return [branch1, branch2];
}

// ---- WritableStream ----

export interface UnderlyingSink<W = any> {
  start?: (controller: WritableStreamDefaultController) => any;
  write?: (chunk: W, controller: WritableStreamDefaultController) => any;
  close?: () => any;
  abort?: (reason?: any) => any;
  type?: undefined;
}

interface PendingAbort {
  promise: Deferred<void>;
  reason: any;
  wasAlreadyErroring: boolean;
}

// (The close request in a writable stream's queue.)
const CLOSE_SENTINEL = Symbol("close");

export class WritableStream<W = any> {
  _state: "writable" | "closed" | "erroring" | "errored" = "writable";
  _storedError: any = undefined;
  _writer: WritableStreamDefaultWriter<W> | undefined = undefined;
  _controller!: WritableStreamDefaultController;
  _writeRequests: Deferred<void>[] = [];
  _inFlightWriteRequest: Deferred<void> | undefined = undefined;
  _closeRequest: Deferred<void> | undefined = undefined;
  _inFlightCloseRequest: Deferred<void> | undefined = undefined;
  _pendingAbortRequest: PendingAbort | undefined = undefined;
  _backpressure = false;

  constructor(underlyingSink?: UnderlyingSink<W> | null, strategy?: QueuingStrategy<W>) {
    if (underlyingSink !== undefined && !isObject(underlyingSink)) throw new TypeError("The underlying sink must be an object");
    const s = readStrategy(strategy);
    // (The sink's members, alphabetically.)
    const sink = underlyingSink === undefined ? {} : (underlyingSink as UnderlyingSink<W>);
    const abort = callback(sink, "abort");
    const close = callback(sink, "close");
    const start = callback(sink, "start");
    const type = (sink as any).type;
    const write = callback(sink, "write");
    if (type !== undefined) throw new RangeError("Invalid sink type");
    const size = extractSizeAlgorithm(s);
    const hwm = extractHighWaterMark(s, 1);
    const controller = new WritableStreamDefaultController(KEY);
    setUpWritableController(
      this,
      controller,
      () => (start !== undefined ? apply(start, sink, [controller]) : undefined),
      (chunk) => (write !== undefined ? promiseCall(() => apply(write, sink, [chunk, controller])) : resolved()),
      () => (close !== undefined ? promiseCall(() => apply(close, sink, [])) : resolved()),
      (reason) => (abort !== undefined ? promiseCall(() => apply(abort, sink, [reason])) : resolved()),
      hwm,
      size,
    );
  }

  get locked(): boolean {
    return this._writer !== undefined;
  }

  abort(reason?: any): Promise<void> {
    if (this._writer !== undefined) return rejected(new TypeError("Cannot abort a locked stream"));
    return writableStreamAbort(this, reason);
  }

  close(): Promise<void> {
    if (this._writer !== undefined) return rejected(new TypeError("Cannot close a locked stream"));
    if (closeQueuedOrInFlight(this)) return rejected(new TypeError("The stream is closing"));
    return writableStreamClose(this);
  }

  getWriter(): WritableStreamDefaultWriter<W> {
    return new WritableStreamDefaultWriter<W>(this);
  }

  get [Symbol.toStringTag](): string {
    return "WritableStream";
  }
}

/** A WritableStream made by the implementation. */
export function createWritableStream<W>(
  start: () => any,
  write: (chunk: W) => Promise<void>,
  close: () => Promise<void>,
  abort: (reason: any) => Promise<void>,
  hwm = 1,
  size: (chunk: any) => number = () => 1,
): WritableStream<W> {
  const stream = Object.create(WritableStream.prototype) as WritableStream<W>;
  stream._state = "writable";
  stream._storedError = undefined;
  stream._writer = undefined;
  stream._writeRequests = [];
  stream._inFlightWriteRequest = undefined;
  stream._closeRequest = undefined;
  stream._inFlightCloseRequest = undefined;
  stream._pendingAbortRequest = undefined;
  stream._backpressure = false;
  const controller = new WritableStreamDefaultController(KEY);
  setUpWritableController(stream, controller, start, write, close, abort, hwm, size);
  return stream;
}

export class WritableStreamDefaultController implements Queued {
  _stream!: WritableStream<any>;
  _queue: Sized[] = [];
  _queueTotalSize = 0;
  _started = false;
  _strategySize: ((chunk: any) => number) | undefined = undefined;
  _strategyHWM = 1;
  _writeAlgorithm: ((chunk: any) => Promise<void>) | undefined = undefined;
  _closeAlgorithm: (() => Promise<void>) | undefined = undefined;
  _abortAlgorithm: ((reason: any) => Promise<void>) | undefined = undefined;
  _abortController: AbortController;

  constructor(key?: symbol) {
    if (key !== KEY) throw new TypeError("Illegal constructor");
    this._abortController = new AbortController();
  }

  get signal(): AbortSignal {
    return this._abortController.signal;
  }

  error(e?: any): void {
    if (this._stream._state !== "writable") return;
    writableControllerError(this, e);
  }

  get [Symbol.toStringTag](): string {
    return "WritableStreamDefaultController";
  }
}

function setUpWritableController(
  stream: WritableStream<any>,
  c: WritableStreamDefaultController,
  start: () => any,
  write: (chunk: any) => Promise<void>,
  close: () => Promise<void>,
  abort: (reason: any) => Promise<void>,
  hwm: number,
  size: (chunk: any) => number,
): void {
  c._stream = stream;
  stream._controller = c;
  resetQueue(c);
  c._started = false;
  c._strategySize = size;
  c._strategyHWM = hwm;
  c._writeAlgorithm = write;
  c._closeAlgorithm = close;
  c._abortAlgorithm = abort;
  updateBackpressure(stream, writableBackpressure(c));
  const startResult = start();
  upon(resolved(startResult),
    () => {
      c._started = true;
      advanceQueueIfNeeded(c);
    },
    (r) => {
      c._started = true;
      dealWithRejection(stream, r);
    },
  );
}

function writableDesiredSize(c: WritableStreamDefaultController): number {
  return c._strategyHWM - c._queueTotalSize;
}

function writableBackpressure(c: WritableStreamDefaultController): boolean {
  return writableDesiredSize(c) <= 0;
}

function clearWritableAlgorithms(c: WritableStreamDefaultController): void {
  c._writeAlgorithm = undefined;
  c._closeAlgorithm = undefined;
  c._abortAlgorithm = undefined;
  c._strategySize = undefined;
}

function writableControllerError(c: WritableStreamDefaultController, e: any): void {
  const stream = c._stream;
  clearWritableAlgorithms(c);
  startErroring(stream, e);
}

function writableErrorIfNeeded(c: WritableStreamDefaultController, e: any): void {
  if (c._stream._state === "writable") writableControllerError(c, e);
}

function writableGetChunkSize(c: WritableStreamDefaultController, chunk: any): number {
  try {
    return (c._strategySize as (chunk: any) => number)(chunk);
  } catch (e) {
    writableErrorIfNeeded(c, e);
    return 1;
  }
}

function writableControllerWrite(c: WritableStreamDefaultController, chunk: any, size: number): void {
  try {
    enqueueValueWithSize(c, chunk, size);
  } catch (e) {
    writableErrorIfNeeded(c, e);
    return;
  }
  const stream = c._stream;
  if (!closeQueuedOrInFlight(stream) && stream._state === "writable") {
    updateBackpressure(stream, writableBackpressure(c));
  }
  advanceQueueIfNeeded(c);
}

function advanceQueueIfNeeded(c: WritableStreamDefaultController): void {
  const stream = c._stream;
  if (!c._started || stream._inFlightWriteRequest !== undefined) return;
  if (stream._state === "erroring") {
    finishErroring(stream);
    return;
  }
  if (c._queue.length === 0) return;
  const value = peekQueueValue(c);
  if (value === CLOSE_SENTINEL) processClose(c);
  else processWrite(c, value);
}

function processClose(c: WritableStreamDefaultController): void {
  const stream = c._stream;
  stream._inFlightCloseRequest = stream._closeRequest;
  stream._closeRequest = undefined;
  dequeueValue(c);
  const sinkClose = (c._closeAlgorithm as () => Promise<void>)();
  clearWritableAlgorithms(c);
  upon(sinkClose,
    () => {
      (stream._inFlightCloseRequest as Deferred<void>).resolve();
      stream._inFlightCloseRequest = undefined;
      if (stream._state === "erroring") {
        stream._storedError = undefined;
        if (stream._pendingAbortRequest !== undefined) {
          stream._pendingAbortRequest.promise.resolve();
          stream._pendingAbortRequest = undefined;
        }
      }
      stream._state = "closed";
      const writer = stream._writer;
      if (writer !== undefined) writer._closed.resolve(undefined);
    },
    (reason) => {
      (stream._inFlightCloseRequest as Deferred<void>).reject(reason);
      stream._inFlightCloseRequest = undefined;
      if (stream._pendingAbortRequest !== undefined) {
        stream._pendingAbortRequest.promise.reject(reason);
        stream._pendingAbortRequest = undefined;
      }
      dealWithRejection(stream, reason);
    },
  );
}

function processWrite(c: WritableStreamDefaultController, chunk: any): void {
  const stream = c._stream;
  stream._inFlightWriteRequest = stream._writeRequests.shift();
  upon((c._writeAlgorithm as (chunk: any) => Promise<void>)(chunk),
    () => {
      (stream._inFlightWriteRequest as Deferred<void>).resolve();
      stream._inFlightWriteRequest = undefined;
      const state = stream._state;
      dequeueValue(c);
      if (!closeQueuedOrInFlight(stream) && state === "writable") {
        updateBackpressure(stream, writableBackpressure(c));
      }
      advanceQueueIfNeeded(c);
    },
    (reason) => {
      if (stream._state === "writable") clearWritableAlgorithms(c);
      (stream._inFlightWriteRequest as Deferred<void>).reject(reason);
      stream._inFlightWriteRequest = undefined;
      dealWithRejection(stream, reason);
    },
  );
}

function closeQueuedOrInFlight(stream: WritableStream<any>): boolean {
  return stream._closeRequest !== undefined || stream._inFlightCloseRequest !== undefined;
}

function hasOperationMarkedInFlight(stream: WritableStream<any>): boolean {
  return stream._inFlightWriteRequest !== undefined || stream._inFlightCloseRequest !== undefined;
}

function updateBackpressure(stream: WritableStream<any>, backpressure: boolean): void {
  const writer = stream._writer;
  if (writer !== undefined && backpressure !== stream._backpressure) {
    if (backpressure) writer._ready = deferred<undefined>();
    else writer._ready.resolve(undefined);
  }
  stream._backpressure = backpressure;
}

function dealWithRejection(stream: WritableStream<any>, e: any): void {
  if (stream._state === "writable") {
    startErroring(stream, e);
    return;
  }
  finishErroring(stream);
}

function startErroring(stream: WritableStream<any>, reason: any): void {
  const c = stream._controller;
  stream._state = "erroring";
  stream._storedError = reason;
  const writer = stream._writer;
  if (writer !== undefined) writerEnsureReadyRejected(writer, reason);
  if (!hasOperationMarkedInFlight(stream) && c._started) finishErroring(stream);
}

function finishErroring(stream: WritableStream<any>): void {
  stream._state = "errored";
  const c = stream._controller;
  resetQueue(c);
  const storedError = stream._storedError;
  for (const r of stream._writeRequests) r.reject(storedError);
  stream._writeRequests = [];
  if (stream._pendingAbortRequest === undefined) {
    rejectCloseAndClosedPromiseIfNeeded(stream);
    return;
  }
  const abort = stream._pendingAbortRequest;
  stream._pendingAbortRequest = undefined;
  if (abort.wasAlreadyErroring) {
    abort.promise.reject(storedError);
    rejectCloseAndClosedPromiseIfNeeded(stream);
    return;
  }
  upon((c._abortAlgorithm as (r: any) => Promise<void>)(abort.reason),
    () => {
      abort.promise.resolve();
      rejectCloseAndClosedPromiseIfNeeded(stream);
    },
    (reason) => {
      abort.promise.reject(reason);
      rejectCloseAndClosedPromiseIfNeeded(stream);
    },
  );
  clearWritableAlgorithms(c);
}

function rejectCloseAndClosedPromiseIfNeeded(stream: WritableStream<any>): void {
  if (stream._closeRequest !== undefined) {
    stream._closeRequest.reject(stream._storedError);
    stream._closeRequest = undefined;
  }
  const writer = stream._writer;
  if (writer !== undefined) {
    writer._closed.reject(stream._storedError);
    handled(writer._closed.promise);
  }
}

export function writableStreamAbort(stream: WritableStream<any>, reason: any): Promise<void> {
  if (stream._state === "closed" || stream._state === "errored") return resolved();
  stream._controller._abortController.abort(reason);
  const state = stream._state as string;
  if (state === "closed" || state === "errored") return resolved();
  if (stream._pendingAbortRequest !== undefined) return stream._pendingAbortRequest.promise.promise;
  let wasAlreadyErroring = false;
  if (state === "erroring") {
    wasAlreadyErroring = true;
    reason = undefined;
  }
  const d = deferred<void>();
  stream._pendingAbortRequest = { promise: d, reason, wasAlreadyErroring };
  if (!wasAlreadyErroring) startErroring(stream, reason);
  return d.promise;
}

function writableStreamClose(stream: WritableStream<any>): Promise<void> {
  const state = stream._state;
  if (state === "closed" || state === "errored") {
    return rejected(new TypeError("The stream is closed or errored"));
  }
  const d = deferred<void>();
  stream._closeRequest = d;
  const writer = stream._writer;
  if (writer !== undefined && stream._backpressure && state === "writable") writer._ready.resolve(undefined);
  const c = stream._controller;
  enqueueValueWithSize(c, CLOSE_SENTINEL, 0);
  advanceQueueIfNeeded(c);
  return d.promise;
}

export class WritableStreamDefaultWriter<W = any> {
  _stream: WritableStream<W> | undefined = undefined;
  _ready: Deferred<undefined>;
  _closed: Deferred<undefined>;

  constructor(stream: WritableStream<W>) {
    if (!(stream instanceof WritableStream)) throw new TypeError("A writer needs a WritableStream");
    if (stream._writer !== undefined) throw new TypeError("The stream is locked to another writer");
    this._stream = stream;
    stream._writer = this;
    this._ready = deferred<undefined>();
    this._closed = deferred<undefined>();
    const state = stream._state;
    if (state === "writable") {
      if (!closeQueuedOrInFlight(stream) && stream._backpressure) {
        // (Pending.)
      } else {
        this._ready.resolve(undefined);
      }
    } else if (state === "erroring") {
      this._ready.reject(stream._storedError);
      handled(this._ready.promise);
    } else if (state === "closed") {
      this._ready.resolve(undefined);
      this._closed.resolve(undefined);
    } else {
      this._ready.reject(stream._storedError);
      handled(this._ready.promise);
      this._closed.reject(stream._storedError);
      handled(this._closed.promise);
    }
  }

  get closed(): Promise<undefined> {
    return this._closed.promise;
  }

  get ready(): Promise<undefined> {
    return this._ready.promise;
  }

  get desiredSize(): number | null {
    const stream = this._stream;
    if (stream === undefined) throw new TypeError("The writer has been released");
    const state = stream._state;
    if (state === "errored" || state === "erroring") return null;
    if (state === "closed") return 0;
    return writableDesiredSize(stream._controller);
  }

  abort(reason?: any): Promise<void> {
    if (this._stream === undefined) return rejected(new TypeError("The writer has been released"));
    return writableStreamAbort(this._stream, reason);
  }

  close(): Promise<void> {
    const stream = this._stream;
    if (stream === undefined) return rejected(new TypeError("The writer has been released"));
    if (closeQueuedOrInFlight(stream)) return rejected(new TypeError("The stream is closing"));
    return writableStreamClose(stream);
  }

  releaseLock(): void {
    const stream = this._stream;
    if (stream === undefined) return;
    writerRelease(this);
  }

  write(chunk?: W): Promise<void> {
    const stream = this._stream;
    if (stream === undefined) return rejected(new TypeError("The writer has been released"));
    const c = stream._controller;
    const size = writableGetChunkSize(c, chunk);
    if (stream !== this._stream) return rejected(new TypeError("The writer has been released"));
    const state = stream._state;
    if (state === "errored") return rejected(stream._storedError);
    if (closeQueuedOrInFlight(stream) || state === "closed") {
      return rejected(new TypeError("The stream is closing or closed"));
    }
    if (state === "erroring") return rejected(stream._storedError);
    const d = deferred<void>();
    stream._writeRequests.push(d);
    writableControllerWrite(c, chunk, size);
    return d.promise;
  }

  get [Symbol.toStringTag](): string {
    return "WritableStreamDefaultWriter";
  }
}

function writerRelease(writer: WritableStreamDefaultWriter<any>): void {
  const stream = writer._stream as WritableStream<any>;
  const e = new TypeError("The writer was released");
  writerEnsureReadyRejected(writer, e);
  writerEnsureClosedRejected(writer, e);
  stream._writer = undefined;
  writer._stream = undefined;
}

function writerEnsureReadyRejected(writer: WritableStreamDefaultWriter<any>, e: any): void {
  if (writer._ready.pending) {
    writer._ready.reject(e);
    handled(writer._ready.promise);
  } else {
    writer._ready = rejectedDeferred(e);
  }
}

function writerEnsureClosedRejected(writer: WritableStreamDefaultWriter<any>, e: any): void {
  if (writer._closed.pending) {
    writer._closed.reject(e);
    handled(writer._closed.promise);
  } else {
    writer._closed = rejectedDeferred(e);
  }
}

// ---- Piping ----

function readableStreamPipeTo<T>(source: ReadableStream<T>, dest: WritableStream<T>, options: PipeOptions): Promise<void> {
  const preventClose = options.preventClose;
  const preventAbort = options.preventAbort;
  const preventCancel = options.preventCancel;
  const signal = options.signal;
  const reader = new ReadableStreamDefaultReader<T>(source);
  const writer = new WritableStreamDefaultWriter<T>(dest);
  source._disturbed = true;
  let shuttingDown = false;
  // (The last write, waited for before shutting down.)
  let currentWrite: Promise<void> = resolved();
  const done = deferred<void>();

  const finalize = (isError: boolean, error?: any): void => {
    writerRelease(writer);
    readerRelease(reader);
    if (signal !== undefined) signal.removeEventListener("abort", onAbort);
    if (isError) done.reject(error);
    else done.resolve();
  };
  const waitForWrites = (): Promise<void> => {
    const old = currentWrite;
    return upon(old, () => (old !== currentWrite ? waitForWrites() : undefined));
  };
  const shutdownWithAction = (action: () => Promise<unknown>, isError: boolean, error?: any): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    const rest = (): void => {
      upon(action(),
        () => finalize(isError, error),
        (e) => finalize(true, e),
      );
    };
    if (dest._state === "writable" && !closeQueuedOrInFlight(dest)) upon(waitForWrites(), rest);
    else rest();
  };
  const shutdown = (isError: boolean, error?: any): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (dest._state === "writable" && !closeQueuedOrInFlight(dest)) upon(waitForWrites(), () => finalize(isError, error));
    else finalize(isError, error);
  };
  const onAbort = (): void => {
    const error = (signal as AbortSignal).reason;
    const actions: (() => Promise<void>)[] = [];
    if (!preventAbort) actions.push(() => (dest._state === "writable" ? writableStreamAbort(dest, error) : resolved()));
    if (!preventCancel) actions.push(() => (source._state === "readable" ? readableStreamCancel(source, error) : resolved()));
    shutdownWithAction(() => all(actions.map((a) => a())), true, error);
  };
  if (signal !== undefined) {
    if (signal.aborted) {
      onAbort();
      return done.promise;
    }
    signal.addEventListener("abort", onAbort);
  }

  // Errors forward.
  const sourceErrored = (e: any): void => {
    if (!preventAbort) shutdownWithAction(() => writableStreamAbort(dest, e), true, e);
    else shutdown(true, e);
  };
  if (source._state === "errored") sourceErrored(source._storedError);
  else upon(reader._closed.promise, undefined, sourceErrored);
  // Errors backward.
  const destErrored = (e: any): void => {
    if (!preventCancel) shutdownWithAction(() => readableStreamCancel(source, e), true, e);
    else shutdown(true, e);
  };
  if (dest._state === "errored") destErrored(dest._storedError);
  else upon(writer._closed.promise, undefined, destErrored);
  // Closing forward.
  const sourceClosed = (): void => {
    if (!preventClose) shutdownWithAction(() => writerCloseWithErrorPropagation(writer), false);
    else shutdown(false);
  };
  if (source._state === "closed") sourceClosed();
  else upon(reader._closed.promise, sourceClosed, noop);
  // Closing backward.
  if (closeQueuedOrInFlight(dest) || dest._state === "closed") {
    const e = new TypeError("The destination stream closed before all data could be piped to it");
    if (!preventCancel) shutdownWithAction(() => readableStreamCancel(source, e), true, e);
    else shutdown(true, e);
  }

  // The loop: a chunk read when the destination is ready, then written.
  const step = (): Promise<boolean> => {
    if (shuttingDown) return resolved(true);
    return upon(writer._ready.promise,
      () =>
        new Promise<boolean>((resolveRead, rejectRead) => {
          readerRead(reader, {
            chunk: (chunk) => {
              // (Written in a microtask: not within the source's enqueue.)
              currentWrite = upon(upon(resolved(), () => writer.write(chunk)), undefined, noop);
              resolveRead(false);
            },
            close: () => resolveRead(true),
            error: rejectRead,
          });
        }),
    );
  };
  const loop = new Promise<void>((resolveLoop, rejectLoop) => {
    const next = (stop: boolean): void => {
      if (stop) resolveLoop();
      else upon(step(), next, rejectLoop);
    };
    next(false);
  });
  handled(loop);
  return done.promise;
}

function writerCloseWithErrorPropagation(writer: WritableStreamDefaultWriter<any>): Promise<void> {
  const stream = writer._stream as WritableStream<any>;
  const state = stream._state;
  if (closeQueuedOrInFlight(stream) || state === "closed") return resolved();
  if (state === "errored") return rejected(stream._storedError);
  return writableStreamClose(stream);
}

// ---- TransformStream ----

export interface Transformer<I = any, O = any> {
  start?: (controller: TransformStreamDefaultController<O>) => any;
  transform?: (chunk: I, controller: TransformStreamDefaultController<O>) => any;
  flush?: (controller: TransformStreamDefaultController<O>) => any;
  cancel?: (reason?: any) => any;
  readableType?: undefined;
  writableType?: undefined;
}

export class TransformStream<I = any, O = any> {
  _readable!: ReadableStream<O>;
  _writable!: WritableStream<I>;
  _backpressure = false;
  _backpressureChange: Deferred<void> | undefined = undefined;
  _controller!: TransformStreamDefaultController<O>;

  constructor(transformer?: Transformer<I, O> | null, writableStrategy?: QueuingStrategy<I>, readableStrategy?: QueuingStrategy<O>) {
    if (transformer !== undefined && !isObject(transformer)) throw new TypeError("The transformer must be an object");
    const ws = readStrategy(writableStrategy);
    const rs = readStrategy(readableStrategy);
    // (The transformer's members, alphabetically.)
    const t = transformer === undefined ? {} : (transformer as Transformer<I, O>);
    const cancel = callback(t, "cancel");
    const flush = callback(t, "flush");
    const readableType = (t as any).readableType;
    const start = callback(t, "start");
    const transform = callback(t, "transform");
    const writableType = (t as any).writableType;
    if (readableType !== undefined) throw new RangeError("Invalid readableType");
    if (writableType !== undefined) throw new RangeError("Invalid writableType");
    const readableHWM = extractHighWaterMark(rs, 0);
    const readableSize = extractSizeAlgorithm(rs);
    const writableHWM = extractHighWaterMark(ws, 1);
    const writableSize = extractSizeAlgorithm(ws);
    const startPromise = deferred<void>();
    initTransformStream(this, startPromise.promise, writableHWM, writableSize, readableHWM, readableSize);
    const controller = new TransformStreamDefaultController<O>(KEY);
    setUpTransformController(
      this,
      controller,
      transform !== undefined
        ? (chunk) => promiseCall(() => apply(transform, t, [chunk, controller]))
        : (chunk) => {
            try {
              transformControllerEnqueue(controller, chunk as any);
              return resolved();
            } catch (e) {
              return rejected(e);
            }
          },
      flush !== undefined ? () => promiseCall(() => apply(flush, t, [controller])) : () => resolved(),
      cancel !== undefined ? (reason) => promiseCall(() => apply(cancel, t, [reason])) : () => resolved(),
    );
    // (A start that throws: the constructor throws.)
    startPromise.resolve(start !== undefined ? apply(start, t, [controller]) : undefined);
  }

  get readable(): ReadableStream<O> {
    return this._readable;
  }

  get writable(): WritableStream<I> {
    return this._writable;
  }

  get [Symbol.toStringTag](): string {
    return "TransformStream";
  }
}

function initTransformStream(
  stream: TransformStream<any, any>,
  startPromise: Promise<void>,
  writableHWM: number,
  writableSize: (chunk: any) => number,
  readableHWM: number,
  readableSize: (chunk: any) => number,
): void {
  const start = (): Promise<void> => startPromise;
  stream._writable = createWritableStream(
    start,
    (chunk) => transformSinkWrite(stream, chunk),
    () => transformSinkClose(stream),
    (reason) => transformSinkAbort(stream, reason),
    writableHWM,
    writableSize,
  );
  stream._readable = createReadableStream(
    start,
    () => transformSourcePull(stream),
    (reason) => transformSourceCancel(stream, reason),
    readableHWM,
    readableSize,
  );
  stream._backpressure = false;
  stream._backpressureChange = undefined;
  setTransformBackpressure(stream, true);
}

export class TransformStreamDefaultController<O = any> {
  _stream!: TransformStream<any, O>;
  _transformAlgorithm: ((chunk: any) => Promise<void>) | undefined = undefined;
  _flushAlgorithm: (() => Promise<void>) | undefined = undefined;
  _cancelAlgorithm: ((reason: any) => Promise<void>) | undefined = undefined;
  _finish: Deferred<void> | undefined = undefined;

  constructor(key?: symbol) {
    if (key !== KEY) throw new TypeError("Illegal constructor");
  }

  get desiredSize(): number | null {
    return controllerDesiredSize(this._stream._readable._controller);
  }

  enqueue(chunk?: O): void {
    transformControllerEnqueue(this, chunk as O);
  }

  error(reason?: any): void {
    transformControllerError(this, reason);
  }

  terminate(): void {
    transformControllerTerminate(this);
  }

  get [Symbol.toStringTag](): string {
    return "TransformStreamDefaultController";
  }
}

function setUpTransformController<O>(
  stream: TransformStream<any, O>,
  c: TransformStreamDefaultController<O>,
  transform: (chunk: any) => Promise<void>,
  flush: () => Promise<void>,
  cancel: (reason: any) => Promise<void>,
): void {
  c._stream = stream;
  stream._controller = c;
  c._transformAlgorithm = transform;
  c._flushAlgorithm = flush;
  c._cancelAlgorithm = cancel;
}

function clearTransformAlgorithms(c: TransformStreamDefaultController<any>): void {
  c._transformAlgorithm = undefined;
  c._flushAlgorithm = undefined;
  c._cancelAlgorithm = undefined;
}

function transformControllerEnqueue<O>(c: TransformStreamDefaultController<O>, chunk: O): void {
  const stream = c._stream;
  const rc = stream._readable._controller;
  if (!canCloseOrEnqueue(rc)) throw new TypeError("The readable side cannot take chunks now");
  try {
    controllerEnqueue(rc, chunk);
  } catch (e) {
    transformErrorWritableAndUnblockWrite(stream, e);
    throw stream._readable._storedError;
  }
  const backpressure = !shouldCallPullForBackpressure(rc);
  if (backpressure !== stream._backpressure) setTransformBackpressure(stream, true);
}

/** Whether the readable side has room (its desired size is positive). */
function shouldCallPullForBackpressure(rc: ReadableStreamDefaultController<any>): boolean {
  const size = controllerDesiredSize(rc);
  return size !== null && size > 0;
}

function transformControllerError(c: TransformStreamDefaultController<any>, e: any): void {
  transformStreamError(c._stream, e);
}

function transformControllerTerminate(c: TransformStreamDefaultController<any>): void {
  const stream = c._stream;
  controllerClose(stream._readable._controller);
  transformErrorWritableAndUnblockWrite(stream, new TypeError("The transform stream was terminated"));
}

function transformStreamError(stream: TransformStream<any, any>, e: any): void {
  controllerError(stream._readable._controller, e);
  transformErrorWritableAndUnblockWrite(stream, e);
}

function transformErrorWritableAndUnblockWrite(stream: TransformStream<any, any>, e: any): void {
  clearTransformAlgorithms(stream._controller);
  writableErrorIfNeeded(stream._writable._controller, e);
  unblockWrite(stream);
}

function unblockWrite(stream: TransformStream<any, any>): void {
  if (stream._backpressure) setTransformBackpressure(stream, false);
}

function setTransformBackpressure(stream: TransformStream<any, any>, backpressure: boolean): void {
  if (stream._backpressureChange !== undefined) stream._backpressureChange.resolve();
  stream._backpressureChange = deferred<void>();
  stream._backpressure = backpressure;
}

function transformPerform(c: TransformStreamDefaultController<any>, chunk: any): Promise<void> {
  return upon((c._transformAlgorithm as (chunk: any) => Promise<void>)(chunk), undefined, (r) => {
    transformStreamError(c._stream, r);
    throw r;
  });
}

function transformSinkWrite(stream: TransformStream<any, any>, chunk: any): Promise<void> {
  const c = stream._controller;
  if (stream._backpressure) {
    return upon((stream._backpressureChange as Deferred<void>).promise, () => {
      const writable = stream._writable;
      if (writable._state === "erroring") throw writable._storedError;
      return transformPerform(c, chunk);
    });
  }
  return transformPerform(c, chunk);
}

function transformSinkAbort(stream: TransformStream<any, any>, reason: any): Promise<void> {
  const c = stream._controller;
  if (c._finish !== undefined) return c._finish.promise;
  const readable = stream._readable;
  const finish = deferred<void>();
  c._finish = finish;
  const cancelPromise = (c._cancelAlgorithm as (r: any) => Promise<void>)(reason);
  clearTransformAlgorithms(c);
  upon(cancelPromise,
    () => {
      if (readable._state === "errored") {
        finish.reject(readable._storedError);
      } else {
        controllerError(readable._controller, reason);
        finish.resolve();
      }
    },
    (r) => {
      controllerError(readable._controller, r);
      finish.reject(r);
    },
  );
  return finish.promise;
}

function transformSinkClose(stream: TransformStream<any, any>): Promise<void> {
  const c = stream._controller;
  if (c._finish !== undefined) return c._finish.promise;
  const readable = stream._readable;
  const finish = deferred<void>();
  c._finish = finish;
  const flushPromise = (c._flushAlgorithm as () => Promise<void>)();
  clearTransformAlgorithms(c);
  upon(flushPromise,
    () => {
      if (readable._state === "errored") {
        finish.reject(readable._storedError);
      } else {
        controllerClose(readable._controller);
        finish.resolve();
      }
    },
    (r) => {
      controllerError(readable._controller, r);
      finish.reject(r);
    },
  );
  return finish.promise;
}

function transformSourcePull(stream: TransformStream<any, any>): Promise<void> {
  setTransformBackpressure(stream, false);
  return (stream._backpressureChange as Deferred<void>).promise;
}

function transformSourceCancel(stream: TransformStream<any, any>, reason: any): Promise<void> {
  const c = stream._controller;
  if (c._finish !== undefined) return c._finish.promise;
  const writable = stream._writable;
  const finish = deferred<void>();
  c._finish = finish;
  const cancelPromise = (c._cancelAlgorithm as (r: any) => Promise<void>)(reason);
  clearTransformAlgorithms(c);
  upon(cancelPromise,
    () => {
      if (writable._state === "errored") {
        finish.reject(writable._storedError);
      } else {
        writableErrorIfNeeded(writable._controller, reason);
        unblockWrite(stream);
        finish.resolve();
      }
    },
    (r) => {
      writableErrorIfNeeded(writable._controller, r);
      unblockWrite(stream);
      finish.reject(r);
    },
  );
  return finish.promise;
}

// ---- Bodies ----

/** A stream of `bytes` (one chunk, then closed). */
export function streamOfBytes(bytes: Uint8Array): ReadableStream<Uint8Array> {
  const stream = createReadableStream<Uint8Array>(noop, () => resolved(), () => resolved(), 0);
  if (bytes.length > 0) controllerEnqueue(stream._controller, bytes);
  controllerClose(stream._controller);
  return stream;
}

/** A body chunk's bytes: a view's or an ArrayBuffer's, or a string's UTF-8 (as Bun's). */
export function chunkBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (typeof value === "string") return encodeUtf8(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new TypeError("Expected text, ArrayBuffer or ArrayBufferView");
}

/** All of a byte stream's chunks, joined (it is read to its end). */
export async function readAllBytes(stream: ReadableStream<any>): Promise<Uint8Array> {
  const reader = new ReadableStreamDefaultReader<any>(stream);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    let b: Uint8Array;
    try {
      b = chunkBytes(value);
    } catch (e) {
      readableStreamCancel(stream, e);
      throw e;
    }
    chunks.push(b);
    size += b.length;
  }
  if (chunks.length === 1) return chunks[0];
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.length;
  }
  return all;
}

// ---- Inspection ----
//
// As Bun prints streams: their state in the style of Node's util.inspect
// (single-quoted strings; one line when it fits in 80 columns; nested
// streams two levels deep).

type Described = [string, [string, unknown][]];
const describers: [Function, (o: any) => Described][] = [];

/** How instances of `cls` print: their name and entries. */
export function describeAs(cls: Function, f: (o: any) => Described): void {
  describers.push([cls, f]);
  Object.defineProperty(cls.prototype, inspectCustom, {
    value: function (): string {
      return nodeFormat(this, 0);
    },
    writable: true,
    configurable: true,
  });
}

function nodeString(s: string): string {
  const q = s.includes("'") && !s.includes('"') ? '"' : "'";
  return q + s.replaceAll("\\", "\\\\").replaceAll(q, `\\${q}`).replaceAll("\n", "\\n") + q;
}

function nodeFormat(v: unknown, level: number): string {
  if (typeof v === "string") return nodeString(v);
  if (typeof v === "number") return Object.is(v, -0) ? "-0" : String(v);
  if (typeof v === "bigint") return `${v}n`;
  if (typeof v === "boolean" || v === undefined || v === null) return String(v);
  if (typeof v === "object") {
    for (const [cls, f] of describers) {
      if (v instanceof cls) {
        const [name, entries] = f(v);
        return nodeObject(name, entries, level);
      }
    }
    const state = promiseState(v);
    if (state === 0) return "Promise { <pending> }";
    if (state > 0) {
      const inner = nodeFormat(promiseResult(v), level + 1);
      return nodeObject("Promise", [["", state === 1 ? inner : `<rejected> ${inner}`]], 0, true);
    }
    if (v instanceof Error) {
      const frames = String(v.stack ?? "").split("\n").filter((l) => l.trim() !== "");
      return [`${v.name}: ${v.message}`, ...frames.map((l) => `    ${l.trim()}`)].join("\n");
    }
    if (ArrayBuffer.isView(v) && !(v instanceof DataView)) {
      const a = Array.from(v as unknown as ArrayLike<number>);
      const name = (v as any).constructor.name;
      return a.length === 0 ? `${name}(0) []` : `${name}(${a.length}) [ ${a.join(", ")} ]`;
    }
  }
  return String(v);
}

/** `name { entries }`, on one line when it fits (`raw`: entries are values, not `key: value`). */
function nodeObject(name: string, entries: [string, unknown][], level: number, raw = false): string {
  if (entries.length === 0 || level >= 2) return `${name} {}`;
  const parts = entries.map(([k, v]) => {
    const value = raw ? (v as string) : nodeFormat(v, level + 1);
    return (raw ? value : `${k}: ${value}`).replaceAll("\n", "\n  ");
  });
  // (Node's rule, its 10 columns of margin included.)
  let total = parts.length * 2 + 11;
  for (const p of parts) total += p.length;
  if (total + parts.length <= 80 + parts.length && !parts.some((p) => p.includes("\n"))) {
    return `${name} { ${parts.join(", ")} }`;
  }
  return `${name} {\n  ${parts.join(",\n  ")}\n}`;
}

describeAs(ReadableStream, (s: ReadableStream<any>) => [
  "ReadableStream",
  [
    ["locked", s._reader !== undefined],
    ["state", s._state],
    ["supportsBYOB", s._controller instanceof ReadableByteStreamController],
  ],
]);
describeAs(WritableStream, (s: WritableStream<any>) => [
  "WritableStream",
  [
    ["locked", s._writer !== undefined],
    ["state", s._state],
  ],
]);
describeAs(TransformStream, (s: TransformStream<any, any>) => [
  "TransformStream",
  [
    ["readable", s._readable],
    ["writable", s._writable],
    ["backpressure", s._backpressure],
  ],
]);
describeAs(ReadableStreamDefaultReader, (r: ReadableStreamDefaultReader<any>) => [
  "ReadableStreamDefaultReader",
  [
    ["stream", r._stream],
    ["readRequests", r._readRequests.length],
    ["close", r._closed.promise],
  ],
]);
describeAs(ReadableStreamBYOBReader, (r: ReadableStreamBYOBReader) => [
  "ReadableStreamBYOBReader",
  [
    ["stream", r._stream],
    ["readIntoRequests", r._readIntoRequests.length],
    ["close", r._closed.promise],
  ],
]);
describeAs(WritableStreamDefaultWriter, (w: WritableStreamDefaultWriter<any>) => [
  "WritableStreamDefaultWriter",
  [
    ["stream", w._stream],
    ["close", w._closed.promise],
    ["ready", w._ready.promise],
    ["desiredSize", w._stream === undefined ? null : w.desiredSize],
  ],
]);
describeAs(ReadableStreamDefaultController, () => ["ReadableStreamDefaultController", []]);
describeAs(ReadableByteStreamController, () => ["ReadableByteStreamController", []]);
describeAs(ReadableStreamBYOBRequest, (r: ReadableStreamBYOBRequest) => [
  "ReadableStreamBYOBRequest",
  [
    ["view", r._view],
    ["controller", r._controller],
  ],
]);
describeAs(WritableStreamDefaultController, (c: WritableStreamDefaultController) => ["WritableStreamDefaultController", [["stream", c._stream]]]);
describeAs(TransformStreamDefaultController, (c: TransformStreamDefaultController<any>) => ["TransformStreamDefaultController", [["stream", c._stream]]]);
describeAs(CountQueuingStrategy, (q: CountQueuingStrategy) => ["CountQueuingStrategy", [["highWaterMark", q._highWaterMark]]]);
describeAs(ByteLengthQueuingStrategy, (q: ByteLengthQueuingStrategy) => ["ByteLengthQueuingStrategy", [["highWaterMark", q._highWaterMark]]]);
