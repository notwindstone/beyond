// Natives of Bun's node_os that Beyond does not have yet: each throws
// when used.

import { $nativeStub } from "node:internal/intrinsics";

export const createNodeOsBinding: any = $nativeStub("node_os", "createNodeOsBinding");
