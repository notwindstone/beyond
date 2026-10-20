// Natives of Bun's bun that Beyond does not have yet: each throws
// when used.

import { $nativeStub } from "node:internal/intrinsics";

export const getUseSystemCA: any = $nativeStub("bun", "getUseSystemCA");
