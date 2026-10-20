import { clusterRawBind as __native_node_cluster_binding_clusterRawBind } from "node:internal/bindings/node_cluster_binding";
import { clusterCloseHandle as __native_node_cluster_binding_clusterCloseHandle } from "node:internal/bindings/node_cluster_binding";
import { clusterValidateFd as __native_node_cluster_binding_clusterValidateFd } from "node:internal/bindings/node_cluster_binding";
const clusterRawBind = __native_node_cluster_binding_clusterRawBind;
const closeRawHandle = __native_node_cluster_binding_clusterCloseHandle;
const validateFd = __native_node_cluster_binding_clusterValidateFd;

export default class SharedHandle {
  key;
  workers;
  handle;
  errno;
  data;
  sharedOnly;

  constructor(key, address, { port, addressType, fd, flags, sharedOnly }) {
    this.key = key;
    this.workers = new Map();
    this.handle = null;
    this.errno = 0;
    this.data = undefined;
    this.sharedOnly = sharedOnly === true;

    if (typeof fd === "number" && fd >= 0) {
      const err = validateFd(fd);
      if (err !== 0) {
        this.errno = err;
      } else {
        this.handle = { fd, port };
      }
      return;
    }
    const rval = clusterRawBind(addressType, address, typeof port === "number" ? port : 0, flags | 0);
    if (typeof rval === "number") this.errno = rval;
    else {
      this.handle = rval;
      if (addressType === -1 && (typeof address !== "string" || address.charCodeAt(0) !== 0)) {
        this.handle.path = address;
      }
    }
  }

  add(worker, send) {
    
    this.workers.set(worker.id, worker);
    send(this.errno, null, this.handle);
  }

  has(worker) {
    return this.workers.has(worker.id);
  }

  remove(worker) {
    const workers = this.workers;
    if (!workers.has(worker.id)) return false;

    workers.delete(worker.id);

    if (workers.size !== 0) return false;

    const handle = this.handle;
    if (handle) {
      const { fd, path } = handle;
      closeRawHandle(fd);
      if (path) {
        try {
          import.meta.require("node:fs").default.unlinkSync(path);
        } catch {}
      }
      this.handle = null;
    }
    return true;
  }
}
