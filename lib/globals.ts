// The globals Beyond adds (this module runs before the program).

import { now } from "beyond:native";
import { Headers, Request, Response } from "./fetch.ts";
import { serve } from "./serve.ts";
import { clearInterval, clearTimeout, setInterval, setTimeout } from "./timers.ts";

const g = globalThis as any;
g.setTimeout = setTimeout;
g.setInterval = setInterval;
g.clearTimeout = clearTimeout;
g.clearInterval = clearInterval;
if (g.performance === undefined) {
  g.performance = { now, timeOrigin: Date.now() - now() };
}
g.Headers = Headers;
g.Request = Request;
g.Response = Response;
g.Beyond = { serve, version: "0.1.0" };
