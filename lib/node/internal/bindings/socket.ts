// Natives of Bun's socket that Beyond does not have yet: each throws
// when used.

import { $nativeStub } from "node:internal/intrinsics";

export const jsCheckServerIdentityInHandshake: any = $nativeStub("socket", "jsCheckServerIdentityInHandshake");
export const jsFirstFlightBeforeFin: any = $nativeStub("socket", "jsFirstFlightBeforeFin");
export const jsGetBufferedAmount: any = $nativeStub("socket", "jsGetBufferedAmount");
export const jsIsNamedPipeSocket: any = $nativeStub("socket", "jsIsNamedPipeSocket");
export const jsReleaseHeldFlight: any = $nativeStub("socket", "jsReleaseHeldFlight");
export const jsUpgradeDuplexToTLS: any = $nativeStub("socket", "jsUpgradeDuplexToTLS");
export const jsUpgradeTLSDeferred: any = $nativeStub("socket", "jsUpgradeTLSDeferred");
