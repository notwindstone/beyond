// Hardcoded module "node:cluster"

import __internal_cluster_child from "node:internal/cluster/child";
import __internal_cluster_isPrimary from "node:internal/cluster/isPrimary";
import __internal_cluster_primary from "node:internal/cluster/primary";
import { process } from "beyond:process";
const { isPrimary } = __internal_cluster_isPrimary;
const child = isPrimary ? undefined : __internal_cluster_child;
const cluster = child ?? __internal_cluster_primary;
export default cluster;

//
//

function initializeClusterIPC() {
  // isPrimary was decided when internal/cluster/isPrimary was first loaded (node:net loads it), so
  // NODE_UNIQUE_ID may have been set since; only the child module has _setupWorker.
  if (child && process.argv[1] && process.env.NODE_UNIQUE_ID) {
    child._setupWorker();
    // Make sure it's not accidentally inherited by child processes.
    delete process.env.NODE_UNIQUE_ID;
  }
}

if (Bun.isMainThread) {
  initializeClusterIPC();
}
const __export_SCHED_NONE = cluster.SCHED_NONE;
const __export_SCHED_RR = cluster.SCHED_RR;
const __export_Worker = cluster.Worker;
const __export__events = cluster._events;
const __export__eventsCount = cluster._eventsCount;
const __export__maxListeners = cluster._maxListeners;
const __export_disconnect = cluster.disconnect;
const __export_fork = cluster.fork;
const __export_isMaster = cluster.isMaster;
const __export_isPrimary = cluster.isPrimary;
const __export_isWorker = cluster.isWorker;
const __export_schedulingPolicy = cluster.schedulingPolicy;
const __export_settings = cluster.settings;
const __export_setupMaster = cluster.setupMaster;
const __export_setupPrimary = cluster.setupPrimary;
const __export_workers = cluster.workers;
export { __export_SCHED_NONE as SCHED_NONE, __export_SCHED_RR as SCHED_RR, __export_Worker as Worker, __export__events as _events, __export__eventsCount as _eventsCount, __export__maxListeners as _maxListeners, __export_disconnect as disconnect, __export_fork as fork, __export_isMaster as isMaster, __export_isPrimary as isPrimary, __export_isWorker as isWorker, __export_schedulingPolicy as schedulingPolicy, __export_settings as settings, __export_setupMaster as setupMaster, __export_setupPrimary as setupPrimary, __export_workers as workers };
