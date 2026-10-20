// Natives of Bun's parse_args that Beyond does not have yet: each throws
// when used.

import { $nativeStub } from "node:internal/intrinsics";

export const parseArgs: any = $nativeStub("parse_args", "parseArgs");
