// fetch()'s HTTP client: HTTP/1.1 requests over Bun's uSockets, as Bun's
// client (src/http) does them, reduced; over TLS (OpenSSL, through memory
// BIOs on the plain socket) for https:. Each request gets a connection (an
// idle keep-alive one to the same host and port, else a new one), writes
// its bytes, and has the response parsed with picohttpparser: its head, then
// its body, unframed (Content-Length, chunked, or until the connection
// closes) and decoded (gzip, deflate, br, zstd). What happens is handed to
// the JavaScript handler `fetchInit` set, with the request's task:
// (task, HEAD, status, statusText, [name, value, ...]), (task, DATA,
// Uint8Array), (task, END), (task, ERROR, code, message), or, when the head
// and the whole body came together (most responses), (task, COMPLETE,
// status, statusText, [name, value, ...], ArrayBuffer), the connection back
// in the pool first.

#define _GNU_SOURCE
#include <arpa/inet.h>
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

#include <openssl/err.h>
#include <openssl/pem.h>
#include <openssl/ssl.h>
#include <openssl/x509v3.h>

#include "libusockets.h"
#include "picohttpparser.h"
#include "quickjs.h"
#include "zstd.h"

int beyond_js_run_jobs(void);
JSContext *beyond_js_context(void);
JSValue beyond_common_string(JSContext *ctx, const char *p, size_t n);
void beyond_js_report(void);
struct us_loop_t *uws_get_loop(void);

#define KIND_FETCH 40

enum { EV_HEAD = 1, EV_DATA = 2, EV_END = 3, EV_ERROR = 4, EV_COMPLETE = 5 };
enum { R_CONNECT, R_HEAD, R_BODY, R_DONE };
enum { ENC_NONE, ENC_GZIP, ENC_DEFLATE, ENC_BR, ENC_ZSTD };

#define KEY_MAX 600

typedef struct {
    uint32_t gen;
    bool live;
    JSValue task;
    struct us_socket_t *s;
    struct us_connecting_socket_t *cs;
    char host[256];
    int port;
    char key[KEY_MAX];
    // https: its TLS context (a reference), whether certificates are
    // checked, and the name to check (and send) if not the host.
    SSL_CTX *tls;
    bool reject;
    char servername[256];
    // The request's bytes, and how many are written (the buffers are kept
    // for the slot's next request).
    char *out;
    size_t out_len, out_off, out_cap;
    // Response bytes not parsed yet (the head; chunked framing).
    char *in;
    size_t in_len, in_cap;
    // While the head's bytes are read on: the body is collected rather than
    // handed over (one piece borrowed, `col_ptr`, or copies in `col`), and the
    // head kept until it is.
    bool collect;
    const uint8_t *col_ptr;
    uint8_t *col;
    size_t col_len, col_cap;
    int status;
    JSValue status_text, flat;
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

// The socket's ext: its request (-1 when idle in the pool), and over TLS
// its session, whether the handshake is done, and the ciphertext the socket
// has not taken yet.
typedef struct {
    int32_t req;
    SSL *ssl;
    bool handshaken;
    char *pend;
    size_t pend_len, pend_cap;
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
    char *out = r->out, *in = r->in;
    uint8_t *col = r->col;
    size_t out_cap = r->out_cap, in_cap = r->in_cap, col_cap = r->col_cap;
    memset(r, 0, sizeof *r);
    r->gen = gen;
    r->live = true;
    r->out = out, r->out_cap = out_cap;
    r->in = in, r->in_cap = in_cap;
    r->col = col, r->col_cap = col_cap;
    r->task = r->status_text = r->flat = JS_UNDEFINED;
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

// (Buffers past this are freed rather than kept for the next request.)
#define KEEP_BUFFER (64 * 1024)

static void req_free(uint32_t i) {
    Req *r = reqs[i];
    if (!r->live)
        return;
    r->task = r->status_text = r->flat = JS_UNDEFINED;
    if (r->tls) {
        SSL_CTX_free(r->tls);
        r->tls = NULL;
    }
    if (r->out_cap > KEEP_BUFFER) {
        free(r->out);
        r->out = NULL, r->out_cap = 0;
    }
    if (r->in_cap > KEEP_BUFFER) {
        free(r->in);
        r->in = NULL, r->in_cap = 0;
    }
    if (r->col_cap > KEEP_BUFFER) {
        free(r->col);
        r->col = NULL, r->col_cap = 0;
    }
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

// (task, type, ...) => void: fetch()'s, for every request.
static JSValue handler = JS_UNDEFINED;

void beyond_client_mark(JSRuntime *rt, JS_MarkFunc *mark_func) {
    JS_MarkValue(rt, handler, mark_func);
    for (uint32_t i = 0; i < nreqs; i++) {
        if (reqs[i]->live) {
            JS_MarkValue(rt, reqs[i]->task, mark_func);
            JS_MarkValue(rt, reqs[i]->status_text, mark_func);
            JS_MarkValue(rt, reqs[i]->flat, mark_func);
        }
    }
}

// Calls the handler with the request's task and argv (an event); false if
// the request is gone after it (the handler aborted it).
static bool emit(uint32_t i, int argc, JSValue *argv) {
    JSContext *ctx = beyond_js_context();
    Req *r = reqs[i];
    uint32_t gen = r->gen;
    JSValue args[6];
    args[0] = r->task;
    for (int k = 0; k < argc; k++)
        args[k + 1] = argv[k];
    JSValue res = JS_Call(ctx, handler, JS_UNDEFINED, argc + 1, args);
    if (JS_IsException(res))
        beyond_js_report();
    return i < nreqs && reqs[i]->live && reqs[i]->gen == gen;
}

static Ext *ext_of(struct us_socket_t *s) { return us_socket_ext(s); }

// What kind of failure an error is (its message is made in JavaScript, as
// Bun's are): one of the connection's or the response's, connecting,
// resolving the host, the TLS handshake, or the server's certificate.
enum { FAIL_OTHER = 0, FAIL_CONNECT = 1, FAIL_DNS = 2, FAIL_TLS = 3, FAIL_CERT = 4 };

// Ends the request with an error (the connection closed): ERROR, its code
// and kind.
static void fail(uint32_t i, const char *code, int kind) {
    JSContext *ctx = beyond_js_context();
    Req *r = reqs[i];
    struct us_socket_t *s = r->s;
    struct us_connecting_socket_t *cs = r->cs;
    r->s = NULL;
    r->cs = NULL;
    r->collect = false;
    if (s && !us_socket_is_closed(s)) {
        ext_of(s)->req = -1;
        us_socket_close(s, 0, NULL);
    } else if (cs) {
        ((Ext *)us_connecting_socket_ext(cs))->req = -1;
        us_connecting_socket_close(cs);
    }
    JSValue argv[3] = {JS_NewInt32(ctx, EV_ERROR), JS_NewString(ctx, code), JS_NewInt32(ctx, kind)};
    if (emit(i, 3, argv))
        req_free(i);
}

// What a response's bytes did: the request goes on, its response is
// complete (the body collected), or the request is gone (ended, failed or
// aborted).
enum { GO_ON, COMPLETE, GONE };

// The response is complete: the connection back to the pool (or closed),
// then END (unless the body is collected: the caller hands it over).
static int finish(uint32_t i) {
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
    if (r->collect)
        return COMPLETE;
    JSValue argv[1] = {JS_NewInt32(ctx, EV_END)};
    if (emit(i, 1, argv))
        req_free(i);
    return GONE;
}

static bool reserve(uint8_t **buf, size_t *cap, size_t need) {
    if (need <= *cap)
        return true;
    size_t c = need < 4096 ? 4096 : need * 2;
    uint8_t *b = realloc(*buf, c);
    if (!b)
        return false;
    *buf = b;
    *cap = c;
    return true;
}

// Hands the head over (HEAD), then what was collected of the body (DATA):
// from now on the body is handed over as it arrives. False if the request
// is gone.
static bool flush_head(uint32_t i) {
    JSContext *ctx = beyond_js_context();
    Req *r = reqs[i];
    r->collect = false;
    JSValue argv[4] = {JS_NewInt32(ctx, EV_HEAD), JS_NewInt32(ctx, r->status), r->status_text, r->flat};
    r->status_text = r->flat = JS_UNDEFINED;
    if (!emit(i, 4, argv))
        return false;
    size_t n = r->col_len;
    if (n == 0)
        return true;
    const uint8_t *p = r->col_ptr ? r->col_ptr : r->col;
    r->col_ptr = NULL;
    r->col_len = 0;
    JSValue data[2] = {JS_NewInt32(ctx, EV_DATA), JS_NewUint8ArrayCopy(ctx, p, n)};
    return emit(i, 2, data);
}

// (Collected past this, the head and the body so far are handed over.)
#define COLLECT_MAX (1 << 20)

// Body bytes, decoded: collected, or handed over (DATA). `borrow`: they stay
// valid until the response's bytes are done with. False if the request is
// gone.
static bool hand_over(uint32_t i, const uint8_t *data, size_t n, bool borrow) {
    JSContext *ctx = beyond_js_context();
    Req *r = reqs[i];
    if (r->collect) {
        if (r->col_len + n <= COLLECT_MAX) {
            if (r->col_len == 0 && borrow) {
                r->col_ptr = data;
                r->col_len = n;
                return true;
            }
            if (!reserve(&r->col, &r->col_cap, r->col_len + n)) {
                fail(i, "OutOfMemory", FAIL_OTHER);
                return false;
            }
            if (r->col_ptr) {
                memcpy(r->col, r->col_ptr, r->col_len);
                r->col_ptr = NULL;
            }
            memcpy(r->col + r->col_len, data, n);
            r->col_len += n;
            return true;
        }
        if (!flush_head(i))
            return false;
    }
    JSValue argv[2] = {JS_NewInt32(ctx, EV_DATA), JS_NewUint8ArrayCopy(ctx, data, n)};
    return emit(i, 2, argv);
}

// Body bytes: decoded, then handed over. False if the request is gone.
static bool deliver(uint32_t i, const uint8_t *data, size_t len, bool borrow) {
    Req *r = reqs[i];
    if (len == 0)
        return true;
    if (r->encoding == ENC_NONE)
        return hand_over(i, data, len, borrow);
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
            if (n > 0 && !hand_over(i, buf, n, false))
                return false;
            if (res == BROTLI_DECODER_RESULT_ERROR) {
                fail(i, "BrotliDecompressionError", FAIL_OTHER);
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
                fail(i, "ZstdDecompressionError", FAIL_OTHER);
                return false;
            }
            if (out.pos > 0 && !hand_over(i, buf, out.pos, false))
                return false;
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
        if (n > 0 && !hand_over(i, buf, n, false))
            return false;
        if (res == Z_STREAM_END)
            return true;
        if (res != Z_OK && res != Z_BUF_ERROR) {
            fail(i, "ZlibError", FAIL_OTHER);
            return false;
        }
        if (r->z.avail_in == 0 && r->z.avail_out != 0)
            return true;
    }
}

static bool header_is(const struct phr_header *h, const char *name, size_t n) {
    return h->name_len == n && !strncasecmp(h->name, name, n);
}

static bool value_has(const struct phr_header *h, const char *token) {
    size_t n = strlen(token);
    for (size_t k = 0; k + n <= h->value_len; k++)
        if (!strncasecmp(h->value + k, token, n))
            return true;
    return false;
}

// Body bytes: unframed, then delivered.
static int body(uint32_t i, char *data, size_t len) {
    Req *r = reqs[i];
    if (r->remaining >= 0) {
        size_t n = len < (uint64_t)r->remaining ? len : (size_t)r->remaining;
        r->remaining -= (int64_t)n;
        // (Bytes past the body: the connection is not reused.)
        if (n < len)
            r->keep_alive = false;
        if (!deliver(i, (uint8_t *)data, n, true))
            return GONE;
        if (reqs[i]->remaining == 0)
            return finish(i);
        return GO_ON;
    }
    if (r->remaining == -1)
        return deliver(i, (uint8_t *)data, len, true) ? GO_ON : GONE;
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
        fail(i, "ChunkedEncodingError", FAIL_OTHER);
        return GONE;
    }
    r->in_len = 0;
    if (!deliver(i, (uint8_t *)r->in, size, true))
        return GONE;
    if (rest >= 0)
        return finish(i);
    return GO_ON;
}

// The status line's text: shared when it is "OK".
static JSValue status_text(JSContext *ctx, const char *p, size_t n) {
    if (n == 2 && p[0] == 'O' && p[1] == 'K')
        return beyond_common_string(ctx, p, n);
    return JS_NewStringLen(ctx, p, n);
}

// Response bytes: the head (once complete), then body.
static void response_data(uint32_t i, char *data, size_t len) {
    JSContext *ctx = beyond_js_context();
    Req *r = reqs[i];
    r->got_bytes = true;
    if (r->state == R_BODY) {
        body(i, data, len);
        return;
    }
    // (Parsed where it is, unless part of the head came before.)
    char *buf = data;
    size_t buf_len = len;
    if (r->in_len) {
        if (r->in_len + len > r->in_cap) {
            r->in_cap = (r->in_len + len) * 2 + 1024;
            r->in = realloc(r->in, r->in_cap);
        }
        memcpy(r->in + r->in_len, data, len);
        r->in_len += len;
        buf = r->in;
        buf_len = r->in_len;
    }
    for (;;) {
        int minor, status;
        const char *msg;
        size_t msg_len, num_headers = 100;
        struct phr_header headers[100];
        int n = phr_parse_response(buf, buf_len, &minor, &status, &msg, &msg_len, headers, &num_headers, 0);
        if (n == -2) {
            if (buf_len > 256 * 1024) {
                fail(i, "ResponseHeadersTooLarge", FAIL_OTHER);
                return;
            }
            // (Kept until the rest of the head comes.)
            if (buf_len > r->in_cap) {
                r->in_cap = buf_len * 2 + 1024;
                r->in = realloc(r->in, r->in_cap);
            }
            memmove(r->in, buf, buf_len);
            r->in_len = buf_len;
            return;
        }
        if (n < 0) {
            fail(i, "Malformed_HTTP_Response", FAIL_OTHER);
            return;
        }
        // (1xx: the final response follows.)
        if (status >= 100 && status < 200 && status != 101) {
            buf += n;
            buf_len -= (size_t)n;
            r->in_len = 0;
            if (buf_len == 0)
                return;
            continue;
        }
        r->keep_alive = minor >= 1;
        r->remaining = -1;
        r->encoding = ENC_NONE;
        bool no_body = r->head_only || status == 204 || status == 205 || status == 304;
        JSValue values[200];
        int k = 0;
        for (size_t h = 0; h < num_headers; h++) {
            const struct phr_header *hd = &headers[h];
            if (!hd->name)
                continue;
            if (header_is(hd, "content-length", 14))
                r->remaining = strtoll(hd->value, NULL, 10);
            else if (header_is(hd, "transfer-encoding", 17) && value_has(hd, "chunked"))
                r->remaining = -2;
            else if (header_is(hd, "connection", 10))
                r->keep_alive = value_has(hd, "keep-alive") || (minor >= 1 && !value_has(hd, "close"));
            else if (header_is(hd, "content-encoding", 16)) {
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
            values[k++] = beyond_common_string(ctx, lower, nl);
            values[k++] = JS_NewStringLen(ctx, hd->value, hd->value_len);
        }
        r->status = status;
        r->status_text = status_text(ctx, msg, msg_len);
        r->flat = JS_NewArrayFrom(ctx, k, values);
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
        // The body that came with the head: collected, and handed over with
        // the head as one event if that is all of it.
        char *rest = buf + n;
        size_t rest_len = buf_len - (size_t)n;
        // (A copy when the head was kept: a chunked body reuses that buffer.)
        char *copy = NULL;
        if (buf != data && rest_len) {
            copy = malloc(rest_len);
            memcpy(copy, rest, rest_len);
            rest = copy;
        }
        r->in_len = 0;
        r->state = R_BODY;
        r->collect = true;
        r->col_ptr = NULL;
        r->col_len = 0;
        int st = r->remaining == 0 ? finish(i) : rest_len ? body(i, rest, rest_len) : GO_ON;
        if (st == COMPLETE) {
            const uint8_t *p = r->col_ptr ? r->col_ptr : r->col;
            JSValue argv[5] = {JS_NewInt32(ctx, EV_COMPLETE), JS_NewInt32(ctx, r->status), r->status_text, r->flat,
                               JS_NewArrayBufferCopy(ctx, p, r->col_len)};
            r->collect = false;
            r->col_ptr = NULL;
            r->col_len = 0;
            r->status_text = r->flat = JS_UNDEFINED;
            if (emit(i, 5, argv))
                req_free(i);
        } else if (st == GO_ON && r->collect) {
            flush_head(i);
        }
        free(copy);
        return;
    }
}

// ---- The connection's events ----

// ---- TLS ----

// Bun's bundled root certificates (vendor/bun-usockets/root_certs.der, as
// Bun embeds them): a u32 count, count + 1 u32 offsets, the DER
// certificates; little-endian.
extern const uint8_t BEYOND_ROOT_CERTS[];
extern const size_t BEYOND_ROOT_CERTS_LEN;

static uint32_t le32(const uint8_t *p) { return p[0] | p[1] << 8 | p[2] << 16 | (uint32_t)p[3] << 24; }

static void add_bundled_roots(X509_STORE *store) {
    const uint8_t *d = BEYOND_ROOT_CERTS;
    if (BEYOND_ROOT_CERTS_LEN < 4)
        return;
    uint32_t count = le32(d);
    const uint8_t *base = d + 4 + 4 * ((size_t)count + 1);
    for (uint32_t k = 0; k < count; k++) {
        uint32_t off = le32(d + 4 + 4 * k), end = le32(d + 8 + 4 * k);
        const uint8_t *p = base + off;
        X509 *x = d2i_X509(NULL, &p, end - off);
        if (x) {
            X509_STORE_add_cert(store, x);
            X509_free(x);
        }
    }
}

// The certificates of PEM text: how many were added.
static int add_pem(X509_STORE *store, const char *pem, size_t len) {
    BIO *b = BIO_new_mem_buf(pem, (int)len);
    int n = 0;
    X509 *x;
    while ((x = PEM_read_bio_X509(b, NULL, NULL, NULL))) {
        X509_STORE_add_cert(store, x);
        X509_free(x);
        n++;
    }
    ERR_clear_error();
    BIO_free(b);
    return n;
}

// NODE_EXTRA_CA_CERTS's file, added to the bundled roots (as Bun's).
static void add_extra_ca_file(X509_STORE *store) {
    const char *f = getenv("NODE_EXTRA_CA_CERTS");
    if (!f || !*f)
        return;
    FILE *fp = fopen(f, "rb");
    if (!fp) {
        fprintf(stderr, "Warning: ignoring extra certs from `%s`, load failed: %s\n", f, strerror(errno));
        return;
    }
    char *text = NULL;
    size_t len = 0, cap = 0, n;
    char chunk[65536];
    while ((n = fread(chunk, 1, sizeof chunk, fp)) > 0) {
        if (!reserve((uint8_t **)&text, &cap, len + n))
            break;
        memcpy(text + len, chunk, n);
        len += n;
    }
    fclose(fp);
    if (text)
        add_pem(store, text, len);
    free(text);
}

// TLS contexts: the default one (the bundled roots), and one for each
// recent `tls.ca` (its certificates alone, as Node's and Bun's `ca`).
// Each has an id, which the pool's keys name.
#define MAX_TLS_CTX 16
typedef struct {
    char *ca; // NULL: the default
    size_t ca_len;
    SSL_CTX *ctx;
    uint32_t id;
} TlsCtx;
static TlsCtx tls_ctxs[MAX_TLS_CTX];
static int ntls_ctxs, next_tls_ctx;
static uint32_t tls_ctx_ids;

// The context for `ca` (NULL: the default), a new reference; NULL if it
// cannot be made.
static SSL_CTX *tls_ctx(const char *ca, size_t ca_len, uint32_t *id) {
    for (int k = 0; k < ntls_ctxs; k++) {
        TlsCtx *t = &tls_ctxs[k];
        if ((ca == NULL) == (t->ca == NULL) && (!ca || (t->ca_len == ca_len && !memcmp(t->ca, ca, ca_len)))) {
            SSL_CTX_up_ref(t->ctx);
            *id = t->id;
            return t->ctx;
        }
    }
    SSL_CTX *ctx = SSL_CTX_new(TLS_client_method());
    if (!ctx)
        return NULL;
    X509_STORE *store = X509_STORE_new();
    if (ca) {
        add_pem(store, ca, ca_len);
    } else {
        add_bundled_roots(store);
        add_extra_ca_file(store);
    }
    SSL_CTX_set_cert_store(ctx, store);
    // (Checked after the handshake, as Bun does, for its errors.)
    SSL_CTX_set_verify(ctx, SSL_VERIFY_NONE, NULL);
    SSL_CTX_set_alpn_protos(ctx, (const unsigned char *)"\x08http/1.1", 9);
    // (The default context is kept for good; one of `ca` until 16 more
    // are made.)
    int k;
    if (ntls_ctxs < MAX_TLS_CTX) {
        k = ntls_ctxs++;
    } else {
        k = 1 + next_tls_ctx++ % (MAX_TLS_CTX - 1);
        SSL_CTX_free(tls_ctxs[k].ctx);
        free(tls_ctxs[k].ca);
    }
    TlsCtx *t = &tls_ctxs[k];
    t->ca = NULL;
    t->ca_len = ca_len;
    if (ca) {
        t->ca = malloc(ca_len ? ca_len : 1);
        memcpy(t->ca, ca, ca_len);
    }
    t->ctx = ctx;
    t->id = ++tls_ctx_ids;
    *id = t->id;
    SSL_CTX_up_ref(ctx);
    return ctx;
}

// The names Bun gives certificate errors (OpenSSL's X509_V_ERR_*).
static const char *cert_error_name(long v) {
    switch (v) {
    case X509_V_ERR_UNABLE_TO_GET_ISSUER_CERT: return "UNABLE_TO_GET_ISSUER_CERT";
    case X509_V_ERR_UNABLE_TO_GET_CRL: return "UNABLE_TO_GET_CRL";
    case X509_V_ERR_UNABLE_TO_DECRYPT_CERT_SIGNATURE: return "UNABLE_TO_DECRYPT_CERT_SIGNATURE";
    case X509_V_ERR_UNABLE_TO_DECRYPT_CRL_SIGNATURE: return "UNABLE_TO_DECRYPT_CRL_SIGNATURE";
    case X509_V_ERR_UNABLE_TO_DECODE_ISSUER_PUBLIC_KEY: return "UNABLE_TO_DECODE_ISSUER_PUBLIC_KEY";
    case X509_V_ERR_CERT_SIGNATURE_FAILURE: return "CERT_SIGNATURE_FAILURE";
    case X509_V_ERR_CRL_SIGNATURE_FAILURE: return "CRL_SIGNATURE_FAILURE";
    case X509_V_ERR_CERT_NOT_YET_VALID: return "CERT_NOT_YET_VALID";
    case X509_V_ERR_CERT_HAS_EXPIRED: return "CERT_HAS_EXPIRED";
    case X509_V_ERR_CRL_NOT_YET_VALID: return "CRL_NOT_YET_VALID";
    case X509_V_ERR_CRL_HAS_EXPIRED: return "CRL_HAS_EXPIRED";
    case X509_V_ERR_ERROR_IN_CERT_NOT_BEFORE_FIELD: return "ERROR_IN_CERT_NOT_BEFORE_FIELD";
    case X509_V_ERR_ERROR_IN_CERT_NOT_AFTER_FIELD: return "ERROR_IN_CERT_NOT_AFTER_FIELD";
    case X509_V_ERR_ERROR_IN_CRL_LAST_UPDATE_FIELD: return "ERROR_IN_CRL_LAST_UPDATE_FIELD";
    case X509_V_ERR_ERROR_IN_CRL_NEXT_UPDATE_FIELD: return "ERROR_IN_CRL_NEXT_UPDATE_FIELD";
    case X509_V_ERR_OUT_OF_MEM: return "OUT_OF_MEM";
    case X509_V_ERR_DEPTH_ZERO_SELF_SIGNED_CERT: return "DEPTH_ZERO_SELF_SIGNED_CERT";
    case X509_V_ERR_SELF_SIGNED_CERT_IN_CHAIN: return "SELF_SIGNED_CERT_IN_CHAIN";
    case X509_V_ERR_UNABLE_TO_GET_ISSUER_CERT_LOCALLY: return "UNABLE_TO_GET_ISSUER_CERT_LOCALLY";
    case X509_V_ERR_UNABLE_TO_VERIFY_LEAF_SIGNATURE: return "UNABLE_TO_VERIFY_LEAF_SIGNATURE";
    case X509_V_ERR_CERT_CHAIN_TOO_LONG: return "CERT_CHAIN_TOO_LONG";
    case X509_V_ERR_CERT_REVOKED: return "CERT_REVOKED";
    case X509_V_ERR_INVALID_CA: return "INVALID_CA";
    case X509_V_ERR_PATH_LENGTH_EXCEEDED: return "PATH_LENGTH_EXCEEDED";
    case X509_V_ERR_INVALID_PURPOSE: return "INVALID_PURPOSE";
    case X509_V_ERR_CERT_UNTRUSTED: return "CERT_UNTRUSTED";
    case X509_V_ERR_CERT_REJECTED: return "CERT_REJECTED";
    case X509_V_ERR_SUBJECT_ISSUER_MISMATCH: return "SUBJECT_ISSUER_MISMATCH";
    case X509_V_ERR_AKID_SKID_MISMATCH: return "AKID_SKID_MISMATCH";
    case X509_V_ERR_AKID_ISSUER_SERIAL_MISMATCH: return "AKID_ISSUER_SERIAL_MISMATCH";
    case X509_V_ERR_KEYUSAGE_NO_CERTSIGN: return "KEYUSAGE_NO_CERTSIGN";
    case X509_V_ERR_UNABLE_TO_GET_CRL_ISSUER: return "UNABLE_TO_GET_CRL_ISSUER";
    case X509_V_ERR_UNHANDLED_CRITICAL_EXTENSION: return "UNHANDLED_CRITICAL_EXTENSION";
    case X509_V_ERR_KEYUSAGE_NO_CRL_SIGN: return "KEYUSAGE_NO_CRL_SIGN";
    case X509_V_ERR_UNHANDLED_CRITICAL_CRL_EXTENSION: return "UNHANDLED_CRITICAL_CRL_EXTENSION";
    case X509_V_ERR_INVALID_NON_CA: return "INVALID_NON_CA";
    case X509_V_ERR_PROXY_PATH_LENGTH_EXCEEDED: return "PROXY_PATH_LENGTH_EXCEEDED";
    case X509_V_ERR_KEYUSAGE_NO_DIGITAL_SIGNATURE: return "KEYUSAGE_NO_DIGITAL_SIGNATURE";
    case X509_V_ERR_PROXY_CERTIFICATES_NOT_ALLOWED: return "PROXY_CERTIFICATES_NOT_ALLOWED";
    case X509_V_ERR_INVALID_EXTENSION: return "INVALID_EXTENSION";
    case X509_V_ERR_INVALID_POLICY_EXTENSION: return "INVALID_POLICY_EXTENSION";
    case X509_V_ERR_NO_EXPLICIT_POLICY: return "NO_EXPLICIT_POLICY";
    case X509_V_ERR_DIFFERENT_CRL_SCOPE: return "DIFFERENT_CRL_SCOPE";
    case X509_V_ERR_UNSUPPORTED_EXTENSION_FEATURE: return "UNSUPPORTED_EXTENSION_FEATURE";
    case X509_V_ERR_UNNESTED_RESOURCE: return "UNNESTED_RESOURCE";
    case X509_V_ERR_PERMITTED_VIOLATION: return "PERMITTED_VIOLATION";
    case X509_V_ERR_EXCLUDED_VIOLATION: return "EXCLUDED_VIOLATION";
    case X509_V_ERR_SUBTREE_MINMAX: return "SUBTREE_MINMAX";
    case X509_V_ERR_APPLICATION_VERIFICATION: return "APPLICATION_VERIFICATION";
    case X509_V_ERR_UNSUPPORTED_CONSTRAINT_TYPE: return "UNSUPPORTED_CONSTRAINT_TYPE";
    case X509_V_ERR_UNSUPPORTED_CONSTRAINT_SYNTAX: return "UNSUPPORTED_CONSTRAINT_SYNTAX";
    case X509_V_ERR_UNSUPPORTED_NAME_SYNTAX: return "UNSUPPORTED_NAME_SYNTAX";
    case X509_V_ERR_CRL_PATH_VALIDATION_ERROR: return "CRL_PATH_VALIDATION_ERROR";
    case X509_V_ERR_SUITE_B_INVALID_VERSION: return "SUITE_B_INVALID_VERSION";
    case X509_V_ERR_SUITE_B_INVALID_ALGORITHM: return "SUITE_B_INVALID_ALGORITHM";
    case X509_V_ERR_SUITE_B_INVALID_CURVE: return "SUITE_B_INVALID_CURVE";
    case X509_V_ERR_SUITE_B_INVALID_SIGNATURE_ALGORITHM: return "SUITE_B_INVALID_SIGNATURE_ALGORITHM";
    case X509_V_ERR_SUITE_B_LOS_NOT_ALLOWED: return "SUITE_B_LOS_NOT_ALLOWED";
    case X509_V_ERR_SUITE_B_CANNOT_SIGN_P_384_WITH_P_256: return "SUITE_B_CANNOT_SIGN_P_384_WITH_P_256";
    case X509_V_ERR_EMAIL_MISMATCH: return "EMAIL_MISMATCH";
    case X509_V_ERR_IP_ADDRESS_MISMATCH: return "IP_ADDRESS_MISMATCH";
    case X509_V_ERR_INVALID_CALL: return "INVALID_CALL";
    case X509_V_ERR_STORE_LOOKUP: return "STORE_LOOKUP";
    default: return "UNKNOWN_CERTIFICATE_VERIFICATION_ERROR";
    }
}

static bool is_ip(const char *name) {
    unsigned char buf[16];
    return inet_pton(AF_INET, name, buf) == 1 || inet_pton(AF_INET6, name, buf) == 1;
}

// After the handshake: NULL if the server's certificate is good for the
// request (or not checked), else the error's code (Bun checks the chain,
// then the name).
static const char *tls_check(Req *r, SSL *ssl, int *kind) {
    if (!r->reject)
        return NULL;
    *kind = FAIL_CERT;
    long v = SSL_get_verify_result(ssl);
    // (A certificate sent alone whose issuer is unknown: BoringSSL's error,
    // as Bun reports it, where OpenSSL 3 reports the issuer missing.)
    if (v == X509_V_ERR_UNABLE_TO_GET_ISSUER_CERT_LOCALLY) {
        STACK_OF(X509) *chain = SSL_get_peer_cert_chain(ssl);
        if (chain && sk_X509_num(chain) == 1)
            v = X509_V_ERR_UNABLE_TO_VERIFY_LEAF_SIGNATURE;
    }
    if (v != X509_V_OK)
        return cert_error_name(v);
    X509 *cert = SSL_get1_peer_certificate(ssl);
    if (!cert)
        return cert_error_name(X509_V_ERR_UNABLE_TO_GET_ISSUER_CERT_LOCALLY);
    const char *name = r->servername[0] ? r->servername : r->host;
    int ok = is_ip(name) ? X509_check_ip_asc(cert, name, 0) : X509_check_host(cert, name, strlen(name), 0, NULL);
    X509_free(cert);
    if (ok == 1)
        return NULL;
    *kind = FAIL_OTHER;
    return "ERR_TLS_CERT_ALTNAME_INVALID";
}

// Writes the ciphertext the session has made (and what the socket did not
// take before) to the socket, keeping what it does not take.
static void tls_flush(struct us_socket_t *s) {
    Ext *e = ext_of(s);
    BIO *wb = SSL_get_wbio(e->ssl);
    size_t pending = BIO_ctrl_pending(wb);
    if (pending && reserve((uint8_t **)&e->pend, &e->pend_cap, e->pend_len + pending)) {
        int n = BIO_read(wb, e->pend + e->pend_len, (int)pending);
        if (n > 0)
            e->pend_len += (size_t)n;
    }
    size_t off = 0;
    while (off < e->pend_len) {
        int n = us_socket_write(s, e->pend + off, (int)(e->pend_len - off));
        if (n <= 0)
            break;
        off += (size_t)n;
    }
    if (off) {
        memmove(e->pend, e->pend + off, e->pend_len - off);
        e->pend_len -= off;
    }
}

static void write_out(uint32_t i);

// Goes on with the handshake of request i's connection: true once it is
// done and the certificate good (false: wait, or the request failed).
static bool tls_handshake(uint32_t i, struct us_socket_t *s) {
    Ext *e = ext_of(s);
    int rc = SSL_do_handshake(e->ssl);
    tls_flush(s);
    if (rc == 1) {
        e->handshaken = true;
        int kind;
        const char *bad = tls_check(reqs[i], e->ssl, &kind);
        if (bad) {
            fail(i, bad, kind);
            return false;
        }
        return true;
    }
    int err = SSL_get_error(e->ssl, rc);
    if (err == SSL_ERROR_WANT_READ || err == SSL_ERROR_WANT_WRITE)
        return false;
    ERR_clear_error();
    fail(i, "EPROTO", FAIL_TLS);
    return false;
}

// A new connection of request i: its TLS session, and the handshake begun.
static void tls_begin(uint32_t i, struct us_socket_t *s) {
    Req *r = reqs[i];
    Ext *e = ext_of(s);
    SSL *ssl = SSL_new(r->tls);
    if (!ssl) {
        fail(i, "EPROTO", FAIL_TLS);
        return;
    }
    SSL_set_bio(ssl, BIO_new(BIO_s_mem()), BIO_new(BIO_s_mem()));
    SSL_set_connect_state(ssl);
    const char *name = r->servername[0] ? r->servername : r->host;
    if (!is_ip(name))
        SSL_set_tlsext_host_name(ssl, name);
    e->ssl = ssl;
    e->handshaken = false;
    if (tls_handshake(i, s))
        write_out(i);
}

static void lost(uint32_t i);

// Ciphertext that came: the handshake's, then the response's plaintext.
static void tls_data(struct us_socket_t *s, char *data, int length) {
    Ext *e = ext_of(s);
    BIO_write(SSL_get_rbio(e->ssl), data, length);
    if (!e->handshaken) {
        int32_t i = e->req;
        if (i < 0 || (uint32_t)i >= nreqs || !reqs[i]->live || reqs[i]->s != s) {
            us_socket_close(s, 0, NULL);
            return;
        }
        if (!tls_handshake((uint32_t)i, s))
            return;
        write_out((uint32_t)i);
        if (us_socket_is_closed(s))
            return;
    }
    char buf[16384];
    for (;;) {
        int n = SSL_read(e->ssl, buf, sizeof buf);
        if (n > 0) {
            int32_t i = e->req;
            if (i < 0) {
                // (An idle connection the server wrote to: not reusable.)
                us_socket_close(s, 0, NULL);
                return;
            }
            if ((uint32_t)i < nreqs && reqs[i]->live && reqs[i]->s == s)
                response_data((uint32_t)i, buf, (size_t)n);
            // (The response may have closed it, or the program.)
            if (us_socket_is_closed(s))
                return;
            continue;
        }
        if (SSL_get_error(e->ssl, n) == SSL_ERROR_WANT_READ)
            break;
        // (The server closed the session, or it failed: the connection is
        // done.)
        ERR_clear_error();
        int32_t i = e->req;
        e->req = -1;
        idle_remove(s);
        us_socket_close(s, 0, NULL);
        if (i >= 0 && (uint32_t)i < nreqs && reqs[i]->live && reqs[i]->s == s)
            lost((uint32_t)i);
        return;
    }
    tls_flush(s);
}

// ---- The connection's events ----

static void write_out(uint32_t i) {
    Req *r = reqs[i];
    Ext *e = ext_of(r->s);
    if (e->ssl) {
        if (!e->handshaken)
            return;
        // (A memory BIO takes it all.)
        if (r->out_off < r->out_len) {
            SSL_write(e->ssl, r->out + r->out_off, (int)(r->out_len - r->out_off));
            r->out_off = r->out_len;
        }
        tls_flush(r->s);
    } else {
        while (r->out_off < r->out_len) {
            int n = us_socket_write(r->s, r->out + r->out_off, (int)(r->out_len - r->out_off));
            if (n <= 0)
                return;
            r->out_off += (size_t)n;
        }
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
    if (r->tls)
        tls_begin((uint32_t)i, s);
    else
        write_out((uint32_t)i);
    return s;
}

static struct us_socket_t *on_writable(struct us_socket_t *s) {
    Ext *e = ext_of(s);
    int32_t i = e->req;
    if (e->ssl) {
        tls_flush(s);
        return s;
    }
    if (i >= 0 && (uint32_t)i < nreqs && reqs[i]->live && reqs[i]->s == s)
        write_out((uint32_t)i);
    return s;
}

static struct us_socket_t *on_data(struct us_socket_t *s, char *data, int length) {
    if (ext_of(s)->ssl) {
        tls_data(s, data, length);
        return s;
    }
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
    fail(i, "ECONNRESET", FAIL_OTHER);
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
    Ext *e = ext_of(s);
    int32_t i = e->req;
    e->req = -1;
    idle_remove(s);
    if (e->ssl) {
        SSL_free(e->ssl);
        e->ssl = NULL;
    }
    free(e->pend);
    e->pend = NULL;
    e->pend_len = e->pend_cap = 0;
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
    if (dns_error) {
        fail(i, "ENOTFOUND", FAIL_DNS);
        return;
    }
    // (As Bun's: the code is the connect error's name.)
    const char *name = code ? strerrorname_np(code) : NULL;
    fail(i, name ? name : "ECONNREFUSED", FAIL_CONNECT);
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
            // (As Bun's: what the server sent since the loop last polled, or
            // its closing the connection, makes it unusable.)
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
    Ext *e = is_connecting ? ext_of(c) : us_connecting_socket_ext(c);
    memset(e, 0, sizeof *e);
    e->req = (int32_t)i;
    if (!is_connecting)
        r->cs = c;
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

// fetchInit(handler): the function every request's events are handed to,
// with its task.
static JSValue js_fetch_init(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    handler = JS_DupValue(ctx, argv[0]);
    return JS_UNDEFINED;
}

// fetchRequest(task, host, port, head, body, headOnly, tls): the request's
// handle. `head` is the request line and headers (a string or bytes), `body`
// its bytes or null; `tls` null for http:, else { ca (PEM text, or null for
// the bundled roots), reject (whether to check the certificate), servername
// (or null) }.
static JSValue js_fetch_request(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    int32_t port;
    if (JS_ToInt32(ctx, &port, argv[2]))
        return JS_EXCEPTION;
    size_t host_len;
    const char *host = JS_ToCStringLen(ctx, &host_len, argv[1]);
    if (!host)
        return JS_EXCEPTION;
    size_t hl, bl;
    const char *ho, *bo;
    const uint8_t *head = bytes_of(ctx, argv[3], &hl, &ho);
    const uint8_t *bodyb = bytes_of(ctx, argv[4], &bl, &bo);
    uint32_t i = req_alloc();
    Req *r = reqs[i];
    size_t n = host_len < sizeof r->host - 1 ? host_len : sizeof r->host - 1;
    memcpy(r->host, host, n);
    r->host[n] = 0;
    r->port = port;
    JS_FreeCString(ctx, host);
    r->out_len = hl + bl;
    bool room = reserve((uint8_t **)&r->out, &r->out_cap, r->out_len ? r->out_len : 1);
    if (room && hl)
        memcpy(r->out, head, hl);
    if (room && bl)
        memcpy(r->out + hl, bodyb, bl);
    if (ho)
        JS_FreeCString(ctx, ho);
    if (bo)
        JS_FreeCString(ctx, bo);
    if (!room) {
        req_free(i);
        return JS_ThrowOutOfMemory(ctx);
    }
    // The pool's key: host:port, and for TLS its context, whether the
    // certificate is checked and the server name.
    size_t k = 0;
    if (JS_IsObject(argv[6])) {
        JSValue ca = JS_GetPropertyStr(ctx, argv[6], "ca");
        JSValue reject = JS_GetPropertyStr(ctx, argv[6], "reject");
        JSValue servername = JS_GetPropertyStr(ctx, argv[6], "servername");
        size_t ca_len = 0;
        const char *ca_text = JS_IsString(ca) ? JS_ToCStringLen(ctx, &ca_len, ca) : NULL;
        uint32_t id = 0;
        r->tls = tls_ctx(ca_text, ca_len, &id);
        if (ca_text)
            JS_FreeCString(ctx, ca_text);
        // (Unset: checked, unless NODE_TLS_REJECT_UNAUTHORIZED is 0.)
        if (JS_IsUndefined(reject)) {
            const char *env = getenv("NODE_TLS_REJECT_UNAUTHORIZED");
            r->reject = !(env && !strcmp(env, "0"));
        } else {
            r->reject = JS_ToBool(ctx, reject);
        }
        if (JS_IsString(servername)) {
            const char *sn = JS_ToCString(ctx, servername);
            if (sn) {
                snprintf(r->servername, sizeof r->servername, "%s", sn);
                JS_FreeCString(ctx, sn);
            }
        }
        if (!r->tls) {
            req_free(i);
            return JS_ThrowInternalError(ctx, "TLS is not available");
        }
        k = (size_t)snprintf(r->key, KEY_MAX - 300, "tls %u %d %s ", id, r->reject, r->servername);
    }
    char digits[12];
    int nd = 0;
    for (uint32_t v = (uint32_t)port; nd == 0 || v; v /= 10)
        digits[nd++] = (char)('0' + v % 10);
    memcpy(r->key + k, r->host, n);
    k += n;
    r->key[k++] = ':';
    for (int d = 0; d < nd; d++)
        r->key[k++] = digits[nd - 1 - d];
    r->key[k] = 0;
    r->task = JS_DupValue(ctx, argv[0]);
    r->head_only = JS_ToBool(ctx, argv[5]);
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
    JS_CFUNC_DEF("fetchInit", 1, js_fetch_init),
    JS_CFUNC_DEF("fetchRequest", 7, js_fetch_request),
    JS_CFUNC_DEF("fetchAbort", 1, js_fetch_abort),
    JS_CFUNC_DEF("fetchPause", 2, js_fetch_pause),
};
const int beyond_client_function_count = sizeof beyond_client_functions / sizeof *beyond_client_functions;
