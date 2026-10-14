// What Bun's runtime provides to its forks of uSockets and uWebSockets
// (vendor/bun-usockets, vendor/bun-uws), for Beyond: Bun implements these in
// its Rust and Zig code (src/runtime/socket/uws_dispatch.rs and others; see
// NOTICE). Beyond's sockets are uWebSockets' (HTTP), whose handlers are the
// socket group's vtable; TLS, QUIC and HTTP/2 are not built yet.

#define _GNU_SOURCE
#include <arpa/inet.h>
#include <errno.h>
#include <netdb.h>
#include <sched.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/epoll.h>
#include <sys/socket.h>
#include <time.h>

#include "libusockets.h"
#include "internal/internal.h"

// ---- Socket events: the socket group's vtable (as Bun's dispatch does for
// uWebSockets' sockets) ----

#define VT(s) ((s)->group->vtable)

struct us_socket_t *us_dispatch_open(struct us_socket_t *s, int is_client, char *ip, int ip_length) {
    return VT(s)->on_open ? VT(s)->on_open(s, is_client, ip, ip_length) : s;
}
struct us_socket_t *us_dispatch_data(struct us_socket_t *s, char *data, int length) {
    return VT(s)->on_data ? VT(s)->on_data(s, data, length) : s;
}
struct us_socket_t *us_dispatch_fd(struct us_socket_t *s, int fd) {
    return VT(s)->on_fd ? VT(s)->on_fd(s, fd) : s;
}
struct us_socket_t *us_dispatch_writable(struct us_socket_t *s) {
    return VT(s)->on_writable ? VT(s)->on_writable(s) : s;
}
struct us_socket_t *us_dispatch_close(struct us_socket_t *s, int code, void *reason) {
    return VT(s)->on_close ? VT(s)->on_close(s, code, reason) : s;
}
struct us_socket_t *us_dispatch_timeout(struct us_socket_t *s) {
    return VT(s)->on_timeout ? VT(s)->on_timeout(s) : s;
}
struct us_socket_t *us_dispatch_long_timeout(struct us_socket_t *s) {
    return VT(s)->on_long_timeout ? VT(s)->on_long_timeout(s) : s;
}
struct us_socket_t *us_dispatch_end(struct us_socket_t *s) {
    return VT(s)->on_end ? VT(s)->on_end(s) : s;
}
struct us_socket_t *us_dispatch_connect_error(struct us_socket_t *s, int code) {
    return VT(s)->on_connect_error ? VT(s)->on_connect_error(s, code) : s;
}
struct us_connecting_socket_t *us_dispatch_connecting_error(struct us_connecting_socket_t *c, int code) {
    const struct us_socket_vtable_t *vt = c->group->vtable;
    return vt->on_connecting_error ? vt->on_connecting_error(c, code) : c;
}

// Socket kinds (Bun's src/uws_sys/SocketKind.rs).
const uint8_t BUN_SOCKET_KIND_DYNAMIC = 1;
const uint8_t BUN_SOCKET_KIND_UWS_HTTP = 19;
const uint8_t BUN_SOCKET_KIND_UWS_HTTP_TLS = 20;
const uint8_t BUN_SOCKET_KIND_UWS_WS = 21;
const uint8_t BUN_SOCKET_KIND_UWS_WS_TLS = 22;

// 0: uWebSockets' own default.
size_t BUN_DEFAULT_MAX_HTTP_HEADER_SIZE = 16 * 1024;

// ---- Process ----

__attribute__((noreturn)) void Bun__panic(const char *message, size_t length) {
    fprintf(stderr, "beyond: panic: %.*s\n", (int)length, message);
    abort();
}

__attribute__((noreturn)) void Bun__outOfMemory(void) {
    fputs("beyond: out of memory\n", stderr);
    abort();
}

int bun_is_exiting(void) { return 0; }

// ---- Locks (a 32-bit word on Linux) ----

void Bun__lock(zig_mutex_t *lock) {
    while (__atomic_exchange_n(lock, 1, __ATOMIC_ACQUIRE))
        sched_yield();
}

void Bun__unlock(zig_mutex_t *lock) { __atomic_store_n(lock, 0, __ATOMIC_RELEASE); }

// ---- The event loop ----

// Bun's polls of its own kinds (files, pipes): Beyond has none yet.
void Bun__internal_dispatch_ready_poll(void *loop, void *poll) {
    (void)loop;
    (void)poll;
}

// The JavaScript engine's hooks around the loop's wait (JavaScriptCore's heap
// access in Bun): none.
unsigned int Bun__JSC_onBeforeWait(void *vm, uint64_t now_ns, int *released_heap_access) {
    (void)vm;
    (void)now_ns;
    if (released_heap_access)
        *released_heap_access = 0;
    return 0;
}
void Bun__JSC_acquireHeapAccessAfterWait(void *vm) { (void)vm; }

// epoll_pwait2 (nanosecond timeouts) is optional: epoll_pwait.
int Bun__isEpollPwait2SupportedOnLinuxKernel(void) { return 0; }
ssize_t sys_epoll_pwait2(int epfd, struct epoll_event *events, int maxevents, const struct timespec *timeout,
                         const sigset_t *sigmask) {
    (void)epfd, (void)events, (void)maxevents, (void)timeout, (void)sigmask;
    errno = ENOSYS;
    return -1;
}

// QUIC and HTTP/3: not built.
void us_quic_loop_process(struct us_loop_t *loop) { (void)loop; }
void us_nq_loop_flush_if_pending(struct us_loop_t *loop) { (void)loop; }

// The `Date` header uWebSockets writes: refreshed when the second it shows
// has passed (Bun refreshes it from a timer while responses are written).
void uws_loop_date_header_timer_update(struct us_loop_t *loop);
static time_t date_second = -1;

void Bun__internal_ensureDateHeaderTimerIsEnabled(struct us_loop_t *loop) {
    struct timespec now;
    clock_gettime(CLOCK_REALTIME_COARSE, &now);
    if (now.tv_sec != date_second) {
        date_second = now.tv_sec;
        uws_loop_date_header_timer_update(loop);
    }
}

// ---- Node's http module (Bun's node:http on uWebSockets): not used ----

void Bun__NodeHTTP__onReadsResumable(int ssl, struct us_socket_t *s) { (void)ssl, (void)s; }
void Bun__NodeHTTP__onReadParsed(int ssl, struct us_socket_t *s) { (void)ssl, (void)s; }

// ---- HTTP methods (strict validation): the index of a known method ----

int16_t Bun__HTTPMethod__from(const char *str, size_t len) {
    static const char *methods[] = {"ACL", "BIND", "CHECKOUT", "CONNECT", "COPY", "DELETE", "GET", "HEAD",
                                    "LINK", "LOCK", "M-SEARCH", "MERGE", "MKACTIVITY", "MKCALENDAR", "MKCOL",
                                    "MOVE", "NOTIFY", "OPTIONS", "PATCH", "POST", "PROPFIND", "PROPPATCH",
                                    "PURGE", "PUT", "QUERY", "REBIND", "REPORT", "SEARCH", "SOURCE",
                                    "SUBSCRIBE", "TRACE", "UNBIND", "UNLINK", "UNLOCK", "UNSUBSCRIBE"};
    for (size_t i = 0; i < sizeof methods / sizeof *methods; i++) {
        if (strlen(methods[i]) == len && memcmp(methods[i], str, len) == 0)
            return (int16_t)i;
    }
    return -1;
}

// ---- Addresses ----

const char *ares_inet_ntop(int af, const char *src, char *dst, size_t size) {
    return inet_ntop(af, src, dst, (socklen_t)size);
}

int Bun__parseIpAddress(const char *host, uint16_t port, struct sockaddr_storage *out) {
    memset(out, 0, sizeof *out);
    struct sockaddr_in *v4 = (struct sockaddr_in *)out;
    if (inet_pton(AF_INET, host, &v4->sin_addr) == 1) {
        v4->sin_family = AF_INET;
        v4->sin_port = htons(port);
        return 1;
    }
    struct sockaddr_in6 *v6 = (struct sockaddr_in6 *)out;
    if (inet_pton(AF_INET6, host, &v6->sin6_addr) == 1) {
        v6->sin6_family = AF_INET6;
        v6->sin6_port = htons(port);
        return 1;
    }
    return 0;
}

// Name resolution for connections (Bun resolves on a thread pool): getaddrinfo,
// at once.
struct addrinfo_request {
    struct addrinfo_result result;
    struct addrinfo *list;
};

int Bun__addrinfo_get(struct us_loop_t *loop, const char *host, uint16_t port, struct addrinfo_request **ptr) {
    (void)loop;
    struct addrinfo_request *req = calloc(1, sizeof *req);
    char portstr[8];
    snprintf(portstr, sizeof portstr, "%u", port);
    struct addrinfo hints = {.ai_family = AF_UNSPEC, .ai_socktype = SOCK_STREAM};
    req->result.error = getaddrinfo(host, portstr, &hints, &req->list);
    if (!req->result.error) {
        int n = 0;
        for (struct addrinfo *a = req->list; a; a = a->ai_next)
            n++;
        req->result.entries = calloc(n + 1, sizeof(struct addrinfo_result_entry));
        int i = 0;
        for (struct addrinfo *a = req->list; a; a = a->ai_next, i++) {
            req->result.entries[i].info = *a;
            memcpy(&req->result.entries[i]._storage, a->ai_addr, a->ai_addrlen);
            req->result.entries[i].info.ai_addr = (struct sockaddr *)&req->result.entries[i]._storage;
            req->result.entries[i].info.ai_next = a->ai_next ? &req->result.entries[i + 1].info : NULL;
        }
    }
    *ptr = req;
    // (Resolved: the caller reads the result now.)
    return 1;
}

int Bun__addrinfo_set(struct addrinfo_request *ptr, struct us_connecting_socket_t *socket) {
    (void)ptr, (void)socket;
    return 0;
}

int Bun__addrinfo_cancel(struct addrinfo_request *ptr, struct us_connecting_socket_t *socket) {
    (void)ptr, (void)socket;
    return 0;
}

void Bun__addrinfo_freeRequest(struct addrinfo_request *req, int error) {
    (void)error;
    if (!req)
        return;
    if (req->list)
        freeaddrinfo(req->list);
    free(req->result.entries);
    free(req);
}

struct addrinfo_result *Bun__addrinfo_getRequestResult(struct addrinfo_request *req) { return &req->result; }

// For Beyond's loop (src/lib.rs): whether sockets keep it alive.
int beyond_loop_num_polls(struct us_loop_t *loop) { return loop->num_polls; }
