// bun:test (and `Bun.jest(path)`), as far as a program run on its own uses
// it: `describe`, `test`/`it` (`skip`, `todo`, `only`, `if`, `skipIf`,
// `each`), the hooks, `jest.fn`/`spyOn`/`mock` and a part of `expect`.
// What a file registers runs once the file has loaded (Node's test runner,
// which node:test registers its tests with, and Node's tests), one test at
// a time, in order; a test fails by throwing, rejecting, calling `done`
// with an error, or taking longer than its timeout (5 s). A failure is
// printed and the program exits with 1 when its event loop is done, as
// `bun test` does with BUN_TEST_DRAIN_EVENT_LOOP.

import { process } from "./process.ts";
import { clearTimeout, setTimeout } from "./timers.ts";

type Fn = (...args: any[]) => any;

class Scope {
  children: (Scope | Case)[] = [];
  beforeAll: Fn[] = [];
  afterAll: Fn[] = [];
  beforeEach: Fn[] = [];
  afterEach: Fn[] = [];
  constructor(
    public name: string,
    public parent: Scope | undefined,
    public skip: boolean,
    public todo: boolean,
  ) {}
  get fullName(): string {
    return this.parent && this.parent.name ? `${this.parent.fullName} > ${this.name}` : this.name;
  }
}

class Case {
  constructor(
    public name: string,
    public fn: Fn | undefined,
    public scope: Scope,
    public skip: boolean,
    public todo: boolean,
    public timeout: number,
  ) {}
}

const DEFAULT_TIMEOUT = 5000;
const root = new Scope("", undefined, false, false);
let collecting: Scope = root;
let started = false;
let failures = 0;
let passes = 0;
let skipped = 0;
// The running test's result, as node:test overrides it (jsNodeTestMarkResult).
let override: "skip" | "todo" | undefined;

function write(s: string): void {
  process.stderr.write(s);
}

function schedule(): void {
  if (!started) setTimeout(run, 0);
}

function timeoutOf(options: unknown): number {
  if (typeof options === "number") return options;
  if (options !== null && typeof options === "object") {
    const t = (options as { timeout?: unknown }).timeout;
    if (typeof t === "number") return t;
  }
  return DEFAULT_TIMEOUT;
}

function addCase(name: unknown, fn: unknown, options: unknown, skip: boolean, todo: boolean): void {
  if (typeof fn !== "function") {
    if (!todo && fn !== undefined) throw new TypeError("test() expects second argument to be a function");
    todo = todo || fn === undefined;
    fn = undefined;
  }
  collecting.children.push(new Case(String(name), fn as Fn | undefined, collecting, skip, todo, timeoutOf(options)));
  schedule();
}

function addScope(name: unknown, fn: unknown, skip: boolean, todo: boolean): void {
  const s = new Scope(typeof name === "function" ? name.name : String(name), collecting, skip || collecting.skip, todo);
  collecting.children.push(s);
  schedule();
  if (typeof fn !== "function") return;
  const prev = collecting;
  collecting = s;
  try {
    fn();
  } finally {
    collecting = prev;
  }
}

/** Each set of arguments of `table` (an array of rows), with `name` formatted as Bun formats it. */
function eachOf(table: unknown[], register: (name: string, fn: Fn, options?: unknown) => void) {
  return (name: string, fn: Fn, options?: unknown) => {
    table.forEach((row, i) => {
      const args = Array.isArray(row) ? row : [row];
      let k = 0;
      const title = String(name)
        .replace(/%[sdifjop#%]/g, m => (m === "%%" ? "%" : m === "%#" ? String(i) : String(args[k++])))
        .replace(/\$(\w+)/g, (m, key) => (row !== null && typeof row === "object" && key in (row as object) ? String((row as any)[key]) : m));
      register(title, fn.length > args.length ? (done: Fn) => fn(...args, done) : () => fn(...args), options);
    });
  };
}

function makeTest(): any {
  const test: any = (name: unknown, fn?: unknown, options?: unknown) => addCase(name, fn, options, collecting.skip, false);
  test.skip = (name: unknown, fn?: unknown, options?: unknown) => addCase(name, fn, options, true, false);
  test.todo = (name: unknown, fn?: unknown, options?: unknown) => addCase(name, fn, options, false, true);
  test.only = test;
  test.if = (cond: unknown) => (cond ? test : test.skip);
  test.skipIf = (cond: unknown) => (cond ? test.skip : test);
  test.todoIf = (cond: unknown) => (cond ? test.todo : test);
  test.failing = test;
  test.concurrent = test;
  test.serial = test;
  test.each = (table: unknown[]) => eachOf(table, (n, f, o) => test(n, f, o));
  return test;
}

const test = makeTest();

function describe(name: unknown, fn?: unknown): void {
  addScope(name, fn, false, false);
}
describe.skip = (name: unknown, fn?: unknown) => addScope(name, fn, true, false);
describe.todo = (name: unknown, fn?: unknown) => addScope(name, fn, false, true);
describe.only = describe;
describe.if = (cond: unknown) => (cond ? describe : describe.skip);
describe.skipIf = (cond: unknown) => (cond ? describe.skip : describe);
describe.todoIf = (cond: unknown) => (cond ? describe.todo : describe);
describe.concurrent = describe;
describe.serial = describe;
describe.each = (table: unknown[]) => eachOf(table, (n, f) => describe(n, f));

function beforeAll(fn: Fn): void {
  collecting.beforeAll.push(fn);
}
function afterAll(fn: Fn): void {
  collecting.afterAll.push(fn);
}
function beforeEach(fn: Fn): void {
  collecting.beforeEach.push(fn);
}
function afterEach(fn: Fn): void {
  collecting.afterEach.push(fn);
}

/** Calls a test or a hook: settled when it returns, its promise settles, or it calls `done`. */
function call(fn: Fn, timeout: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let timer: any;
    const finish = (err?: unknown) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (err === undefined || err === null) resolve();
      else reject(err);
    };
    if (timeout > 0 && timeout < 2147483647) timer = setTimeout(() => finish(new Error(`this test timed out after ${timeout}ms.`)), timeout);
    try {
      if (fn.length > 0) {
        fn((err?: unknown) => finish(err));
      } else {
        const r = fn();
        if (r !== null && typeof r === "object" && typeof r.then === "function") r.then(() => finish(), (e: unknown) => finish(e ?? new Error("rejected")));
        else finish();
      }
    } catch (e) {
      finish(e ?? new Error("thrown"));
    }
  });
}

function hasCases(s: Scope): boolean {
  return s.children.some(c => (c instanceof Scope ? hasCases(c) : true));
}

function report(name: string, err: unknown): void {
  failures++;
  write(`(fail) ${name}\n`);
  let text: string;
  try {
    text = err instanceof Error ? (err.stack ?? String(err)) : String(err);
    if (err instanceof Error && !text.includes(err.message)) text = `${err.name}: ${err.message}\n${text}`;
  } catch {
    text = "(an error that cannot be printed)";
  }
  write(`${text}\n`);
}

async function runCase(c: Case): Promise<void> {
  const name = c.scope.name ? `${c.scope.fullName} > ${c.name}` : c.name;
  if (c.skip || c.scope.skip || c.todo || c.scope.todo || c.fn === undefined) {
    skipped++;
    return;
  }
  const chain: Scope[] = [];
  for (let s: Scope | undefined = c.scope; s; s = s.parent) chain.unshift(s);
  override = undefined;
  let error: unknown;
  let failed = false;
  try {
    for (const s of chain) for (const h of s.beforeEach) await call(h, DEFAULT_TIMEOUT);
    await call(c.fn, c.timeout);
  } catch (e) {
    failed = true;
    error = e;
  }
  for (let i = chain.length - 1; i >= 0; i--) {
    for (const h of chain[i].afterEach) {
      try {
        await call(h, DEFAULT_TIMEOUT);
      } catch (e) {
        if (!failed) {
          failed = true;
          error = e;
        }
      }
    }
  }
  if (override !== undefined) skipped++;
  else if (failed) report(name, error);
  else passes++;
  override = undefined;
}

async function runScope(s: Scope): Promise<void> {
  if (!hasCases(s)) return;
  for (const h of s.beforeAll) {
    try {
      await call(h, DEFAULT_TIMEOUT);
    } catch (e) {
      report(s.fullName || "beforeAll", e);
      return;
    }
  }
  for (const c of s.children) {
    if (c instanceof Scope) await runScope(c);
    else await runCase(c);
  }
  for (const h of s.afterAll) {
    try {
      await call(h, DEFAULT_TIMEOUT);
    } catch (e) {
      report(s.fullName || "afterAll", e);
    }
  }
}

/** Runs what was registered (once): the runner calls it when the file has
 * loaded, else a timer does. */
export function run(): void {
  if (started) return;
  started = true;
  runScope(root).then(
    () => {
      if (failures > 0) {
        write(`\n ${passes} pass\n ${skipped ? `${skipped} skip\n ` : ""}${failures} fail\n`);
        process.exitCode = 1;
      }
    },
    (e: unknown) => {
      report("bun:test", e);
      process.exitCode = 1;
    },
  );
}

(globalThis as any)[Symbol.for("beyond.test.run")] = run;

// ---- node:test's natives (src/runtime/test_runner's) ----

/** jsFileGeneration: one file per program. */
export function fileGeneration(): number {
  return 1;
}

/** jsNodeTestMarkResult(todo, done): the running test is a skip (or a todo). */
export function markResult(todo: boolean, _done?: unknown): void {
  override = todo ? "todo" : "skip";
}

// ---- Mocks ----

const mocks: any[] = [];

function mockFunction(impl?: Fn): any {
  let implementation = impl;
  const once: Fn[] = [];
  let name = "mock";
  const state: any = { calls: [], contexts: [], instances: [], invocationCallOrder: [], results: [], lastCall: undefined };
  const fn: any = function (this: any, ...args: any[]) {
    state.calls.push(args);
    state.contexts.push(this);
    state.lastCall = args;
    const f = once.length > 0 ? once.shift() : implementation;
    try {
      const value = f === undefined ? undefined : new.target ? Reflect.construct(f, args, new.target) : f.apply(this, args);
      if (new.target) state.instances.push(value);
      state.results.push({ type: "return", value });
      return value;
    } catch (e) {
      state.results.push({ type: "throw", value: e });
      throw e;
    }
  };
  fn.mock = state;
  fn._isMockFunction = true;
  fn.getMockImplementation = () => implementation;
  fn.getMockName = () => name;
  fn.mockName = (n: string) => ((name = n), fn);
  fn.mockImplementation = (f: Fn) => ((implementation = f), fn);
  fn.mockImplementationOnce = (f: Fn) => (once.push(f), fn);
  fn.mockReturnValue = (v: unknown) => fn.mockImplementation(() => v);
  fn.mockReturnValueOnce = (v: unknown) => fn.mockImplementationOnce(() => v);
  fn.mockResolvedValue = (v: unknown) => fn.mockImplementation(() => Promise.resolve(v));
  fn.mockResolvedValueOnce = (v: unknown) => fn.mockImplementationOnce(() => Promise.resolve(v));
  fn.mockRejectedValue = (v: unknown) => fn.mockImplementation(() => Promise.reject(v));
  fn.mockRejectedValueOnce = (v: unknown) => fn.mockImplementationOnce(() => Promise.reject(v));
  fn.mockReturnThis = () => fn.mockImplementation(function (this: unknown) {
    return this;
  });
  fn.mockClear = () => {
    state.calls.length = state.contexts.length = state.instances.length = state.results.length = 0;
    state.lastCall = undefined;
    return fn;
  };
  fn.mockReset = () => {
    fn.mockClear();
    implementation = undefined;
    once.length = 0;
    return fn;
  };
  fn.mockRestore = () => fn.mockReset();
  mocks.push(fn);
  return fn;
}

function spyOn(obj: any, key: PropertyKey): any {
  const original = obj[key];
  if (typeof original !== "function") throw new TypeError(`spyOn: ${String(key)} is not a function`);
  const own = Object.prototype.hasOwnProperty.call(obj, key);
  const spy = mockFunction(original);
  spy.mockRestore = () => {
    if (own) obj[key] = original;
    else delete obj[key];
    spy.mockReset();
  };
  obj[key] = spy;
  return spy;
}

const jest: any = {
  fn: mockFunction,
  spyOn,
  restoreAllMocks(): void {
    for (const m of mocks.splice(0)) m.mockRestore();
  },
  clearAllMocks(): void {
    for (const m of mocks) m.mockClear();
  },
  resetAllMocks(): void {
    for (const m of mocks) m.mockReset();
  },
  isMockFunction: (f: any) => typeof f === "function" && f._isMockFunction === true,
  setTimeout(): void {},
};

const mock: any = (impl?: Fn) => mockFunction(impl);
mock.restore = jest.restoreAllMocks;
mock.clearAllMocks = jest.clearAllMocks;

// ---- expect (a part of it) ----

function deepEqual(a: unknown, b: unknown, strict: boolean): boolean {
  const m = import.meta.require("node:internal/util/deep_equal");
  return strict ? m.isDeepStrictEqual(a, b) : m.isDeepEqual(a, b);
}

function fail(message: string): never {
  const e = new Error(message);
  e.name = "AssertionError";
  throw e;
}

function show(v: unknown): string {
  return (globalThis as any).Bun.inspect(v);
}

function expect(actual: any): any {
  const make = (not: boolean): any => {
    const check = (ok: boolean, what: string) => {
      if (ok === not) fail(`expect(${show(actual)}).${not ? "not." : ""}${what}`);
    };
    const m: any = {
      toBe: (e: unknown) => check(Object.is(actual, e), `toBe(${show(e)})`),
      toEqual: (e: unknown) => check(deepEqual(actual, e, false), `toEqual(${show(e)})`),
      toStrictEqual: (e: unknown) => check(deepEqual(actual, e, true), `toStrictEqual(${show(e)})`),
      toBeTrue: () => check(actual === true, "toBeTrue()"),
      toBeFalse: () => check(actual === false, "toBeFalse()"),
      toBeTruthy: () => check(!!actual, "toBeTruthy()"),
      toBeFalsy: () => check(!actual, "toBeFalsy()"),
      toBeNull: () => check(actual === null, "toBeNull()"),
      toBeUndefined: () => check(actual === undefined, "toBeUndefined()"),
      toBeDefined: () => check(actual !== undefined, "toBeDefined()"),
      toBeNaN: () => check(Number.isNaN(actual), "toBeNaN()"),
      toBeGreaterThan: (e: number) => check(actual > e, `toBeGreaterThan(${e})`),
      toBeGreaterThanOrEqual: (e: number) => check(actual >= e, `toBeGreaterThanOrEqual(${e})`),
      toBeLessThan: (e: number) => check(actual < e, `toBeLessThan(${e})`),
      toBeLessThanOrEqual: (e: number) => check(actual <= e, `toBeLessThanOrEqual(${e})`),
      toBeInstanceOf: (c: Fn) => check(actual instanceof c, `toBeInstanceOf(${c.name})`),
      toBeTypeOf: (t: string) => check(typeof actual === t, `toBeTypeOf(${show(t)})`),
      toHaveLength: (n: number) => check(actual?.length === n, `toHaveLength(${n})`),
      toContain: (e: unknown) => check(actual?.includes?.(e) === true, `toContain(${show(e)})`),
      toMatch: (e: string | RegExp) => check(typeof e === "string" ? String(actual).includes(e) : e.test(String(actual)), `toMatch(${show(e)})`),
      toHaveProperty: (k: string) => check(actual != null && k in Object(actual), `toHaveProperty(${show(k)})`),
      toHaveBeenCalled: () => check(actual.mock.calls.length > 0, "toHaveBeenCalled()"),
      toHaveBeenCalledTimes: (n: number) => check(actual.mock.calls.length === n, `toHaveBeenCalledTimes(${n})`),
      toHaveBeenCalledWith: (...args: unknown[]) =>
        check(actual.mock.calls.some((c: unknown[]) => deepEqual(c, args, false)), `toHaveBeenCalledWith(${args.map(show).join(", ")})`),
      toThrow: (e?: unknown) => {
        let thrown = false,
          err: any;
        try {
          actual();
        } catch (x) {
          thrown = true;
          err = x;
        }
        let ok = thrown;
        if (ok && e !== undefined) {
          if (typeof e === "string") ok = String(err?.message).includes(e);
          else if (e instanceof RegExp) ok = e.test(String(err?.message));
          else if (typeof e === "function") ok = err instanceof e;
          else if (e !== null && typeof e === "object") ok = Object.keys(e).every(k => deepEqual(err?.[k], (e as any)[k], false));
        }
        check(ok, `toThrow(${e === undefined ? "" : show(e)})`);
      },
    };
    m.toThrowError = m.toThrow;
    m.toBeCalled = m.toHaveBeenCalled;
    m.toBeCalledTimes = m.toHaveBeenCalledTimes;
    return m;
  };
  const m = make(false);
  m.not = make(true);
  m.resolves = new Proxy(
    {},
    { get: (_t, k) => (...args: unknown[]) => Promise.resolve(actual).then(v => expect(v)[k](...args)) },
  );
  m.rejects = new Proxy(
    {},
    {
      get: (_t, k) => (...args: unknown[]) =>
        Promise.resolve(actual).then(
          () => fail("expected a rejection"),
          v => expect(v)[k](...args),
        ),
    },
  );
  return m;
}
expect.assertions = (_n: number): void => {};
expect.hasAssertions = (): void => {};

const api = {
  describe,
  test,
  it: test,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  expect,
  jest,
  mock,
  spyOn,
  vi: jest,
  setDefaultTimeout(_ms: number): void {},
};

/** `Bun.jest(path)`: the functions of bun:test (one set for the program). */
export function jestFor(_path?: string): typeof api {
  return api;
}

export { afterAll, afterEach, beforeAll, beforeEach, describe, expect, jest, mock, spyOn, test, test as it };
export default api;
