// Natives of Bun's BunDebugger that Beyond does not have yet: each throws
// when used.

import { $nativeStub } from "node:internal/intrinsics";

export const jsFunction_closeNodeInspector: any = $nativeStub("BunDebugger", "jsFunction_closeNodeInspector");
export const jsFunction_openNodeInspector: any = $nativeStub("BunDebugger", "jsFunction_openNodeInspector");
export const jsFunction_postNodeInspectorControl: any = $nativeStub("BunDebugger", "jsFunction_postNodeInspectorControl");
export const jsFunction_waitForNodeInspectorConnection: any = $nativeStub("BunDebugger", "jsFunction_waitForNodeInspectorConnection");
