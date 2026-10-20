// Bun's native `node:os` binding (`$rust("node_os.rs", "createNodeOsBinding")`:
// src/runtime/node/node_os.rs and node_os.bind.ts) on the natives of
// crates/beyond-rt/native/os.c: the arguments checked as bindgen's
// validators check them, the errors Bun's.

import {
  fsError,
  osCpus,
  osFreemem,
  osGetPriority,
  osHomedir,
  osIds,
  osLoadavg,
  osNetworkInterfaces,
  osSetPriority,
  osTotalmem,
  osUname,
  osUptime,
} from "beyond:native";
import { process } from "beyond:process";
import { codedRangeError, codedTypeError, determineSpecificType } from "node:internal/intrinsics";

/** bindgen's `t.i32.validateInt32(min, max)`. */
function int32Arg(value: any, name: string, min: number = -2147483648, max: number = 2147483647): number {
  if (typeof value !== "number") {
    throw codedTypeError("ERR_INVALID_ARG_TYPE", `The "${name}" argument must be of type number. Received ${determineSpecificType(value)}`);
  }
  if (value % 1 !== 0 && isFinite(value)) {
    throw codedRangeError("ERR_OUT_OF_RANGE", `The value of "${name}" is out of range. It must be an integer. Received ${value}`);
  }
  if (value !== value) {
    throw codedRangeError("ERR_OUT_OF_RANGE", `The value of "${name}" is out of range. It must be an integer. Received NaN`);
  }
  if (value < min || value > max) {
    throw codedRangeError("ERR_OUT_OF_RANGE", `The value of "${name}" is out of range. It must be >= ${min} and <= ${max}. Received ${value}`);
  }
  return value;
}

/** Bun's SystemError::to_error_instance_with_info_object. */
function systemErrorWithInfo(code: string, syscall: string, message: string, errno: number): Error {
  const e: any = new Error(`A system error occurred: ${syscall} returned ${code} (${message})`);
  Object.defineProperty(e, "name", { value: "SystemError", writable: true, enumerable: false, configurable: true });
  Object.defineProperty(e, "code", { value: "ERR_SYSTEM_ERROR", writable: true, enumerable: false, configurable: true });
  const info = { code, syscall, message, errno };
  Object.defineProperty(e, "info", { value: info, writable: true, enumerable: true, configurable: false });
  Object.defineProperty(e, "syscall", { value: syscall, writable: true, enumerable: true, configurable: false });
  Object.defineProperty(e, "errno", { value: errno, writable: true, enumerable: true, configurable: false });
  return e;
}

// (libuv's labels of the errors setpriority gives.)
const PRIORITY_ERRORS: Record<number, [string, string]> = {
  1: ["EPERM", "operation not permitted"],
  3: ["ESRCH", "no such process"],
  13: ["EACCES", "permission denied"],
  22: ["EINVAL", "invalid argument"],
};

function cpus(): any[] {
  const r = osCpus();
  if (r === undefined) {
    // (/proc/stat unreadable: as many as there are processors, unknown.)
    const n = osIds()[2];
    const out: any[] = [];
    for (let i = 0; i < n; i++) out.push({ times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 }, model: "unknown", speed: 0 });
    return out;
  }
  if (r === null) {
    const e: any = new Error("Failed to get CPU information");
    e.code = "ERR_SYSTEM_ERROR";
    Object.defineProperty(e, "name", { value: "SystemError", writable: true, enumerable: false, configurable: true });
    throw e;
  }
  return r;
}

function freemem(): number {
  return osFreemem();
}

function getPriority(pid?: any): number {
  const p = pid === undefined ? 0 : int32Arg(pid, "pid");
  const r = osGetPriority(p);
  if (r === null) throw systemErrorWithInfo("ESRCH", "uv_os_getpriority", "no such process", -3);
  return r;
}

function homedir(): string {
  const r = osHomedir();
  if (typeof r === "number") throw fsError(r, "uv_os_homedir", undefined, undefined, -1);
  return r;
}

function hostname(): string {
  return osUname(0);
}

function loadavg(): number[] {
  return osLoadavg();
}

function networkInterfaces(): any {
  const r = osNetworkInterfaces();
  if (typeof r === "number") {
    const e: any = new Error("A system error occurred: getifaddrs returned an error");
    e.code = "ERR_SYSTEM_ERROR";
    e.errno = r;
    e.syscall = "getifaddrs";
    throw e;
  }
  return r;
}

function release(): string {
  return osUname(1);
}

function totalmem(): number {
  return osTotalmem();
}

function uptime(): number {
  return osUptime();
}

function userInfo(options?: any): any {
  if (options !== undefined && options !== null && typeof options !== "object") {
    throw codedTypeError("ERR_INVALID_ARG_TYPE", `The "options" argument must be of type object. Received ${determineSpecificType(options)}`);
  }
  const ids = osIds();
  const env = process.env;
  return {
    homedir: homedir(),
    username: env.USER || "unknown",
    shell: env.SHELL || "unknown",
    uid: ids[0],
    gid: ids[1],
  };
}

function version(): string {
  return osUname(2);
}

function setPriority(...args: any[]): undefined {
  if (args.length === 0) throw codedTypeError("ERR_MISSING_ARGS", "Not enough arguments");
  let pid = 0,
    priority: number;
  if (args.length === 1) {
    priority = int32Arg(args[0], "priority", -20, 19);
  } else {
    pid = int32Arg(args[0], "pid");
    priority = int32Arg(args[1], "priority", -20, 19);
  }
  const no = osSetPriority(pid, priority);
  if (no !== 0) {
    const [code, message] = PRIORITY_ERRORS[no] ?? ["UNKNOWN", "unknown error"];
    throw systemErrorWithInfo(code, "uv_os_setpriority", message, -no);
  }
  return undefined;
}

export const createNodeOsBinding: any = {
  hostCpuCount: osIds()[2],
  cpus,
  freemem,
  getPriority,
  homedir,
  hostname,
  loadavg,
  networkInterfaces,
  release,
  totalmem,
  uptime,
  userInfo,
  version,
  setPriority,
};
