// Natives of Bun's JSNodePerformanceHooksHistogram that Beyond does not have yet: each throws
// when used.

import { $nativeStub } from "node:internal/intrinsics";

export const jsFunction_createHistogram: any = $nativeStub("JSNodePerformanceHooksHistogram", "jsFunction_createHistogram");
