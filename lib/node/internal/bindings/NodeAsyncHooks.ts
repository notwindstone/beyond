// Natives of Bun's NodeAsyncHooks that Beyond does not have yet: each throws
// when used.

import { $nativeStub } from "node:internal/intrinsics";

export const jsSetAsyncHooksEnabled: any = $nativeStub("NodeAsyncHooks", "jsSetAsyncHooksEnabled");
