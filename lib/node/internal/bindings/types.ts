// Natives of Bun's types that Beyond does not have yet: each throws
// when used.

import { $nativeStub } from "node:internal/intrinsics";

export const jsAssertEncodingValid: any = $nativeStub("types", "jsAssertEncodingValid");
