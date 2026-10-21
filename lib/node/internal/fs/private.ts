// (Beyond: what Bun's modules share through private names, which Beyond does
// not have: a property or an export would be visible to programs.)

// node:fs/promises' `$data`: its FileHandle class and symbols, for
// internal/fs/streams, node:http2, node:worker_threads and internal/quic.
let promisesData: any;

export function setPromisesData(data: any): void {
  promisesData = data;
}

export function getPromisesData(): any {
  if (promisesData === undefined) import.meta.require("node:fs/promises");
  return promisesData;
}

// node:fs reads its stream exports again once node:internal/fs/streams (which
// imports node:fs) has been evaluated, when that was evaluated first.
let onStreamsReady: (() => void) | undefined;

export function setOnStreamsReady(f: () => void): void {
  onStreamsReady = f;
}

export function streamsReady(): void {
  onStreamsReady?.();
}
