// The HTTP server (Beyond.serve) on Bun's uWebSockets, through Bun's C
// interface (vendor/uws-capi): what Bun's RequestContext does
// (src/runtime/server/RequestContext.rs), reduced to what Beyond's
// TypeScript side (lib/serve.ts) needs: each request is handed to a
// JavaScript function, which answers it with `respond` then or later.

#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include "libusockets.h"
#include "quickjs.h"

typedef struct uws_app_s uws_app_t;
typedef struct uws_req_s uws_req_t;
typedef struct uws_res_s uws_res_t;
uws_app_t *uws_create_app(int ssl, struct us_bun_socket_context_options_t options);
void uws_app_destroy(int ssl, uws_app_t *app);
void uws_app_any(int ssl, uws_app_t *app, const char *pattern, size_t pattern_len,
                 void (*handler)(uws_res_t *, uws_req_t *, void *), void *user);
void uws_app_listen_with_config(int ssl, uws_app_t *app, const char *host, uint16_t port, int32_t options,
                                void (*handler)(struct us_listen_socket_t *, void *), void *user);
size_t uws_req_get_url(uws_req_t *req, const char **dest);
size_t uws_req_get_header(uws_req_t *req, const char *name, size_t name_len, const char **dest);
void uws_res_write_status(int ssl, uws_res_t *res, const char *status, size_t len);
void uws_res_write_header(int ssl, uws_res_t *res, const char *k, size_t kl, const char *v, size_t vl);
void uws_res_end(int ssl, uws_res_t *res, const char *data, size_t len, bool close_connection);
void uws_res_end_without_body(int ssl, uws_res_t *res, bool close_connection);
void uws_res_on_aborted(int ssl, uws_res_t *res, void (*handler)(uws_res_t *, void *), void *data);
void uws_res_on_data(int ssl, uws_res_t *res, void (*handler)(uws_res_t *, const char *, size_t, bool, void *),
                     void *data);
void uws_res_cork(int ssl, uws_res_t *res, void *ctx, void (*corker)(void *ctx));
size_t beyond_req_method(uws_req_t *req, const char **dest);
void beyond_req_headers(uws_req_t *req, void (*cb)(void *, const char *, size_t, const char *, size_t), void *user);
int us_listen_socket_port(struct us_listen_socket_t *ls);
void us_listen_socket_close(struct us_listen_socket_t *ls);

int beyond_js_run_jobs(void);
JSContext *beyond_js_context(void);
void beyond_js_report(void);

// ---- Servers ----

typedef struct {
    uws_app_t *app;
    struct us_listen_socket_t *listen;
    JSValue handler; // (handle, method, url, headers, body) => void
} Server;

#define MAX_SERVERS 64
static Server servers[MAX_SERVERS];
static int nservers;

// ---- Requests: slots, named by index and generation (a stale handle is
// ignored, not dereferenced) ----

enum { FREE, SYNC, BODY, ASYNC };

typedef struct {
    uws_res_t *res;
    Server *server;
    uint32_t gen;
    uint8_t state;
    bool aborted;
    JSValue args[4]; // method, url, headers, while the body arrives
    char *body;
    size_t body_len, body_cap;
    uint32_t next_free;
} Slot;

static Slot *slots;
static uint32_t nslots, cap_slots, free_head = UINT32_MAX;

static uint32_t slot_alloc(void) {
    uint32_t i;
    if (free_head != UINT32_MAX) {
        i = free_head;
        free_head = slots[i].next_free;
    } else {
        if (nslots == cap_slots) {
            cap_slots = cap_slots ? cap_slots * 2 : 256;
            slots = realloc(slots, cap_slots * sizeof *slots);
        }
        i = nslots++;
        slots[i].gen = 0;
    }
    Slot *s = &slots[i];
    s->state = SYNC;
    s->aborted = false;
    s->body = NULL;
    s->body_len = s->body_cap = 0;
    for (int k = 0; k < 4; k++)
        s->args[k] = JS_UNDEFINED;
    return i;
}

static void slot_free(uint32_t i) {
    Slot *s = &slots[i];
    JSContext *ctx = beyond_js_context();
    for (int k = 0; k < 4; k++) {
        JS_FreeValue(ctx, s->args[k]);
        s->args[k] = JS_UNDEFINED;
    }
    free(s->body);
    s->body = NULL;
    s->state = FREE;
    s->gen++;
    s->next_free = free_head;
    free_head = i;
}

// A handle: index + generation * 2^24 (an integer JavaScript number).
static double handle_of(uint32_t i) { return (double)i + (double)(slots[i].gen & 0x1FFFFFFF) * 16777216.0; }

static Slot *slot_of(double h, uint32_t *index) {
    if (!(h >= 0))
        return NULL;
    uint64_t v = (uint64_t)h;
    uint32_t i = (uint32_t)(v & 0xFFFFFF), gen = (uint32_t)(v >> 24);
    if (i >= nslots || slots[i].state == FREE || (slots[i].gen & 0x1FFFFFFF) != gen)
        return NULL;
    *index = i;
    return &slots[i];
}

// The JavaScript values marked while the program runs (module.c's hook).
void beyond_server_mark(JSRuntime *rt, JS_MarkFunc *mark_func) {
    for (int i = 0; i < nservers; i++)
        JS_MarkValue(rt, servers[i].handler, mark_func);
    for (uint32_t i = 0; i < nslots; i++)
        if (slots[i].state != FREE)
            for (int k = 0; k < 4; k++)
                JS_MarkValue(rt, slots[i].args[k], mark_func);
}

// ---- Handing a request to JavaScript ----

typedef struct {
    JSContext *ctx;
    JSValue array;
    uint32_t n;
} HeaderSink;

// (Names in lower case: Bun's uWebSockets keeps them as sent.)
static void add_header(void *user, const char *k, size_t kl, const char *v, size_t vl) {
    HeaderSink *h = user;
    char lower[256];
    if (kl <= sizeof lower) {
        for (size_t i = 0; i < kl; i++)
            lower[i] = (k[i] >= 'A' && k[i] <= 'Z') ? (char)(k[i] | 32) : k[i];
        k = lower;
    }
    JS_SetPropertyUint32(h->ctx, h->array, h->n++, JS_NewStringLen(h->ctx, k, kl));
    JS_SetPropertyUint32(h->ctx, h->array, h->n++, JS_NewStringLen(h->ctx, v, vl));
}

static void on_aborted(uws_res_t *res, void *data);

// Calls the server's handler with the slot's request; the slot is freed
// when the handler responded, else it waits (for `respond`, or an abort).
static void dispatch(uint32_t i) {
    JSContext *ctx = beyond_js_context();
    Slot *s = &slots[i];
    JSValue argv[5];
    argv[0] = JS_NewFloat64(ctx, handle_of(i));
    argv[1] = s->args[0];
    argv[2] = s->args[1];
    argv[3] = s->args[2];
    argv[4] = s->body ? JS_NewArrayBufferCopy(ctx, (const uint8_t *)s->body, s->body_len) : JS_UNDEFINED;
    s->state = SYNC;
    JSValue r = JS_Call(ctx, s->server->handler, JS_UNDEFINED, 5, argv);
    JS_FreeValue(ctx, argv[4]);
    if (JS_IsException(r))
        beyond_js_report();
    JS_FreeValue(ctx, r);
    if (beyond_js_run_jobs() < 0)
        beyond_js_report();
    // (`respond` may have freed it, and the slot be another request's now.)
    s = &slots[i];
    if (s->state == SYNC) {
        s->state = ASYNC;
        uws_res_on_aborted(0, s->res, on_aborted, (void *)(uintptr_t)i);
    }
}

static void on_aborted(uws_res_t *res, void *data) {
    (void)res;
    uint32_t i = (uint32_t)(uintptr_t)data;
    if (i < nslots && slots[i].state != FREE)
        slots[i].aborted = true;
}

static void on_body(uws_res_t *res, const char *chunk, size_t len, bool last, void *data) {
    (void)res;
    uint32_t i = (uint32_t)(uintptr_t)data;
    Slot *s = &slots[i];
    if (s->body_len + len > s->body_cap) {
        s->body_cap = (s->body_len + len) * 2;
        s->body = realloc(s->body, s->body_cap);
    }
    memcpy(s->body + s->body_len, chunk, len);
    s->body_len += len;
    if (last) {
        if (!s->body)
            s->body = malloc(1);
        dispatch(i);
    }
}

static void on_request(uws_res_t *res, uws_req_t *req, void *user) {
    JSContext *ctx = beyond_js_context();
    uint32_t i = slot_alloc();
    Slot *s = &slots[i];
    s->res = res;
    s->server = user;
    const char *p;
    size_t n = beyond_req_method(req, &p);
    s->args[0] = JS_NewStringLen(ctx, p, n);
    n = uws_req_get_url(req, &p);
    s->args[1] = JS_NewStringLen(ctx, p, n);
    HeaderSink h = {ctx, JS_NewArray(ctx), 0};
    beyond_req_headers(req, add_header, &h);
    s->args[2] = h.array;
    // A body: read it all, then call the handler.
    const char *v;
    size_t cl = uws_req_get_header(req, "content-length", 14, &v);
    bool has_body = (cl && !(cl == 1 && v[0] == '0')) || uws_req_get_header(req, "transfer-encoding", 17, &v);
    if (has_body) {
        s->state = BODY;
        uws_res_on_data(0, res, on_body, (void *)(uintptr_t)i);
        uws_res_on_aborted(0, res, on_aborted, (void *)(uintptr_t)i);
        return;
    }
    dispatch(i);
}

// ---- Responding ----

static const char *reason(int status) {
    switch (status) {
    case 100: return "Continue";
    case 101: return "Switching Protocols";
    case 200: return "OK";
    case 201: return "Created";
    case 202: return "Accepted";
    case 204: return "No Content";
    case 206: return "Partial Content";
    case 301: return "Moved Permanently";
    case 302: return "Found";
    case 303: return "See Other";
    case 304: return "Not Modified";
    case 307: return "Temporary Redirect";
    case 308: return "Permanent Redirect";
    case 400: return "Bad Request";
    case 401: return "Unauthorized";
    case 403: return "Forbidden";
    case 404: return "Not Found";
    case 405: return "Method Not Allowed";
    case 409: return "Conflict";
    case 410: return "Gone";
    case 413: return "Payload Too Large";
    case 415: return "Unsupported Media Type";
    case 422: return "Unprocessable Entity";
    case 429: return "Too Many Requests";
    case 500: return "Internal Server Error";
    case 501: return "Not Implemented";
    case 502: return "Bad Gateway";
    case 503: return "Service Unavailable";
    case 504: return "Gateway Timeout";
    default: return "";
    }
}

typedef struct {
    JSContext *ctx;
    Slot *s;
    int status;
    JSValueConst status_text, headers, body;
    bool ok;
} Reply;

static void write_reply(void *data) {
    Reply *r = data;
    JSContext *ctx = r->ctx;
    uws_res_t *res = r->s->res;
    char line[160];
    const char *text = NULL;
    size_t text_len = 0;
    if (JS_IsString(r->status_text))
        text = JS_ToCStringLen(ctx, &text_len, r->status_text);
    int n = snprintf(line, sizeof line, "%d %.*s", r->status, (int)(text && text_len ? text_len : strlen(reason(r->status))),
                     text && text_len ? text : reason(r->status));
    if (text)
        JS_FreeCString(ctx, text);
    uws_res_write_status(0, res, line, (size_t)(n < (int)sizeof line ? n : (int)sizeof line - 1));
    // headers: [name, value, ...]
    int64_t len = 0;
    if (JS_IsArray(r->headers))
        JS_GetLength(ctx, r->headers, &len);
    for (int64_t k = 0; k + 1 < len; k += 2) {
        JSValue kv = JS_GetPropertyInt64(ctx, r->headers, k), vv = JS_GetPropertyInt64(ctx, r->headers, k + 1);
        size_t kl, vl;
        const char *ks = JS_ToCStringLen(ctx, &kl, kv), *vs = JS_ToCStringLen(ctx, &vl, vv);
        if (ks && vs)
            uws_res_write_header(0, res, ks, kl, vs, vl);
        JS_FreeCString(ctx, ks);
        JS_FreeCString(ctx, vs);
        JS_FreeValue(ctx, kv);
        JS_FreeValue(ctx, vv);
    }
    // body: a string (UTF-8), bytes (an ArrayBuffer or a view of one), or none
    if (JS_IsString(r->body)) {
        size_t bl;
        const char *b = JS_ToCStringLen(ctx, &bl, r->body);
        uws_res_end(0, res, b ? b : "", b ? bl : 0, false);
        JS_FreeCString(ctx, b);
    } else if (JS_IsUndefined(r->body) || JS_IsNull(r->body)) {
        if (r->status == 204 || r->status == 304 || (r->status >= 100 && r->status < 200))
            uws_res_end_without_body(0, res, false);
        else
            uws_res_end(0, res, "", 0, false);
    } else {
        size_t bl = 0, off = 0, bpe;
        uint8_t *b = JS_GetArrayBuffer(ctx, &bl, r->body);
        if (!b) {
            JS_FreeValue(ctx, JS_GetException(ctx));
            JSValue ab = JS_GetTypedArrayBuffer(ctx, r->body, &off, &bl, &bpe);
            if (JS_IsException(ab)) {
                JS_FreeValue(ctx, JS_GetException(ctx));
            } else {
                size_t total;
                b = JS_GetArrayBuffer(ctx, &total, ab);
                if (b)
                    b += off;
                JS_FreeValue(ctx, ab);
            }
        }
        uws_res_end(0, res, b ? (const char *)b : "", b ? bl : 0, false);
    }
    r->ok = true;
}

// respond(handle, status, statusText, headers, body): false when the
// request is no longer waiting (answered, aborted).
static JSValue js_respond(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    double h;
    int32_t status;
    uint32_t i;
    if (JS_ToFloat64(ctx, &h, argv[0]) || JS_ToInt32(ctx, &status, argv[1]))
        return JS_EXCEPTION;
    Slot *s = slot_of(h, &i);
    if (!s || s->state == BODY)
        return JS_FALSE;
    if (s->aborted) {
        slot_free(i);
        return JS_FALSE;
    }
    Reply r = {ctx, s, status, argv[2], argv[3], argv[4], false};
    if (s->state == SYNC)
        write_reply(&r);
    else
        uws_res_cork(0, s->res, &r, write_reply);
    slot_free(i);
    return JS_TRUE;
}

// ---- Listening ----

static void on_listen(struct us_listen_socket_t *ls, void *user) {
    ((Server *)user)->listen = ls;
}

// listen(hostname, port, handler): the server's index, or -1.
static JSValue js_listen(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    int32_t port;
    if (JS_ToInt32(ctx, &port, argv[1]))
        return JS_EXCEPTION;
    if (nservers == MAX_SERVERS)
        return JS_ThrowRangeError(ctx, "too many servers");
    const char *host = JS_IsString(argv[0]) ? JS_ToCString(ctx, argv[0]) : NULL;
    struct us_bun_socket_context_options_t options;
    memset(&options, 0, sizeof options);
    Server *srv = &servers[nservers];
    srv->app = uws_create_app(0, options);
    srv->listen = NULL;
    srv->handler = JS_DupValue(ctx, argv[2]);
    uws_app_any(0, srv->app, "/*", 2, on_request, srv);
    uws_app_listen_with_config(0, srv->app, host ? host : "", (uint16_t)port, 0, on_listen, srv);
    if (host)
        JS_FreeCString(ctx, host);
    if (!srv->listen) {
        JS_FreeValue(ctx, srv->handler);
        uws_app_destroy(0, srv->app);
        return JS_NewInt32(ctx, -1);
    }
    return JS_NewInt32(ctx, nservers++);
}

static JSValue js_server_port(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    int32_t k;
    if (JS_ToInt32(ctx, &k, argv[0]))
        return JS_EXCEPTION;
    if (k < 0 || k >= nservers || !servers[k].listen)
        return JS_NewInt32(ctx, 0);
    return JS_NewInt32(ctx, us_listen_socket_port(servers[k].listen));
}

// stop(server): no new connections (those open finish).
static JSValue js_stop(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    int32_t k;
    if (JS_ToInt32(ctx, &k, argv[0]))
        return JS_EXCEPTION;
    if (k >= 0 && k < nservers && servers[k].listen) {
        us_listen_socket_close(servers[k].listen);
        servers[k].listen = NULL;
    }
    return JS_UNDEFINED;
}

const JSCFunctionListEntry beyond_server_functions[] = {
    JS_CFUNC_DEF("listen", 3, js_listen),
    JS_CFUNC_DEF("serverPort", 1, js_server_port),
    JS_CFUNC_DEF("stopServer", 1, js_stop),
    JS_CFUNC_DEF("respond", 5, js_respond),
};
const int beyond_server_function_count = sizeof beyond_server_functions / sizeof *beyond_server_functions;
