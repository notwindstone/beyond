// Natives of Bun's h2_frame_parser that Beyond does not have yet: each throws
// when used.

import { $nativeStub } from "node:internal/intrinsics";

export const H2FrameParserConstructor: any = $nativeStub("h2_frame_parser", "H2FrameParserConstructor");
