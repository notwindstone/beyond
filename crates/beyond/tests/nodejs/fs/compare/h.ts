// Test harness shared by the suite (runs unchanged under bun and beyond).
import fs from "node:fs";

export const W = (process.env.TMPDIR ?? "/tmp") + "/beyond-fs/work/" + (process.argv[2] ?? "w");

export function fresh(): string {
  fs.rmSync(W, { recursive: true, force: true });
  fs.mkdirSync(W, { recursive: true });
  return W;
}

function clean(s: string): string {
  return s.split(W).join("<W>");
}

export function fmt(v: any, depth = 0): string {
  if (v === null) return "null";
  if (v === undefined) return "undefined";
  if (typeof v === "string") return JSON.stringify(clean(v));
  if (typeof v === "bigint") return v + "n";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (typeof v === "function") return "[fn " + v.name + "]";
  if (v instanceof Error) return errStr(v);
  // (A path in a buffer: the work directory's name is the runtime's.)
  if (v instanceof Uint8Array && Buffer.from(v).toString("latin1").includes(W)) return "Buffer<" + JSON.stringify(clean(Buffer.from(v).toString("latin1"))) + ">";
  if (v instanceof Uint8Array) return (Buffer.isBuffer(v) ? "Buffer" : v.constructor.name) + "<" + Array.from(v.subarray(0, 40)).map((b) => b.toString(16).padStart(2, "0")).join("") + (v.length > 40 ? "..." : "") + ">";
  if (Array.isArray(v)) return depth > 3 ? "[...]" : "[" + v.map((x) => fmt(x, depth + 1)).join(",") + "]";
  if (v instanceof Date) return "Date(" + v.getTime() + ")";
  if (typeof v === "object") {
    const tag = Object.prototype.toString.call(v);
    if (depth > 3) return tag;
    return tag + "{" + Object.keys(v).map((k) => k + ":" + fmt(v[k], depth + 1)).join(",") + "}";
  }
  return String(v);
}

export function errStr(e: any): string {
  if (!(e instanceof Error)) return "thrown " + fmt(e);
  const props = ["code", "errno", "syscall", "path", "dest", "fd"].filter((k) => e[k] !== undefined).map((k) => k + "=" + (k === "fd" ? "<fd>" : fmt(e[k])));
  return `${e.name}(${props.join(" ")}): ${clean(e.message)}`;
}

export function t(label: string, f: () => any): void {
  try {
    console.log(label, "=>", fmt(f()));
  } catch (e) {
    console.log(label, "!!", errStr(e));
  }
}

export async function ta(label: string, f: () => any): Promise<void> {
  try {
    console.log(label, "=>", fmt(await f()));
  } catch (e) {
    console.log(label, "!!", errStr(e));
  }
}

export function tcb(label: string, f: (cb: (...a: any[]) => void) => void): Promise<void> {
  return new Promise((resolve) => {
    try {
      f((...a: any[]) => {
        console.log(label, "cb(", a.map((x) => fmt(x)).join(", "), ")");
        resolve();
      });
    } catch (e) {
      console.log(label, "!!", errStr(e));
      resolve();
    }
  });
}
