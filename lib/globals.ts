// The globals Beyond adds (this module runs before the program). QuickJS-NG
// has some of the web's own: queueMicrotask, atob and btoa, DOMException,
// performance.

import { now } from "beyond:native";
import { structuredClone } from "./clone.ts";
import { Crypto, crypto } from "./crypto.ts";
import { TextDecoder, TextEncoder } from "./encoding.ts";
import { AbortController, AbortSignal, CustomEvent, Event, EventTarget, reportError } from "./events.ts";
import { Headers, Request, Response } from "./fetch.ts";
import { serve } from "./serve.ts";
import { clearInterval, clearTimeout, setInterval, setTimeout } from "./timers.ts";
import { URL, URLSearchParams } from "./url.ts";

const g = globalThis as any;

/** As the web's globals are: writable and configurable, not enumerable. */
function define(name: string, value: unknown): void {
  Object.defineProperty(g, name, { value, writable: true, configurable: true, enumerable: false });
}

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
define("Headers", Headers);
define("Request", Request);
define("Response", Response);
if (g.self === undefined) define("self", globalThis);
define("Beyond", { serve, version: "0.1.0" });
