"use strict";

import __internal_streams_duplex from "node:internal/streams/duplex";
import __internal_streams_duplexpair from "node:internal/streams/duplexpair";
import __internal_streams_legacy from "node:internal/streams/legacy";
import __internal_streams_operators from "node:internal/streams/operators";
import __internal_streams_passthrough from "node:internal/streams/passthrough";
import __internal_streams_readable from "node:internal/streams/readable";
import __internal_streams_transform from "node:internal/streams/transform";
import __internal_streams_writable from "node:internal/streams/writable";
import { $Buffer, $ERR_ILLEGAL_CONSTRUCTOR } from "node:internal/intrinsics";
const ObjectKeys = Object.keys;
const ObjectDefineProperty = Object.defineProperty;

const customPromisify = Symbol.for("nodejs.util.promisify.custom");
const { streamReturningOperators, promiseReturningOperators } = __internal_streams_operators;
import compose from "node:internal/streams/compose";
import { setDefaultHighWaterMark, getDefaultHighWaterMark } from "node:internal/streams/state";
import { pipeline } from "node:internal/streams/pipeline";
import { destroyer } from "node:internal/streams/destroy";
import eos from "node:internal/streams/end-of-stream";
import utils from "node:internal/streams/utils";
import { isArrayBufferView, isUint8Array } from "node:util/types";
const Stream = __internal_streams_legacy.Stream;

Stream.isDestroyed = utils.isDestroyed;
Stream.isDisturbed = utils.isDisturbed;
Stream.isErrored = utils.isErrored;
Stream.isReadable = utils.isReadable;
Stream.isWritable = utils.isWritable;

Stream.Readable = __internal_streams_readable;
const streamKeys = ObjectKeys(streamReturningOperators);
for (let i = 0; i < streamKeys.length; i++) {
  const key = streamKeys[i];
  const op = streamReturningOperators[key];
  function fn(...args) {
    if (new.target) {
      throw $ERR_ILLEGAL_CONSTRUCTOR();
    }
    return Stream.Readable.from(op.apply(this, args));
  }
  ObjectDefineProperty(fn, "name", { __proto__: null, value: op.name });
  ObjectDefineProperty(fn, "length", { __proto__: null, value: op.length });
  ObjectDefineProperty(Stream.Readable.prototype, key, {
    __proto__: null,
    value: fn,
    enumerable: false,
    configurable: true,
    writable: true,
  });
}
const promiseKeys = ObjectKeys(promiseReturningOperators);
for (let i = 0; i < promiseKeys.length; i++) {
  const key = promiseKeys[i];
  const op = promiseReturningOperators[key];
  function fn(...args) {
    if (new.target) {
      throw $ERR_ILLEGAL_CONSTRUCTOR();
    }
    return Promise.resolve().then(() => op.apply(this, args));
  }
  ObjectDefineProperty(fn, "name", { __proto__: null, value: op.name });
  ObjectDefineProperty(fn, "length", { __proto__: null, value: op.length });
  ObjectDefineProperty(Stream.Readable.prototype, key, {
    __proto__: null,
    value: fn,
    enumerable: false,
    configurable: true,
    writable: true,
  });
}
Stream.Writable = __internal_streams_writable;
Stream.Duplex = __internal_streams_duplex;
Stream.Transform = __internal_streams_transform;
Stream.PassThrough = __internal_streams_passthrough;
Stream.duplexPair = __internal_streams_duplexpair;
Stream.pipeline = pipeline;
import { addAbortSignal } from "node:internal/streams/add-abort-signal";
Stream.addAbortSignal = addAbortSignal;
Stream.finished = eos;
Stream.destroy = destroyer;
Stream.compose = compose;
Stream.setDefaultHighWaterMark = setDefaultHighWaterMark;
Stream.getDefaultHighWaterMark = getDefaultHighWaterMark;

ObjectDefineProperty(Stream, "promises", {
  __proto__: null,
  configurable: true,
  enumerable: true,
  get() {
    return import.meta.require("node:internal/stream.promises").default;
  },
});

ObjectDefineProperty(pipeline, customPromisify, {
  __proto__: null,
  enumerable: true,
  get() {
    return import.meta.require("node:internal/stream.promises").default.pipeline;
  },
});

ObjectDefineProperty(eos, customPromisify, {
  __proto__: null,
  enumerable: true,
  get() {
    return import.meta.require("node:internal/stream.promises").default.finished;
  },
});

// Backwards-compat with node 0.4.x
Stream.Stream = Stream;

Stream._isArrayBufferView = isArrayBufferView;
Stream._isUint8Array = isUint8Array;
Stream._uint8ArrayToBuffer = function _uint8ArrayToBuffer(chunk) {
  return new $Buffer(chunk.buffer, chunk.byteOffset, chunk.byteLength);
};

export default Stream;

export { pipeline, addAbortSignal, eos as finished, destroyer as destroy, compose, setDefaultHighWaterMark, getDefaultHighWaterMark, Stream, isArrayBufferView as _isArrayBufferView, isUint8Array as _isUint8Array };
