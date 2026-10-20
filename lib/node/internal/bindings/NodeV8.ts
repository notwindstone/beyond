// Natives of Bun's NodeV8 that Beyond does not have yet: each throws
// when used.

import { $nativeStub } from "node:internal/intrinsics";

export const Bun__createNodeV8Binding: any = $nativeStub("NodeV8", "Bun__createNodeV8Binding");
