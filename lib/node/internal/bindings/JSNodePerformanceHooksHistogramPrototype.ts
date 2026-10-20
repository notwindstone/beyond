// Natives of Bun's JSNodePerformanceHooksHistogramPrototype that Beyond does not have yet: each throws
// when used.

import { $nativeStub } from "node:internal/intrinsics";

export const jsFunction_disableEventLoopDelay: any = $nativeStub("JSNodePerformanceHooksHistogramPrototype", "jsFunction_disableEventLoopDelay");
export const jsFunction_enableEventLoopDelay: any = $nativeStub("JSNodePerformanceHooksHistogramPrototype", "jsFunction_enableEventLoopDelay");
export const jsFunction_monitorEventLoopDelay: any = $nativeStub("JSNodePerformanceHooksHistogramPrototype", "jsFunction_monitorEventLoopDelay");
