// Natives of Bun's node_assert_binding that Beyond does not have yet: each throws
// when used.

import { $nativeStub } from "node:internal/intrinsics";

export const generate: any = $nativeStub("node_assert_binding", "generate");
