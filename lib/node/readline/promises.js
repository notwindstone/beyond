// Ported from Node.js v26.3.0 lib/readline/promises.js for Bun's node:repl.
// Attribution: derived from Node.js, MIT licensed (Node.js contributors).
// prettier-ignore
import __internal_readline_interface from "node:internal/readline/interface";
import __internal_readline_promises from "node:internal/readline/promises";
import primordials from "node:internal/repl/node-primordials";
var __node_module__ = { exports: {} };

const { Promise, SymbolDispose } = primordials;

const { Readline } = __internal_readline_promises;

const { Interface: _Interface, kQuestion, kQuestionCancel, kQuestionReject } = __internal_readline_interface;

import { AbortError } from "node:internal/repl/node-errors";
import { validateAbortSignal } from "node:internal/validators";

import { kEmptyObject } from "node:internal/shared";
let addAbortListener;

class Interface extends _Interface {
  question(query, options = kEmptyObject) {
    return new Promise((resolve, reject) => {
      let cb = resolve;

      if (options?.signal) {
        validateAbortSignal(options.signal, "options.signal");
        if (options.signal.aborted) {
          return reject(new AbortError(undefined, { cause: options.signal.reason }));
        }

        const onAbort = () => {
          this[kQuestionCancel]();
          reject(new AbortError(undefined, { cause: options.signal.reason }));
        };
        addAbortListener ??= import.meta.require("node:internal/abort_listener").default.addAbortListener;
        const disposable = addAbortListener(options.signal, onAbort);

        cb = answer => {
          disposable[SymbolDispose]();
          resolve(answer);
        };
      }

      this[kQuestionReject] = reject;

      this[kQuestion](query, cb);
    });
  }
}

function createInterface(input, output, completer, terminal) {
  return new Interface(input, output, completer, terminal);
}

__node_module__.exports = {
  Interface,
  Readline,
  createInterface,
};

const __default = __node_module__.exports;
export default __default;
const __export_Interface = __default.Interface;
const __export_Readline = __default.Readline;
const __export_createInterface = __default.createInterface;
export { __export_Interface as Interface, __export_Readline as Readline, __export_createInterface as createInterface };
