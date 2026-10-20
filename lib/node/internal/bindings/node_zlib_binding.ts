// Natives of Bun's node_zlib_binding that Beyond does not have yet: each throws
// when used.

import { $nativeStub } from "node:internal/intrinsics";

export const NativeBrotli: any = $nativeStub("node_zlib_binding", "NativeBrotli");
export const NativeZlib: any = $nativeStub("node_zlib_binding", "NativeZlib");
export const NativeZstd: any = $nativeStub("node_zlib_binding", "NativeZstd");
export const crc32: any = $nativeStub("node_zlib_binding", "crc32");
