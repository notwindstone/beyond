// Natives of Bun's JSInspectorProfiler that Beyond does not have yet: each throws
// when used.

import { $nativeStub } from "node:internal/intrinsics";

export const jsFunction_collectPreciseCoverage: any = $nativeStub("JSInspectorProfiler", "jsFunction_collectPreciseCoverage");
export const jsFunction_isCPUProfilerRunning: any = $nativeStub("JSInspectorProfiler", "jsFunction_isCPUProfilerRunning");
export const jsFunction_setCPUSamplingInterval: any = $nativeStub("JSInspectorProfiler", "jsFunction_setCPUSamplingInterval");
export const jsFunction_startCPUProfiler: any = $nativeStub("JSInspectorProfiler", "jsFunction_startCPUProfiler");
export const jsFunction_startPreciseCoverage: any = $nativeStub("JSInspectorProfiler", "jsFunction_startPreciseCoverage");
export const jsFunction_stopCPUProfiler: any = $nativeStub("JSInspectorProfiler", "jsFunction_stopCPUProfiler");
export const jsFunction_stopPreciseCoverage: any = $nativeStub("JSInspectorProfiler", "jsFunction_stopPreciseCoverage");
