// bun:jsc, the part that does not depend on JavaScriptCore
// (src/jsc/modules/BunJSCModule.h): collections, which give the heap's size
// after them (QuickJS's are always full ones), and releaseWeakRefs (QuickJS
// keeps no WeakRef targets alive until the end of a job: nothing to
// release).

import { gc as nativeGC } from "beyond:native";

export function fullGC(): number {
  return nativeGC();
}

export function edenGC(): number {
  return nativeGC();
}

export function gcAndSweep(): number {
  return nativeGC();
}

export function releaseWeakRefs(): void {}

export default { fullGC, edenGC, gcAndSweep, releaseWeakRefs };
