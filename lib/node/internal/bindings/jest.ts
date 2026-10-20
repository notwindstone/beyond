// Natives of Bun's jest that Beyond does not have yet: each throws
// when used.

import { $nativeStub } from "node:internal/intrinsics";

export const jsFileGeneration: any = $nativeStub("jest", "jsFileGeneration");
export const jsNodeTestMarkResult: any = $nativeStub("jest", "jsNodeTestMarkResult");
