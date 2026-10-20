// Shim for Node's `internal/util/inspect` as consumed by the ported
// node:repl / internal/readline stack. getStringWidth/stripVTControlCharacters
// go straight to the native bindings so `require("node:readline")` does not
// pull in the 99 KB internal/util/inspect; inspect loads it lazily on
// first access (REPL output / completion rendering).

import { jsFunctionBunStringWidth as __native_stringWidth_jsFunctionBunStringWidth } from "node:internal/bindings/stringWidth";
import { $ERR_INVALID_ARG_TYPE } from "node:internal/intrinsics";
const stripANSI = Bun.stripANSI;
const nativeStringWidth = __native_stringWidth_jsFunctionBunStringWidth;
const StringPrototypeNormalize = String.prototype.normalize;

// Same wrapper internal/util/inspect exports: strip ANSI (opt-out via second
// arg) then NFC-normalize so combining sequences measure as one cell.
function getStringWidth(str, removeControlChars = true) {
  if (removeControlChars) str = stripANSI(str);
  return nativeStringWidth(StringPrototypeNormalize.call(str, "NFC"));
}

function stripVTControlCharacters(str) {
  if (typeof str !== "string") throw $ERR_INVALID_ARG_TYPE("str", "string", str);
  return stripANSI(str);
}

let util;
function load() {
  return (util ??= import.meta.require("node:internal/util/inspect").default);
}

export default {
  getStringWidth,
  stripVTControlCharacters,
  get inspect() {
    return load().inspect;
  },
};

export { getStringWidth, stripVTControlCharacters };
