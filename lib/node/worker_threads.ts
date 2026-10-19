// node:worker_threads: Beyond runs one thread of JavaScript; this is the
// main one, and making a Worker is an error.

export const isMainThread = true;
export const parentPort = null;
export const workerData = null;
export const threadId = 0;
export const resourceLimits = {};

export class Worker {
  constructor(_filename: string | URL, _options?: unknown) {
    const e = new Error("worker_threads.Worker is not supported by Beyond yet");
    (e as any).code = "ERR_NOT_SUPPORTED";
    throw e;
  }
}

export function markAsUntransferable(_value: unknown): void {}

export default { isMainThread, parentPort, workerData, threadId, resourceLimits, Worker, markAsUntransferable };
