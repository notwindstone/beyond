// The native parts of web APIs: text encoding (TextEncoder, TextDecoder;
// the UTF-8 itself is in Rust, src/encoding.rs) and random numbers
// (crypto.getRandomValues, crypto.randomUUID).

#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <inttypes.h>
#include <string.h>
#include <sys/random.h>
#include <unistd.h>

#include "quickjs.h"

void beyond_rt_wtf8_fix(uint8_t *p, size_t len);
size_t beyond_rt_utf8_valid(const uint8_t *p, size_t len, size_t *error_len);
size_t beyond_rt_utf8_lossy(const uint8_t *p, size_t len, uint8_t *out);

// The bytes of an ArrayBuffer, or of the part of one a typed array views:
// 0, or -1 with an exception.
static int bytes_of(JSContext *c, JSValueConst v, uint8_t **p, size_t *len) {
    if (JS_IsArrayBuffer(v)) {
        *p = JS_GetArrayBuffer(c, len, v);
        return *p || !JS_HasException(c) ? 0 : -1;
    }
    if (JS_GetTypedArrayType(v) < 0) {
        JS_ThrowTypeError(c, "expected an ArrayBuffer or a typed array");
        return -1;
    }
    size_t off, bpe, total;
    JSValue ab = JS_GetTypedArrayBuffer(c, v, &off, len, &bpe);
    if (JS_IsException(ab))
        return -1;
    uint8_t *base = JS_GetArrayBuffer(c, &total, ab);
    JS_FreeValue(c, ab);
    if (!base && JS_HasException(c))
        return -1;
    *p = base ? base + off : NULL;
    return 0;
}

// encodeUtf8(string): a Uint8Array of its UTF-8 (lone surrogates as
// U+FFFD), as TextEncoder's `encode`.
static JSValue js_encode_utf8(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    size_t len;
    const char *s = JS_ToCStringLen(c, &len, argv[0]);
    if (!s)
        return JS_EXCEPTION;
    JSValue r = JS_NewUint8ArrayCopy(c, (const uint8_t *)s, len);
    JS_FreeCString(c, s);
    if (JS_IsException(r))
        return r;
    uint8_t *p;
    if (bytes_of(c, r, &p, &len) == 0)
        beyond_rt_wtf8_fix(p, len);
    return r;
}

// encodeUtf8Into(string, Uint8Array): as much of the string's UTF-8 as fits
// (whole characters), as TextEncoder's `encodeInto`: { read, written }.
static JSValue js_encode_utf8_into(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    uint8_t *d;
    size_t cap, len;
    if (bytes_of(c, argv[1], &d, &cap))
        return JS_EXCEPTION;
    const char *s = JS_ToCStringLen(c, &len, argv[0]);
    if (!s)
        return JS_EXCEPTION;
    size_t i = 0, units = 0;
    while (i < len) {
        uint8_t b = (uint8_t)s[i];
        size_t n = b < 0x80 ? 1 : b < 0xE0 ? 2 : b < 0xF0 ? 3 : 4;
        if (i + n > cap)
            break;
        i += n;
        units += n == 4 ? 2 : 1;
    }
    if (i)
        memcpy(d, s, i);
    JS_FreeCString(c, s);
    beyond_rt_wtf8_fix(d, i);
    JSValue r = JS_NewObject(c);
    if (JS_IsException(r))
        return r;
    JS_SetPropertyStr(c, r, "read", JS_NewInt64(c, (int64_t)units));
    JS_SetPropertyStr(c, r, "written", JS_NewInt64(c, (int64_t)i));
    return r;
}

// decodeUtf8(bytes, fatal): the string of UTF-8 bytes (an ArrayBuffer or a
// typed array), invalid sequences as U+FFFD, or, if `fatal`, a TypeError.
static JSValue js_decode_utf8(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    uint8_t *p;
    size_t len, err;
    if (bytes_of(c, argv[0], &p, &len))
        return JS_EXCEPTION;
    if (len == 0)
        return JS_NewStringLen(c, "", 0);
    if (beyond_rt_utf8_valid(p, len, &err) == len)
        return JS_NewStringLen(c, (const char *)p, len);
    if (argc > 1 && JS_ToBool(c, argv[1]))
        return JS_ThrowTypeError(c, "The encoded data was not valid for encoding utf-8");
    uint8_t *out = js_malloc(c, 3 * len);
    if (!out)
        return JS_EXCEPTION;
    size_t n = beyond_rt_utf8_lossy(p, len, out);
    JSValue r = JS_NewStringLen(c, (const char *)out, n);
    js_free(c, out);
    return r;
}

// ---- Random numbers ----

// From the kernel (getrandom), through a buffer: bytes handed out are
// cleared from it.
static uint8_t pool[4096];
static size_t pool_left;

static int kernel_random(uint8_t *p, size_t n) {
    while (n) {
        ssize_t k = getrandom(p, n, 0);
        if (k < 0) {
            if (errno == EINTR)
                continue;
            return -1;
        }
        p += k;
        n -= (size_t)k;
    }
    return 0;
}

static int random_bytes(uint8_t *p, size_t n) {
    if (n > sizeof pool / 2)
        return kernel_random(p, n);
    while (n) {
        if (!pool_left) {
            if (kernel_random(pool, sizeof pool))
                return -1;
            pool_left = sizeof pool;
        }
        size_t k = n < pool_left ? n : pool_left;
        uint8_t *src = pool + sizeof pool - pool_left;
        memcpy(p, src, k);
        memset(src, 0, k);
        pool_left -= k;
        p += k;
        n -= k;
    }
    return 0;
}

// randomFill(typedArray): fills it with random bytes.
static JSValue js_random_fill(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    uint8_t *p;
    size_t len;
    if (bytes_of(c, argv[0], &p, &len))
        return JS_EXCEPTION;
    if (len && random_bytes(p, len))
        return JS_ThrowInternalError(c, "getrandom failed: %s", strerror(errno));
    return JS_UNDEFINED;
}

// randomUUID(): a version 4 UUID.
static JSValue js_random_uuid(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    static const char hex[] = "0123456789abcdef";
    uint8_t b[16];
    char s[36];
    if (random_bytes(b, sizeof b))
        return JS_ThrowInternalError(c, "getrandom failed: %s", strerror(errno));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    for (int i = 0, j = 0; i < 16; i++) {
        if (i == 4 || i == 6 || i == 8 || i == 10)
            s[j++] = '-';
        s[j++] = hex[b[i] >> 4];
        s[j++] = hex[b[i] & 15];
    }
    return JS_NewStringLen(c, s, sizeof s);
}

// randomUUIDv7(ms): a version 7 UUID of Unix time `ms` (its first 48 bits),
// the rest random, as Bun.randomUUIDv7's.
static JSValue js_random_uuid_v7(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    static const char hex[] = "0123456789abcdef";
    uint8_t b[16];
    char s[36];
    double ms;
    if (JS_ToFloat64(c, &ms, argv[0]))
        return JS_EXCEPTION;
    if (random_bytes(b, sizeof b))
        return JS_ThrowInternalError(c, "getrandom failed: %s", strerror(errno));
    uint64_t t = ms > 0 ? (uint64_t)ms : 0;
    for (int i = 0; i < 6; i++)
        b[i] = (uint8_t)(t >> (40 - 8 * i));
    b[6] = (b[6] & 0x0f) | 0x70;
    b[8] = (b[8] & 0x3f) | 0x80;
    for (int i = 0, j = 0; i < 16; i++) {
        if (i == 4 || i == 6 || i == 8 || i == 10)
            s[j++] = '-';
        s[j++] = hex[b[i] >> 4];
        s[j++] = hex[b[i] & 15];
    }
    return JS_NewStringLen(c, s, sizeof s);
}

// ---- xxHash64 (seed 0): the etags of static routes, as Bun's ----

#define XXH_P1 0x9E3779B185EBCA87ULL
#define XXH_P2 0xC2B2AE3D27D4EB4FULL
#define XXH_P3 0x165667B19E3779F9ULL
#define XXH_P4 0x85EBCA77C2B2AE63ULL
#define XXH_P5 0x27D4EB2F165667C5ULL

static inline uint64_t xxh_rotl(uint64_t x, int r) { return (x << r) | (x >> (64 - r)); }
static inline uint64_t xxh_read64(const uint8_t *p) { uint64_t v; memcpy(&v, p, 8); return v; }
static inline uint32_t xxh_read32(const uint8_t *p) { uint32_t v; memcpy(&v, p, 4); return v; }
static inline uint64_t xxh_round(uint64_t acc, uint64_t in) {
    return xxh_rotl(acc + in * XXH_P2, 31) * XXH_P1;
}
static inline uint64_t xxh_merge(uint64_t acc, uint64_t v) {
    return (acc ^ xxh_round(0, v)) * XXH_P1 + XXH_P4;
}

static uint64_t xxh64(const uint8_t *p, size_t len) {
    const uint8_t *end = p + len;
    uint64_t h;
    if (len >= 32) {
        uint64_t v1 = XXH_P1 + XXH_P2, v2 = XXH_P2, v3 = 0, v4 = -XXH_P1;
        do {
            v1 = xxh_round(v1, xxh_read64(p));
            v2 = xxh_round(v2, xxh_read64(p + 8));
            v3 = xxh_round(v3, xxh_read64(p + 16));
            v4 = xxh_round(v4, xxh_read64(p + 24));
            p += 32;
        } while (p + 32 <= end);
        h = xxh_rotl(v1, 1) + xxh_rotl(v2, 7) + xxh_rotl(v3, 12) + xxh_rotl(v4, 18);
        h = xxh_merge(h, v1);
        h = xxh_merge(h, v2);
        h = xxh_merge(h, v3);
        h = xxh_merge(h, v4);
    } else {
        h = XXH_P5;
    }
    h += len;
    for (; p + 8 <= end; p += 8)
        h = xxh_rotl(h ^ xxh_round(0, xxh_read64(p)), 27) * XXH_P1 + XXH_P4;
    if (p + 4 <= end) {
        h = xxh_rotl(h ^ (uint64_t)xxh_read32(p) * XXH_P1, 23) * XXH_P2 + XXH_P3;
        p += 4;
    }
    for (; p < end; p++)
        h = xxh_rotl(h ^ *p * XXH_P5, 11) * XXH_P1;
    h ^= h >> 33;
    h *= XXH_P2;
    h ^= h >> 29;
    h *= XXH_P3;
    h ^= h >> 32;
    return h;
}

// xxh64Hex(value): the xxHash64 of a string's UTF-8 or of bytes (an
// ArrayBuffer or a view), in lowercase hex.
static JSValue js_xxh64_hex(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    char out[17];
    uint64_t h;
    if (JS_IsString(argv[0])) {
        size_t len;
        const char *s = JS_ToCStringLen(c, &len, argv[0]);
        if (!s)
            return JS_EXCEPTION;
        h = xxh64((const uint8_t *)s, len);
        JS_FreeCString(c, s);
    } else {
        size_t len = 0, off = 0, bpe;
        uint8_t *b = JS_GetArrayBuffer(c, &len, argv[0]);
        if (!b) {
            JS_FreeValue(c, JS_GetException(c));
            JSValue ab = JS_GetTypedArrayBuffer(c, argv[0], &off, &len, &bpe);
            if (JS_IsException(ab))
                return ab;
            size_t total;
            b = JS_GetArrayBuffer(c, &total, ab);
            JS_FreeValue(c, ab);
            if (!b)
                return JS_EXCEPTION;
            b += off;
        }
        h = xxh64(b, len);
    }
    snprintf(out, sizeof out, "%" PRIx64, h);
    return JS_NewString(c, out);
}

// gc(): a full collection.
static JSValue js_gc(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    JS_RunGC(JS_GetRuntime(c));
    return JS_UNDEFINED;
}

// ---- The console's output ----

// Standard output is buffered (flushed before the event loop waits, before
// anything goes to standard error, and at exit), unless it is a terminal.
static int stdout_tty = -1;

void beyond_flush_stdout(void) { fflush(stdout); }

// writeOut(fd, string): the string's UTF-8 (lone surrogates as U+FFFD) to
// standard output (1) or standard error (2).
static JSValue js_write_out(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    int32_t fd;
    size_t len;
    if (JS_ToInt32(c, &fd, argv[0]))
        return JS_EXCEPTION;
    const char *s = JS_ToCStringLen(c, &len, argv[1]);
    if (!s)
        return JS_EXCEPTION;
    const char *data = s;
    char *copy = NULL;
    if (memchr(s, 0xED, len)) {
        copy = malloc(len);
        if (copy) {
            memcpy(copy, s, len);
            beyond_rt_wtf8_fix((uint8_t *)copy, len);
            data = copy;
        }
    }
    if (fd == 2) {
        fflush(stdout);
        fwrite(data, 1, len, stderr);
    } else {
        if (stdout_tty < 0)
            stdout_tty = isatty(1);
        fwrite(data, 1, len, stdout);
        if (stdout_tty)
            fflush(stdout);
    }
    free(copy);
    JS_FreeCString(c, s);
    return JS_UNDEFINED;
}

// promiseState(value): -1 if not a promise, 0 pending, 1 fulfilled, 2
// rejected.
static JSValue js_promise_state(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    if (!JS_IsPromise(argv[0]))
        return JS_NewInt32(c, -1);
    return JS_NewInt32(c, (int)JS_PromiseState(c, argv[0]));
}

// promiseResult(promise): its value or reason (undefined while pending).
static JSValue js_promise_result(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    if (!JS_IsPromise(argv[0]))
        return JS_UNDEFINED;
    return JS_PromiseResult(c, argv[0]);
}

const JSCFunctionListEntry beyond_web_functions[] = {
    JS_CFUNC_DEF("promiseResult", 1, js_promise_result),
    JS_CFUNC_DEF("writeOut", 2, js_write_out),
    JS_CFUNC_DEF("promiseState", 1, js_promise_state),
    JS_CFUNC_DEF("encodeUtf8", 1, js_encode_utf8),
    JS_CFUNC_DEF("encodeUtf8Into", 2, js_encode_utf8_into),
    JS_CFUNC_DEF("decodeUtf8", 2, js_decode_utf8),
    JS_CFUNC_DEF("randomFill", 1, js_random_fill),
    JS_CFUNC_DEF("randomUUID", 0, js_random_uuid),
    JS_CFUNC_DEF("randomUUIDv7", 1, js_random_uuid_v7),
    JS_CFUNC_DEF("xxh64Hex", 1, js_xxh64_hex),
    JS_CFUNC_DEF("gc", 0, js_gc),
};
const int beyond_web_function_count = sizeof beyond_web_functions / sizeof *beyond_web_functions;
