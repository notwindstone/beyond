// The globals Beyond adds (this module runs before the program). QuickJS-NG
// has some of the web's own: queueMicrotask, atob and btoa, DOMException,
// performance.

import { buildTranspile, gc as nativeGC, now, randomUUIDv7 as nativeUUIDv7 } from "beyond:native";
import { Blob, File } from "./blob.ts";
import { structuredClone } from "./clone.ts";
import { console } from "./console.ts";
import { Crypto, crypto } from "./crypto.ts";
import { TextDecoder, TextDecoderStream, TextEncoder, TextEncoderStream } from "./encoding.ts";
import { AbortController, AbortSignal, CustomEvent, Event, EventTarget, reportError } from "./events.ts";
import { Headers, Request, Response } from "./fetch.ts";
import { file, write } from "./file.ts";
import { builtinModule, libModule } from "./modules.ts";
import { Buffer } from "./node/buffer.ts";
import { process } from "./process.ts";
import { FormData } from "./formdata.ts";
import { inspect } from "./inspect.ts";
import {
  Performance,
  PerformanceEntry,
  PerformanceMark,
  PerformanceMeasure,
  PerformanceObserver,
  PerformanceObserverEntryList,
  PerformanceResourceTiming,
  performance,
} from "./performance.ts";
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
import { clearImmediate, clearInterval, clearTimeout, setImmediate, setInterval, setTimeout } from "./timers.ts";
import { URL, URLSearchParams } from "./url.ts";
import { fileURLToPath, pathToFileURL } from "./sys/url.ts";

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
define("performance", performance);
define("Performance", Performance);
define("PerformanceEntry", PerformanceEntry);
define("PerformanceMark", PerformanceMark);
define("PerformanceMeasure", PerformanceMeasure);
define("PerformanceObserver", PerformanceObserver);
define("PerformanceObserverEntryList", PerformanceObserverEntryList);
define("PerformanceResourceTiming", PerformanceResourceTiming);
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
define("process", process);
define("Buffer", Buffer);
define("global", globalThis);
define("setImmediate", setImmediate);
define("clearImmediate", clearImmediate);
(globalThis as any)[Symbol.for("beyond.builtin")] = builtinModule;
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

/** Bun.Transpiler: TypeScript and JSX made JavaScript. */
class Transpiler {
  #loader: string;
  constructor(options?: { loader?: string }) {
    this.#loader = options?.loader ?? "tsx";
  }
  transformSync(code: string, loader?: string): string {
    const l = loader ?? this.#loader;
    const r = JSON.parse(buildTranspile(JSON.stringify({ path: "input." + l, source: code, loader: l })) as string);
    if (r.error !== undefined) throw new SyntaxError(r.error);
    return r.code;
  }
  async transform(code: string, loader?: string): Promise<string> {
    return this.transformSync(code, loader);
  }
}

const runtime = {
  serve,
  inspect,
  version: "0.1.0",
  sleep,
  randomUUIDv7,
  gc,
  /** Bun.build: lib/build.ts, loaded when first used. */
  async build(config: any): Promise<any> {
    return (await libModule("build.ts")).build(config);
  },
  file,
  write,
  Transpiler,
  env: process.env,
  argv: process.argv,
  /** (One thread runs JavaScript: the main one.) */
  isMainThread: true,
  fileURLToPath,
  pathToFileURL,
  /** Bun.nanoseconds: nanoseconds since the program started. */
  nanoseconds(): number {
    return Math.floor(now() * 1e6);
  },
  /** Bun.stringWidth: the columns a string takes in a terminal. */
  stringWidth(s: unknown, options?: { countAnsiEscapeCodes?: boolean }): number {
    return import.meta.require("node:internal/bindings/stringWidth").jsFunctionBunStringWidth(s, options);
  },
  /** Bun.spawn: a child process (lib/spawn.ts, evaluated when first used). */
  spawn(cmd: any, options?: any): any {
    return import.meta.require("./spawn.ts").spawn(cmd, options);
  },
  /** Bun.spawnSync: a child process, run to its end. */
  spawnSync(cmd: any, options?: any): any {
    return import.meta.require("./spawn.ts").spawnSync(cmd, options);
  },
  /** Bun.deepEquals: Node's deep equality, strict or loose. */
  deepEquals(a: unknown, b: unknown, strict?: boolean): boolean {
    const m = import.meta.require("node:internal/util/deep_equal");
    return strict ? m.isDeepStrictEqual(a, b) : m.isDeepEqual(a, b);
  },
  get main(): string {
    return process.argv[1] ?? "";
  },
  /** Bun.jest(path): bun:test's functions (lib/jest.ts, loaded when first used). */
  jest(path?: string): any {
    return import.meta.require("./jest.ts").jestFor(path);
  },
};
define("Beyond", runtime);
// Code written for Bun runs as it is: `Bun` is `Beyond`.
define("Bun", runtime);
