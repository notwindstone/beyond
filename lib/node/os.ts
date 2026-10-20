// Hardcoded module "node:os"
import { process } from "beyond:process";
import { createNodeOsBinding as __native_node_os_createNodeOsBinding } from "node:internal/bindings/node_os";
import { $bundleError, $processBindingConstants } from "node:internal/intrinsics";
var tmpdir = function () {
  var env = Bun.env;

  tmpdir = function () {
    if (process.platform === "win32") {
      // using node implementation
      // https://github.com/nodejs/node/blob/ad5e2dab4c8306183685973387829c2f69e793da/lib/os.js#L186
      var path = env["TEMP"] || env["TMP"] || (env["SystemRoot"] || env["windir"]) + "\\temp";
      if (path.length > 1 && path[path.length - 1] === "\\" && !String.prototype.endsWith.call(path, ":\\")) {
        path = String.prototype.slice.call(path, 0, -1);
      }
      return path;
    }
    var path =
      env["TMPDIR"] || env["TMP"] || env["TEMP"] || (process.platform === "android" ? "/data/local/tmp" : "/tmp");
    const length = path.length;
    if (length > 1 && path[length - 1] === "/") path = path.slice(0, -1);
    return path;
  };

  tmpdir[Symbol.toPrimitive] = tmpdir;

  return tmpdir();
};

// os.cpus() is super expensive
// Specifically: getting the CPU speed on Linux is very expensive
// Some packages like FastGlob only bother to read the length of the array
// so instead of actually populating the entire object
// we turn them into getters
function lazyCpus({ cpus, hostCpuCount }) {
  return () => {
    const array = new Array(hostCpuCount);
    function populate() {
      const results = cpus();
      const length = results.length;
      array.length = length;
      for (let i = 0; i < length; i++) {
        array[i] = results[i];
      }
    }

    for (let i = 0; i < array.length; i++) {
      // This is technically still observable via
      // Object.getOwnPropertyDescriptors(), but it should be okay.
      const instance = {
        get model() {
          if (array[i] === instance) populate();
          return array[i].model;
        },
        set model(value) {
          if (array[i] === instance) populate();
          array[i].model = value;
        },

        get speed() {
          if (array[i] === instance) populate();
          return array[i].speed;
        },

        set speed(value) {
          if (array[i] === instance) populate();
          array[i].speed = value;
        },

        get times() {
          if (array[i] === instance) populate();
          return array[i].times;
        },
        set times(value) {
          if (array[i] === instance) populate();
          array[i].times = value;
        },

        toJSON() {
          if (array[i] === instance) populate();
          return array[i];
        },
      };

      array[i] = instance;
    }

    return array;
  };
}

// all logic based on `process.platform` and `process.arch` is inlined at bundle time
function bound(binding) {
  return {
    availableParallelism: function () {
      return navigator.hardwareConcurrency;
    },
    arch: function () {
      return process.arch;
    },
    cpus: lazyCpus(binding),
    endianness: function () {
      return process.arch === "arm64" || process.arch === "x64" //
        ? "LE"
        : $bundleError("TODO: endianness");
    },
    freemem: binding.freemem,
    getPriority: binding.getPriority,
    homedir: binding.homedir,
    hostname: binding.hostname,
    loadavg: binding.loadavg,
    networkInterfaces: binding.networkInterfaces,
    platform: function () {
      return process.platform;
    },
    release: binding.release,
    setPriority: binding.setPriority,
    get tmpdir() {
      return tmpdir;
    },
    totalmem: binding.totalmem,
    type: function () {
      return process.platform === "win32"
        ? "Windows_NT"
        : process.platform === "darwin"
          ? "Darwin"
          : process.platform === "linux" || process.platform === "android"
            ? "Linux"
            : process.platform === "freebsd"
              ? "FreeBSD"
              : $bundleError("TODO: type");
    },
    uptime: binding.uptime,
    userInfo: binding.userInfo,
    version: binding.version,
    machine: function () {
      // TODO: linux arm64 should also return "aarch64" (Node/uname compat) —
      // separate PR to avoid behavior change in the Android port.
      // FreeBSD: uname -m returns MACHINE ("arm64"/"amd64"), not MACHINE_ARCH.
      return process.arch === "arm64"
        ? process.platform === "android"
          ? "aarch64"
          : "arm64"
        : process.arch === "x64"
          ? process.platform === "freebsd"
            ? "amd64"
            : "x86_64"
          : $bundleError("TODO: machine");
    },
    devNull: process.platform === "win32" ? "\\\\.\\nul" : "/dev/null",
    get EOL() {
      return process.platform === "win32" ? "\r\n" : "\n";
    },
    constants: $processBindingConstants.os,
  };
}

const out = bound(__native_node_os_createNodeOsBinding);

symbolToStringify(out, "arch");
symbolToStringify(out, "availableParallelism");
symbolToStringify(out, "endianness");
symbolToStringify(out, "freemem");
symbolToStringify(out, "homedir");
symbolToStringify(out, "hostname");
symbolToStringify(out, "platform");
symbolToStringify(out, "release");
symbolToStringify(out, "tmpdir");
symbolToStringify(out, "totalmem");
symbolToStringify(out, "type");
symbolToStringify(out, "uptime");
symbolToStringify(out, "version");
symbolToStringify(out, "machine");

function symbolToStringify(obj, key) {
  
  obj[key][Symbol.toPrimitive] = function (_hint: string) {
    return obj[key]();
  };
}

export default out;
const __export_EOL = out.EOL;
const __export_arch = out.arch;
const __export_availableParallelism = out.availableParallelism;
const __export_constants = out.constants;
const __export_cpus = out.cpus;
const __export_devNull = out.devNull;
const __export_endianness = out.endianness;
const __export_freemem = out.freemem;
const __export_getPriority = out.getPriority;
const __export_homedir = out.homedir;
const __export_hostname = out.hostname;
const __export_loadavg = out.loadavg;
const __export_machine = out.machine;
const __export_networkInterfaces = out.networkInterfaces;
const __export_platform = out.platform;
const __export_release = out.release;
const __export_setPriority = out.setPriority;
const __export_tmpdir = out.tmpdir;
const __export_totalmem = out.totalmem;
const __export_type = out.type;
const __export_uptime = out.uptime;
const __export_userInfo = out.userInfo;
const __export_version = out.version;
export { __export_EOL as EOL, __export_arch as arch, __export_availableParallelism as availableParallelism, __export_constants as constants, __export_cpus as cpus, __export_devNull as devNull, __export_endianness as endianness, __export_freemem as freemem, __export_getPriority as getPriority, __export_homedir as homedir, __export_hostname as hostname, __export_loadavg as loadavg, __export_machine as machine, __export_networkInterfaces as networkInterfaces, __export_platform as platform, __export_release as release, __export_setPriority as setPriority, __export_tmpdir as tmpdir, __export_totalmem as totalmem, __export_type as type, __export_uptime as uptime, __export_userInfo as userInfo, __export_version as version };
