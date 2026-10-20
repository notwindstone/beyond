// Natives of Bun's dns that Beyond does not have yet: each throws
// when used.

import { $nativeStub } from "node:internal/intrinsics";

export const Resolver_getRuntimeDefaultResultOrderOption: any = $nativeStub("dns", "Resolver_getRuntimeDefaultResultOrderOption");
export const Resolver_newResolver: any = $nativeStub("dns", "Resolver_newResolver");
