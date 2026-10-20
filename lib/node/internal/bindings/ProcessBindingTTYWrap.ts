// Natives of Bun's ProcessBindingTTYWrap that Beyond does not have yet: each throws
// when used.

import { $nativeStub } from "node:internal/intrinsics";

export const createBunTTYFunctions: any = $nativeStub("ProcessBindingTTYWrap", "createBunTTYFunctions");
