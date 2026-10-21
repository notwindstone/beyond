// Bun's native `node:fs` binding (`$rust("node_fs_binding.rs", "createBinding")`:
// src/runtime/node/node_fs_binding.rs and node_fs.rs, types.rs, Stat.rs,
// StatFS.rs, node_fs_stat_watcher.rs, and the C++ classes of
// NodeFSStatBinding.cpp, NodeFSStatFSBinding.cpp and NodeDirent.cpp), for
// lib/node/fs.ts, fs/promises.ts and internal/fs/*.
//
// For each operation `x`: `xSync(...)`, `x(...)` (a promise) and
// `xCb(callback, ...)` (Node's callback), with Bun's argument parsing
// (`Arguments::*::from_js`) and errors. The system calls are natives of
// crates/beyond-rt/native/fs.c (`beyond:native`), which throw Bun's
// SystemErrors and make the Stats, Dirents and StatFs.
//
// The asynchronous forms parse their arguments as the synchronous ones,
// then hand the operation to fs.c's thread pool (`fsXJob`), which settles
// the promise or calls the callback once it is done, from the event loop,
// as Bun's work pool does. (What the pool does not run is run when called,
// its result reported after the jobs queued by then.)

import {
  fsAccess,
  fsChmod,
  fsChown,
  fsClose,
  fsCopyFile,
  fsCp,
  fsDirentType,
  fsError,
  fsExists,
  fsFchmod,
  fsFchown,
  fsFdatasync,
  fsFstat,
  fsFsync,
  fsFtruncate,
  fsFutimes,
  fsInit,
  fsJobsPending,
  fsLchmod,
  fsLchown,
  fsLink,
  fsMakeDirent,
  fsMkdir,
  fsMkdtemp,
  fsOpen,
  fsRead,
  fsReadFile,
  fsReaddir,
  fsReadlink,
  fsReadv,
  fsRealpath,
  fsRename,
  fsRm,
  fsRmdir,
  fsRmdirRecursive,
  fsStat,
  fsStatfs,
  fsSymlink,
  fsTruncate,
  fsUnlink,
  fsUtimes,
  fsWatchClose,
  fsWatchRef,
  fsWatchStart,
  fsWrite,
  fsWriteFile,
  fsWriteString,
  fsWritev,
  fsAccessJob,
  fsChmodJob,
  fsChownJob,
  fsCloseJob,
  fsCopyFileJob,
  fsCpJob,
  fsExistsJob,
  fsFchmodJob,
  fsFchownJob,
  fsFdatasyncJob,
  fsFstatJob,
  fsFsyncJob,
  fsFtruncateJob,
  fsFutimesJob,
  fsLchmodJob,
  fsLchownJob,
  fsLinkJob,
  fsMkdirJob,
  fsMkdtempJob,
  fsOpenJob,
  fsPoolInit,
  fsReadFileJob,
  fsReadJob,
  fsReaddirJob,
  fsReadlinkJob,
  fsReadvJob,
  fsRealpathJob,
  fsRenameJob,
  fsRmJob,
  fsRmdirJob,
  fsRmdirRecursiveJob,
  fsStatJob,
  fsStatfsJob,
  fsSymlinkJob,
  fsTruncateJob,
  fsUnlinkJob,
  fsUtimesJob,
  fsWriteFileJob,
  fsWriteJob,
  fsWriteStringJob,
  fsWritevJob,
  promiseNew,
  promiseSettle,
} from "beyond:native";
import { AbortSignal, reportError } from "beyond:events";
import { Buffer } from "beyond:node/buffer";
import { clearInterval, setInterval } from "beyond:timers";
import { URL } from "beyond:url";
import {
  $ERR_INVALID_ARG_TYPE,
  $ERR_INVALID_ARG_VALUE,
  $makeAbortError,
  codedRangeError,
  codedTypeError,
  determineSpecificType,
} from "node:internal/intrinsics";

// ---- Constants (Linux's) ----

const O_RDONLY = 0,
  O_WRONLY = 1,
  O_RDWR = 2,
  O_CREAT = 0o100,
  O_EXCL = 0o200,
  O_TRUNC = 0o1000,
  O_APPEND = 0o2000,
  O_SYNC = 0o4010000;
const FLAG_W = O_TRUNC | O_CREAT | O_WRONLY;
const FLAG_A = O_APPEND | O_CREAT | O_WRONLY;

const S_IFMT = 0o170000,
  S_IFREG = 0o100000,
  S_IFDIR = 0o040000,
  S_IFCHR = 0o020000,
  S_IFBLK = 0o060000,
  S_IFIFO = 0o010000,
  S_IFLNK = 0o120000,
  S_IFSOCK = 0o140000;

// Bun's Encoding, as fs.c numbers them.
const ENC_UTF8 = 0,
  ENC_UTF16LE = 2,
  ENC_LATIN1 = 3,
  ENC_ASCII = 4,
  ENC_BASE64 = 5,
  ENC_BASE64URL = 6,
  ENC_HEX = 7,
  ENC_BUFFER = 8;
// (Buffer's names, to encode a string.)
const encodingNames = ["utf8", "utf16le", "utf16le", "latin1", "ascii", "base64", "base64url", "hex", "utf8"];

// fsReaddir's kinds.
const RD_NAMES = 0,
  RD_DIRENTS = 1,
  RD_BUFFERS = 2;

const MAX_SAFE = 9007199254740991;

// ---- Errors ----

/** Bun's `throwInvalidArguments`: a TypeError ERR_INVALID_ARG_TYPE of `message`. */
function invalidArgs(message: string): Error {
  return codedTypeError("ERR_INVALID_ARG_TYPE", message);
}

/** Bun's `throw_invalid_argument_type_value`. */
function argType(name: string, expected: string, value: unknown): Error {
  return codedTypeError(
    "ERR_INVALID_ARG_TYPE",
    `The "${name}" argument must be of type ${expected}. Received ${determineSpecificType(value)}`,
  );
}

/** Bun's `throw_range_error`. */
function rangeError(field: string, value: unknown, min?: number, max?: number, must?: string): Error {
  if (must === undefined) {
    if (min !== undefined && max !== undefined) must = `>= ${min} and <= ${max}`;
    else if (max !== undefined) must = `<= ${max}`;
    else must = `>= ${min}`;
  }
  return codedRangeError("ERR_OUT_OF_RANGE", `The value of "${field}" is out of range. It must be ${must}. Received ${String(value)}`);
}

function outOfRange(name: string, must: string, value: unknown): Error {
  return codedRangeError("ERR_OUT_OF_RANGE", `The value of "${name}" is out of range. It must be ${must}. Received ${String(value)}`);
}

/** Bun's validators::validate_integer (its messages: "argument" for any name). */
function validateInteger(value: any, name: string, min: number = -MAX_SAFE, max: number = MAX_SAFE): number {
  if (typeof value !== "number") throw argType(name, "number", value);
  // (An int32 needs no `%`, a call of fmod.)
  if ((value | 0) !== value && value % 1 !== 0) throw outOfRange(name, "an integer", value);
  if (value < min || value > max) throw outOfRange(name, `>= ${min} && <= ${max}`, value);
  return value;
}

/** The path with a NUL byte, as Bun's Valid::path_null_bytes reports it. */
function nullBytes(p: string | Uint8Array): Error {
  const s = typeof p === "string" ? p : (Buffer.from(p.buffer, p.byteOffset, p.byteLength) as any).toString("utf8");
  return codedTypeError(
    "ERR_INVALID_ARG_VALUE",
    `The argument 'path' must be a string, Uint8Array, or URL without null bytes. Received ${JSON.stringify(s)}`,
  );
}

function hasNul(p: string | Uint8Array): boolean {
  return typeof p === "string" ? p.indexOf("\u0000") !== -1 : p.indexOf(0) !== -1;
}

/** nullBytes of whichever of two paths has the NUL. */
function nullBytes2(a: string | Uint8Array, b: string | Uint8Array): Error {
  return nullBytes(hasNul(a) ? a : b);
}

function encodingError(value: unknown): Error {
  return codedTypeError("ERR_INVALID_ARG_VALUE", `encoding '${String(value)}' is an invalid encoding`);
}

// ---- Arguments (Bun's from_js helpers) ----

function isObject(v: any): boolean {
  return v !== null && (typeof v === "object" || typeof v === "function");
}

function isStringLike(v: any): boolean {
  return typeof v === "string" || v instanceof String;
}

/** A Uint8Array of the bytes of an ArrayBuffer or a view. */
function bytesOf(v: any): Uint8Array {
  if (v instanceof Uint8Array) return v;
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  return new Uint8Array(v);
}

function isBufferLike(v: any): boolean {
  return ArrayBuffer.isView(v) || v instanceof ArrayBuffer || (typeof SharedArrayBuffer !== "undefined" && v instanceof SharedArrayBuffer);
}

const URL_MESSAGE = 'URL must be a non-empty "file:" path';

/** A `file:` URL's path (Bun's DOMURL::fileSystemPath). */
function urlPath(u: any): string {
  if (u.protocol !== "file:") throw codedTypeError("ERR_INVALID_URL_SCHEME", URL_MESSAGE);
  const host = u.hostname;
  if (host !== "" && host !== "localhost") throw codedTypeError("ERR_INVALID_FILE_URL_HOST", URL_MESSAGE);
  const pathname = u.pathname;
  if (/%2f/i.test(pathname)) throw codedTypeError("ERR_INVALID_FILE_URL_PATH", URL_MESSAGE);
  let path: string;
  try {
    path = decodeURIComponent(pathname);
  } catch {
    path = pathname;
  }
  if (path === "") throw codedTypeError("ERR_INVALID_ARG_VALUE", URL_MESSAGE);
  return path;
}

/** PathLike::from_js: a string, or the bytes of a Uint8Array, DataView or
 * ArrayBuffer, or a `file:` URL's path; undefined for anything else. */
function pathLike(v: any): string | Uint8Array | undefined {
  if (typeof v === "string") return v;
  let u: Uint8Array;
  if (v instanceof Uint8Array) u = v;
  else if (v instanceof DataView) u = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  else if (v instanceof ArrayBuffer) u = new Uint8Array(v);
  else if (v instanceof String) return String(v);
  else if (v instanceof URL) return urlPath(v);
  else return undefined;
  if (u.byteLength === 0) throw invalidArgs("Invalid path buffer: can't be empty");
  return u;
}

function requiredPath(v: any, name: string): string | Uint8Array {
  const p = typeof v === "string" ? v : pathLike(v);
  if (p === undefined) throw invalidArgs(`${name} must be a string or TypedArray`);
  return p;
}

/** PathOrFileDescriptor::from_js: an fd (validated), or a path. */
function pathOrFd(v: any): number | string | Uint8Array | undefined {
  if (typeof v === "number") return fdArg(v);
  return pathLike(v);
}

/** Fd::from_js_validated, required. */
function fdArg(v: any): number {
  if (typeof v === "number" && (v | 0) === v && v >= 0) return v;
  if (typeof v !== "number") throw $ERR_INVALID_ARG_TYPE("fd", "number", v);
  if (v % 1 !== 0) throw outOfRange("fd", "an integer", v);
  throw outOfRange("fd", ">= 0 && <= 2147483647", v);
}

/** Encoding::from: a name's encoding (any case), or -1. */
function encodingOf(s: string): number {
  switch (s) {
    case "utf8":
    case "utf-8":
      return ENC_UTF8;
    case "buffer":
      return ENC_BUFFER;
    case "hex":
      return ENC_HEX;
    case "ucs2":
    case "ucs-2":
    case "utf16le":
    case "utf16-le":
      return ENC_UTF16LE;
    case "ascii":
      return ENC_ASCII;
    case "base64":
      return ENC_BASE64;
    case "base64url":
      return ENC_BASE64URL;
    case "latin1":
    case "binary":
      return ENC_LATIN1;
  }
  const lower = s.toLowerCase();
  return lower === s ? -1 : encodingOf(lower);
}

/** Encoding::assert. */
function assertEncoding(value: any, def: number): number {
  if (!value) return def;
  if (typeof value !== "string") {
    if (!(value instanceof String)) throw encodingError(value);
    value = String(value);
    if (value === "") return def;
  }
  const e = encodingOf(value);
  if (e < 0) throw encodingError(value);
  return e;
}

/** get_encoding: an options object's `encoding`. */
function optionEncoding(options: any, def: number): number {
  const e = options.encoding;
  return e === undefined ? def : assertEncoding(e, def);
}

/** parse_encoding_arg: an encoding, or an object with one; anything else is ignored. */
function encodingArg(v: any, def: number): number {
  if (isStringLike(v)) return assertEncoding(v, def);
  if (isObject(v)) return optionEncoding(v, def);
  return def;
}

/** get_boolean_strict. */
function boolOption(options: any, name: string): boolean | undefined {
  const v = options[name];
  if (v === undefined) return undefined;
  if (typeof v === "boolean") return v;
  throw invalidArgs(`The "${name}" property must be of type boolean, got ${typeof v}`);
}

/** The flags of Node's stringToFlags, or -1. */
function stringFlags(s: string): number {
  switch (s) {
    case "r":
      return O_RDONLY;
    case "w":
      return O_TRUNC | O_CREAT | O_WRONLY;
    case "a":
      return O_APPEND | O_CREAT | O_WRONLY;
    case "r+":
      return O_RDWR;
    case "w+":
      return O_TRUNC | O_CREAT | O_RDWR;
    case "a+":
      return O_APPEND | O_CREAT | O_RDWR;
    case "rs":
    case "sr":
      return O_RDONLY | O_SYNC;
    case "wx":
    case "xw":
      return O_TRUNC | O_CREAT | O_WRONLY | O_EXCL;
    case "ax":
    case "xa":
      return O_APPEND | O_CREAT | O_WRONLY | O_EXCL;
    case "as":
    case "sa":
      return O_APPEND | O_CREAT | O_WRONLY | O_SYNC;
    case "rs+":
    case "sr+":
      return O_RDWR | O_SYNC;
    case "wx+":
    case "xw+":
      return O_TRUNC | O_CREAT | O_RDWR | O_EXCL;
    case "ax+":
    case "xa+":
      return O_APPEND | O_CREAT | O_RDWR | O_EXCL;
    case "as+":
    case "sa+":
      return O_APPEND | O_CREAT | O_RDWR | O_SYNC;
  }
  return -1;
}

/** FileSystemFlags::from_js (undefined and null: `def`). */
function flagsArg(v: any, def: number): number {
  if (typeof v === "number") {
    if (v % 1 !== 0) throw outOfRange("flags", "an integer", v);
    if (v < -2147483648 || v > 2147483647) throw outOfRange("flags", ">= -2147483648 && <= 2147483647", v);
    return v < 0 ? 0 : v;
  }
  if (v === undefined || v === null) return def;
  if (typeof v === "string") {
    const f = stringFlags(v);
    if (f >= 0) return f;
  }
  throw $ERR_INVALID_ARG_VALUE("flags", v);
}

function uint32Arg(v: number, name: string): number {
  if (v % 1 !== 0) throw outOfRange(name, "an integer", v);
  if (v < 0 || v > 4294967295) throw outOfRange(name, ">= 0 && <= 4294967295", v);
  return v;
}

/** mode_from_js: a mode, or undefined for undefined and null. */
function modeArg(v: any): number | undefined {
  if (typeof v === "number") return uint32Arg(v, "mode");
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw argType("mode", "number", v);
  if (!/^[0-7]+$/.test(v)) throw $ERR_INVALID_ARG_VALUE("mode", v, "must be a 32-bit unsigned integer or an octal string");
  return uint32Arg(parseInt(v, 8), "mode");
}

/** FileSystemFlags::from_js_number_only (access's and copyFile's mode). */
function modeNumberOnly(v: any): number {
  if (typeof v !== "number") {
    if (v === undefined || v === null) return 0;
    throw invalidArgs("mode must be int32 or null/undefined");
  }
  if (!(v >= 0 && v <= 7)) throw codedRangeError("ERR_OUT_OF_RANGE", "mode is out of range: >= 0 and <= 7");
  return v | 0;
}

/** i52::offset_from_js: a position, if a number that is a safe integer >= 0, else -1. */
function offsetArg(v: any): number {
  if (typeof v === "number" && v % 1 === 0 && v >= 0 && v <= MAX_SAFE) return v;
  return -1;
}

// time_like_from_js: the seconds and nanoseconds of a time (nanoseconds -1:
// now), in timeSec and timeNsec.
let timeSec = 0,
  timeNsec = 0;

function fromSeconds(s: number): void {
  let sec = Math.floor(s);
  let nsec = (s - sec) * 1e9;
  if (nsec >= 1e9) {
    nsec -= 1e9;
    sec += 1;
  }
  timeSec = sec;
  timeNsec = Math.trunc(nsec);
}

function timeLike(v: any): boolean {
  if (typeof v === "number") {
    if (!isFinite(v)) return false;
    if (v < 0) {
      timeSec = 0;
      timeNsec = -1;
    } else {
      fromSeconds(v);
    }
    return true;
  }
  if (v instanceof Date) {
    const ms = v.getTime();
    if (!isFinite(ms)) return false;
    const sec = Math.floor(ms / 1000);
    timeSec = sec;
    timeNsec = Math.trunc((ms - sec * 1000) * 1e6);
    return true;
  }
  if (typeof v === "string") {
    const s = +v;
    if (!isFinite(s)) return false;
    fromSeconds(s);
    return true;
  }
  return false;
}

// ---- Asynchronous forms ----

// Set to 1 once a call's arguments are parsed: what it throws after is the
// operation's error, which the asynchronous forms report (as Bun reports
// the errors of the work it schedules); before, an argument's error, which
// they throw.
let phase = 0;
// Whether the call runs for an asynchronous form.
let asyncCall = false;
// What an asynchronous call's job settles: whether a callback (else a
// promise), and it. An operation returns JOB once its job is queued.
let jobKind = false;
let jobTarget: any = undefined;
const JOB: any = { job: true };
// The signal of an asynchronous call's options (readFile's, writeFile's):
// aborted by when it completes, it fails with an AbortError (Bun's
// AsyncFSTask: HAVE_ABORT_SIGNAL).
let callSignal: any = undefined;

// Completions to report: (kind: 0 a promise, 1 a callback; its promise or
// callback; the value; whether an error; the call's signal), in order.
const completions: any[] = [];
let completionsHead = 0;
let flushing = false;

function complete(kind: number, target: any, value: any, isError: boolean, signal?: any): void {
  completions.push(kind, target, value, isError, signal);
  if (!flushing) {
    flushing = true;
    queueMicrotask(flushCompletions);
  }
}

// One completion a job: after the jobs queued before it (and those its
// callback queues), as a task of the event loop would run.
function flushCompletions(): void {
  if (fsJobsPending()) {
    queueMicrotask(flushCompletions);
    return;
  }
  const i = completionsHead;
  const kind = completions[i],
    target = completions[i + 1],
    signal = completions[i + 4];
  let value = completions[i + 2],
    isError = completions[i + 3];
  completions[i + 1] = completions[i + 2] = completions[i + 4] = undefined;
  completionsHead = i + 5;
  if (signal !== undefined && !isError && signal.aborted) {
    value = $makeAbortError(undefined, { cause: signal.reason });
    isError = true;
  }
  if (completionsHead === completions.length) {
    completions.length = 0;
    completionsHead = 0;
    flushing = false;
  } else {
    queueMicrotask(flushCompletions);
  }
  if (kind === 0) promiseSettle(target, value, isError);
  else if (isError) target(value);
  else target(null, value);
}

function runAsync(fn: Function, args: any[]): Promise<any> {
  phase = 0;
  asyncCall = true;
  callSignal = undefined;
  const p = promiseNew();
  jobKind = false;
  jobTarget = p;
  let value: any;
  try {
    value = fn.apply(undefined, args);
  } catch (err) {
    asyncCall = false;
    callSignal = undefined;
    jobTarget = undefined;
    if (phase === 0) throw err;
    phase = 0;
    complete(0, p, err, true);
    return p;
  }
  asyncCall = false;
  phase = 0;
  jobTarget = undefined;
  if (value !== JOB) complete(0, p, value, false, callSignal);
  callSignal = undefined;
  return p;
}

function runCallback(fn: Function, callback: any, args: any[]): void {
  if (typeof callback !== "function") throw invalidArgs("callback must be a function");
  phase = 0;
  asyncCall = true;
  callSignal = undefined;
  jobKind = true;
  jobTarget = callback;
  let value: any;
  try {
    value = fn.apply(undefined, args);
  } catch (err) {
    asyncCall = false;
    callSignal = undefined;
    jobTarget = undefined;
    if (phase === 0) throw err;
    phase = 0;
    complete(1, callback, err, true);
    return;
  }
  asyncCall = false;
  phase = 0;
  jobTarget = undefined;
  if (value !== JOB) complete(1, callback, value, false, callSignal);
  callSignal = undefined;
}

/** An aborted signal's error: the operation's (Bun's AbortError for the
 * asynchronous forms, EINTR for the synchronous ones). */
function abortedError(signal: any): Error {
  phase = 1;
  if (asyncCall) return $makeAbortError(undefined, { cause: signal.reason });
  return fsError(4, "access") as Error;
}

function signalOption(options: any): any {
  const s = options.signal;
  if (!s) return undefined;
  if (!(s instanceof AbortSignal)) throw argType("signal", "AbortSignal", s);
  return s;
}

// ---- Stats, BigIntStats, StatFs, BigIntStatFs, Dirent ----

function isThisObject(o: any): boolean {
  return o !== null && (typeof o === "object" || typeof o === "function");
}

/** fs.Stats: `new Stats(dev, mode, nlink, uid, gid, rdev, blksize, ino, size,
 * blocks, atimeMs, mtimeMs, ctimeMs, birthtimeMs)` (Node's order), its
 * properties in Bun's order. */
function Stats(
  this: any,
  dev?: any,
  mode?: any,
  nlink?: any,
  uid?: any,
  gid?: any,
  rdev?: any,
  blksize?: any,
  ino?: any,
  size?: any,
  blocks?: any,
  atimeMs?: any,
  mtimeMs?: any,
  ctimeMs?: any,
  birthtimeMs?: any,
): any {
  const o = new.target === undefined ? Object.create(StatsPrototype) : this;
  o.dev = dev;
  o.ino = ino;
  o.mode = mode;
  o.nlink = nlink;
  o.uid = uid;
  o.gid = gid;
  o.rdev = rdev;
  o.size = size;
  o.blksize = blksize;
  o.blocks = blocks;
  o.atimeMs = atimeMs;
  o.mtimeMs = mtimeMs;
  o.ctimeMs = ctimeMs;
  o.birthtimeMs = birthtimeMs;
  return o;
}

function nsToMs(ns: any): number {
  return Number(BigInt.asIntN(64, BigInt(ns))) / 1000000;
}

/** BigIntStats: as Stats, of nanoseconds (its milliseconds made of them). */
function BigIntStats(
  this: any,
  dev?: any,
  mode?: any,
  nlink?: any,
  uid?: any,
  gid?: any,
  rdev?: any,
  blksize?: any,
  ino?: any,
  size?: any,
  blocks?: any,
  atimeNs?: any,
  mtimeNs?: any,
  ctimeNs?: any,
  birthtimeNs?: any,
): any {
  const atimeMs = nsToMs(atimeNs),
    mtimeMs = nsToMs(mtimeNs),
    ctimeMs = nsToMs(ctimeNs),
    birthtimeMs = nsToMs(birthtimeNs);
  const o = new.target === undefined ? Object.create(BigIntStatsPrototype) : this;
  o.dev = dev;
  o.ino = ino;
  o.mode = mode;
  o.nlink = nlink;
  o.uid = uid;
  o.gid = gid;
  o.rdev = rdev;
  o.size = size;
  o.blksize = blksize;
  o.blocks = blocks;
  o.atimeMs = atimeMs;
  o.mtimeMs = mtimeMs;
  o.ctimeMs = ctimeMs;
  o.birthtimeMs = birthtimeMs;
  o.atimeNs = atimeNs;
  o.mtimeNs = mtimeNs;
  o.ctimeNs = ctimeNs;
  o.birthtimeNs = birthtimeNs;
  return o;
}

const StatsPrototype: any = Stats.prototype;
const BigIntStatsPrototype: any = BigIntStats.prototype;

function modeOf(o: any, big: boolean): number {
  const m = o.mode;
  return big ? Number(BigInt.asIntN(64, BigInt(m))) : m | 0;
}

function defineStatsPrototype(proto: any, ctor: Function, name: string, big: boolean): void {
  delete proto.constructor;
  const test = (fnName: string, type: number) => {
    const fn = {
      [fnName](this: any): any {
        if (!isThisObject(this)) return undefined;
        return (modeOf(this, big) & S_IFMT) === type;
      },
    }[fnName];
    Object.defineProperty(proto, fnName, { value: fn, writable: true, enumerable: true, configurable: true });
  };
  test("isBlockDevice", S_IFBLK);
  test("isCharacterDevice", S_IFCHR);
  test("isDirectory", S_IFDIR);
  test("isFIFO", S_IFIFO);
  test("isFile", S_IFREG);
  test("isSocket", S_IFSOCK);
  test("isSymbolicLink", S_IFLNK);
  for (const key of ["atime", "mtime", "ctime", "birthtime"]) {
    const msKey = key + "Ms";
    Object.defineProperty(proto, key, {
      get(this: any) {
        if (!isThisObject(this)) return undefined;
        const v = this[msKey];
        const date = new Date(big ? Number(v) : +v);
        if (this !== proto) Object.defineProperty(this, key, { value: date, writable: true, enumerable: true, configurable: true });
        return date;
      },
      set(this: any, value: any) {
        if (isThisObject(this)) Object.defineProperty(this, key, { value, writable: true, enumerable: true, configurable: true });
      },
      enumerable: true,
      configurable: true,
    });
  }
  Object.defineProperty(proto, "constructor", { value: ctor, writable: true, enumerable: false, configurable: true });
  Object.defineProperty(proto, Symbol.toStringTag, { value: name, writable: false, enumerable: false, configurable: true });
  Object.defineProperty(ctor, "prototype", { writable: false });
  Object.defineProperty(ctor, "length", { value: 0 });
}

defineStatsPrototype(StatsPrototype, Stats, "Stats", false);
defineStatsPrototype(BigIntStatsPrototype, BigIntStats, "BigIntStats", true);

/** StatFs: `new StatFs(type, bsize, frsize, blocks, bfree, bavail, files, ffree)`. */
function StatFs(this: any, type?: any, bsize?: any, frsize?: any, blocks?: any, bfree?: any, bavail?: any, files?: any, ffree?: any): any {
  const o = new.target === undefined ? Object.create(StatFsPrototype) : this;
  o.type = type;
  o.bsize = bsize;
  o.frsize = frsize;
  o.blocks = blocks;
  o.bfree = bfree;
  o.bavail = bavail;
  o.files = files;
  o.ffree = ffree;
  return o;
}

function BigIntStatFs(this: any, type?: any, bsize?: any, frsize?: any, blocks?: any, bfree?: any, bavail?: any, files?: any, ffree?: any): any {
  const o = new.target === undefined ? Object.create(BigIntStatFsPrototype) : this;
  o.type = type;
  o.bsize = bsize;
  o.frsize = frsize;
  o.blocks = blocks;
  o.bfree = bfree;
  o.bavail = bavail;
  o.files = files;
  o.ffree = ffree;
  return o;
}

const StatFsPrototype: any = StatFs.prototype;
const BigIntStatFsPrototype: any = BigIntStatFs.prototype;
for (const [proto, ctor, name] of [
  [StatFsPrototype, StatFs, "StatFs"],
  [BigIntStatFsPrototype, BigIntStatFs, "BigIntStatFs"],
] as [any, Function, string][]) {
  // (Bun's prototypes have no `constructor`.)
  delete proto.constructor;
  Object.defineProperty(proto, Symbol.toStringTag, { value: name, writable: false, enumerable: false, configurable: true });
  Object.defineProperty(ctor, "prototype", { writable: false });
  Object.defineProperty(ctor, "length", { value: 0 });
}

/** fs.Dirent: `new Dirent(name, type, path)`; its type is kept where only
 * native code sees it, as Bun keeps it in a private field. */
function Dirent(this: any, name: any, type: any, path: any): any {
  if (new.target === undefined) {
    throw codedTypeError("ERR_ILLEGAL_CONSTRUCTOR", "Dirent constructor cannot be called as a function");
  }
  return fsMakeDirent(new.target.prototype, name, type, path);
}

const DirentPrototype: any = Dirent.prototype;
{
  delete DirentPrototype.constructor;
  const test = (fnName: string, type: number) => {
    const fn = {
      [fnName](this: any): boolean {
        return fsDirentType(this) === type;
      },
    }[fnName];
    Object.defineProperty(DirentPrototype, fnName, { value: fn, writable: true, enumerable: true, configurable: true });
  };
  test("isBlockDevice", 7);
  test("isCharacterDevice", 6);
  test("isDirectory", 2);
  test("isFIFO", 4);
  test("isFile", 1);
  test("isSocket", 5);
  test("isSymbolicLink", 3);
  Object.defineProperty(DirentPrototype, "constructor", { value: Dirent, writable: true, enumerable: false, configurable: true });
  Object.defineProperty(DirentPrototype, Symbol.toStringTag, { value: "Dirent", writable: false, enumerable: false, configurable: true });
  Object.defineProperty(Dirent, "prototype", { writable: false });
}

// The natives make these of the shapes of templates (Bun's structures).
{
  const stats: any = Object.create(StatsPrototype);
  const bigStats: any = Object.create(BigIntStatsPrototype);
  for (const k of ["dev", "ino", "mode", "nlink", "uid", "gid", "rdev", "size", "blksize", "blocks", "atimeMs", "mtimeMs", "ctimeMs", "birthtimeMs"]) {
    stats[k] = 0;
    bigStats[k] = 0;
  }
  for (const k of ["atimeNs", "mtimeNs", "ctimeNs", "birthtimeNs"]) bigStats[k] = 0;
  const statFs: any = Object.create(StatFsPrototype);
  const bigStatFs: any = Object.create(BigIntStatFsPrototype);
  for (const k of ["type", "bsize", "frsize", "blocks", "bfree", "bavail", "files", "ffree"]) {
    statFs[k] = 0;
    bigStatFs[k] = 0;
  }
  fsInit(Buffer.prototype, DirentPrototype, stats, bigStats, statFs, bigStatFs);
  // (The AbortError of a readFile or writeFile whose signal was aborted by when it was done.)
  fsPoolInit((reason: any) => $makeAbortError(undefined, { cause: reason }));
}

// ---- Operations ----
//
// Each `xSync` parses its arguments as Bun's Arguments::X::from_js, sets
// `phase`, and calls the native; the natives return null for a path with a
// NUL byte (an argument's error).

function accessSync(path: any, mode?: any): null {
  const p = requiredPath(path, "path");
  const m = modeNumberOnly(mode);
  phase = 1;
  if ((asyncCall ? fsAccessJob(p, m, jobKind, jobTarget) : fsAccess(p, m)) === null) {
    phase = 0;
    throw nullBytes(p);
  }
  return asyncCall ? JOB : null;
}

function readFileSync(path: any, options?: any): any {
  const p = typeof path === "string" ? path : pathOrFd(path);
  if (p === undefined) throw invalidArgs("path must be a string or a file descriptor");
  let encoding = ENC_BUFFER,
    flag = O_RDONLY;
  if (options !== undefined) {
    if (options === "utf8") {
      encoding = ENC_UTF8;
    } else if (isStringLike(options)) {
      encoding = assertEncoding(options, ENC_BUFFER);
    } else if (isObject(options)) {
      encoding = optionEncoding(options, ENC_BUFFER);
      const f = options.flag;
      if (f) flag = flagsArg(f, flag);
      const signal = signalOption(options);
      if (asyncCall) callSignal = signal;
      if (signal !== undefined && signal.aborted) {
        if (asyncCall) throw abortedError(signal);
        // (The synchronous form opens the file first.)
        if (typeof p !== "number") fsClose(openFileSync(p, flag | 0o400, 0o666));
        throw abortedError(signal);
      }
    }
  }
  phase = 1;
  const r = asyncCall ? fsReadFileJob(p, flag, encoding, callSignal, jobKind, jobTarget) : fsReadFile(p, flag, encoding);
  if (r === null) {
    phase = 0;
    throw nullBytes(p as string | Uint8Array);
  }
  return asyncCall ? JOB : r;
}

function openFileSync(p: string | Uint8Array, flags: number, mode: number): number {
  const fd = fsOpen(p, flags, mode);
  if (fd === null) {
    phase = 0;
    throw nullBytes(p);
  }
  return fd;
}

/** A job of an operation of one path: JOB, or Bun's error for a NUL byte. */
function pathJob(r: any, p: string | Uint8Array): any {
  if (r === null) {
    phase = 0;
    throw nullBytes(p);
  }
  return JOB;
}

/** The same, of two paths. */
function pathsJob(r: any, a: string | Uint8Array, b: string | Uint8Array): any {
  if (r === null) {
    phase = 0;
    throw nullBytes2(a, b);
  }
  return JOB;
}

/** writeFile and appendFile (`defaultFlag`: w or a). */
function writeFileWith(path: any, data: any, options: any, defaultFlag: number): undefined {
  const p = typeof path === "string" ? path : pathOrFd(path);
  if (p === undefined) throw invalidArgs("path must be a string or a file descriptor");
  let encoding = typeof data === "string" ? ENC_UTF8 : ENC_BUFFER;
  let flag = defaultFlag,
    mode = 0o666,
    flush = false;
  let signal: any;
  if (options !== undefined) {
    if (isStringLike(options)) {
      encoding = assertEncoding(options, encoding);
    } else if (isObject(options)) {
      encoding = optionEncoding(options, encoding);
      const f = options.flag;
      if (f) flag = flagsArg(f, flag);
      const m = options.mode;
      if (m) {
        const mm = modeArg(m);
        if (mm !== undefined) mode = mm;
      }
      signal = signalOption(options);
      const fl = options.flush;
      if (fl !== undefined) {
        if (typeof fl === "boolean" || fl === null) flush = fl === true;
        else throw argType("flush", "boolean", fl);
      }
    }
  }
  // (String objects are not data.)
  let d: string | Uint8Array;
  if (typeof data === "string") {
    d = encoding === ENC_UTF8 || encoding === ENC_BUFFER || data === "" ? data : (Buffer.from(data, encodingNames[encoding] as any) as Uint8Array);
  } else if (data instanceof Uint8Array) {
    d = data;
  } else if (isBufferLike(data)) {
    d = bytesOf(data);
  } else {
    throw invalidArgs('The "data" argument must be of type string or an instance of Buffer, TypedArray, or DataView');
  }
  if (asyncCall) callSignal = signal;
  if (signal !== undefined && signal.aborted) {
    if (asyncCall) throw abortedError(signal);
    if (typeof p !== "number") fsClose(openFileSync(p, flag & ~O_TRUNC, mode));
    throw abortedError(signal);
  }
  phase = 1;
  if (asyncCall) {
    if (fsWriteFileJob(p, d, flag, mode, flush, callSignal, jobKind, jobTarget) === null) {
      phase = 0;
      throw nullBytes(p as string | Uint8Array);
    }
    return JOB;
  }
  if (fsWriteFile(p, d, flag, mode, flush) === null) {
    phase = 0;
    throw nullBytes(p as string | Uint8Array);
  }
  return undefined;
}

function writeFileSync(path: any, data?: any, options?: any): undefined {
  return writeFileWith(path, data, options, FLAG_W);
}

function appendFileSync(path: any, data?: any, options?: any): undefined {
  return writeFileWith(path, data, options, FLAG_A);
}

function closeSync(fd: any): undefined {
  const f = fdArg(fd);
  phase = 1;
  if (asyncCall) return fsCloseJob(f, jobKind, jobTarget) && JOB;
  fsClose(f);
  return undefined;
}

function copyFileSync(src: any, dest: any, mode?: any): undefined {
  const s = requiredPath(src, "src");
  const d = requiredPath(dest, "dest");
  const m = modeNumberOnly(mode);
  phase = 1;
  if (asyncCall) return pathsJob(fsCopyFileJob(s, d, m, jobKind, jobTarget), s, d);
  if (fsCopyFile(s, d, m) === null) {
    phase = 0;
    throw nullBytes2(s, d);
  }
  return undefined;
}

function cpSync(...args: any[]): undefined {
  const s = requiredPath(args[0], "src");
  const d = requiredPath(args[1], "dest");
  const n = args.length;
  const recursive = n > 2 ? !!args[2] : false;
  const errorOnExist = n > 3 ? !!args[3] : false;
  const force = n > 4 ? !!args[4] : true;
  phase = 1;
  if (asyncCall) return pathsJob(fsCpJob(s, d, recursive, errorOnExist, force, jobKind, jobTarget), s, d);
  if (fsCp(s, d, recursive, errorOnExist, force) === null) {
    phase = 0;
    throw nullBytes2(s, d);
  }
  return undefined;
}

function existsSync(path: any): boolean {
  const p = typeof path === "string" ? path : pathLike(path);
  if (p === undefined) return false;
  phase = 1;
  if (asyncCall) return pathJob(fsExistsJob(p, jobKind, jobTarget), p);
  const r = fsExists(p);
  if (r === null) {
    phase = 0;
    throw nullBytes(p);
  }
  return r;
}

/** chown, lchown (Bun's errors for a missing uid or gid: the forms' own). */
function chownWith(args: any[], native: Function, job: Function): undefined {
  const p = requiredPath(args[0], "path");
  if (args.length < 2) throw invalidArgs("uid is required");
  const uid = validateInteger(args[1], "uid", -1, 4294967295) >>> 0;
  if (args.length < 3) throw invalidArgs("gid is required");
  const gid = validateInteger(args[2], "gid", -1, 4294967295) >>> 0;
  phase = 1;
  if (asyncCall) return pathJob(job(p, uid, gid, jobKind, jobTarget), p);
  if (native(p, uid, gid) === null) {
    phase = 0;
    throw nullBytes(p);
  }
  return undefined;
}

function chownSync(...args: any[]): undefined {
  return chownWith(args, fsChown, fsChownJob);
}

function lchownSync(...args: any[]): undefined {
  return chownWith(args, fsLchown, fsLchownJob);
}

function fchownSync(...args: any[]): undefined {
  const fd = fdArg(args[0]);
  if (args.length < 2) throw invalidArgs("uid is required");
  const uid = validateInteger(args[1], "uid", -1, 4294967295) >>> 0;
  if (args.length < 3) throw invalidArgs("gid is required");
  const gid = validateInteger(args[2], "gid", -1, 4294967295) >>> 0;
  phase = 1;
  if (asyncCall) return fsFchownJob(fd, uid, gid, jobKind, jobTarget) && JOB;
  fsFchown(fd, uid, gid);
  return undefined;
}

function requiredMode(mode: any): number {
  const m = modeArg(mode);
  if (m === undefined) throw invalidArgs(`The "mode" property must be of type number, got ${typeof mode}`);
  return m;
}

function chmodSync(path: any, mode?: any): undefined {
  const p = requiredPath(path, "path");
  const m = requiredMode(mode);
  phase = 1;
  if (asyncCall) return pathJob(fsChmodJob(p, m, jobKind, jobTarget), p);
  if (fsChmod(p, m) === null) {
    phase = 0;
    throw nullBytes(p);
  }
  return undefined;
}

function lchmodSync(path: any, mode?: any): undefined {
  const p = requiredPath(path, "path");
  const m = requiredMode(mode);
  phase = 1;
  if (asyncCall) return pathJob(fsLchmodJob(p, m, jobKind, jobTarget), p);
  if (fsLchmod(p, m) === null) {
    phase = 0;
    throw nullBytes(p);
  }
  return undefined;
}

function fchmodSync(fd: any, mode?: any): undefined {
  const f = fdArg(fd);
  const m = requiredMode(mode);
  phase = 1;
  if (asyncCall) return fsFchmodJob(f, m, jobKind, jobTarget) && JOB;
  fsFchmod(f, m);
  return undefined;
}

function fdatasyncSync(fd: any): undefined {
  const f = fdArg(fd);
  phase = 1;
  if (asyncCall) return fsFdatasyncJob(f, jobKind, jobTarget) && JOB;
  fsFdatasync(f);
  return undefined;
}

function fsyncSync(fd: any): undefined {
  const f = fdArg(fd);
  phase = 1;
  if (asyncCall) return fsFsyncJob(f, jobKind, jobTarget) && JOB;
  fsFsync(f);
  return undefined;
}

/** The `bigint` of stat options (an object that is not a function). */
function bigintOption(options: any): boolean {
  if (options !== null && typeof options === "object") {
    const b = boolOption(options, "bigint");
    if (b !== undefined) return b;
  }
  return false;
}

function fstatSync(fd: any, options?: any): any {
  const f = fdArg(fd);
  const big = options === undefined ? false : bigintOption(options);
  phase = 1;
  if (asyncCall) return fsFstatJob(f, big, jobKind, jobTarget) && JOB;
  return fsFstat(f, big);
}

function statWith(path: any, options: any, lstat: boolean): any {
  const p = typeof path === "string" ? path : requiredPath(path, "path");
  let big = false,
    throwIfNoEntry = true;
  if (options !== undefined && options !== null && typeof options === "object") {
    const t = boolOption(options, "throwIfNoEntry");
    if (t !== undefined) throwIfNoEntry = t;
    const b = boolOption(options, "bigint");
    if (b !== undefined) big = b;
  }
  phase = 1;
  if (asyncCall) return pathJob(fsStatJob(p, lstat, big, throwIfNoEntry, jobKind, jobTarget), p);
  const r = fsStat(p, lstat, big, throwIfNoEntry);
  if (r === null) {
    phase = 0;
    throw nullBytes(p);
  }
  return r;
}

function statSync(path: any, options?: any): any {
  return statWith(path, options, false);
}

function lstatSync(path: any, options?: any): any {
  return statWith(path, options, true);
}

function statfsSync(path: any, options?: any): any {
  const p = requiredPath(path, "path");
  const big = options === undefined ? false : bigintOption(options);
  phase = 1;
  if (asyncCall) return pathJob(fsStatfsJob(p, big, jobKind, jobTarget), p);
  const r = fsStatfs(p, big);
  if (r === null) {
    phase = 0;
    throw nullBytes(p);
  }
  return r;
}

function ftruncateSync(fd: any, len?: any): undefined {
  const f = fdArg(fd);
  const l = len === undefined ? 0 : Math.max(validateInteger(len, "len", -2251799813685248, 4503599627370495), 0);
  phase = 1;
  if (asyncCall) return fsFtruncateJob(f, l, jobKind, jobTarget) && JOB;
  fsFtruncate(f, l);
  return undefined;
}

function truncateSync(path: any, len?: any): undefined {
  const p = pathOrFd(path);
  if (p === undefined) throw invalidArgs("path must be a string or TypedArray");
  const l = len === undefined ? 0 : Math.max(validateInteger(len, "len"), 0);
  phase = 1;
  if (asyncCall) return typeof p === "number" ? fsFtruncateJob(p, l, jobKind, jobTarget) && JOB : pathJob(fsTruncateJob(p, l, jobKind, jobTarget), p);
  if (typeof p === "number") {
    fsFtruncate(p, l);
  } else if (fsTruncate(p, l) === null) {
    phase = 0;
    throw nullBytes(p);
  }
  return undefined;
}

/** The atime and mtime of utimes, lutimes and futimes (`args[first]` on). */
function timesOf(args: any[], first: number): [number, number, number, number] {
  if (args.length <= first) throw invalidArgs("atime is required");
  if (!timeLike(args[first])) throw invalidArgs("atime must be a number or a Date");
  const as = timeSec,
    ans = timeNsec;
  if (args.length <= first + 1) throw invalidArgs("mtime is required");
  if (!timeLike(args[first + 1])) throw invalidArgs("mtime must be a number or a Date");
  return [as, ans, timeSec, timeNsec];
}

function utimesWith(args: any[], nofollow: boolean): undefined {
  const p = requiredPath(args[0], "path");
  const t = timesOf(args, 1);
  phase = 1;
  if (asyncCall) return pathJob(fsUtimesJob(p, t[0], t[1], t[2], t[3], nofollow, jobKind, jobTarget), p);
  if (fsUtimes(p, t[0], t[1], t[2], t[3], nofollow) === null) {
    phase = 0;
    throw nullBytes(p);
  }
  return undefined;
}

function utimesSync(...args: any[]): undefined {
  return utimesWith(args, false);
}

function lutimesSync(...args: any[]): undefined {
  return utimesWith(args, true);
}

function futimesSync(...args: any[]): undefined {
  const fd = fdArg(args[0]);
  const t = timesOf(args, 1);
  phase = 1;
  if (asyncCall) return fsFutimesJob(fd, t[0], t[1], t[2], t[3], jobKind, jobTarget) && JOB;
  fsFutimes(fd, t[0], t[1], t[2], t[3]);
  return undefined;
}

function linkSync(existingPath: any, newPath?: any): undefined {
  const a = requiredPath(existingPath, "oldPath");
  const b = requiredPath(newPath, "newPath");
  phase = 1;
  if (asyncCall) return pathsJob(fsLinkJob(a, b, jobKind, jobTarget), a, b);
  if (fsLink(a, b) === null) {
    phase = 0;
    throw nullBytes2(a, b);
  }
  return undefined;
}

function symlinkSync(target: any, path?: any, type?: any): undefined {
  const a = requiredPath(target, "target");
  const b = requiredPath(path, "path");
  if (type !== undefined && type !== null) {
    if (typeof type === "string") {
      if (type !== "dir" && type !== "file" && type !== "junction") {
        throw codedTypeError("ERR_INVALID_ARG_VALUE", `Symlink type must be one of "dir", "file", or "junction". Received "${type}"`);
      }
    } else {
      throw codedTypeError("ERR_INVALID_ARG_VALUE", 'Symlink type must be one of "dir", "file", or "junction".');
    }
  }
  phase = 1;
  if (asyncCall) return pathsJob(fsSymlinkJob(a, b, jobKind, jobTarget), a, b);
  if (fsSymlink(a, b) === null) {
    phase = 0;
    throw nullBytes2(a, b);
  }
  return undefined;
}

function mkdirSync(path: any, options?: any): string | undefined {
  const p = typeof path === "string" ? path : requiredPath(path, "path");
  let recursive = false,
    mode = 0o777;
  if (options !== undefined) {
    if (isObject(options)) {
      const r = boolOption(options, "recursive");
      if (r !== undefined) recursive = r;
      const m = options.mode;
      if (m !== undefined) {
        const mm = modeArg(m);
        if (mm !== undefined) mode = mm;
      }
    }
    if (typeof options === "number" || typeof options === "string") {
      const mm = modeArg(options);
      if (mm !== undefined) mode = mm;
    }
  }
  phase = 1;
  if (asyncCall) return pathJob(fsMkdirJob(p, mode, recursive, jobKind, jobTarget), p);
  const r = fsMkdir(p, mode, recursive);
  if (r === null) {
    phase = 0;
    throw nullBytes(p);
  }
  return r;
}

function mkdtempSync(prefix: any, options?: any): any {
  const p = typeof prefix === "string" ? prefix : pathLike(prefix);
  if (p === undefined) throw argType("prefix", "string, Buffer, or URL", prefix);
  const encoding = options === undefined ? ENC_UTF8 : encodingArg(options, ENC_UTF8);
  phase = 1;
  if (asyncCall) return pathJob(fsMkdtempJob(p, encoding, jobKind, jobTarget), p);
  const r = fsMkdtemp(p, encoding);
  if (r === null) {
    phase = 0;
    throw nullBytes(p);
  }
  return r;
}

function openSync(path: any, flags?: any, mode?: any): number {
  const p = typeof path === "string" ? path : requiredPath(path, "path");
  const f = flagsArg(flags, O_RDONLY);
  let m = 0o666;
  if (mode !== undefined) {
    const mm = modeArg(mode);
    if (mm !== undefined) m = mm;
  }
  phase = 1;
  if (asyncCall) return pathJob(fsOpenJob(p, f, m, jobKind, jobTarget), p);
  return openFileSync(p, f, m);
}

function readSync(fd: any, buffer?: any, offset?: any, length?: any, position?: any): number {
  const f = fdArg(fd);
  if (!isBufferLike(buffer)) {
    throw codedTypeError(
      "ERR_INVALID_ARG_TYPE",
      `The "buffer" argument must be an instance of Buffer, TypedArray, or DataView. Received ${determineSpecificType(buffer)}`,
    );
  }
  const off = offset === undefined || offset === null ? 0 : validateInteger(offset, "offset", 0, MAX_SAFE);
  const lengthFloat = +length;
  const u8 = bytesOf(buffer);
  if (lengthFloat === 0) return 0;
  const bufLen = u8.byteLength;
  if (bufLen === 0) throw codedTypeError("ERR_INVALID_ARG_VALUE", "The argument 'buffer' is empty and cannot be written.");
  if (lengthFloat % 1 !== 0) throw rangeError("length", lengthFloat, undefined, undefined, "an integer");
  const len = Math.trunc(lengthFloat);
  if (len > 0 && len > bufLen) throw rangeError("length", lengthFloat, undefined, bufLen);
  if (off + len > bufLen) throw rangeError("length", lengthFloat, undefined, Math.max(bufLen - off, 0));
  if (len < 0) throw rangeError("length", lengthFloat, 0);
  let pos = -1;
  if (position !== undefined && position !== null) {
    if (typeof position === "number") {
      pos = validateInteger(position, "position", -1, MAX_SAFE);
    } else if (typeof position === "bigint") {
      const maxPosition = 9223372036854775807n - BigInt(len);
      if (position < -1n || position > maxPosition) throw rangeError("position", position, -1, maxPosition as any);
      pos = position as any;
    } else {
      throw argType("position", "number or bigint", position);
    }
  }
  phase = 1;
  if (asyncCall) return fsReadJob(f, u8, off, len, pos, jobKind, jobTarget) && JOB;
  return fsRead(f, u8, off, len, pos);
}

function writeSync(fd: any, buffer?: any, offsetOrPosition?: any, lengthOrEncoding?: any, position?: any): number {
  const f = fdArg(fd);
  if (typeof buffer === "string") {
    // fs.write(fd, string[, position[, encoding]])
    const pos = offsetArg(offsetOrPosition);
    if (lengthOrEncoding !== undefined && isStringLike(lengthOrEncoding)) {
      const encoding = assertEncoding(lengthOrEncoding, ENC_UTF8);
      if (encoding !== ENC_UTF8 && encoding !== ENC_BUFFER) {
        const bytes = Buffer.from(buffer, encodingNames[encoding] as any) as Uint8Array;
        phase = 1;
        if (asyncCall) return fsWriteJob(f, bytes, 0, bytes.byteLength, pos, jobKind, jobTarget) && JOB;
        return fsWrite(f, bytes, 0, bytes.byteLength, pos);
      }
    }
    phase = 1;
    if (asyncCall) return fsWriteStringJob(f, buffer, pos, jobKind, jobTarget) && JOB;
    return fsWriteString(f, buffer, pos);
  }
  if (!isBufferLike(buffer)) throw argType("buffer", "string or TypedArray", buffer);
  // fs.write(fd, buffer[, offset[, length[, position]]])
  const u8 = buffer instanceof Uint8Array ? buffer : bytesOf(buffer);
  // (The length -1: the rest of the buffer. fsWrite checks the bounds,
  // which saves reading a Buffer's byteLength, and returns null when they
  // are out of the buffer for writeBoundsError.)
  let off = 0,
    len = -1,
    pos = -1;
  if (offsetOrPosition !== undefined && offsetOrPosition !== null && typeof offsetOrPosition !== "function") {
    off = validateInteger(offsetOrPosition, "offset", 0, MAX_SAFE);
    const t = typeof lengthOrEncoding;
    if (t === "number" || t === "bigint") {
      len =
        t === "bigint"
          ? Number(BigInt.asIntN(64, lengthOrEncoding))
          : (lengthOrEncoding | 0) === lengthOrEncoding
            ? lengthOrEncoding
            : Math.trunc(lengthOrEncoding) || 0;
      if (len < 0) throw writeBoundsError(u8, off, len);
      const tp = typeof position;
      if (tp === "number" || tp === "bigint") pos = offsetArg(position);
    }
  }
  phase = 1;
  const r = asyncCall ? fsWriteJob(f, u8, off, len, pos, jobKind, jobTarget) : fsWrite(f, u8, off, len, pos);
  if (r === null) {
    phase = 0;
    throw writeBoundsError(u8, off, len);
  }
  return asyncCall ? JOB : r;
}

/** Bun's error for an offset or a length out of the buffer (length -1: the rest). */
function writeBoundsError(u8: Uint8Array, off: number, len: number): Error {
  const bufLen = u8.byteLength;
  if (off > bufLen) return rangeError("offset", off, undefined, bufLen);
  const maxLen = Math.min(bufLen - off, 2147483647);
  return rangeError("length", len, 0, maxLen);
}

/** VectorArrayBuffer::from_js: the buffers as Uint8Arrays. */
function vectorArg(v: any): Uint8Array[] {
  if (!Array.isArray(v)) throw invalidArgs("Expected ArrayBufferView[]");
  let out: Uint8Array[] | undefined;
  for (let i = 0; i < v.length; i++) {
    const e = v[i];
    if (e instanceof Uint8Array) {
      if (out !== undefined) out.push(e);
      continue;
    }
    if (!ArrayBuffer.isView(e)) throw invalidArgs("Expected ArrayBufferView[]");
    if (out === undefined) out = v.slice(0, i);
    out.push(bytesOf(e));
  }
  return out ?? v;
}

function readvSync(fd: any, buffers?: any, position?: any): number {
  const f = fdArg(fd);
  const bufs = vectorArg(buffers);
  const pos = offsetArg(position);
  phase = 1;
  if (asyncCall) return fsReadvJob(f, bufs, pos, jobKind, jobTarget) && JOB;
  return fsReadv(f, bufs, pos);
}

function writevSync(fd: any, buffers?: any, position?: any): number {
  const f = fdArg(fd);
  const bufs = vectorArg(buffers);
  const pos = offsetArg(position);
  phase = 1;
  if (asyncCall) return fsWritevJob(f, bufs, pos, jobKind, jobTarget) && JOB;
  return fsWritev(f, bufs, pos);
}

function readdirSync(path: any, options?: any): any[] {
  const p = typeof path === "string" ? path : requiredPath(path, "path");
  let encoding = ENC_UTF8,
    withFileTypes = false,
    recursive = false;
  if (options !== undefined) {
    if (isStringLike(options)) {
      encoding = assertEncoding(options, ENC_UTF8);
    } else if (isObject(options)) {
      encoding = optionEncoding(options, ENC_UTF8);
      const r = boolOption(options, "recursive");
      if (r !== undefined) recursive = r;
      const w = boolOption(options, "withFileTypes");
      if (w !== undefined) withFileTypes = w;
    }
  }
  const kind = encoding === ENC_BUFFER ? RD_BUFFERS : withFileTypes ? RD_DIRENTS : RD_NAMES;
  phase = 1;
  if (asyncCall) return pathJob(fsReaddirJob(p, kind, recursive, encoding, jobKind, jobTarget), p);
  const r = fsReaddir(p, kind, recursive, encoding);
  if (r === null) {
    phase = 0;
    throw nullBytes(p);
  }
  return r;
}

function readlinkSync(path: any, options?: any): any {
  const p = typeof path === "string" ? path : requiredPath(path, "path");
  const encoding = options === undefined ? ENC_UTF8 : encodingArg(options, ENC_UTF8);
  phase = 1;
  if (asyncCall) return pathJob(fsReadlinkJob(p, encoding, jobKind, jobTarget), p);
  const r = fsReadlink(p, encoding);
  if (r === null) {
    phase = 0;
    throw nullBytes(p);
  }
  return r;
}

function realpathWith(path: any, options: any, native: boolean): any {
  const p = typeof path === "string" ? path : requiredPath(path, "path");
  const encoding = options === undefined ? ENC_UTF8 : encodingArg(options, ENC_UTF8);
  phase = 1;
  if (asyncCall) return pathJob(fsRealpathJob(p, encoding, native, jobKind, jobTarget), p);
  const r = fsRealpath(p, encoding, native);
  if (r === null) {
    phase = 0;
    throw nullBytes(p);
  }
  return r;
}

function realpathSync(path: any, options?: any): any {
  return realpathWith(path, options, false);
}

function realpathNativeSync(path: any, options?: any): any {
  return realpathWith(path, options, true);
}

function renameSync(oldPath: any, newPath?: any): undefined {
  const a = typeof oldPath === "string" ? oldPath : pathLike(oldPath);
  if (a === undefined) throw argType("oldPath", "string or an instance of Buffer or URL", oldPath);
  const b = typeof newPath === "string" ? newPath : pathLike(newPath);
  if (b === undefined) throw argType("newPath", "string or an instance of Buffer or URL", newPath);
  phase = 1;
  if (asyncCall) return pathsJob(fsRenameJob(a, b, jobKind, jobTarget), a, b);
  if (fsRename(a, b) === null) {
    phase = 0;
    throw nullBytes2(a, b);
  }
  return undefined;
}

/** RmDir::from_js_impl's options: [recursive, force, maxRetries,
 * retryDelay] (`strict`: rm's, where an own `undefined` is a value). */
function rmOptions(options: any, strict: boolean): [boolean, boolean, number, number] {
  let recursive = false,
    force = false,
    maxRetries = 0,
    retryDelay = 100;
  if (options === undefined) return [recursive, force, maxRetries, retryDelay];
  if (!isObject(options)) throw invalidArgs('The "options" argument must be of type object.');
  const has = (name: string) => (strict ? Object.prototype.hasOwnProperty.call(options, name) : options[name] !== undefined);
  if (has("recursive")) {
    const v = options.recursive;
    if (typeof v !== "boolean") throw invalidArgs('The "options.recursive" property must be of type boolean.');
    recursive = v;
  }
  if (has("force")) {
    const v = options.force;
    if (typeof v !== "boolean") throw invalidArgs('The "options.force" property must be of type boolean.');
    force = v;
  }
  if (has("retryDelay")) retryDelay = validateInteger(options.retryDelay, "options.retryDelay", 0, 4294967295);
  if (has("maxRetries")) maxRetries = validateInteger(options.maxRetries, "options.maxRetries", 0, 4294967295);
  return [recursive, force, maxRetries, retryDelay];
}

/** bun:internal-for-testing's internal/fs/utils.stringToFlags: the flags
 * fs.open parses. */
export function stringToFlagsForTesting(flags?: any): number {
  return flagsArg(flags, O_RDONLY);
}

/** internal/fs/utils.validateRmOptionsSync: the options fs.rm parses. */
export function rmOptionsForTesting(path?: any, options?: any): any {
  requiredPath(path, "path");
  const o = rmOptions(options, true);
  return { retryDelay: o[3], maxRetries: o[2], recursive: o[0], force: o[1] };
}

function rmSync(path: any, options?: any): undefined {
  const p = requiredPath(path, "path");
  const o = rmOptions(options, true);
  phase = 1;
  if (asyncCall) return pathJob(fsRmJob(p, o[0], o[1], jobKind, jobTarget), p);
  if (fsRm(p, o[0], o[1]) === null) {
    phase = 0;
    throw nullBytes(p);
  }
  return undefined;
}

function rmdirSync(path: any, options?: any): undefined {
  const p = requiredPath(path, "path");
  const o = rmOptions(options, false);
  phase = 1;
  if (asyncCall) return pathJob(o[0] ? fsRmdirRecursiveJob(p, jobKind, jobTarget) : fsRmdirJob(p, jobKind, jobTarget), p);
  if ((o[0] ? fsRmdirRecursive(p) : fsRmdir(p)) === null) {
    phase = 0;
    throw nullBytes(p);
  }
  return undefined;
}

function unlinkSync(path: any): undefined {
  const p = typeof path === "string" ? path : requiredPath(path, "path");
  phase = 1;
  if (asyncCall) return pathJob(fsUnlinkJob(p, jobKind, jobTarget), p);
  if (fsUnlink(p) === null) {
    phase = 0;
    throw nullBytes(p);
  }
  return undefined;
}

// ---- watch, watchFile ----

// watch: Bun's FSWatcher (node_fs_watcher.rs) over fs.c's inotify watchers
// (Bun's path_watcher.rs), whose events reach watchEvent.

/** A watch option that must be a boolean when given (Bun's messages). */
function watchBool(options: any, name: string, def: boolean): boolean {
  const v = options[name];
  if (v === undefined || v === null) return def;
  if (typeof v !== "boolean") throw invalidArgs(`${name} must be a boolean`);
  return v;
}

const watchers = new Map<number, FSWatcher>();

// fs.c's dispatcher: an event of watcher `id` (kind 0 "rename", 1 "change",
// 2 an error, closing the watcher if `close`).
function watchEvent(id: number, kind: number, value: any, close: boolean): void {
  const w = watchers.get(id);
  if (w !== undefined) w._event(kind, value, close);
}

/** Bun's native FSWatcher: what fs.watch's watcher (internal/fs/watch.ts)
 * holds; the listener gets (eventType, filename), ("error", error), and
 * ("close") once closed. */
class FSWatcher {
  #id = 0;
  #listener: Function;
  #persistent: boolean;
  #closed = false;
  #signal: any;
  #onAbort: (() => void) | undefined;

  constructor(listener: Function, persistent: boolean, signal: any) {
    this.#listener = listener;
    this.#persistent = persistent;
    this.#signal = signal;
  }

  _start(id: number, walkError: any): void {
    this.#id = id;
    watchers.set(id, this);
    const signal = this.#signal;
    if (signal !== undefined) {
      this.#onAbort = () => this.#abort();
      signal.addEventListener("abort", this.#onAbort, { once: true });
    }
    // (A directory of the tree that could not be watched: an error, the
    // watcher going on.)
    if (walkError !== undefined) complete(1, () => this._event(2, walkError, false), undefined, true);
  }

  /** An aborted signal: the watcher is not started, the abort reported later. */
  _startAborted(): void {
    complete(1, () => this.#abort(), undefined, true);
  }

  _event(kind: number, value: any, close: boolean): void {
    if (this.#closed) return;
    this.#call(kind === 0 ? "rename" : kind === 1 ? "change" : "error", value);
    if (kind === 2 && close) this.close();
  }

  // (Bun's run_callback: what the listener throws is uncaught.)
  #call(type: string, value: any, fromAbort?: boolean): void {
    try {
      if (fromAbort) this.#listener(type, value, true);
      else this.#listener(type, value);
    } catch (e) {
      reportError(e);
    }
  }

  #abort(): void {
    if (this.#closed) return;
    const reason = this.#signal?.reason;
    this.#call("error", reason ?? $makeAbortError(), true);
    this.close();
  }

  #detach(): void {
    if (this.#id !== 0) {
      watchers.delete(this.#id);
      fsWatchClose(this.#id);
    }
    if (this.#onAbort !== undefined) this.#signal.removeEventListener("abort", this.#onAbort);
    this.#onAbort = undefined;
    this.#signal = undefined;
  }

  ref(): undefined {
    if (!this.#closed && !this.#persistent) {
      this.#persistent = true;
      if (this.#id !== 0) fsWatchRef(this.#id, true);
    }
    return undefined;
  }

  unref(): undefined {
    if (this.#persistent) {
      this.#persistent = false;
      if (this.#id !== 0) fsWatchRef(this.#id, false);
    }
    return undefined;
  }

  close(): undefined {
    if (this.#closed) return undefined;
    this.#closed = true;
    this.#detach();
    this.#call("close", undefined);
    return undefined;
  }
}

/** Bun's Arguments::Watch::from_js and NodeFS::watch. */
function watch(path: any, options?: any, listener?: any): FSWatcher {
  const p = pathLike(path);
  if (p === undefined) throw invalidArgs("filename must be a string or TypedArray");
  let persistent = true,
    recursive = false,
    encoding = ENC_UTF8,
    signal: any;
  let fn: any;
  if (options !== undefined) {
    if (options !== null && typeof options === "object") {
      persistent = watchBool(options, "persistent", true);
      watchBool(options, "verbose", false);
      const e = options.encoding;
      if (e !== undefined) encoding = assertEncoding(e, ENC_UTF8);
      recursive = watchBool(options, "recursive", false);
      const sg = options.signal;
      if (sg) {
        if (!(sg instanceof AbortSignal)) throw invalidArgs("signal is not of type AbortSignal");
        signal = sg;
      }
      if (listener !== undefined) {
        if (typeof listener !== "function") throw invalidArgs('Expected "listener" callback to be a function');
        fn = listener;
      }
    } else {
      if (typeof options !== "function") throw invalidArgs('Expected "listener" callback to be a function');
      fn = options;
    }
  }
  if (fn === undefined) throw invalidArgs('Expected "listener" callback');
  const w = new FSWatcher(fn, persistent, signal);
  if (signal !== undefined && signal.aborted) {
    w._startAborted();
    return w;
  }
  const r = fsWatchStart(p, recursive, persistent, encoding, watchEvent);
  if (r === null) throw nullBytes(p);
  w._start(r[0], r[1]);
  return w;
}

/** watchFile's handle (Bun's StatWatcher): polls the file's stat every
 * `interval` ms, and calls the listener with the new and previous stats
 * when it changed (its access time aside). */
class StatWatcher {
  #path: string | Uint8Array;
  #listener: Function;
  #bigint: boolean;
  #timer: any;
  #prev: any;
  #closed = false;

  constructor(path: string | Uint8Array, listener: Function, persistent: boolean, bigint: boolean, interval: number) {
    this.#path = path;
    this.#listener = listener;
    this.#bigint = bigint;
    const first = this.#restat();
    this.#prev = first;
    this.#timer = setInterval(() => this.#poll(), interval > 0 ? interval : 1);
    if (!persistent) this.#timer.unref();
    if (first === undefined) {
      // (It does not exist: the listener is called once with empty stats.)
      const empty = this.#empty();
      this.#prev = empty;
      complete(1, (_err: any, _v: any) => {
        if (!this.#closed) this.#listener(empty, empty);
      }, undefined, false);
    }
  }

  #empty(): any {
    if (!this.#bigint) return new (Stats as any)(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
    // (as the natives make it: milliseconds of BigInts)
    const s = new (BigIntStats as any)(0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n);
    s.atimeMs = s.mtimeMs = s.ctimeMs = s.birthtimeMs = 0n;
    return s;
  }

  #restat(): any {
    try {
      return fsStat(this.#path, false, this.#bigint, false) ?? undefined;
    } catch {
      return undefined;
    }
  }

  #poll(): void {
    if (this.#closed) return;
    const curr = this.#restat() ?? this.#empty();
    const prev = this.#prev;
    if (
      curr.dev === prev.dev &&
      curr.ino === prev.ino &&
      curr.mode === prev.mode &&
      curr.nlink === prev.nlink &&
      curr.uid === prev.uid &&
      curr.gid === prev.gid &&
      curr.rdev === prev.rdev &&
      curr.size === prev.size &&
      curr.blksize === prev.blksize &&
      curr.blocks === prev.blocks &&
      (this.#bigint ? curr.mtimeNs === prev.mtimeNs : curr.mtimeMs === prev.mtimeMs) &&
      (this.#bigint ? curr.ctimeNs === prev.ctimeNs : curr.ctimeMs === prev.ctimeMs) &&
      (this.#bigint ? curr.birthtimeNs === prev.birthtimeNs : curr.birthtimeMs === prev.birthtimeMs)
    ) {
      return;
    }
    this.#prev = curr;
    this.#listener(curr, prev);
  }

  ref(): this {
    if (!this.#closed) this.#timer.ref();
    return this;
  }

  unref(): this {
    if (!this.#closed) this.#timer.unref();
    return this;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    clearInterval(this.#timer);
  }
}

function watchFile(path: any, options?: any, listener?: any): StatWatcher {
  const p = typeof path === "string" ? path : pathLike(path);
  if (p === undefined) throw invalidArgs("filename must be a string or TypedArray");
  let persistent = true,
    bigint = false,
    interval = 5007;
  if (isObject(options)) {
    const ps = boolOption(options, "persistent");
    if (ps !== undefined) persistent = ps;
    const b = boolOption(options, "bigint");
    if (b !== undefined) bigint = b;
    const i = options.interval;
    if (i !== undefined) {
      if (typeof i !== "number") throw invalidArgs("interval must be a number");
      interval = i | 0;
    }
  }
  if (typeof listener !== "function") throw invalidArgs('Expected "listener" callback');
  if (hasNul(p)) throw nullBytes(p);
  return new StatWatcher(p, listener, persistent, bigint, interval);
}

// ---- The binding ----

/** `x(...)`: a promise of `xSync`'s result (or error). */
function asyncOf(sync: Function, name: string, length: number): Function {
  const fn = {
    [name](...args: any[]): Promise<any> {
      return runAsync(sync, args);
    },
  }[name];
  Object.defineProperty(fn, "length", { value: length });
  return fn;
}

/** `xCb(callback, ...)`: `xSync`'s result to Node's callback. */
function callbackOf(sync: Function, name: string, length: number): Function {
  const fn = {
    [name](callback: any, ...args: any[]): void {
      runCallback(sync, callback, args);
    },
  }[name];
  Object.defineProperty(fn, "length", { value: length });
  return fn;
}

function cp(...args: any[]): Promise<void> {
  return runAsync(cpSync, args);
}

function existsAsync(...args: any[]): Promise<boolean> {
  return runAsync(existsSync, args);
}

const binding: any = {
  Stats,
  BigIntStats,
  StatFs,
  BigIntStatFs,
  Dirent,
  cp,
  cpSync,
  watch,
  watchFile,
};

// [name, sync, sync length, async length, callback length] (Bun's lengths,
// src/runtime/node/node.classes.ts).
const operations: [string, Function, number, number, number][] = [
  ["access", accessSync, 2, 3, 4],
  ["appendFile", appendFileSync, 3, 4, 5],
  ["chmod", chmodSync, 2, 3, 4],
  ["chown", chownSync, 3, 4, 5],
  ["close", closeSync, 1, 1, 2],
  ["copyFile", copyFileSync, 3, 4, 5],
  ["exists", existsSync, 1, 2, 3],
  ["fchmod", fchmodSync, 2, 3, 4],
  ["fchown", fchownSync, 3, 4, 5],
  ["fdatasync", fdatasyncSync, 1, 2, 3],
  ["fstat", fstatSync, 1, 1, 2],
  ["fsync", fsyncSync, 1, 2, 3],
  ["ftruncate", ftruncateSync, 1, 1, 2],
  ["futimes", futimesSync, 3, 4, 5],
  ["lchmod", lchmodSync, 2, 3, 4],
  ["lchown", lchownSync, 3, 4, 5],
  ["link", linkSync, 2, 3, 4],
  ["lstat", lstatSync, 1, 1, 2],
  ["lutimes", lutimesSync, 3, 4, 5],
  ["mkdir", mkdirSync, 2, 3, 4],
  ["mkdtemp", mkdtempSync, 2, 3, 4],
  ["open", openSync, 3, 4, 5],
  ["read", readSync, 5, 6, 7],
  ["readdir", readdirSync, 2, 3, 4],
  ["readFile", readFileSync, 2, 3, 4],
  ["readlink", readlinkSync, 2, 3, 4],
  ["readv", readvSync, 3, 4, 5],
  ["realpath", realpathSync, 2, 3, 4],
  ["realpathNative", realpathNativeSync, 3, 3, 4],
  ["rename", renameSync, 2, 3, 4],
  ["rm", rmSync, 2, 3, 4],
  ["rmdir", rmdirSync, 2, 3, 4],
  ["stat", statSync, 1, 1, 2],
  ["statfs", statfsSync, 2, 2, 3],
  ["symlink", symlinkSync, 3, 4, 5],
  ["truncate", truncateSync, 2, 3, 4],
  ["unlink", unlinkSync, 1, 2, 3],
  ["utimes", utimesSync, 3, 4, 5],
  ["write", writeSync, 5, 6, 7],
  ["writeFile", writeFileSync, 3, 4, 5],
  ["writev", writevSync, 3, 4, 5],
];

for (const [name, sync, syncLength, asyncLength, callbackLength] of operations) {
  Object.defineProperty(sync, "name", { value: name + "Sync" });
  Object.defineProperty(sync, "length", { value: syncLength });
  binding[name + "Sync"] = sync;
  binding[name] = name === "exists" ? existsAsync : asyncOf(sync, name, asyncLength);
  binding[name + "Cb"] = callbackOf(sync, name + "Cb", callbackLength);
}
Object.defineProperty(existsAsync, "name", { value: "exists" });
Object.defineProperty(existsAsync, "length", { value: 2 });
Object.defineProperty(cp, "length", { value: 2 });
Object.defineProperty(cpSync, "length", { value: 2 });

export const createBinding: any = binding;
