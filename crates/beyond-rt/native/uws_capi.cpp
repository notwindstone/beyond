// Bun's C interface to uWebSockets (vendor/uws-capi/libuwsockets.cpp), as
// Bun builds it: uSockets' internals have C linkage.
extern "C" {
#include <bun-usockets/src/internal/internal.h>
}
#include <bun-uws/src/App.h>
#include "../../../vendor/uws-capi/libuwsockets.cpp"
