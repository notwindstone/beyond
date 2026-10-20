// Natives of Bun's JSEventTarget that Beyond does not have yet: each throws
// when used.

import { $nativeStub } from "node:internal/intrinsics";

export const jsEventTargetGetEventListenersCount: any = $nativeStub("JSEventTarget", "jsEventTargetGetEventListenersCount");
