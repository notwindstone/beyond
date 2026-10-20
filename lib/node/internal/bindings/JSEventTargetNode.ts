// Natives of Bun's JSEventTargetNode that Beyond does not have yet: each throws
// when used.

import { $nativeStub } from "node:internal/intrinsics";

export const jsFunctionNodeEventsGetEventListeners: any = $nativeStub("JSEventTargetNode", "jsFunctionNodeEventsGetEventListeners");
