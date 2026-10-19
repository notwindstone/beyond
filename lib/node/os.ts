// node:os: the system's description, as far as programs ask for it.

import { processInfo, readFile } from "beyond:native";
import { process } from "../process.ts";

const info = processInfo() as { release?: string; hostname?: string };

function meminfo(key: string): number {
  try {
    const m = new RegExp(`^${key}:\\s+(\\d+)`, "m").exec(readFile("/proc/meminfo", true) as string);
    return m ? Number(m[1]) * 1024 : 0;
  } catch {
    return 0;
  }
}

export const EOL = "\n";
export const devNull = "/dev/null";
export function platform(): string {
  return "linux";
}
export function type(): string {
  return "Linux";
}
export function arch(): string {
  return process.arch;
}
export function release(): string {
  return info.release ?? "";
}
export function hostname(): string {
  return info.hostname ?? "localhost";
}
export function homedir(): string {
  return process.env.HOME ?? "/";
}
export function tmpdir(): string {
  const t = process.env.TMPDIR ?? process.env.TMP ?? process.env.TEMP ?? "/tmp";
  return t.length > 1 && t.endsWith("/") ? t.slice(0, -1) : t;
}
export function endianness(): "LE" {
  return "LE";
}
export function totalmem(): number {
  return meminfo("MemTotal");
}
export function freemem(): number {
  return meminfo("MemAvailable");
}
export function cpus(): { model: string; speed: number; times: Record<string, number> }[] {
  let n = 1;
  try {
    n = Math.max(1, ((readFile("/proc/cpuinfo", true) as string).match(/^processor\s*:/gm) ?? []).length);
  } catch {}
  return Array.from({ length: n }, () => ({ model: "", speed: 0, times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } }));
}
export function availableParallelism(): number {
  return cpus().length;
}
export function loadavg(): number[] {
  try {
    return (readFile("/proc/loadavg", true) as string).split(" ").slice(0, 3).map(Number);
  } catch {
    return [0, 0, 0];
  }
}
export function uptime(): number {
  try {
    return Number((readFile("/proc/uptime", true) as string).split(" ")[0]);
  } catch {
    return 0;
  }
}
export function userInfo(): { username: string; uid: number; gid: number; shell: string | null; homedir: string } {
  return { username: process.env.USER ?? "", uid: -1, gid: -1, shell: process.env.SHELL ?? null, homedir: homedir() };
}
export function networkInterfaces(): Record<string, unknown[]> {
  return {};
}
export const constants = { signals: {}, errno: {} };

export default {
  EOL,
  devNull,
  platform,
  type,
  arch,
  release,
  hostname,
  homedir,
  tmpdir,
  endianness,
  totalmem,
  freemem,
  cpus,
  availableParallelism,
  loadavg,
  uptime,
  userInfo,
  networkInterfaces,
  constants,
};
