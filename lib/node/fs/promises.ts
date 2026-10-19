// node:fs/promises: node:fs's `promises`.

import { constants, promises } from "../fs.ts";

export const readFile = promises.readFile;
export const writeFile = promises.writeFile;
export const appendFile = promises.appendFile;
export const stat = promises.stat;
export const lstat = promises.lstat;
export const realpath = promises.realpath;
export const readdir = promises.readdir;
export const mkdir = promises.mkdir;
export const rm = promises.rm;
export const rmdir = promises.rmdir;
export const unlink = promises.unlink;
export const rename = promises.rename;
export const copyFile = promises.copyFile;
export const cp = promises.cp;
export const access = promises.access;
export const readlink = promises.readlink;
export const symlink = promises.symlink;
export const chmod = promises.chmod;
export const mkdtemp = promises.mkdtemp;
export { constants };
export default promises;
