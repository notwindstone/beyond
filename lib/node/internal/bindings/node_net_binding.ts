// Natives of Bun's node_net_binding (src/runtime/node/node_net_binding.rs):
// the defaults of autoSelectFamily (Happy Eyeballs). Sockets, BlockList and
// SocketAddress are not there yet: each throws when used.

import { $nativeStub } from "node:internal/intrinsics";
import { validateInt32 } from "node:internal/validators";

let autoSelectFamily = true;
// (Node's documented default is 250 ms; its command line's is 500, which
// Node's tests assume.)
let attemptTimeout = 500;

export function getDefaultAutoSelectFamily(): boolean {
  return autoSelectFamily;
}

export function setDefaultAutoSelectFamily(value: unknown): boolean {
  if (arguments.length < 1) throw new Error("missing argument");
  if (typeof value !== "boolean") {
    const e = new TypeError("Invalid arguments: autoSelectFamilyDefault") as TypeError & { code: string };
    e.code = "ERR_INVALID_ARG_TYPE";
    throw e;
  }
  autoSelectFamily = value;
  return value;
}

export function getDefaultAutoSelectFamilyAttemptTimeout(): number {
  return attemptTimeout;
}

export function setDefaultAutoSelectFamilyAttemptTimeout(value: unknown): number {
  if (arguments.length < 1) throw new Error("missing argument");
  validateInt32(value, "value", 1);
  attemptTimeout = Math.max(value as number, 10);
  return attemptTimeout;
}

export const BlockList: any = $nativeStub("node_net_binding", "BlockList");
export const SocketAddress: any = $nativeStub("node_net_binding", "SocketAddress");
export const doConnect: any = $nativeStub("node_net_binding", "doConnect");
export const newDetachedSocket: any = $nativeStub("node_net_binding", "newDetachedSocket");
