// The globals Beyond adds (this module runs before the program).

import { now } from "beyond:native";
import { clearInterval, clearTimeout, setInterval, setTimeout } from "./timers.ts";

const g = globalThis as any;
g.setTimeout = setTimeout;
g.setInterval = setInterval;
g.clearTimeout = clearTimeout;
g.clearInterval = clearInterval;
if (g.performance === undefined) {
  g.performance = { now, timeOrigin: Date.now() - now() };
}
