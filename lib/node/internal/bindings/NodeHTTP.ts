// Natives of Bun's NodeHTTP that Beyond does not have yet: each throws
// when used.

import { $nativeStub } from "node:internal/intrinsics";

export const createNodeHTTPInternalBinding: any = $nativeStub("NodeHTTP", "createNodeHTTPInternalBinding");
