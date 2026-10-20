// Natives of Bun's SecureContext that Beyond does not have yet: each throws
// when used.

import { $nativeStub } from "node:internal/intrinsics";

export const js_getConstructor: any = $nativeStub("SecureContext", "js_getConstructor");
