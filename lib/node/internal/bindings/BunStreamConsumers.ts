// Natives of Bun's BunStreamConsumers.

/** A ReadableStream whose native source a Node readable reads from now on
 * (native-readable.ts): the stream itself is done with (its source stops
 * serving its pulls). */
export function jsFunctionTransferToNativeReadableStream(stream: any): void {
  const source = stream?.$bunNativePtr;
  if (source !== undefined && source !== null && typeof source.transfer === "function") source.transfer();
}
