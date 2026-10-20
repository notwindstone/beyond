// What Bun's Node.js modules use of bun:jsc (JavaScriptCore's own API in
// Bun), as Beyond has it.

import { $nativeStub } from "node:internal/intrinsics";

/** The file of the caller's caller (async_hooks' warnings name it). */
export function callerSourceOrigin(): string {
  const stack = new Error().stack ?? "";
  const line = stack.split("\n")[3] ?? "";
  const m = /\(?((?:file:\/\/)?\/[^:)]*)/.exec(line);
  return m ? m[1] : "";
}

/** The engine's heap: what v8.getHeapStatistics() reports. */
export function heapStats(): { heapSize: number; heapCapacity: number; extraMemorySize: number; objectCount: number } {
  const rss = process.memoryUsage?.().rss ?? 0;
  return { heapSize: rss, heapCapacity: rss, extraMemorySize: 0, objectCount: 0 };
}

export function memoryUsage(): { current: number; peak: number; currentCommit: number; peakCommit: number; pageFaults: number } {
  const rss = process.memoryUsage?.().rss ?? 0;
  return { current: rss, peak: rss, currentCommit: rss, peakCommit: rss, pageFaults: 0 };
}

export const serialize: any = $nativeStub("bun:jsc", "serialize");
export const deserialize: any = $nativeStub("bun:jsc", "deserialize");

export default { callerSourceOrigin, heapStats, memoryUsage, serialize, deserialize };
