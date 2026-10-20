// Natives of Bun's NodeTLS that Beyond does not have yet: each throws
// when used.

import { $nativeStub } from "node:internal/intrinsics";

export const Bun__canonicalizeIP: any = $nativeStub("NodeTLS", "Bun__canonicalizeIP");
export const getBundledRootCertificates: any = $nativeStub("NodeTLS", "getBundledRootCertificates");
export const getDefaultCiphers: any = $nativeStub("NodeTLS", "getDefaultCiphers");
export const getExtraCACertificates: any = $nativeStub("NodeTLS", "getExtraCACertificates");
export const getSystemCACertificates: any = $nativeStub("NodeTLS", "getSystemCACertificates");
export const loadExtraCACertificates: any = $nativeStub("NodeTLS", "loadExtraCACertificates");
export const parseCACertificates: any = $nativeStub("NodeTLS", "parseCACertificates");
export const selectServerName: any = $nativeStub("NodeTLS", "selectServerName");
export const setDefaultCiphers: any = $nativeStub("NodeTLS", "setDefaultCiphers");
