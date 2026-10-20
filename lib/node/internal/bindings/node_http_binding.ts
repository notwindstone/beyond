// Natives of Bun's node_http_binding that Beyond does not have yet: each throws
// when used.

import { $nativeStub } from "node:internal/intrinsics";

export const getBunServerAllClosedPromise: any = $nativeStub("node_http_binding", "getBunServerAllClosedPromise");
export const getBunServerOpenCount: any = $nativeStub("node_http_binding", "getBunServerOpenCount");
export const getInsecureHTTPParser: any = $nativeStub("node_http_binding", "getInsecureHTTPParser");
export const getMaxHTTPHeaderSize: any = $nativeStub("node_http_binding", "getMaxHTTPHeaderSize");
export const setMaxHTTPHeaderSize: any = $nativeStub("node_http_binding", "setMaxHTTPHeaderSize");
