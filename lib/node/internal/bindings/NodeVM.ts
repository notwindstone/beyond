// Natives of Bun's NodeVM that Beyond does not have yet: each throws
// when used.

import { $nativeStub } from "node:internal/intrinsics";

export const Bun__createNodeVMBinding: any = $nativeStub("NodeVM", "Bun__createNodeVMBinding");
