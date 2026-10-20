// Natives of Bun's mysql that Beyond does not have yet: each throws
// when used.

import { $nativeStub } from "node:internal/intrinsics";

export const createBinding: any = $nativeStub("mysql", "createBinding");
