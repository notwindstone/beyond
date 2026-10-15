// fetch()'s HTTP client: HTTP/1.1 requests over Bun's uSockets, as Bun's
// client (src/http) does them, reduced. Each request gets a connection (an
// idle keep-alive one to the same host and port, else a new one), writes
// its bytes, and has the response parsed with picohttpparser: its head, then
// its body, unframed (Content-Length, chunked, or until the connection
// closes) and decoded (gzip, deflate, br, zstd). What happens is handed to the
// request's JavaScript callback: (HEAD, status, statusText, [name, value,
// ...]), (DATA, Uint8Array), (END) or (ERROR, code, message).

#define _GNU_SOURCE
#include <brotli/decode.h>
#include <errno.h>
#include <netdb.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <zlib.h>

#include "libusockets.h"
#include "picohttpparser.h"
#include "quickjs.h"
#include "zstd.h"

int beyond_js_run_jobs(void);
JSContext *beyond_js_context(void);
void beyond_js_report(void);
struct us_loop_t *uws_get_loop(void);

#define KIND_FETCH 40

enum { EV_HEAD = 1, EV_DATA = 2, EV_END = 3, EV_ERROR = 4 };
enum { R_CONNECT, R_HEAD, R_BODY, R_DONE };
enum { ENC_NONE, ENC_GZIP, ENC_DEFLATE, ENC_BR, ENC_ZSTD };

#define KEY_MAX 300

typedef struct {
    uint32_t gen;
    bool live;
    JSValue cb;
    struct us_socket_t *s;
    struct us_connecting_socket_t *cs;
    char host[256];
    int port;
    char key[KEY_MAX];
    // The request's bytes, and how many are written.
    char *out;
    size_t out_len, out_off;
    // Response bytes not parsed yet (the head; chunked framing).
    char *in;
    size_t in_len, in_cap;
    int state;
    bool head_only;
    // Content-Length left; -1: until the connection closes; -2: chunked.
    int64_t remaining;
    struct phr_chunked_decoder chunked;
    bool keep_alive;
    // (On an idle connection: retried once on a new one if that fails before
    // any response byte.)
    bool reused;
    bool got_bytes;
    int encoding;
    z_stream z;
    bool z_init;
    BrotliDecoderState *br;
    ZSTD_DStream *zstd;
    uint32_t next_free;
} Req;

// The socket's ext: its request, or -1 when idle in the pool.
typedef struct {
    int32_t req;
} Ext;

static Req **reqs;
static uint32_t nreqs, cap_reqs, free_head = UINT32_MAX;

static struct us_socket_group_t group;
static bool group_ready;

// Idle keep-alive connections.
typedef struct {
    struct us_socket_t *s;
    char key[KEY_MAX];
} Idle;
#define MAX_IDLE 128
static Idle idle[MAX_IDLE];
static int nidle;

// (For the loop: idle connections do not keep the program alive.)
int beyond_client_idle_count(void) { return nidle; }

static void idle_remove(struct us_socket_t *s) {
    for (int i = 0; i < nidle; i++) {
        if (idle[i].s == s) {
            idle[i] = idle[--nidle];
            return;
        }
    }
}

// ---- Requests ----

static uint32_t req_alloc(void) {
    uint32_t i;
    if (free_head != UINT32_MAX) {
        i = free_head;
        free_head = reqs[i]->next_free;
    } else {
        if (nreqs == cap_reqs) {
            cap_reqs = cap_reqs ? cap_reqs * 2 : 64;
            reqs = realloc(reqs, cap_reqs * sizeof *reqs);
        }
        i = nreqs++;
        reqs[i] = calloc(1, sizeof(Req));
    }
    Req *r = reqs[i];
    uint32_t gen = r->gen;
    memset(r, 0, sizeof *r);
    r->gen = gen;
    r->live = true;
    r->cb = JS_UNDEFINED;
    return i;
}

static void decoder_end(Req *r) {
    if (r->z_init) {
        inflateEnd(&r->z);
        r->z_init = false;
    }
    if (r->br) {
        BrotliDecoderDestroyInstance(r->br);
        r->br = NULL;
    }
    if (r->zstd) {
        ZSTD_freeDStream(r->zstd);
        r->zstd = NULL;
    }
}

static void req_free(uint32_t i) {
    Req *r = reqs[i];
    if (!r->live)
        return;
    JS_FreeValue(beyond_js_context(), r->cb);
    r->cb = JS_UNDEFINED;
    free(r->out);
    free(r->in);
    r->out = r->in = NULL;
    decoder_end(r);
    r->live = false;
    r->gen++;
    r->next_free = free_head;
    free_head = i;
}

static double handle_of(uint32_t i) { return (double)i + (double)(reqs[i]->gen & 0x1FFFFFFF) * 16777216.0; }

static Req *req_of(double h, uint32_t *index) {
    if (!(h >= 0))
        return NULL;
    uint64_t v = (uint64_t)h;
    uint32_t i = (uint32_t)(v & 0xFFFFFF), gen = (uint32_t)(v >> 24);
    if (i >= nreqs || !reqs[i]->live || (reqs[i]->gen & 0x1FFFFFFF) != gen)
        return NULL;
    *index = i;
    return reqs[i];
}

void beyond_client_mark(JSRuntime *rt, JS_MarkFunc *mark_func) {
    for (uint32_t i = 0; i < nreqs; i++)
        if (reqs[i]->live)
            JS_MarkValue(rt, reqs[i]->cb, mark_func);
}

// Calls the request's callback; false if the request is gone after it (the
// callback aborted it).
static bool emit(uint32_t i, int argc, JSValue *argv) {
    JSContext *ctx = beyond_js_context();
    Req *r = reqs[i];
    uint32_t gen = r->gen;
    JSValue cb = JS_DupValue(ctx, r->cb);
    JSValue res = JS_Call(ctx, cb, JS_UNDEFINED, argc, argv);
    JS_FreeValue(ctx, cb);
    for (int k = 0; k < argc; k++)
        JS_FreeValue(ctx, argv[k]);
    if (JS_IsException(res))
        beyond_js_report();
    JS_FreeValue(ctx, res);
    return i < nreqs && reqs[i]->live && reqs[i]->gen == gen;
}

static Ext *ext_of(struct us_socket_t *s) { return us_socket_ext(s); }

// Ends the request with an error (the connection closed).
static void fail(uint32_t i, const char *code, const char *message) {
    JSContext *ctx = beyond_js_context();
    Req *r = reqs[i];
    struct us_socket_t *s = r->s;
    struct us_connecting_socket_t *cs = r->cs;
    r->s = NULL;
    r->cs = NULL;
    if (s && !us_socket_is_closed(s)) {
        ext_of(s)->req = -1;
        us_socket_close(s, 0, NULL);
    } else if (cs) {
        ((Ext *)us_connecting_socket_ext(cs))->req = -1;
        us_connecting_socket_close(cs);
    }
    JSValue argv[3] = {JS_NewInt32(ctx, EV_ERROR), JS_NewString(ctx, code), JS_NewString(ctx, message)};
    if (emit(i, 3, argv))
        req_free(i);
}

// The response is complete: END, and the connection back to the pool (or
// closed).
static void finish(uint32_t i) {
    JSContext *ctx = beyond_js_context();
    Req *r = reqs[i];
    struct us_socket_t *s = r->s;
    r->s = NULL;
    r->state = R_DONE;
    if (s && !us_socket_is_closed(s)) {
        ext_of(s)->req = -1;
        if (r->keep_alive && nidle < MAX_IDLE) {
            idle[nidle].s = s;
            memcpy(idle[nidle].key, r->key, KEY_MAX);
            nidle++;
            us_socket_timeout(s, 60);
        } else {
            us_socket_close(s, 0, NULL);
        }
    }
    JSValue argv[1] = {JS_NewInt32(ctx, EV_END)};
    if (emit(i, 1, argv))
        req_free(i);
}

// Hands body bytes to JavaScript, decoded. False if the request is gone.
static bool deliver(uint32_t i, const uint8_t *data, size_t len) {
    JSContext *ctx = beyond_js_context();
    Req *r = reqs[i];
    if (len == 0)
        return true;
    if (r->encoding == ENC_NONE) {
        JSValue argv[2] = {JS_NewInt32(ctx, EV_DATA), JS_NewUint8ArrayCopy(ctx, data, len)};
        return emit(i, 2, argv);
    }
    uint8_t buf[65536];
    if (r->encoding == ENC_BR) {
        size_t avail_in = len;
        const uint8_t *next_in = data;
        for (;;) {
            size_t avail_out = sizeof buf;
            uint8_t *next_out = buf;
            BrotliDecoderResult res =
                BrotliDecoderDecompressStream(r->br, &avail_in, &next_in, &avail_out, &next_out, NULL);
            size_t n = sizeof buf - avail_out;
            if (n > 0) {
                JSValue argv[2] = {JS_NewInt32(ctx, EV_DATA), JS_NewUint8ArrayCopy(ctx, buf, n)};
                if (!emit(i, 2, argv))
                    return false;
                r = reqs[i];
            }
            if (res == BROTLI_DECODER_RESULT_ERROR) {
                fail(i, "BrotliDecompressionError", "The response body could not be decompressed (br)");
                return false;
            }
            if (res != BROTLI_DECODER_RESULT_NEEDS_MORE_OUTPUT)
                return true;
        }
    }
    if (r->encoding == ENC_ZSTD) {
        ZSTD_inBuffer in = {data, len, 0};
        for (;;) {
            ZSTD_outBuffer out = {buf, sizeof buf, 0};
            size_t res = ZSTD_decompressStream(r->zstd, &out, &in);
            if (ZSTD_isError(res)) {
                fail(i, "ZstdDecompressionError", "The response body could not be decompressed (zstd)");
                return false;
            }
            if (out.pos > 0) {
                JSValue argv[2] = {JS_NewInt32(ctx, EV_DATA), JS_NewUint8ArrayCopy(ctx, buf, out.pos)};
                if (!emit(i, 2, argv))
                    return false;
                r = reqs[i];
            }
            // (Done with the input, and the output not cut short.)
            if (in.pos == in.size && out.pos < out.size)
                return true;
        }
    }
    r->z.next_in = (Bytef *)data;
    r->z.avail_in = (uInt)len;
    for (;;) {
        r->z.next_out = buf;
        r->z.avail_out = sizeof buf;
        int res = inflate(&r->z, Z_NO_FLUSH);
        size_t n = sizeof buf - r->z.avail_out;
        if (n > 0) {
            JSValue argv[2] = {JS_NewInt32(ctx, EV_DATA), JS_NewUint8ArrayCopy(ctx, buf, n)};
            if (!emit(i, 2, argv))
                return false;
            r = reqs[i];
        }
        if (res == Z_STREAM_END)
            return true;
        if (res != Z_OK && res != Z_BUF_ERROR) {
            fail(i, "ZlibError", "The response body could not be decompressed");
            return false;
        }
        if (r->z.avail_in == 0 && r->z.avail_out != 0)
            return true;
    }
}

static bool header_is(const struct phr_header *h, const char *name) {
    size_t n = strlen(name);
    return h->name_len == n && !strncasecmp(h->name, name, n);
}

static bool value_has(const struct phr_header *h, const char *token) {
    size_t n = strlen(token);
    for (size_t k = 0; k + n <= h->value_len; k++)
        if (!strncasecmp(h->value + k, token, n))
            return true;
    return false;
}

// Body bytes: unframed, then delivered. False if the request is gone.
static bool body(uint32_t i, char *data, size_t len) {
    Req *r = reqs[i];
    if (r->remaining >= 0) {
        size_t n = len < (uint64_t)r->remaining ? len : (size_t)r->remaining;
        r->remaining -= (int64_t)n;
        if (!deliver(i, (uint8_t *)data, n))
            return false;
        if (reqs[i]->remaining == 0) {
            finish(i);
            return false;
        }
        return true;
    }
    if (r->remaining == -1)
        return deliver(i, (uint8_t *)data, len);
    // Chunked: decoded in place (in a copy: `data` is the socket's buffer).
    if (r->in_len + len > r->in_cap) {
        r->in_cap = (r->in_len + len) * 2;
        r->in = realloc(r->in, r->in_cap);
    }
    memcpy(r->in + r->in_len, data, len);
    r->in_len += len;
    size_t size = r->in_len;
    ssize_t rest = phr_decode_chunked(&r->chunked, r->in, &size);
    if (rest == -1) {
        fail(i, "ChunkedEncodingError", "The response body's chunked encoding is invalid");
        return false;
    }
    r->in_len = 0;
    if (!deliver(i, (uint8_t *)r->in, size))
        return false;
    if (rest >= 0) {
        finish(i);
        return false;
    }
    return true;
}

// Response bytes: the head (once complete), then body. False if the
// request is gone.
static void response_data(uint32_t i, char *data, size_t len) {
    JSContext *ctx = beyond_js_context();
    Req *r = reqs[i];
    r->got_bytes = true;
    if (r->state == R_BODY) {
        body(i, data, len);
        return;
    }
    if (r->in_len + len > r->in_cap) {
        r->in_cap = (r->in_len + len) * 2 + 1024;
        r->in = realloc(r->in, r->in_cap);
    }
    memcpy(r->in + r->in_len, data, len);
    r->in_len += len;
    for (;;) {
        int minor, status;
        const char *msg;
        size_t msg_len, num_headers = 100;
        struct phr_header headers[100];
        int n = phr_parse_response(r->in, r->in_len, &minor, &status, &msg, &msg_len, headers, &num_headers, 0);
        if (n == -2) {
            if (r->in_len > 256 * 1024)
                fail(i, "ResponseHeadersTooLarge", "The response's headers are too large");
            return;
        }
        if (n < 0) {
            fail(i, "Malformed_HTTP_Response", "The response is not valid HTTP");
            return;
        }
        // (1xx: the final response follows.)
        if (status >= 100 && status < 200 && status != 101) {
            memmove(r->in, r->in + n, r->in_len - n);
            r->in_len -= n;
            continue;
        }
        r->keep_alive = minor >= 1;
        r->remaining = -1;
        r->encoding = ENC_NONE;
        bool no_body = r->head_only || status == 204 || status == 205 || status == 304;
        JSValue flat = JS_NewArray(ctx);
        uint32_t k = 0;
        for (size_t h = 0; h < num_headers; h++) {
            const struct phr_header *hd = &headers[h];
            if (!hd->name)
                continue;
            if (header_is(hd, "content-length"))
                r->remaining = strtoll(hd->value, NULL, 10);
            else if (header_is(hd, "transfer-encoding") && value_has(hd, "chunked"))
                r->remaining = -2;
            else if (header_is(hd, "connection"))
                r->keep_alive = value_has(hd, "keep-alive") || (minor >= 1 && !value_has(hd, "close"));
            else if (header_is(hd, "content-encoding")) {
                if (value_has(hd, "br"))
                    r->encoding = ENC_BR;
                else if (value_has(hd, "zstd"))
                    r->encoding = ENC_ZSTD;
                else if (value_has(hd, "gzip"))
                    r->encoding = ENC_GZIP;
                else if (value_has(hd, "deflate"))
                    r->encoding = ENC_DEFLATE;
            }
            char lower[256];
            size_t nl = hd->name_len < sizeof lower ? hd->name_len : sizeof lower;
            for (size_t c = 0; c < nl; c++)
                lower[c] = (hd->name[c] >= 'A' && hd->name[c] <= 'Z') ? (char)(hd->name[c] | 32) : hd->name[c];
            JS_SetPropertyUint32(ctx, flat, k++, JS_NewStringLen(ctx, lower, nl));
            JS_SetPropertyUint32(ctx, flat, k++, JS_NewStringLen(ctx, hd->value, hd->value_len));
        }
        if (r->remaining == -2)
            memset(&r->chunked, 0, sizeof r->chunked);
        if (r->remaining == -1)
            r->keep_alive = false;
        if (no_body)
            r->remaining = 0;
        if (r->encoding == ENC_BR) {
            r->br = BrotliDecoderCreateInstance(NULL, NULL, NULL);
        } else if (r->encoding == ENC_ZSTD) {
            r->zstd = ZSTD_createDStream();
        } else if (r->encoding != ENC_NONE) {
            memset(&r->z, 0, sizeof r->z);
            // (gzip, or zlib's format; 32: either, detected.)
            inflateInit2(&r->z, r->encoding == ENC_GZIP ? 16 + MAX_WBITS : 32 + MAX_WBITS);
            r->z_init = true;
        }
        size_t rest = r->in_len - (size_t)n;
        char *tail = rest ? malloc(rest) : NULL;
        if (rest)
            memcpy(tail, r->in + n, rest);
        r->in_len = 0;
        r->state = R_BODY;
        JSValue argv[4] = {JS_NewInt32(ctx, EV_HEAD), JS_NewInt32(ctx, status), JS_NewStringLen(ctx, msg, msg_len), flat};
        if (!emit(i, 4, argv)) {
            free(tail);
            return;
        }
        if (reqs[i]->remaining == 0) {
            free(tail);
            finish(i);
            return;
        }
        if (rest)
            body(i, tail, rest);
        free(tail);
        return;
    }
}

// ---- The connection's events ----

static void write_out(uint32_t i) {
    Req *r = reqs[i];
    while (r->out_off < r->out_len) {
        int n = us_socket_write(r->s, r->out + r->out_off, (int)(r->out_len - r->out_off));
        if (n <= 0)
            return;
        r->out_off += (size_t)n;
    }
    if (r->state == R_CONNECT)
        r->state = R_HEAD;
}

static struct us_socket_t *on_open(struct us_socket_t *s, int is_client, char *ip, int ip_length) {
    (void)is_client, (void)ip, (void)ip_length;
    int32_t i = ext_of(s)->req;
    if (i < 0 || (uint32_t)i >= nreqs || !reqs[i]->live) {
        us_socket_close(s, 0, NULL);
        return s;
    }
    Req *r = reqs[i];
    r->s = s;
    r->cs = NULL;
    us_socket_nodelay(s, 1);
    write_out((uint32_t)i);
    return s;
}

static struct us_socket_t *on_writable(struct us_socket_t *s) {
    int32_t i = ext_of(s)->req;
    if (i >= 0 && (uint32_t)i < nreqs && reqs[i]->live && reqs[i]->s == s)
        write_out((uint32_t)i);
    return s;
}

static struct us_socket_t *on_data(struct us_socket_t *s, char *data, int length) {
    int32_t i = ext_of(s)->req;
    if (i < 0) {
        // (An idle connection the server wrote to: not reusable.)
        us_socket_close(s, 0, NULL);
        return s;
    }
    if ((uint32_t)i < nreqs && reqs[i]->live && reqs[i]->s == s)
        response_data((uint32_t)i, data, (size_t)length);
    return s;
}

static void start(uint32_t i);

// The connection ended before the response did.
static void lost(uint32_t i) {
    Req *r = reqs[i];
    if (r->state == R_BODY && r->remaining == -1) {
        r->s = NULL;
        decoder_end(r);
        finish(i);
        return;
    }
    if (r->reused && !r->got_bytes) {
        // (A pooled connection the server had closed: a new one.)
        r->s = NULL;
        r->reused = false;
        r->out_off = 0;
        r->state = R_CONNECT;
        start(i);
        return;
    }
    r->s = NULL;
    fail(i, "ECONNRESET", "The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()");
}

static struct us_socket_t *on_end(struct us_socket_t *s) {
    int32_t i = ext_of(s)->req;
    ext_of(s)->req = -1;
    idle_remove(s);
    us_socket_close(s, 0, NULL);
    if (i >= 0 && (uint32_t)i < nreqs && reqs[i]->live && reqs[i]->s == s)
        lost((uint32_t)i);
    return s;
}

static struct us_socket_t *on_close(struct us_socket_t *s, int code, void *reason) {
    (void)code, (void)reason;
    int32_t i = ext_of(s)->req;
    ext_of(s)->req = -1;
    idle_remove(s);
    if (i >= 0 && (uint32_t)i < nreqs && reqs[i]->live && reqs[i]->s == s)
        lost((uint32_t)i);
    return s;
}

static struct us_socket_t *on_timeout(struct us_socket_t *s) {
    if (ext_of(s)->req < 0) {
        idle_remove(s);
        us_socket_close(s, 0, NULL);
    }
    return s;
}

static void connect_failed(uint32_t i, int dns_error, int code) {
    Req *r = reqs[i];
    r->s = NULL;
    r->cs = NULL;
    char message[400];
    if (dns_error) {
        snprintf(message, sizeof message, "getaddrinfo ENOTFOUND %s", r->host);
        fail(i, "ENOTFOUND", message);
    } else if (code == ECONNREFUSED || code == 0) {
        fail(i, "ConnectionRefused", "Unable to connect. Is the computer able to access the url?");
    } else {
        snprintf(message, sizeof message, "connect %s", strerror(code));
        fail(i, "ConnectionClosed", message);
    }
}

static struct us_socket_t *on_connect_error(struct us_socket_t *s, int code) {
    int32_t i = ext_of(s)->req;
    ext_of(s)->req = -1;
    if (i >= 0 && (uint32_t)i < nreqs && reqs[i]->live)
        connect_failed((uint32_t)i, 0, code);
    return s;
}

static struct us_connecting_socket_t *on_connecting_error(struct us_connecting_socket_t *c, int code) {
    Ext *e = us_connecting_socket_ext(c);
    int32_t i = e->req;
    e->req = -1;
    if (i >= 0 && (uint32_t)i < nreqs && reqs[i]->live)
        connect_failed((uint32_t)i, us_connecting_socket_get_dns_error(c), code);
    return c;
}

static const struct us_socket_vtable_t vtable = {
    .on_open = on_open,
    .on_data = on_data,
    .on_writable = on_writable,
    .on_close = on_close,
    .on_timeout = on_timeout,
    .on_end = on_end,
    .on_connect_error = on_connect_error,
    .on_connecting_error = on_connecting_error,
};

// A connection for request i: an idle one to its host and port, else a new
// one.
static void start(uint32_t i) {
    Req *r = reqs[i];
    for (int k = nidle - 1; k >= 0; k--) {
        if (!strcmp(idle[k].key, r->key)) {
            struct us_socket_t *s = idle[k].s;
            idle[k] = idle[--nidle];
            if (us_socket_is_closed(s) || us_socket_queued_input(s) != LIBUS_QUEUED_INPUT_NONE) {
                us_socket_close(s, 0, NULL);
                continue;
            }
            ext_of(s)->req = (int32_t)i;
            us_socket_timeout(s, 0);
            r->s = s;
            r->reused = true;
            write_out(i);
            return;
        }
    }
    if (!group_ready) {
        us_socket_group_init(&group, uws_get_loop(), &vtable, NULL);
        group_ready = true;
    }
    int is_connecting = 0;
    void *c = us_socket_group_connect(&group, KIND_FETCH, NULL, r->host, r->port, NULL, 0, 0, sizeof(Ext), &is_connecting);
    if (!c) {
        connect_failed(i, 0, errno);
        return;
    }
    if (is_connecting) {
        struct us_socket_t *s = c;
        ext_of(s)->req = (int32_t)i;
    } else {
        struct us_connecting_socket_t *cs = c;
        ((Ext *)us_connecting_socket_ext(cs))->req = (int32_t)i;
        r->cs = cs;
    }
}

// ---- beyond:native ----

/** The bytes of a string's UTF-8, an ArrayBuffer or a view of one (NULL: none). */
static const uint8_t *bytes_of(JSContext *ctx, JSValueConst v, size_t *len, const char **owned) {
    *owned = NULL;
    *len = 0;
    if (JS_IsUndefined(v) || JS_IsNull(v))
        return NULL;
    if (JS_IsString(v)) {
        *owned = JS_ToCStringLen(ctx, len, v);
        return (const uint8_t *)*owned;
    }
    size_t off = 0, bpe;
    uint8_t *b = JS_GetArrayBuffer(ctx, len, v);
    if (b)
        return b;
    JS_FreeValue(ctx, JS_GetException(ctx));
    JSValue ab = JS_GetTypedArrayBuffer(ctx, v, &off, len, &bpe);
    if (JS_IsException(ab)) {
        JS_FreeValue(ctx, JS_GetException(ctx));
        *len = 0;
        return NULL;
    }
    size_t total;
    b = JS_GetArrayBuffer(ctx, &total, ab);
    JS_FreeValue(ctx, ab);
    return b ? b + off : NULL;
}

// fetchRequest(host, port, head, body, headOnly, callback): the request's
// handle. `head` is the request line and headers (a string), `body` its
// bytes or null.
static JSValue js_fetch_request(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    int32_t port;
    if (JS_ToInt32(ctx, &port, argv[1]))
        return JS_EXCEPTION;
    const char *host = JS_ToCString(ctx, argv[0]);
    if (!host)
        return JS_EXCEPTION;
    size_t hl, bl;
    const char *ho, *bo;
    const uint8_t *head = bytes_of(ctx, argv[2], &hl, &ho);
    const uint8_t *bodyb = bytes_of(ctx, argv[3], &bl, &bo);
    uint32_t i = req_alloc();
    Req *r = reqs[i];
    snprintf(r->host, sizeof r->host, "%s", host);
    r->port = port;
    snprintf(r->key, sizeof r->key, "%s:%d", host, port);
    JS_FreeCString(ctx, host);
    r->out_len = hl + bl;
    r->out = malloc(r->out_len ? r->out_len : 1);
    if (hl)
        memcpy(r->out, head, hl);
    if (bl)
        memcpy(r->out + hl, bodyb, bl);
    if (ho)
        JS_FreeCString(ctx, ho);
    if (bo)
        JS_FreeCString(ctx, bo);
    r->head_only = JS_ToBool(ctx, argv[4]);
    r->cb = JS_DupValue(ctx, argv[5]);
    r->state = R_CONNECT;
    double h = handle_of(i);
    start(i);
    return JS_NewFloat64(ctx, h);
}

// fetchAbort(handle): the request ends with no more events (its connection
// closed).
static JSValue js_fetch_abort(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    double h;
    uint32_t i;
    if (JS_ToFloat64(ctx, &h, argv[0]))
        return JS_EXCEPTION;
    Req *r = req_of(h, &i);
    if (!r)
        return JS_FALSE;
    if (r->s && !us_socket_is_closed(r->s)) {
        ext_of(r->s)->req = -1;
        us_socket_close(r->s, 0, NULL);
    } else if (r->cs) {
        ((Ext *)us_connecting_socket_ext(r->cs))->req = -1;
        us_connecting_socket_close(r->cs);
    }
    r->s = NULL;
    r->cs = NULL;
    req_free(i);
    return JS_TRUE;
}

// fetchPause(handle, paused): stops (or resumes) reading the response.
static JSValue js_fetch_pause(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    double h;
    uint32_t i;
    if (JS_ToFloat64(ctx, &h, argv[0]))
        return JS_EXCEPTION;
    Req *r = req_of(h, &i);
    if (!r || !r->s || us_socket_is_closed(r->s))
        return JS_FALSE;
    if (JS_ToBool(ctx, argv[1]))
        us_socket_pause(r->s);
    else
        us_socket_resume(r->s);
    return JS_TRUE;
}

const JSCFunctionListEntry beyond_client_functions[] = {
    JS_CFUNC_DEF("fetchRequest", 6, js_fetch_request),
    JS_CFUNC_DEF("fetchAbort", 1, js_fetch_abort),
    JS_CFUNC_DEF("fetchPause", 2, js_fetch_pause),
};
const int beyond_client_function_count = sizeof beyond_client_functions / sizeof *beyond_client_functions;
