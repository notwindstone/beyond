// node:fs: files, synchronously and as promises (`fs.promises`,
// node:fs/promises) or callbacks, through the native core's system calls.
// Errors are Node's (`code`, `errno`, `syscall`, `path`).

import {
  access as nativeAccess,
  chmod as nativeChmod,
  mkdir as nativeMkdir,
  readdir as nativeReaddir,
  readFile as nativeReadFile,
  readlink as nativeReadlink,
  realpath as nativeRealpath,
  rename as nativeRename,
  rmdir as nativeRmdir,
  stat as nativeStat,
  symlink as nativeSymlink,
  unlink as nativeUnlink,
  writeFile as nativeWriteFile,
} from "beyond:native";
import { Buffer } from "./buffer.ts";
import { dirname, join, resolve } from "./path.ts";

type PathLike = string | URL | Uint8Array;
type Encoding = "utf8" | "utf-8" | "ascii" | "latin1" | "binary" | "base64" | "base64url" | "hex" | "ucs2" | "utf16le" | null;

/** A path argument as a string (`file:` URLs and bytes too). */
function toPath(p: PathLike, name = "path"): string {
  if (typeof p === "string") return p;
  if (p instanceof URL) {
    if (p.protocol !== "file:") throw new TypeError("The URL must be of scheme file");
    return decodeURIComponent(p.pathname);
  }
  if (p instanceof Uint8Array) return new TextDecoder().decode(p);
  const e = new TypeError(`The "${name}" argument must be of type string or an instance of Buffer or URL. Received ${p === null ? "null" : typeof p}`);
  (e as any).code = "ERR_INVALID_ARG_TYPE";
  throw e;
}

function encodingOf(options: any): Encoding | undefined {
  if (typeof options === "string") return options as Encoding;
  return options?.encoding ?? undefined;
}

const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;
const S_IFCHR = 0o020000;
const S_IFBLK = 0o060000;
const S_IFIFO = 0o010000;
const S_IFSOCK = 0o140000;

export class Stats {
  dev!: number;
  ino!: number;
  mode!: number;
  nlink!: number;
  uid!: number;
  gid!: number;
  rdev!: number;
  size!: number;
  blksize!: number;
  blocks!: number;
  atimeMs!: number;
  mtimeMs!: number;
  ctimeMs!: number;
  birthtimeMs!: number;
  atime!: Date;
  mtime!: Date;
  ctime!: Date;
  birthtime!: Date;
  constructor(raw: any) {
    Object.assign(this, raw);
    this.atime = new Date(raw.atimeMs);
    this.mtime = new Date(raw.mtimeMs);
    this.ctime = new Date(raw.ctimeMs);
    this.birthtime = new Date(raw.birthtimeMs);
  }
  isFile(): boolean {
    return (this.mode & S_IFMT) === S_IFREG;
  }
  isDirectory(): boolean {
    return (this.mode & S_IFMT) === S_IFDIR;
  }
  isSymbolicLink(): boolean {
    return (this.mode & S_IFMT) === S_IFLNK;
  }
  isCharacterDevice(): boolean {
    return (this.mode & S_IFMT) === S_IFCHR;
  }
  isBlockDevice(): boolean {
    return (this.mode & S_IFMT) === S_IFBLK;
  }
  isFIFO(): boolean {
    return (this.mode & S_IFMT) === S_IFIFO;
  }
  isSocket(): boolean {
    return (this.mode & S_IFMT) === S_IFSOCK;
  }
}

export class Dirent {
  name: string;
  parentPath: string;
  path: string;
  #type: number;
  constructor(name: string, type: number, parent: string) {
    this.name = name;
    this.parentPath = parent;
    this.path = parent;
    this.#type = type;
  }
  isFile(): boolean {
    return this.#type === 1;
  }
  isDirectory(): boolean {
    return this.#type === 2;
  }
  isSymbolicLink(): boolean {
    return this.#type === 3;
  }
  isCharacterDevice(): boolean {
    return false;
  }
  isBlockDevice(): boolean {
    return false;
  }
  isFIFO(): boolean {
    return false;
  }
  isSocket(): boolean {
    return false;
  }
}

export const constants = {
  F_OK: 0,
  R_OK: 4,
  W_OK: 2,
  X_OK: 1,
  O_RDONLY: 0,
  O_WRONLY: 1,
  O_RDWR: 2,
  S_IFMT,
  S_IFREG,
  S_IFDIR,
  S_IFLNK,
  COPYFILE_EXCL: 1,
};
export const F_OK = 0;
export const R_OK = 4;
export const W_OK = 2;
export const X_OK = 1;

// ---- Synchronous ----

export function existsSync(path: PathLike): boolean {
  try {
    return nativeStat(toPath(path), true, false) !== undefined;
  } catch {
    return false;
  }
}

export function readFileSync(path: PathLike | number, options?: any): any {
  if (typeof path === "number") throw new TypeError("file descriptors are not supported yet");
  const encoding = encodingOf(options);
  const p = toPath(path);
  if (encoding === "utf8" || encoding === "utf-8") return nativeReadFile(p, true);
  const buf = Buffer.from(nativeReadFile(p, false) as ArrayBuffer);
  return encoding ? buf.toString(encoding) : buf;
}

export function writeFileSync(path: PathLike, data: any, options?: any): void {
  const encoding = encodingOf(options);
  const flag = typeof options === "object" ? options?.flag : undefined;
  if (typeof data === "string" && encoding && encoding !== "utf8" && encoding !== "utf-8") data = Buffer.from(data, encoding);
  if (typeof data !== "string" && !ArrayBuffer.isView(data) && !(data instanceof ArrayBuffer)) data = String(data);
  nativeWriteFile(toPath(path), data, flag === "a" || flag === "a+", options?.mode);
}

export function appendFileSync(path: PathLike, data: any, options?: any): void {
  if (typeof data !== "string" && !ArrayBuffer.isView(data) && !(data instanceof ArrayBuffer)) data = String(data);
  nativeWriteFile(toPath(path), data, true, options?.mode);
}

export function statSync(path: PathLike, options?: { throwIfNoEntry?: boolean }): Stats | undefined {
  const raw = nativeStat(toPath(path), true, options?.throwIfNoEntry !== false);
  return raw === undefined ? undefined : new Stats(raw);
}

export function lstatSync(path: PathLike, options?: { throwIfNoEntry?: boolean }): Stats | undefined {
  const raw = nativeStat(toPath(path), false, options?.throwIfNoEntry !== false);
  return raw === undefined ? undefined : new Stats(raw);
}

export function realpathSync(path: PathLike, options?: any): string {
  const r = nativeRealpath(toPath(path)) as string;
  const encoding = encodingOf(options);
  return encoding === "buffer" ? (Buffer.from(r) as any) : r;
}
realpathSync.native = realpathSync;

export function readdirSync(path: PathLike, options?: any): any[] {
  const p = toPath(path);
  const withFileTypes = typeof options === "object" && options?.withFileTypes;
  const recursive = typeof options === "object" && options?.recursive;
  const out: any[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const [name, type] of nativeReaddir(dir) as [string, number][]) {
      const rel = prefix ? `${prefix}/${name}` : name;
      out.push(withFileTypes ? new Dirent(name, type, dir) : rel);
      if (recursive && type === 2) walk(join(dir, name), rel);
    }
  };
  walk(p, "");
  return out;
}

export function mkdirSync(path: PathLike, options?: any): string | undefined {
  const p = resolve(toPath(path));
  const recursive = typeof options === "object" && options?.recursive;
  const mode = typeof options === "number" ? options : options?.mode;
  if (!recursive) {
    nativeMkdir(p, mode);
    return undefined;
  }
  // The first directory made, as Node returns.
  const missing: string[] = [];
  let d = p;
  while (nativeStat(d, true, false) === undefined) {
    missing.push(d);
    const parent = dirname(d);
    if (parent === d) break;
    d = parent;
  }
  const st = nativeStat(d, true, false);
  if (st !== undefined && (st.mode & S_IFMT) !== S_IFDIR) nativeMkdir(p, mode);
  for (let i = missing.length - 1; i >= 0; i--) {
    try {
      nativeMkdir(missing[i], mode);
    } catch (e: any) {
      if (e?.code !== "EEXIST") throw e;
    }
  }
  return missing.length ? missing[missing.length - 1] : undefined;
}

export function rmSync(path: PathLike, options?: { recursive?: boolean; force?: boolean }): void {
  const p = toPath(path);
  const st = nativeStat(p, false, false);
  if (st === undefined) {
    if (options?.force) return;
    nativeStat(p, false, true);
    return;
  }
  if ((st.mode & S_IFMT) === S_IFDIR) {
    if (!options?.recursive) {
      const e: any = new Error(`Path is a directory: rm returned EISDIR (is a directory) ${p}`);
      e.code = "ERR_FS_EISDIR";
      throw e;
    }
    for (const [name] of nativeReaddir(p) as [string, number][]) rmSync(join(p, name), { recursive: true, force: true });
    nativeRmdir(p);
  } else {
    nativeUnlink(p);
  }
}

export function rmdirSync(path: PathLike, options?: { recursive?: boolean }): void {
  if (options?.recursive) return rmSync(path, { recursive: true, force: true });
  nativeRmdir(toPath(path));
}

export function unlinkSync(path: PathLike): void {
  nativeUnlink(toPath(path));
}

export function renameSync(from: PathLike, to: PathLike): void {
  nativeRename(toPath(from, "oldPath"), toPath(to, "newPath"));
}

export function copyFileSync(from: PathLike, to: PathLike, mode = 0): void {
  const dest = toPath(to, "dest");
  if (mode & 1 && nativeStat(dest, false, false) !== undefined) nativeAccess(dest, -1);
  nativeWriteFile(dest, nativeReadFile(toPath(from, "src"), false), false, undefined);
}

export function cpSync(from: PathLike, to: PathLike, options?: { recursive?: boolean }): void {
  const src = toPath(from, "src");
  const dest = toPath(to, "dest");
  const st = nativeStat(src, true, true);
  if ((st.mode & S_IFMT) === S_IFDIR) {
    if (!options?.recursive) {
      const e: any = new Error(`Recursive option is required to copy a directory: ${src}`);
      e.code = "ERR_FS_EISDIR";
      throw e;
    }
    mkdirSync(dest, { recursive: true });
    for (const [name] of nativeReaddir(src) as [string, number][]) cpSync(join(src, name), join(dest, name), options);
  } else {
    copyFileSync(src, dest);
  }
}

export function accessSync(path: PathLike, mode = F_OK): void {
  nativeAccess(toPath(path), mode);
}

export function readlinkSync(path: PathLike): string {
  return nativeReadlink(toPath(path)) as string;
}

export function symlinkSync(target: PathLike, path: PathLike): void {
  nativeSymlink(toPath(target, "target"), toPath(path));
}

export function chmodSync(path: PathLike, mode: number | string): void {
  nativeChmod(toPath(path), typeof mode === "string" ? parseInt(mode, 8) : mode);
}

export function mkdtempSync(prefix: string): string {
  for (;;) {
    const p = prefix + Math.random().toString(36).slice(2, 8);
    try {
      nativeMkdir(p, 0o700);
      return p;
    } catch (e: any) {
      if (e?.code !== "EEXIST") throw e;
    }
  }
}

// ---- Promises ----

/** `f` as a function returning a promise of its result (settled in a
 * later job, as I/O is). */
function later<A extends any[], R>(f: (...args: A) => R): (...args: A) => Promise<R> {
  return (...args: A) =>
    new Promise<R>((ok, fail) => {
      queueMicrotask(() => {
        try {
          ok(f(...args));
        } catch (e) {
          fail(e);
        }
      });
    });
}

export const promises = {
  readFile: later(readFileSync),
  writeFile: later(writeFileSync),
  appendFile: later(appendFileSync),
  stat: later((p: PathLike, o?: any) => statSync(p, o) as Stats),
  lstat: later((p: PathLike, o?: any) => lstatSync(p, o) as Stats),
  realpath: later(realpathSync),
  readdir: later(readdirSync),
  mkdir: later(mkdirSync),
  rm: later(rmSync),
  rmdir: later(rmdirSync),
  unlink: later(unlinkSync),
  rename: later(renameSync),
  copyFile: later(copyFileSync),
  cp: later(cpSync),
  access: later(accessSync),
  readlink: later(readlinkSync),
  symlink: later(symlinkSync),
  chmod: later(chmodSync),
  mkdtemp: later(mkdtempSync),
  exists: later(existsSync),
  constants,
};

// ---- Callbacks ----

/** `f` with a Node callback last: (error, result), in a later job. */
function callback<A extends any[], R>(f: (...args: A) => R): (...args: any[]) => void {
  return (...args: any[]) => {
    const cb = args.pop();
    if (typeof cb !== "function") {
      const e = new TypeError(`The "cb" argument must be of type function. Received ${typeof cb}`);
      (e as any).code = "ERR_INVALID_ARG_TYPE";
      throw e;
    }
    queueMicrotask(() => {
      let r: R;
      try {
        r = f(...(args as A));
      } catch (e) {
        cb(e);
        return;
      }
      cb(null, r);
    });
  };
}

export const readFile = callback(readFileSync);
export const writeFile = callback(writeFileSync);
export const appendFile = callback(appendFileSync);
export const stat = callback(statSync);
export const lstat = callback(lstatSync);
export const realpath = callback(realpathSync);
export const readdir = callback(readdirSync);
export const mkdir = callback(mkdirSync);
export const rm = callback(rmSync);
export const rmdir = callback(rmdirSync);
export const unlink = callback(unlinkSync);
export const rename = callback(renameSync);
export const copyFile = callback(copyFileSync);
export const access = callback(accessSync);
export const readlink = callback(readlinkSync);
export const symlink = callback(symlinkSync);
export const chmod = callback(chmodSync);
export function exists(path: PathLike, cb: (exists: boolean) => void): void {
  queueMicrotask(() => cb(existsSync(path)));
}

export default {
  existsSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  statSync,
  lstatSync,
  realpathSync,
  readdirSync,
  mkdirSync,
  rmSync,
  rmdirSync,
  unlinkSync,
  renameSync,
  copyFileSync,
  cpSync,
  accessSync,
  readlinkSync,
  symlinkSync,
  chmodSync,
  mkdtempSync,
  readFile,
  writeFile,
  appendFile,
  stat,
  lstat,
  realpath,
  readdir,
  mkdir,
  rm,
  rmdir,
  unlink,
  rename,
  copyFile,
  access,
  readlink,
  symlink,
  chmod,
  exists,
  promises,
  constants,
  Stats,
  Dirent,
  F_OK,
  R_OK,
  W_OK,
  X_OK,
};
