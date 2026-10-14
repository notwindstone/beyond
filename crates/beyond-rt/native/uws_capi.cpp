// Bun's C interface to uWebSockets (vendor/uws-capi/libuwsockets.cpp), as
// Bun builds it: uSockets' internals have C linkage.
extern "C" {
#include <bun-usockets/src/internal/internal.h>
}
#include <bun-uws/src/App.h>
#include "../../../vendor/uws-capi/libuwsockets.cpp"

// Beyond's additions: what Bun's Rust reads of a request directly.
extern "C" {
// The method as sent (uWS::HttpRequest::getMethod lowers it in place).
size_t beyond_req_method(uws_req_t *req, const char **dest) {
    std::string_view v = ((uWS::HttpRequest *)req)->getCaseSensitiveMethod();
    *dest = v.data();
    return v.size();
}

// Each header field (names in lower case, as uWebSockets parses them).
void beyond_req_headers(uws_req_t *req, void (*cb)(void *, const char *, size_t, const char *, size_t), void *user) {
    for (auto [k, v] : *(uWS::HttpRequest *)req)
        cb(user, k.data(), k.size(), v.data(), v.size());
}
}
