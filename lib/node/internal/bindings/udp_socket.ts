// Natives of Bun's udp_socket that Beyond does not have yet: each throws
// when used.

import { $nativeStub } from "node:internal/intrinsics";

export const UDPSocket_jsBufferSize: any = $nativeStub("udp_socket", "UDPSocket_jsBufferSize");
export const UDPSocket_jsConnect: any = $nativeStub("udp_socket", "UDPSocket_jsConnect");
export const UDPSocket_jsDisconnect: any = $nativeStub("udp_socket", "UDPSocket_jsDisconnect");
export const UDPSocket_jsGetFd: any = $nativeStub("udp_socket", "UDPSocket_jsGetFd");
export const jsDgramAdoptFd: any = $nativeStub("udp_socket", "jsDgramAdoptFd");
export const jsDgramBindFd: any = $nativeStub("udp_socket", "jsDgramBindFd");
export const jsDgramCloseFd: any = $nativeStub("udp_socket", "jsDgramCloseFd");
export const jsDgramGetSockNameFd: any = $nativeStub("udp_socket", "jsDgramGetSockNameFd");
export const jsDgramGuessHandleType: any = $nativeStub("udp_socket", "jsDgramGuessHandleType");
export const jsDgramIsFdAdopted: any = $nativeStub("udp_socket", "jsDgramIsFdAdopted");
export const jsDgramListenFd: any = $nativeStub("udp_socket", "jsDgramListenFd");
export const jsDgramNewSocketFd: any = $nativeStub("udp_socket", "jsDgramNewSocketFd");
