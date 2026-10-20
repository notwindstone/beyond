// Natives of Bun's NodeModuleModule that Beyond does not have yet: each throws
// when used.

import { $nativeStub } from "node:internal/intrinsics";

export const createStreamIterEnabledFlag: any = $nativeStub("NodeModuleModule", "createStreamIterEnabledFlag");
