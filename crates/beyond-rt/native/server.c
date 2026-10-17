// The HTTP server (Beyond.serve) on Bun's uWebSockets, through Bun's C
// interface (vendor/uws-capi): what Bun's RequestContext does
// (src/runtime/server/RequestContext.rs), reduced to what Beyond's
// TypeScript side (lib/serve.ts) needs: each request is handed to a
// JavaScript function, which answers it with `respond` then or later.

#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>

#include "libusockets.h"
#include "quickjs.h"

typedef struct uws_app_s uws_app_t;
typedef struct uws_req_s uws_req_t;
typedef struct uws_res_s uws_res_t;
uws_app_t *uws_create_app(int ssl, struct us_bun_socket_context_options_t options);
void uws_app_destroy(int ssl, uws_app_t *app);
void uws_app_close(int ssl, uws_app_t *app);
size_t uws_app_close_idle(int ssl, uws_app_t *app, int close_when_idle);
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
bool uws_res_write(int ssl, uws_res_t *res, const char *data, size_t *length);
void uws_res_end_stream(int ssl, uws_res_t *res, bool close_connection);
void uws_res_on_writable(int ssl, uws_res_t *res, bool (*handler)(uws_res_t *, uint64_t, void *), void *data);
void uws_res_clear_on_writable(int ssl, uws_res_t *res);
void uws_res_pause(int ssl, uws_res_t *res);
void uws_res_resume(int ssl, uws_res_t *res);
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

// SYNC: in the handler; BODY: reading the request's body before calling the
// handler (until it has come, or the loop's turn ends); ASYNC: waiting for
// `respond`; STREAM: the response's head sent, its body being written.
enum { FREE, SYNC, BODY, ASYNC, STREAM };

typedef struct {
    uws_res_t *res;
    Server *server;
    uint32_t gen;
    uint8_t state;
    bool aborted;
    JSValue args[4]; // method, url, headers, while the body arrives; then a
                     // streamed response's writable callback
    char *body;
    size_t body_len, body_cap;
    // A body still arriving once the handler was called: handed to
    // `incoming` (JavaScript's), unless the program dropped it.
    bool body_open, body_dropped;
    bool head; // a HEAD request: the response's length, without its body
    JSValue incoming;
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
    s->body_open = s->body_dropped = false;
    s->incoming = JS_UNDEFINED;
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
    s->incoming = JS_UNDEFINED;
    s->body_open = false;
    s->state = FREE;
    s->gen++;
    s->next_free = free_head;
    free_head = i;
}

// A handle: index + generation * 2^24 (an integer JavaScript number).
static double handle_of(uint32_t i) { return (double)i + (double)(slots[i].gen & 0x1FFFFFFF) * 16777216.0; }

// What callbacks of uWebSockets get: the slot and its generation.
static void *cb_data(uint32_t i) { return (void *)(uintptr_t)((uint64_t)i | (uint64_t)slots[i].gen << 32); }

// The slot a callback's data names, if it is still that request's.
static Slot *cb_slot(void *data, uint32_t *index) {
    uint64_t v = (uintptr_t)data;
    uint32_t i = (uint32_t)v;
    if (i >= nslots || slots[i].state == FREE || slots[i].gen != (uint32_t)(v >> 32))
        return NULL;
    *index = i;
    return &slots[i];
}

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

// Strings made once: the common methods and header names (a request's are
// these, shared, most of the time).
static const char *const common[] = {
    "GET", "POST", "PUT", "DELETE", "HEAD", "PATCH", "OPTIONS",
    "host", "user-agent", "accept", "accept-encoding", "accept-language", "connection", "content-type",
    "content-length", "cookie", "referer", "origin", "cache-control", "pragma", "authorization",
    "upgrade-insecure-requests", "if-none-match", "if-modified-since", "x-forwarded-for", "x-forwarded-proto",
    "x-real-ip", "sec-fetch-dest", "sec-fetch-mode", "sec-fetch-site", "sec-fetch-user", "sec-ch-ua",
    "sec-ch-ua-mobile", "sec-ch-ua-platform", "dnt", "te", "transfer-encoding", "priority",
    // (And a response's, for fetch().)
    "date", "server", "content-encoding", "vary", "etag", "last-modified", "location", "set-cookie",
    "keep-alive", "expires", "access-control-allow-origin", "x-powered-by", "OK",
};
#define NCOMMON (sizeof common / sizeof *common)
static JSValue common_values[NCOMMON];
static uint8_t common_lens[NCOMMON];

// (incoming, chunk, kind) => void: request bodies' events, for every
// server's (bodyHandler).
static JSValue body_handler = JS_UNDEFINED;
enum { BODY_DATA = 0, BODY_END = 1, BODY_ABORTED = 2 };

// The JavaScript values marked while the program runs (module.c's hook).
void beyond_server_mark(JSRuntime *rt, JS_MarkFunc *mark_func) {
    JS_MarkValue(rt, body_handler, mark_func);
    for (int i = 0; i < nservers; i++)
        JS_MarkValue(rt, servers[i].handler, mark_func);
    for (size_t i = 0; i < NCOMMON; i++)
        JS_MarkValue(rt, common_values[i], mark_func);
    for (uint32_t i = 0; i < nslots; i++) {
        if (slots[i].state != FREE) {
            for (int k = 0; k < 4; k++)
                JS_MarkValue(rt, slots[i].args[k], mark_func);
            JS_MarkValue(rt, slots[i].incoming, mark_func);
        }
    }
}

// ---- Handing a request to JavaScript ----

// The common strings by a hash of their length and ends: index + 1, open
// addressing (0: none).
#define COMMON_SLOTS 256
static uint8_t common_index[COMMON_SLOTS];

static unsigned common_hash(const char *p, size_t n) {
    return ((unsigned)n * 31u + (unsigned char)p[0] * 7u + (unsigned char)p[n - 1] * 3u) & (COMMON_SLOTS - 1);
}

JSValue beyond_common_string(JSContext *ctx, const char *p, size_t n) {
    if (n == 0)
        return JS_NewStringLen(ctx, p, n);
    if (!common_lens[0]) {
        for (size_t i = 0; i < NCOMMON; i++) {
            common_lens[i] = (uint8_t)strlen(common[i]);
            common_values[i] = JS_UNDEFINED;
            unsigned h = common_hash(common[i], common_lens[i]);
            while (common_index[h])
                h = (h + 1) & (COMMON_SLOTS - 1);
            common_index[h] = (uint8_t)(i + 1);
        }
    }
    for (unsigned h = common_hash(p, n); common_index[h]; h = (h + 1) & (COMMON_SLOTS - 1)) {
        size_t i = common_index[h] - 1;
        if (common_lens[i] == n && !memcmp(common[i], p, n)) {
            if (JS_IsUndefined(common_values[i]))
                common_values[i] = JS_NewStringLen(ctx, p, n);
            return common_values[i];
        }
    }
    return JS_NewStringLen(ctx, p, n);
}

// The request's fields for JavaScript, made into strings only if it reads
// them: one string, "name\rvalue\rname\rvalue" (names in lower case: Bun's
// uWebSockets keeps them as sent; a field holds no CR).
typedef struct {
    char *buf;
    size_t len, cap;
    char stack[2048];
    const char *host;
    size_t host_len;
} HeaderSink;

static void sink_put(HeaderSink *h, const char *p, size_t n) {
    if (h->len + n > h->cap) {
        size_t cap = h->cap * 2 > h->len + n ? h->cap * 2 : h->len + n;
        char *b = h->buf == h->stack ? malloc(cap) : realloc(h->buf, cap);
        if (!b)
            return;
        if (h->buf == h->stack)
            memcpy(b, h->stack, h->len);
        h->buf = b;
        h->cap = cap;
    }
    memcpy(h->buf + h->len, p, n);
    h->len += n;
}

static void add_header(void *user, const char *k, size_t kl, const char *v, size_t vl) {
    HeaderSink *h = user;
    char lower[256];
    if (kl <= sizeof lower) {
        for (size_t i = 0; i < kl; i++)
            lower[i] = (k[i] >= 'A' && k[i] <= 'Z') ? (char)(k[i] | 32) : k[i];
        k = lower;
    }
    if (kl == 4 && !memcmp(k, "host", 4) && !h->host) {
        h->host = v;
        h->host_len = vl;
    }
    if (h->len)
        sink_put(h, "\r", 1);
    sink_put(h, k, kl);
    sink_put(h, "\r", 1);
    sink_put(h, v, vl);
}

static void on_aborted(uws_res_t *res, void *data);

// Calls the server's handler with the slot's request; the slot is freed
// when the handler responded, else it waits (for `respond`, or an abort).
// The body: all of it (or none), or, `streaming`, what came of it so far,
// the rest handed to the object the handler returns as it arrives.
static void dispatch(uint32_t i, bool streaming) {
    JSContext *ctx = beyond_js_context();
    Slot *s = &slots[i];
    uint32_t gen = s->gen;
    JSValue argv[6];
    argv[0] = JS_NewFloat64(ctx, handle_of(i));
    argv[1] = s->args[0];
    argv[2] = s->args[1];
    argv[3] = s->args[2];
    argv[5] = JS_UNDEFINED;
    if (streaming) {
        argv[4] = JS_TRUE;
        if (s->body_len)
            argv[5] = JS_NewUint8ArrayCopy(ctx, (const uint8_t *)s->body, s->body_len);
        free(s->body);
        s->body = NULL;
        s->body_len = s->body_cap = 0;
        s->body_open = true;
    } else {
        argv[4] = s->body ? JS_NewArrayBufferCopy(ctx, (const uint8_t *)s->body, s->body_len) : JS_UNDEFINED;
    }
    s->state = SYNC;
    JSValue r = JS_Call(ctx, s->server->handler, JS_UNDEFINED, 6, argv);
    if (JS_IsException(r))
        beyond_js_report();
    // (`respond` may have freed it, and the slot be another request's now.)
    s = &slots[i];
    if (streaming && s->state != FREE && s->gen == gen)
        s->incoming = JS_IsException(r) ? JS_UNDEFINED : r;
    if (beyond_js_run_jobs() < 0)
        beyond_js_report();
    s = &slots[i];
    if (s->state == SYNC && s->gen == gen) {
        s->state = ASYNC;
        uws_res_on_aborted(0, s->res, on_aborted, cb_data(i));
    }
}

// Hands a request's body event to JavaScript: a chunk, the end, or the
// client gone.
static void body_event(uint32_t i, const char *chunk, size_t len, int kind) {
    JSContext *ctx = beyond_js_context();
    Slot *s = &slots[i];
    if (!JS_IsObject(s->incoming) || s->body_dropped)
        return;
    JSValue argv[3] = {s->incoming, chunk ? JS_NewUint8ArrayCopy(ctx, (const uint8_t *)chunk, len) : JS_NULL,
                       JS_NewInt32(ctx, kind)};
    JSValue r = JS_Call(ctx, body_handler, JS_UNDEFINED, 3, argv);
    if (JS_IsException(r))
        beyond_js_report();
    if (beyond_js_run_jobs() < 0)
        beyond_js_report();
}

// Requests whose body has not all come by the end of the loop's turn they
// came in: their handler is called then (as Bun calls it on the head), the
// body following. Handles (index and generation).
static uint64_t *waiting;
static uint32_t nwaiting, cap_waiting;

// (Called by the loop after each of its turns.)
void beyond_server_after_tick(void) {
    if (!nwaiting)
        return;
    uint32_t n = nwaiting;
    uint64_t list[64];
    uint64_t *w = n <= 64 ? list : malloc(n * sizeof *w);
    memcpy(w, waiting, n * sizeof *w);
    nwaiting = 0;
    for (uint32_t k = 0; k < n; k++) {
        uint32_t i;
        Slot *s = cb_slot((void *)(uintptr_t)w[k], &i);
        if (s && s->state == BODY)
            dispatch(i, true);
    }
    if (w != list)
        free(w);
}

static void call_writable(uint32_t i, bool ok);

static void on_aborted(uws_res_t *res, void *data) {
    (void)res;
    uint32_t i;
    Slot *s = cb_slot(data, &i);
    if (!s)
        return;
    // (Gone before its handler was called: it never is.)
    if (s->state == BODY) {
        slot_free(i);
        return;
    }
    s->aborted = true;
    // (A body being read, and a streamed response waiting to write, learn
    // it now.)
    if (s->body_open) {
        s->body_open = false;
        body_event(i, NULL, 0, BODY_ABORTED);
    }
    if (slots[i].state == STREAM && slots[i].gen == s->gen)
        call_writable(i, false);
}

static void on_body(uws_res_t *res, const char *chunk, size_t len, bool last, void *data) {
    (void)res;
    uint32_t i;
    Slot *s = cb_slot(data, &i);
    if (!s)
        return;
    if (s->state == BODY) {
        if (s->body_len + len > s->body_cap) {
            s->body_cap = (s->body_len + len) * 2;
            s->body = realloc(s->body, s->body_cap);
        }
        memcpy(s->body + s->body_len, chunk, len);
        s->body_len += len;
        if (last) {
            if (!s->body)
                s->body = malloc(1);
            dispatch(i, false);
        }
        return;
    }
    if (!s->body_open)
        return;
    if (len)
        body_event(i, chunk, len, BODY_DATA);
    s = &slots[i];
    if (last && s->state != FREE && s->body_open) {
        s->body_open = false;
        body_event(i, NULL, 0, BODY_END);
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
    s->head = n == 4 && memcmp(p, "HEAD", 4) == 0;
    s->args[0] = beyond_common_string(ctx, p, n);
    HeaderSink h;
    h.buf = h.stack;
    h.len = 0;
    h.cap = sizeof h.stack;
    h.host = NULL;
    h.host_len = 0;
    beyond_req_headers(req, add_header, &h);
    s->args[2] = JS_NewStringLen(ctx, h.buf, h.len);
    if (h.buf != h.stack)
        free(h.buf);
    // The URL: http://host/path (localhost without a Host header).
    n = uws_req_get_url(req, &p);
    if (!h.host) {
        h.host = "localhost";
        h.host_len = 9;
    }
    size_t ul = 7 + h.host_len + n;
    char stack[1024];
    char *u = ul <= sizeof stack ? stack : malloc(ul);
    memcpy(u, "http://", 7);
    memcpy(u + 7, h.host, h.host_len);
    memcpy(u + 7 + h.host_len, p, n);
    s->args[1] = JS_NewStringLen(ctx, u, ul);
    if (u != stack)
        free(u);
    // A body: read it all, then call the handler.
    const char *v;
    size_t cl = uws_req_get_header(req, "content-length", 14, &v);
    bool has_body = (cl && !(cl == 1 && v[0] == '0')) || uws_req_get_header(req, "transfer-encoding", 17, &v);
    if (has_body) {
        s->state = BODY;
        uws_res_on_data(0, res, on_body, cb_data(i));
        uws_res_on_aborted(0, res, on_aborted, cb_data(i));
        if (nwaiting == cap_waiting) {
            cap_waiting = cap_waiting ? cap_waiting * 2 : 64;
            waiting = realloc(waiting, cap_waiting * sizeof *waiting);
        }
        waiting[nwaiting++] = (uintptr_t)cb_data(i);
        return;
    }
    dispatch(i, false);
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
    JSValueConst status_text, headers, body, content_type;
    bool ok;
} Reply;

// The status line and headers, without the framing headers the program
// gave (Content-Length, Transfer-Encoding: as Bun's, the body's own are
// written, by uWebSockets).
static void write_head(Reply *r, bool stream) {
    JSContext *ctx = r->ctx;
    uws_res_t *res = r->s->res;
    char line[160];
    const char *text = NULL;
    size_t text_len = 0;
    if (JS_IsString(r->status_text))
        text = JS_ToCStringLen(ctx, &text_len, r->status_text);
    if (r->status == 200 && !text_len) {
        uws_res_write_status(0, res, "200 OK", 6);
    } else {
        int n = snprintf(line, sizeof line, "%d %.*s", r->status,
                         (int)(text && text_len ? text_len : strlen(reason(r->status))), text && text_len ? text : reason(r->status));
        uws_res_write_status(0, res, line, (size_t)(n < (int)sizeof line ? n : (int)sizeof line - 1));
    }
    if (text)
        JS_FreeCString(ctx, text);
    // headers: [name, value, ...]
    int64_t len = 0;
    if (JS_IsArray(r->headers))
        JS_GetLength(ctx, r->headers, &len);
    for (int64_t k = 0; k + 1 < len; k += 2) {
        JSValue kv = JS_GetPropertyInt64(ctx, r->headers, k), vv = JS_GetPropertyInt64(ctx, r->headers, k + 1);
        size_t kl, vl;
        const char *ks = JS_ToCStringLen(ctx, &kl, kv), *vs = JS_ToCStringLen(ctx, &vl, vv);
        bool framing = ks && ((kl == 14 && !strncasecmp(ks, "content-length", 14)) ||
                              (kl == 17 && !strncasecmp(ks, "transfer-encoding", 17)));
        if (ks && vs && !framing)
            uws_res_write_header(0, res, ks, kl, vs, vl);
        JS_FreeCString(ctx, ks);
        JS_FreeCString(ctx, vs);
        JS_FreeValue(ctx, kv);
        JS_FreeValue(ctx, vv);
    }
    // (The content type a response has without headers of its own.)
    if (JS_IsString(r->content_type)) {
        size_t vl;
        const char *vs = JS_ToCStringLen(ctx, &vl, r->content_type);
        if (vs)
            uws_res_write_header(0, res, "content-type", 12, vs, vl);
        JS_FreeCString(ctx, vs);
    }
}

/** The bytes of a string's UTF-8 (`*owned`: to free), an ArrayBuffer or a view of one. */
static const uint8_t *bytes_of(JSContext *ctx, JSValueConst v, size_t *len, const char **owned) {
    *owned = NULL;
    if (JS_IsString(v)) {
        *owned = JS_ToCStringLen(ctx, len, v);
        return (const uint8_t *)*owned;
    }
    // (Checked before asking: asking for the wrong kind throws, and making
    // an error is costly.)
    if (JS_IsArrayBuffer(v))
        return JS_GetArrayBuffer(ctx, len, v);
    int type = JS_GetTypedArrayType(v);
    if (type < 0) {
        *len = 0;
        return NULL;
    }
    if (type == JS_TYPED_ARRAY_UINT8 || type == JS_TYPED_ARRAY_UINT8C) {
        uint8_t *b = JS_GetUint8Array(ctx, len, v);
        if (!b)
            JS_FreeValue(ctx, JS_GetException(ctx));
        return b;
    }
    size_t off = 0, bpe;
    JSValue ab = JS_GetTypedArrayBuffer(ctx, v, &off, len, &bpe);
    if (JS_IsException(ab)) {
        JS_FreeValue(ctx, JS_GetException(ctx));
        *len = 0;
        return NULL;
    }
    size_t total;
    uint8_t *b = JS_GetArrayBuffer(ctx, &total, ab);
    JS_FreeValue(ctx, ab);
    return b ? b + off : NULL;
}

// Ends the response with body `b`: for a HEAD request, its length only (as
// Bun's server answers HEAD).
static void end_with(Reply *r, const char *b, size_t bl) {
    uws_res_t *res = r->s->res;
    if (r->s->head) {
        char len[24];
        int n = snprintf(len, sizeof len, "%zu", bl);
        uws_res_write_header(0, res, "Content-Length", 14, len, (size_t)n);
        uws_res_end_without_body(0, res, false);
        return;
    }
    uws_res_end(0, res, b, bl, false);
}

static void write_reply(void *data) {
    Reply *r = data;
    JSContext *ctx = r->ctx;
    uws_res_t *res = r->s->res;
    write_head(r, false);
    // body: a string (UTF-8), bytes (an ArrayBuffer or a view of one), or none
    if (JS_IsString(r->body)) {
        size_t bl;
        const char *b = JS_ToCStringLen(ctx, &bl, r->body);
        end_with(r, b ? b : "", b ? bl : 0);
        JS_FreeCString(ctx, b);
    } else if (JS_IsUndefined(r->body) || JS_IsNull(r->body)) {
        if (r->status == 204 || r->status == 304 || (r->status >= 100 && r->status < 200))
            uws_res_end_without_body(0, res, false);
        else
            end_with(r, "", 0);
    } else {
        size_t bl = 0;
        const char *owned;
        const uint8_t *b = bytes_of(ctx, r->body, &bl, &owned);
        end_with(r, b ? (const char *)b : "", b ? bl : 0);
    }
    r->ok = true;
}

// respond(handle, status, statusText, headers, body, contentType): false
// when the request is no longer waiting (answered, aborted). `headers` is
// [name, value, ...] or null, `contentType` a string or null.
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
    Reply r = {ctx, s, status, argv[2], argv[3], argv[4], argc > 5 ? argv[5] : JS_UNDEFINED, false};
    if (s->state == SYNC)
        write_reply(&r);
    else
        uws_res_cork(0, s->res, &r, write_reply);
    slot_free(i);
    return JS_TRUE;
}

// ---- Streamed responses (chunked, Bun's HTTPServerWritable reduced) ----

static void write_head_cb(void *data) { write_head(data, true); }

// respondStart(handle, status, statusText, headers): sends the head of a
// response whose body follows in chunks; false when the request is no
// longer waiting.
static JSValue js_respond_start(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    double h;
    int32_t status;
    uint32_t i;
    if (JS_ToFloat64(ctx, &h, argv[0]) || JS_ToInt32(ctx, &status, argv[1]))
        return JS_EXCEPTION;
    Slot *s = slot_of(h, &i);
    if (!s || s->state == BODY || s->state == STREAM)
        return JS_FALSE;
    if (s->aborted) {
        slot_free(i);
        return JS_FALSE;
    }
    Reply r = {ctx, s, status, argv[2], argv[3], JS_UNDEFINED, JS_UNDEFINED, false};
    if (s->state == SYNC)
        write_head(&r, true);
    else
        uws_res_cork(0, s->res, &r, write_head_cb);
    s->state = STREAM;
    uws_res_on_aborted(0, s->res, on_aborted, cb_data(i));
    return JS_TRUE;
}

typedef struct {
    uws_res_t *res;
    const char *data;
    size_t len;
    bool ok;
} Chunk;

static void write_chunk_cb(void *data) {
    Chunk *c = data;
    size_t len = c->len;
    c->ok = uws_res_write(0, c->res, c->data, &len);
}

// writeChunk(handle, bytes): 1 when written, 0 when the connection is
// backpressured (wait with `whenWritable` before writing more), -1 when the
// request is gone.
static JSValue js_write_chunk(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    double h;
    uint32_t i;
    if (JS_ToFloat64(ctx, &h, argv[0]))
        return JS_EXCEPTION;
    Slot *s = slot_of(h, &i);
    if (!s || s->state != STREAM)
        return JS_NewInt32(ctx, -1);
    if (s->aborted) {
        slot_free(i);
        return JS_NewInt32(ctx, -1);
    }
    size_t len = 0;
    const char *owned;
    const uint8_t *b = bytes_of(ctx, argv[1], &len, &owned);
    Chunk c = {s->res, (const char *)b, len, true};
    if (b && len)
        uws_res_cork(0, s->res, &c, write_chunk_cb);
    if (owned)
        JS_FreeCString(ctx, owned);
    return JS_NewInt32(ctx, c.ok ? 1 : 0);
}

static void call_writable(uint32_t i, bool ok) {
    JSContext *ctx = beyond_js_context();
    Slot *s = &slots[i];
    JSValue f = s->args[3];
    if (!JS_IsFunction(ctx, f))
        return;
    s->args[3] = JS_UNDEFINED;
    JSValue arg = JS_NewBool(ctx, ok);
    JSValue r = JS_Call(ctx, f, JS_UNDEFINED, 1, &arg);
    JS_FreeValue(ctx, f);
    if (JS_IsException(r))
        beyond_js_report();
    JS_FreeValue(ctx, r);
    if (beyond_js_run_jobs() < 0)
        beyond_js_report();
}

static bool on_writable(uws_res_t *res, uint64_t offset, void *data) {
    (void)offset;
    uint32_t i;
    Slot *s = cb_slot(data, &i);
    if (!s || s->state != STREAM || s->res != res)
        return true;
    uws_res_clear_on_writable(0, res);
    call_writable(i, true);
    return true;
}

// whenWritable(handle, callback): calls callback(true) once the connection
// has drained (callback(false) if the request is aborted instead).
static JSValue js_when_writable(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    double h;
    uint32_t i;
    if (JS_ToFloat64(ctx, &h, argv[0]))
        return JS_EXCEPTION;
    Slot *s = slot_of(h, &i);
    if (!s || s->state != STREAM || s->aborted)
        return JS_FALSE;
    JS_FreeValue(ctx, s->args[3]);
    s->args[3] = JS_DupValue(ctx, argv[1]);
    uws_res_on_writable(0, s->res, on_writable, cb_data(i));
    return JS_TRUE;
}

static void end_stream_cb(void *data) { uws_res_end_stream(0, data, false); }

// endStream(handle, ok): ends a streamed response (`ok` false: the body
// failed, the connection is closed without the final chunk).
static JSValue js_end_stream(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    double h;
    uint32_t i;
    if (JS_ToFloat64(ctx, &h, argv[0]))
        return JS_EXCEPTION;
    Slot *s = slot_of(h, &i);
    if (!s || s->state != STREAM)
        return JS_FALSE;
    bool aborted = s->aborted;
    uws_res_t *res = s->res;
    slot_free(i);
    if (aborted)
        return JS_FALSE;
    if (JS_ToBool(ctx, argv[1])) {
        uws_res_cork(0, res, res, end_stream_cb);
    } else {
        uws_res_on_aborted(0, res, NULL, NULL);
        uws_res_clear_on_writable(0, res);
        us_socket_close((struct us_socket_t *)res, 0, NULL);
    }
    return JS_TRUE;
}

// ---- Request bodies ----

// bodyHandler(fn): the function request bodies' events are handed to:
// fn(incoming, chunk, kind), kind 0 a chunk, 1 the end, 2 the client gone.
static JSValue js_body_handler(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    body_handler = JS_DupValue(ctx, argv[0]);
    return JS_UNDEFINED;
}

// requestPause(handle, paused): stops (or resumes) reading the request's
// body.
static JSValue js_request_pause(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    double h;
    uint32_t i;
    if (JS_ToFloat64(ctx, &h, argv[0]))
        return JS_EXCEPTION;
    Slot *s = slot_of(h, &i);
    if (!s || !s->body_open || s->aborted)
        return JS_FALSE;
    if (JS_ToBool(ctx, argv[1]))
        uws_res_pause(0, s->res);
    else
        uws_res_resume(0, s->res);
    return JS_TRUE;
}

// requestDrop(handle): the rest of the request's body is not wanted (it is
// read and dropped).
static JSValue js_request_drop(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    double h;
    uint32_t i;
    if (JS_ToFloat64(ctx, &h, argv[0]))
        return JS_EXCEPTION;
    Slot *s = slot_of(h, &i);
    if (!s || !s->body_open)
        return JS_FALSE;
    s->body_dropped = true;
    if (!s->aborted)
        uws_res_resume(0, s->res);
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

// stopServer(server, force): no new connections; as Bun's, idle ones are
// closed and the others once their request is answered, or (`force`) all
// of them now.
static JSValue js_stop(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    int32_t k;
    if (JS_ToInt32(ctx, &k, argv[0]))
        return JS_EXCEPTION;
    if (k < 0 || k >= nservers || !servers[k].app)
        return JS_UNDEFINED;
    Server *srv = &servers[k];
    if (srv->listen) {
        us_listen_socket_close(srv->listen);
        srv->listen = NULL;
    }
    if (JS_ToBool(ctx, argv[1]))
        uws_app_close(0, srv->app);
    else
        uws_app_close_idle(0, srv->app, 1);
    return JS_UNDEFINED;
}

const JSCFunctionListEntry beyond_server_functions[] = {
    JS_CFUNC_DEF("listen", 3, js_listen),
    JS_CFUNC_DEF("serverPort", 1, js_server_port),
    JS_CFUNC_DEF("stopServer", 2, js_stop),
    JS_CFUNC_DEF("respond", 6, js_respond),
    JS_CFUNC_DEF("respondStart", 4, js_respond_start),
    JS_CFUNC_DEF("writeChunk", 2, js_write_chunk),
    JS_CFUNC_DEF("whenWritable", 2, js_when_writable),
    JS_CFUNC_DEF("endStream", 2, js_end_stream),
    JS_CFUNC_DEF("bodyHandler", 1, js_body_handler),
    JS_CFUNC_DEF("requestPause", 2, js_request_pause),
    JS_CFUNC_DEF("requestDrop", 1, js_request_drop),
};
const int beyond_server_function_count = sizeof beyond_server_functions / sizeof *beyond_server_functions;
