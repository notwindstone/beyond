// The native parts of web APIs: text encoding (TextEncoder, TextDecoder;
// the UTF-8 itself is in Rust, src/encoding.rs) and random numbers
// (crypto.getRandomValues, crypto.randomUUID).

#include <errno.h>
#include <stdint.h>
#include <string.h>
#include <sys/random.h>

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

const JSCFunctionListEntry beyond_web_functions[] = {
    JS_CFUNC_DEF("encodeUtf8", 1, js_encode_utf8),
    JS_CFUNC_DEF("encodeUtf8Into", 2, js_encode_utf8_into),
    JS_CFUNC_DEF("decodeUtf8", 2, js_decode_utf8),
    JS_CFUNC_DEF("randomFill", 1, js_random_fill),
    JS_CFUNC_DEF("randomUUID", 0, js_random_uuid),
};
const int beyond_web_function_count = sizeof beyond_web_functions / sizeof *beyond_web_functions;
