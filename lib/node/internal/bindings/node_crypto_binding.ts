// Natives of Bun's node_crypto_binding that Beyond does not have yet: each throws
// when used.

import { $nativeStub } from "node:internal/intrinsics";

export const createNodeCryptoBinding: any = $nativeStub("node_crypto_binding", "createNodeCryptoBinding");
export const createNodeCryptoBindingZig: any = $nativeStub("node_crypto_binding", "createNodeCryptoBindingZig");
