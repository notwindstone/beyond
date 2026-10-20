// Hardcoded module "node:stream/iter"
// Public entry point for the iterable streams API.
// Usage: require('stream/iter') or require('node:stream/iter')
// Requires: --experimental-stream-iter (gated at module resolution)

import { process } from "beyond:process";
process.emitWarning("stream/iter is an experimental feature and might change at any time", "ExperimentalWarning");

// Protocol symbols
import { toStreamable, toAsyncStreamable, broadcastProtocol, shareProtocol, shareSyncProtocol, drainableProtocol } from "node:internal/streams/iter/types";

// Factories
import { push } from "node:internal/streams/iter/push";
import { duplex } from "node:internal/streams/iter/duplex";
import { from, fromSync } from "node:internal/streams/iter/from";

// Pipelines
import { pull, pullSync, pipeTo, pipeToSync } from "node:internal/streams/iter/pull";

// Consumers
import { bytes, bytesSync, text, textSync, arrayBuffer, arrayBufferSync, array, arraySync, tap, tapSync, merge, ondrain } from "node:internal/streams/iter/consumers";

// Classic stream interop (Node.js-specific, not part of the spec)
import { fromReadable, fromWritable, toReadable, toReadableSync, toWritable } from "node:internal/streams/iter/classic";

// Multi-consumer
import { broadcast, Broadcast } from "node:internal/streams/iter/broadcast";
import { share, shareSync, Share, SyncShare } from "node:internal/streams/iter/share";

/**
 * Stream namespace - unified access to all stream functions.
 */
const Stream = Object.freeze({
  // Factories
  push,
  duplex,
  from,
  fromSync,

  // Pipelines
  pull,
  pullSync,

  // Pipe to destination
  pipeTo,
  pipeToSync,

  // Consumers (async)
  bytes,
  text,
  arrayBuffer,
  array,

  // Consumers (sync)
  bytesSync,
  textSync,
  arrayBufferSync,
  arraySync,

  // Combining
  merge,

  // Multi-consumer (push model)
  broadcast,

  // Multi-consumer (pull model)
  share,
  shareSync,

  // Utilities
  tap,
  tapSync,

  // Drain utility for event source integration
  ondrain,

  // Protocol symbols
  toStreamable,
  toAsyncStreamable,
  broadcastProtocol,
  shareProtocol,
  shareSyncProtocol,
  drainableProtocol,
});

export default {
  // The Stream namespace
  Stream,

  // Also export everything individually for destructured imports

  // Protocol symbols
  toStreamable,
  toAsyncStreamable,
  broadcastProtocol,
  shareProtocol,
  shareSyncProtocol,
  drainableProtocol,

  // Factories
  push,
  duplex,
  from,
  fromSync,

  // Pipelines
  pull,
  pullSync,
  pipeTo,
  pipeToSync,

  // Consumers (async)
  bytes,
  text,
  arrayBuffer,
  array,

  // Consumers (sync)
  bytesSync,
  textSync,
  arrayBufferSync,
  arraySync,

  // Combining
  merge,

  // Multi-consumer
  broadcast,
  Broadcast,
  share,
  shareSync,
  Share,
  SyncShare,

  // Utilities
  tap,
  tapSync,
  ondrain,

  // Classic stream interop
  fromReadable,
  fromWritable,
  toReadable,
  toReadableSync,
  toWritable,
};

export { Stream, toStreamable, toAsyncStreamable, broadcastProtocol, shareProtocol, shareSyncProtocol, drainableProtocol, push, duplex, from, fromSync, pull, pullSync, pipeTo, pipeToSync, bytes, text, arrayBuffer, array, bytesSync, textSync, arrayBufferSync, arraySync, merge, broadcast, Broadcast, share, shareSync, Share, SyncShare, tap, tapSync, ondrain, fromReadable, fromWritable, toReadable, toReadableSync, toWritable };
