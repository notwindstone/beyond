// `require('internal/test/binding')` — Node.js-internal testing shim used by
// the vendored node test suite. Resolution is gated like
// `bun:internal-for-testing`: release builds require `--expose-internals`
// (or BUN_FEATURE_FLAG_INTERNAL_FOR_TESTING); debug builds always allow it.
// See HardcodedModule::InternalTestBinding.

import { TextDecoder } from "beyond:encoding";
import { process } from "beyond:process";
import { jsDgramNewSocketFd as __native_udp_socket_jsDgramNewSocketFd } from "node:internal/bindings/udp_socket";
import { jsDgramListenFd as __native_udp_socket_jsDgramListenFd } from "node:internal/bindings/udp_socket";
import { jsDgramCloseFd as __native_udp_socket_jsDgramCloseFd } from "node:internal/bindings/udp_socket";
import { Bun__createNodeICUBinding as __native_NodeURL_Bun__createNodeICUBinding } from "node:internal/bindings/NodeURL";
import { $processBindingConstants } from "node:internal/intrinsics";
import agent from "node:internal/trace_events";

interface ErrnoError {
  errno: number;
}

const newRawSocketFd = __native_udp_socket_jsDgramNewSocketFd;
const listenRawFd = __native_udp_socket_jsDgramListenFd;
const closeRawFd = __native_udp_socket_jsDgramCloseFd;

// Just enough of internalBinding('tcp_wrap').TCP for vendored dgram tests to
// produce a listening stream descriptor and assert it gets rejected.
class TestTCPWrap {
  #fd = -1;

  constructor(_type: number) {
    this.#fd = newRawSocketFd(false, true);
  }

  get fd() {
    return this.#fd;
  }

  listen() {
    try {
      listenRawFd(this.#fd);
      return 0;
    } catch (err) {
      return typeof (err as ErrnoError | null | undefined)?.errno === "number" && (err as ErrnoError).errno < 0
        ? (err as ErrnoError).errno
        : -1;
    }
  }

  close() {
    if (this.#fd >= 0) {
      closeRawFd(this.#fd);
      this.#fd = -1;
    }
  }
}

import { isInsideNodeModules } from "node:internal/shared";

function safeGetenv(name: string) {
  return process.env[name];
}

let cachedUvBinding: Record<string, unknown> | undefined;

function internalBinding(name: string) {
  switch (name) {
    case "trace_events":
      return {
        trace: agent.trace,
        isTraceCategoryEnabled: agent.isTraceCategoryEnabled,
        getCategoryEnabledBuffer: agent.getCategoryEnabledBuffer,
      };
    case "constants":
      // The real thing: os/fs/crypto/zlib/trace sections, same object node's
      // internalBinding("constants") exposes (ProcessBindingConstants.cpp).
      return $processBindingConstants;
    case "quic":
      return import.meta.require("node:internal/quic/binding").default;
    case "uv": {
      // Add getErrorMessage (which node's uv binding exposes) derived from the same native uv_e
      // table so messages can never diverge. Cached: node returns a stable object.
      // https://github.com/nodejs/node/blob/main/src/uv.cc
      if (cachedUvBinding === undefined) {
        const errmap: Map<number, [string, string]> = import.meta.require("node:util").default.getSystemErrorMap();
        cachedUvBinding = {
          ...process.binding("uv"),
          getErrorMessage: function getErrorMessage(n: number) {
            const entry = errmap.get(n);
            return entry !== undefined ? entry[1] : `Unknown system error ${n}`;
          },
        };
      }
      return cachedUvBinding;
    }
    // node's credentials binding: without setuid/setgid mismatch handling,
    // safeGetenv degenerates to a plain env read (same as node run normally).
    case "credentials":
      return { safeGetenv };
    case "buffer": {
      const { kMaxLength, kStringMaxLength } = import.meta.require("node:buffer").default;
      return { kMaxLength, kStringMaxLength };
    }
    case "udp_wrap":
      return { UDP: import.meta.require("node:internal/dgram").default.UDP };
    case "tcp_wrap":
      return { TCP: TestTCPWrap, constants: { SOCKET: 0, SERVER: 1 } };
    case "util":
      return { isInsideNodeModules };
    case "cares_wrap":
      // Only the pure IP-normalizer the vendored tls/dns tests reach for; the
      // resolver surface lives in node:dns.
      return { canonicalizeIP: import.meta.require("node:internal/bun/internal-for-testing").default.canonicalizeIP };
    // The icu-era binding node exposed until nodejs/node#55156; vendored
    // tests like test-icu-punycode still consume it.
    case "icu": {
      const icu = __native_NodeURL_Bun__createNodeICUBinding;
      // Node asked ICU's converter registry; answer from the runtime's
      // encoding registry instead.
      icu.hasConverter = function hasConverter(label: string) {
        try {
          new TextDecoder(label);
          return true;
        } catch {
          return false;
        }
      };
      return icu;
    }
    default: {
      const err = new Error(`internalBinding("${name}") is not implemented in Bun`);
      // node reports unknown/restricted bindings with this code.
      (err as Error & { code: string }).code = "ERR_INVALID_MODULE";
      throw err;
    }
  }
}

export default { internalBinding };

export { internalBinding };
