// Natives of Bun's BunProcess that Beyond does not have yet: each throws
// when used.

import { $nativeStub } from "node:internal/intrinsics";

export const jsFunctionReportUncaughtException: any = $nativeStub("BunProcess", "jsFunctionReportUncaughtException");
