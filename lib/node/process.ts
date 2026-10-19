// node:process: the global `process`.

import { process } from "../process.ts";

export const env = process.env;
export const argv = process.argv;
export const platform = process.platform;
export const arch = process.arch;
export const version = process.version;
export const versions = process.versions;
export const pid = process.pid;
export const stdout = process.stdout;
export const stderr = process.stderr;
export const hrtime = process.hrtime;
export const cwd = (): string => process.cwd();
export const chdir = (dir: string): void => process.chdir(dir);
export const exit = (code?: number): never => process.exit(code);
export const nextTick = (fn: (...args: any[]) => void, ...args: any[]): void => process.nextTick(fn, ...args);
export const emitWarning = (w: string | Error, t?: string): void => process.emitWarning(w, t);
export { process };
export default process;
