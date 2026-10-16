// The globals Beyond adds (this module runs before the program). QuickJS-NG
// has some of the web's own: queueMicrotask, atob and btoa, DOMException,
// performance.

import { gc as nativeGC, now, randomUUIDv7 as nativeUUIDv7 } from "beyond:native";
import { Blob, File } from "./blob.ts";
import { structuredClone } from "./clone.ts";
import { console } from "./console.ts";
import { Crypto, crypto } from "./crypto.ts";
import { TextDecoder, TextDecoderStream, TextEncoder, TextEncoderStream } from "./encoding.ts";
import { AbortController, AbortSignal, CustomEvent, Event, EventTarget, reportError } from "./events.ts";
import { Headers, Request, Response } from "./fetch.ts";
import { FormData } from "./formdata.ts";
import { inspect } from "./inspect.ts";
import { serve } from "./serve.ts";
import {
  ByteLengthQueuingStrategy,
  CountQueuingStrategy,
  ReadableByteStreamController,
  ReadableStream,
  ReadableStreamBYOBReader,
  ReadableStreamBYOBRequest,
  ReadableStreamDefaultController,
  ReadableStreamDefaultReader,
  TransformStream,
  TransformStreamDefaultController,
  WritableStream,
  WritableStreamDefaultController,
  WritableStreamDefaultWriter,
} from "./streams.ts";
import { fetch } from "./client.ts";
import { clearInterval, clearTimeout, setInterval, setTimeout } from "./timers.ts";
import { URL, URLSearchParams } from "./url.ts";

const g = globalThis as any;

/** As the web's globals are: writable and configurable, not enumerable. */
function define(name: string, value: unknown): void {
  Object.defineProperty(g, name, { value, writable: true, configurable: true, enumerable: false });
}

define("console", console);
define("setTimeout", setTimeout);
define("setInterval", setInterval);
define("clearTimeout", clearTimeout);
define("clearInterval", clearInterval);
if (g.performance === undefined) define("performance", { now, timeOrigin: Date.now() - now() });
define("TextEncoder", TextEncoder);
define("TextDecoder", TextDecoder);
define("Event", Event);
define("CustomEvent", CustomEvent);
define("EventTarget", EventTarget);
define("AbortController", AbortController);
define("AbortSignal", AbortSignal);
define("reportError", reportError);
define("Crypto", Crypto);
define("crypto", crypto);
define("structuredClone", structuredClone);
define("URL", URL);
define("URLSearchParams", URLSearchParams);
define("Blob", Blob);
define("File", File);
define("FormData", FormData);
define("ReadableStream", ReadableStream);
define("ReadableStreamDefaultReader", ReadableStreamDefaultReader);
define("ReadableStreamDefaultController", ReadableStreamDefaultController);
define("ReadableStreamBYOBReader", ReadableStreamBYOBReader);
define("ReadableStreamBYOBRequest", ReadableStreamBYOBRequest);
define("ReadableByteStreamController", ReadableByteStreamController);
define("WritableStream", WritableStream);
define("WritableStreamDefaultWriter", WritableStreamDefaultWriter);
define("WritableStreamDefaultController", WritableStreamDefaultController);
define("TransformStream", TransformStream);
define("TransformStreamDefaultController", TransformStreamDefaultController);
define("ByteLengthQueuingStrategy", ByteLengthQueuingStrategy);
define("CountQueuingStrategy", CountQueuingStrategy);
define("TextEncoderStream", TextEncoderStream);
define("TextDecoderStream", TextDecoderStream);
define("Headers", Headers);
define("Request", Request);
define("Response", Response);
define("fetch", fetch);
if (g.self === undefined) define("self", globalThis);
/** Bun.sleep: a promise fulfilled after `ms` milliseconds (or at a Date). */
function sleep(ms: number | Date): Promise<void> {
  const delay = ms instanceof Date ? ms.getTime() - Date.now() : Number(ms);
  return new Promise((resolve) => setTimeout(resolve, delay > 0 ? delay : 0));
}

/** Bun.randomUUIDv7: a version 7 UUID (of `timestamp`, else now). */
function randomUUIDv7(encoding?: string, timestamp?: number | Date): string | Uint8Array {
  const t = timestamp instanceof Date ? timestamp.getTime() : timestamp === undefined ? Date.now() : Number(timestamp);
  const uuid = nativeUUIDv7(t) as string;
  if (encoding === undefined || encoding === "hex") return uuid;
  const hex = uuid.replace(/-/g, "");
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) bytes[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  if (encoding === "buffer") return bytes;
  let bin = "";
  for (let i = 0; i < 16; i++) bin += String.fromCharCode(bytes[i]);
  const b64 = btoa(bin);
  if (encoding === "base64") return b64;
  if (encoding === "base64url") return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  throw new TypeError(`Unknown encoding: ${encoding}`);
}

/** Bun.gc: a collection (always a full one). */
function gc(_force?: boolean): void {
  nativeGC();
}

const runtime = { serve, inspect, version: "0.1.0", sleep, randomUUIDv7, gc };
define("Beyond", runtime);
// Code written for Bun runs as it is: `Bun` is `Beyond`.
define("Bun", runtime);
