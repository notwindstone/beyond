// A small stand-in for the web platform tests' testharness.js: test,
// promise_test and async_test, the assertions the streams and encoding
// tests use, and a report of each test's result on standard output
// ("PASS name", "FAIL name: message", "TIMEOUT name"). It runs in Beyond and
// in Bun, so that both can be compared on the same tests.

"use strict";

const __results = [];
const __promiseTests = [];
const __asyncTests = [];
const __TIMEOUT = 3000;
// The test file running (set between files when several run in one
// program): its name prefixes its tests'.
let __file = "";

function __name(name) {
  return __file === "" ? name : `${__file}: ${name}`;
}

class AssertionError extends Error {
  constructor(message) {
    super(message);
    this.name = "AssertionError";
  }
}

function __fmt(v) {
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number" && Object.is(v, -0)) return "-0";
  if (typeof v === "symbol") return v.toString();
  if (typeof v === "function") return `function ${v.name}`;
  if (Array.isArray(v)) return `[${v.map(__fmt).join(", ")}]`;
  if (typeof v === "object" && v !== null) {
    try {
      return Object.prototype.toString.call(v) + (v instanceof Error ? ` ${v.name}: ${v.message}` : "");
    } catch {
      return "object";
    }
  }
  return String(v);
}

function __assert(cond, message) {
  if (!cond) throw new AssertionError(message);
}

function __prefix(d) {
  return d === undefined ? "" : `${d}: `;
}

function same_value(a, b) {
  return Object.is(a, b);
}

function assert_equals(actual, expected, d) {
  __assert(same_value(actual, expected), `${__prefix(d)}assert_equals: expected ${__fmt(expected)} but got ${__fmt(actual)}`);
}

function assert_not_equals(actual, expected, d) {
  __assert(!same_value(actual, expected), `${__prefix(d)}assert_not_equals: got disallowed value ${__fmt(actual)}`);
}

function assert_true(actual, d) {
  __assert(actual === true, `${__prefix(d)}assert_true: expected true got ${__fmt(actual)}`);
}

function assert_false(actual, d) {
  __assert(actual === false, `${__prefix(d)}assert_false: expected false got ${__fmt(actual)}`);
}

function assert_unreached(d) {
  throw new AssertionError(`${__prefix(d)}assert_unreached: reached unreachable code`);
}

function assert_in_array(actual, expected, d) {
  __assert(expected.indexOf(actual) !== -1, `${__prefix(d)}assert_in_array: value ${__fmt(actual)} not in array ${__fmt(expected)}`);
}

function assert_greater_than(actual, expected, d) {
  __assert(actual > expected, `${__prefix(d)}assert_greater_than: expected a number greater than ${expected} but got ${actual}`);
}

function assert_greater_than_equal(actual, expected, d) {
  __assert(actual >= expected, `${__prefix(d)}assert_greater_than_equal: expected ${actual} >= ${expected}`);
}

function assert_less_than(actual, expected, d) {
  __assert(actual < expected, `${__prefix(d)}assert_less_than: expected a number less than ${expected} but got ${actual}`);
}

function assert_less_than_equal(actual, expected, d) {
  __assert(actual <= expected, `${__prefix(d)}assert_less_than_equal: expected ${actual} <= ${expected}`);
}

function assert_class_string(object, cls, d) {
  const actual = Object.prototype.toString.call(object);
  __assert(actual === `[object ${cls}]`, `${__prefix(d)}assert_class_string: expected [object ${cls}] but got ${actual}`);
}

function assert_own_property(object, name, d) {
  __assert(Object.prototype.hasOwnProperty.call(object, name), `${__prefix(d)}assert_own_property: expected property ${__fmt(name)} missing`);
}

function assert_array_equals(actual, expected, d) {
  __assert(typeof actual === "object" && actual !== null && "length" in actual, `${__prefix(d)}assert_array_equals: value is ${__fmt(actual)}, expected array`);
  __assert(actual.length === expected.length, `${__prefix(d)}assert_array_equals: lengths differ, expected array ${__fmt(expected)} length ${expected.length}, got ${__fmt(actual)} length ${actual.length}`);
  for (let i = 0; i < actual.length; i++) {
    __assert(
      Object.prototype.hasOwnProperty.call(actual, i) === Object.prototype.hasOwnProperty.call(expected, i),
      `${__prefix(d)}assert_array_equals: property ${i}, property expected to be ${Object.prototype.hasOwnProperty.call(expected, i) ? "present" : "missing"}`,
    );
    __assert(same_value(actual[i], expected[i]), `${__prefix(d)}assert_array_equals: expected property ${i} to be ${__fmt(expected[i])} but got ${__fmt(actual[i])} (expected array ${__fmt(expected)} got ${__fmt(actual)})`);
  }
}

function assert_object_equals(actual, expected, d) {
  __assert(typeof actual === "object" && actual !== null, `${__prefix(d)}assert_object_equals: value is ${__fmt(actual)}, expected object`);
  const check = (a, e, stack) => {
    stack.push(a);
    for (const p in a) {
      __assert(Object.prototype.hasOwnProperty.call(e, p), `${__prefix(d)}assert_object_equals: unexpected property ${__fmt(p)}`);
      if (typeof a[p] === "object" && a[p] !== null) {
        if (stack.indexOf(a[p]) === -1) check(a[p], e[p], stack);
      } else {
        __assert(same_value(a[p], e[p]), `${__prefix(d)}assert_object_equals: property ${__fmt(p)} expected ${__fmt(e[p])} got ${__fmt(a[p])}`);
      }
    }
    for (const p in e) {
      __assert(Object.prototype.hasOwnProperty.call(a, p), `${__prefix(d)}assert_object_equals: expected property ${__fmt(p)} missing`);
    }
    stack.pop();
  };
  check(actual, expected, []);
}

function __checkJsError(e, constructor, d) {
  __assert(typeof e === "object" && e !== null, `${__prefix(d)}assert_throws_js: thrown value ${__fmt(e)} is not an object`);
  __assert(
    e.constructor === constructor,
    `${__prefix(d)}assert_throws_js: expected ${constructor.name} but got ${__fmt(e)}`,
  );
}

function assert_throws_js(constructor, func, d) {
  try {
    func.call(this);
  } catch (e) {
    if (e instanceof AssertionError) throw e;
    __checkJsError(e, constructor, d);
    return;
  }
  throw new AssertionError(`${__prefix(d)}assert_throws_js: ${func} did not throw`);
}

function assert_throws_exactly(exception, func, d) {
  try {
    func.call(this);
  } catch (e) {
    if (e instanceof AssertionError) throw e;
    __assert(same_value(e, exception), `${__prefix(d)}assert_throws_exactly: expected ${__fmt(exception)} but got ${__fmt(e)}`);
    return;
  }
  throw new AssertionError(`${__prefix(d)}assert_throws_exactly: ${func} did not throw`);
}

function __checkDomError(e, name, d) {
  __assert(typeof e === "object" && e !== null && e.name === name, `${__prefix(d)}assert_throws_dom: expected ${name} but got ${__fmt(e)}`);
}

function assert_throws_dom(name, func, d) {
  try {
    func.call(this);
  } catch (e) {
    if (e instanceof AssertionError) throw e;
    __checkDomError(e, name, d);
    return;
  }
  throw new AssertionError(`${__prefix(d)}assert_throws_dom: ${func} did not throw`);
}

function __rejects(t, promise, check, what, d) {
  return Promise.resolve(promise).then(
    () => {
      throw new AssertionError(`${__prefix(d)}${what}: promise fulfilled, expected a rejection`);
    },
    (e) => check(e),
  );
}

function promise_rejects_js(t, constructor, promise, d) {
  return __rejects(t, promise, (e) => __checkJsError(e, constructor, d), "promise_rejects_js", d);
}

function promise_rejects_exactly(t, exception, promise, d) {
  return __rejects(
    t,
    promise,
    (e) => __assert(same_value(e, exception), `${__prefix(d)}promise_rejects_exactly: expected ${__fmt(exception)} but got ${__fmt(e)}`),
    "promise_rejects_exactly",
    d,
  );
}

function promise_rejects_dom(t, name, promise, d) {
  return __rejects(t, promise, (e) => __checkDomError(e, name, d), "promise_rejects_dom", d);
}

function step_timeout(f, ms, ...args) {
  return setTimeout(() => f(...args), ms);
}

function setup() {}
function done() {}
function format_value(v) {
  return __fmt(v);
}

class Test {
  constructor(name) {
    this.name = name;
    this.error = null;
    this.finished = false;
    this.cleanups = [];
    this._done = null;
  }
  _fail(e) {
    if (this.error === null) this.error = e;
    if (this._done !== null) this._done();
  }
  step(f, thisObj, ...args) {
    if (this.finished) return undefined;
    try {
      return f.apply(thisObj, args);
    } catch (e) {
      this._fail(e);
      return undefined;
    }
  }
  step_func(f, thisObj) {
    return (...args) => this.step(f, thisObj, ...args);
  }
  step_func_done(f, thisObj) {
    return (...args) => {
      if (f !== undefined) this.step(f, thisObj, ...args);
      this.done();
    };
  }
  unreached_func(d) {
    return this.step_func(() => assert_unreached(d));
  }
  step_timeout(f, ms, ...args) {
    return setTimeout(this.step_func(() => f(...args)), ms);
  }
  add_cleanup(f) {
    this.cleanups.push(f);
  }
  done() {
    if (this._done !== null) this._done();
  }
}

function __message(e) {
  if (e instanceof AssertionError) return e.message;
  try {
    return `${e && e.name ? e.name : typeof e}: ${e && e.message !== undefined ? e.message : String(e)}`;
  } catch {
    return "(error)";
  }
}

async function __cleanup(t) {
  for (const f of t.cleanups) {
    try {
      await f();
    } catch (e) {
      if (t.error === null) t.error = e;
    }
  }
}

function __record(t, timedOut) {
  t.finished = true;
  if (timedOut) __results.push(`TIMEOUT ${t.name}`);
  else if (t.error !== null) __results.push(`FAIL ${t.name}: ${__message(t.error)}`);
  else __results.push(`PASS ${t.name}`);
}

/** Waits for `p`, or the timeout: whether it timed out. */
function __withTimeout(p) {
  return new Promise((resolve) => {
    const id = setTimeout(() => resolve(true), __TIMEOUT);
    p.then(
      () => {
        clearTimeout(id);
        resolve(false);
      },
      () => {
        clearTimeout(id);
        resolve(false);
      },
    );
  });
}

function test(f, name) {
  const t = new Test(__name(name));
  try {
    f(t);
  } catch (e) {
    t.error = e;
  }
  // (Cleanups of a synchronous test run at once.)
  for (const c of t.cleanups) {
    try {
      c();
    } catch (e) {
      if (t.error === null) t.error = e;
    }
  }
  __record(t, false);
}

function promise_test(f, name) {
  __promiseTests.push([f, __name(name)]);
}

function async_test(f, name) {
  if (typeof f !== "function") {
    name = f;
    f = undefined;
  }
  const t = new Test(__name(name));
  const finished = new Promise((resolve) => {
    t._done = resolve;
  });
  if (f !== undefined) t.step(f, t, t);
  __asyncTests.push(
    __withTimeout(finished).then(async (timedOut) => {
      await __cleanup(t);
      __record(t, timedOut);
    }),
  );
  return t;
}

async function __run() {
  // (After the test file's own code, as testharness.js starts promise tests.)
  await Promise.resolve();
  for (const [f, name] of __promiseTests) {
    const t = new Test(name);
    let p;
    try {
      p = Promise.resolve(f(t));
    } catch (e) {
      p = Promise.reject(e);
    }
    const settled = p.then(undefined, (e) => t._fail(e));
    const timedOut = await __withTimeout(settled);
    await __cleanup(t);
    __record(t, timedOut);
  }
  await Promise.all(__asyncTests);
  let pass = 0;
  for (const r of __results) {
    console.log(r);
    if (r.startsWith("PASS")) pass++;
  }
  console.log(`${pass}/${__results.length} passed`);
}

// What the tests ask of their global.
self.GLOBAL = { isWindow: () => false, isWorker: () => false, isShadowRealm: () => false };
self.garbageCollect = () => Promise.resolve();
