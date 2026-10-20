// Natives of Bun's JSMIMEParams that Beyond does not have yet: each throws
// when used.

import { $nativeStub } from "node:internal/intrinsics";

export const createJSMIMEBinding: any = $nativeStub("JSMIMEParams", "createJSMIMEBinding");
