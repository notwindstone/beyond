// Natives of Bun's node_cluster_binding that Beyond does not have yet: each throws
// when used.

import { $nativeStub } from "node:internal/intrinsics";

export const channelIgnoreOneDisconnectEventListener: any = $nativeStub("node_cluster_binding", "channelIgnoreOneDisconnectEventListener");
export const clusterCloseHandle: any = $nativeStub("node_cluster_binding", "clusterCloseHandle");
export const clusterRawBind: any = $nativeStub("node_cluster_binding", "clusterRawBind");
export const clusterValidateFd: any = $nativeStub("node_cluster_binding", "clusterValidateFd");
export const onInternalMessageChild: any = $nativeStub("node_cluster_binding", "onInternalMessageChild");
export const onInternalMessagePrimary: any = $nativeStub("node_cluster_binding", "onInternalMessagePrimary");
export const sendHelperPrimary: any = $nativeStub("node_cluster_binding", "sendHelperPrimary");
