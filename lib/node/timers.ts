import { setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, clearImmediate } from "beyond:timers";
import { $isCallable } from "node:internal/intrinsics";
import { throwNotImplemented } from "node:internal/shared";

var timersPromisesValue;

const __default = {
  setTimeout,
  clearTimeout,
  setInterval,
  setImmediate,
  clearInterval,
  clearImmediate,
  get promises() {
    return (timersPromisesValue ??= import.meta.require("node:timers/promises").default);
  },
  set promises(value) {
    timersPromisesValue = value;
  },
  active(timer) {
    if ($isCallable(timer?.refresh)) {
      timer.refresh();
    } else {
      throwNotImplemented("'timers.active'");
    }
  },
  unenroll(timer) {
    if ($isCallable(timer?.refresh)) {
      clearTimeout(timer);
      return;
    }

    throwNotImplemented("'timers.unenroll'");
  },
  enroll(timer, _msecs) {
    if ($isCallable(timer?.refresh)) {
      timer.refresh();
      return;
    }

    throwNotImplemented("'timers.enroll'");
  },
};
export default __default;
const __export_active = __default.active;
const __export_clearImmediate = __default.clearImmediate;
const __export_clearInterval = __default.clearInterval;
const __export_clearTimeout = __default.clearTimeout;
const __export_enroll = __default.enroll;
const __export_promises = __default.promises;
const __export_setImmediate = __default.setImmediate;
const __export_setInterval = __default.setInterval;
const __export_setTimeout = __default.setTimeout;
const __export_unenroll = __default.unenroll;
export { __export_active as active, __export_clearImmediate as clearImmediate, __export_clearInterval as clearInterval, __export_clearTimeout as clearTimeout, __export_enroll as enroll, __export_promises as promises, __export_setImmediate as setImmediate, __export_setInterval as setInterval, __export_setTimeout as setTimeout, __export_unenroll as unenroll };
