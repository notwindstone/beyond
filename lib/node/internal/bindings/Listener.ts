// Natives of Bun's Listener that Beyond does not have yet: each throws
// when used.

import { $nativeStub } from "node:internal/intrinsics";

export const jsAddServerName: any = $nativeStub("Listener", "jsAddServerName");
export const jsSetSecureContext: any = $nativeStub("Listener", "jsSetSecureContext");
