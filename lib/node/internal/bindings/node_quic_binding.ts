// Natives of Bun's node_quic_binding that Beyond does not have yet: each throws
// when used.

import { $nativeStub } from "node:internal/intrinsics";

export const createNodeQuicBinding: any = $nativeStub("node_quic_binding", "createNodeQuicBinding");
