// node:buffer's natives (Node's internalBinding('buffer'), src/node_buffer.cc
// and nbytes, which Bun's JSBuffer.cpp matches): strings to bytes and back
// in Node's encodings, searching, filling, comparing and byte swapping of
// Buffers, and UTF-8 / ASCII validation. lib/node/buffer.ts is Node's
// lib/buffer.js on these.

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include "quickjs.h"

size_t beyond_rt_utf8_valid(const uint8_t *p, size_t len, size_t *error_len);
size_t beyond_rt_utf8_lossy(const uint8_t *p, size_t len, uint8_t *out);

// Node's encodings, numbered as its `enum encoding` (internal/util's
// encodingsMap).
enum { ENC_ASCII, ENC_UTF8, ENC_BASE64, ENC_UCS2, ENC_LATIN1, ENC_HEX, ENC_BUFFER, ENC_BASE64URL };

// The longest string the engine makes (JS_STRING_LEN_MAX): kStringMaxLength.
#define STRING_MAX_LENGTH ((1u << 30) - 1)

// ---- Errors, as Node's ----

// Throws a RangeError (or TypeError) with Node's `code`.
static JSValue throw_coded(JSContext *c, int range, const char *code, const char *message) {
    if (range)
        JS_ThrowRangeError(c, "%s", message);
    else
        JS_ThrowTypeError(c, "%s", message);
    JSValue e = JS_GetException(c);
    JS_DefinePropertyValueStr(c, e, "code", JS_NewString(c, code), JS_PROP_CONFIGURABLE | JS_PROP_WRITABLE);
    return JS_Throw(c, e);
}

static JSValue throw_range(JSContext *c, const char *code, const char *message) {
    return throw_coded(c, 1, code, message);
}

static JSValue throw_type(JSContext *c, const char *code, const char *message) {
    return throw_coded(c, 0, code, message);
}

static JSValue throw_oob(JSContext *c) {
    return throw_range(c, "ERR_OUT_OF_RANGE", "Index out of range");
}

static JSValue throw_not_buffer(JSContext *c) {
    return throw_type(c, "ERR_INVALID_ARG_TYPE", "argument must be a buffer");
}

// ---- Bytes and strings ----

// The bytes a typed array, DataView or (Shared)ArrayBuffer views: 0, 1 if
// its buffer is detached (no bytes), or -1 if `v` is none of them.
static int view_bytes(JSContext *c, JSValueConst v, uint8_t **p, size_t *len) {
    JSValue ab;
    size_t off = 0, n = 0;
    if (JS_GetTypedArrayType(v) >= 0) {
        size_t bpe;
        ab = JS_GetTypedArrayBuffer(c, v, &off, &n, &bpe);
        if (JS_IsException(ab)) {
            JS_FreeValue(c, JS_GetException(c));
            return -1;
        }
    } else if (JS_IsArrayBuffer(v)) {
        ab = JS_DupValue(c, v);
    } else if (JS_IsDataView(v)) {
        int64_t o = 0, l = 0;
        JSValue off_v = JS_GetPropertyStr(c, v, "byteOffset");
        JSValue len_v = JS_GetPropertyStr(c, v, "byteLength");
        JS_ToInt64(c, &o, off_v);
        JS_ToInt64(c, &l, len_v);
        JS_FreeValue(c, off_v);
        JS_FreeValue(c, len_v);
        off = (size_t)o;
        n = (size_t)l;
        ab = JS_GetPropertyStr(c, v, "buffer");
    } else {
        return -1;
    }
    size_t total;
    uint8_t *base = JS_GetArrayBuffer(c, &total, ab);
    int whole = JS_IsArrayBuffer(v);
    JS_FreeValue(c, ab);
    if (!base && JS_HasException(c)) {
        JS_FreeValue(c, JS_GetException(c));
        *p = NULL;
        *len = 0;
        return 1;
    }
    *p = base ? base + off : NULL;
    *len = whole ? total : n;
    return 0;
}

// A string's characters: Latin-1 bytes (`one`) or UTF-16 code units
// (`two`, to free with JS_FreeCStringUTF16).
typedef struct {
    const uint8_t *one;
    const uint16_t *two;
    size_t len;
} Chars;

static int chars_of(JSContext *c, JSValueConst s, Chars *ch) {
    ch->one = JS_GetStringLatin1(s, &ch->len);
    ch->two = NULL;
    if (ch->one)
        return 0;
    ch->two = JS_ToCStringLenUTF16(c, &ch->len, s);
    return ch->two ? 0 : -1;
}

static void chars_free(JSContext *c, Chars *ch) {
    if (ch->two)
        JS_FreeCStringUTF16(c, ch->two);
}

static inline uint32_t char_at(const Chars *ch, size_t i) {
    return ch->one ? ch->one[i] : ch->two[i];
}

// The length of a string's UTF-8 (lone surrogates as U+FFFD: 3 bytes).
static size_t utf8_length(const Chars *ch) {
    size_t n = ch->len;
    if (ch->one) {
        for (size_t i = 0; i < ch->len; i++)
            n += ch->one[i] >> 7;
        return n;
    }
    n = 0;
    for (size_t i = 0; i < ch->len; i++) {
        uint32_t u = ch->two[i];
        if (u < 0x80)
            n += 1;
        else if (u < 0x800)
            n += 2;
        else if (u >= 0xd800 && u <= 0xdbff && i + 1 < ch->len && ch->two[i + 1] >= 0xdc00 && ch->two[i + 1] <= 0xdfff) {
            n += 4;
            i++;
        } else
            n += 3;
    }
    return n;
}

// Writes the UTF-8 of a string into p[..cap]: whole characters only, lone
// surrogates as U+FFFD. Returns the bytes written.
static size_t utf8_write(const Chars *ch, uint8_t *p, size_t cap) {
    size_t n = 0;
    for (size_t i = 0; i < ch->len; i++) {
        uint32_t u = char_at(ch, i);
        if (u < 0x80) {
            if (n + 1 > cap)
                break;
            p[n++] = (uint8_t)u;
            continue;
        }
        if (u < 0x800) {
            if (n + 2 > cap)
                break;
            p[n++] = (uint8_t)(0xc0 | u >> 6);
            p[n++] = (uint8_t)(0x80 | (u & 63));
            continue;
        }
        if (u >= 0xd800 && u <= 0xdfff) {
            uint32_t lo = i + 1 < ch->len ? char_at(ch, i + 1) : 0;
            if (u <= 0xdbff && lo >= 0xdc00 && lo <= 0xdfff) {
                if (n + 4 > cap)
                    break;
                uint32_t cp = 0x10000 + ((u - 0xd800) << 10) + (lo - 0xdc00);
                p[n++] = (uint8_t)(0xf0 | cp >> 18);
                p[n++] = (uint8_t)(0x80 | ((cp >> 12) & 63));
                p[n++] = (uint8_t)(0x80 | ((cp >> 6) & 63));
                p[n++] = (uint8_t)(0x80 | (cp & 63));
                i++;
                continue;
            }
            u = 0xfffd;
        }
        if (n + 3 > cap)
            break;
        p[n++] = (uint8_t)(0xe0 | u >> 12);
        p[n++] = (uint8_t)(0x80 | ((u >> 6) & 63));
        p[n++] = (uint8_t)(0x80 | (u & 63));
    }
    return n;
}

static inline int unhex(uint32_t c) {
    if (c >= '0' && c <= '9')
        return (int)(c - '0');
    if (c >= 'a' && c <= 'f')
        return (int)(c - 'a' + 10);
    if (c >= 'A' && c <= 'F')
        return (int)(c - 'A' + 10);
    return -1;
}

// Base64's alphabets, both (as Node's decoder takes either).
static int8_t UNBASE64[256];
static int unbase64_ready;

static void unbase64_init(void) {
    static const char a[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    memset(UNBASE64, -1, sizeof UNBASE64);
    for (int i = 0; i < 64; i++)
        UNBASE64[(uint8_t)a[i]] = (int8_t)i;
    UNBASE64['-'] = 62;
    UNBASE64['_'] = 63;
    unbase64_ready = 1;
}

static inline int unbase64(uint32_t c) {
    return c < 256 ? UNBASE64[c] : -1;
}

// The bytes a base64 string decodes to, at most (Node's Base64DecodedSize).
static size_t base64_size(const Chars *ch) {
    size_t n = ch->len;
    if (n < 2)
        return 0;
    if (char_at(ch, n - 1) == '=') {
        n--;
        if (char_at(ch, n - 1) == '=')
            n--;
    }
    return n > 1 ? (n / 4) * 3 + (n % 4 + 1) / 2 : 0;
}

// Decodes base64 (either alphabet) into p[..cap], skipping characters
// outside it and stopping at '=': Node's decoder. Returns the bytes written.
static size_t base64_write(const Chars *ch, uint8_t *p, size_t cap) {
    if (!unbase64_ready)
        unbase64_init();
    size_t limit = base64_size(ch);
    if (cap > limit)
        cap = limit;
    size_t n = 0, i = 0;
    uint32_t acc = 0;
    int bits = 0;
    while (i < ch->len && n < cap) {
        uint32_t c = char_at(ch, i++);
        if (c == '=')
            break;
        int v = unbase64(c);
        if (v < 0)
            continue;
        acc = acc << 6 | (uint32_t)v;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            p[n++] = (uint8_t)(acc >> bits);
        }
    }
    return n;
}

// Writes a string into p[..cap] in encoding `enc`: the bytes written.
static size_t string_write(const Chars *ch, uint8_t *p, size_t cap, int enc) {
    size_t n;
    switch (enc) {
    case ENC_UTF8:
    case ENC_BUFFER:
        if (ch->one) {
            // (Latin-1: ASCII runs copied as they are.)
            size_t i = 0;
            n = 0;
            while (i < ch->len && n < cap && ch->one[i] < 0x80)
                p[n++] = ch->one[i++];
            if (i == ch->len || n == cap)
                return n;
        }
        return utf8_write(ch, p, cap);
    case ENC_UCS2:
        n = ch->len < cap / 2 ? ch->len : cap / 2;
        for (size_t i = 0; i < n; i++) {
            uint32_t u = char_at(ch, i);
            p[2 * i] = (uint8_t)u;
            p[2 * i + 1] = (uint8_t)(u >> 8);
        }
        return 2 * n;
    case ENC_LATIN1:
    case ENC_ASCII:
        n = ch->len < cap ? ch->len : cap;
        if (ch->one)
            memcpy(p, ch->one, n);
        else
            for (size_t i = 0; i < n; i++)
                p[i] = (uint8_t)ch->two[i];
        return n;
    case ENC_HEX:
        n = 0;
        for (size_t i = 0; n < cap && 2 * i + 1 < ch->len; i++) {
            int a = unhex(char_at(ch, 2 * i)), b = unhex(char_at(ch, 2 * i + 1));
            if (a < 0 || b < 0)
                break;
            p[n++] = (uint8_t)(a << 4 | b);
        }
        return n;
    case ENC_BASE64:
    case ENC_BASE64URL:
        return base64_write(ch, p, cap);
    }
    return 0;
}

// The bytes a string takes in encoding `enc` (base64: at most).
static size_t string_size(const Chars *ch, int enc) {
    switch (enc) {
    case ENC_UTF8:
    case ENC_BUFFER:
        return utf8_length(ch);
    case ENC_UCS2:
        return ch->len * 2;
    case ENC_HEX:
        return ch->len / 2;
    case ENC_BASE64:
    case ENC_BASE64URL:
        return base64_size(ch);
    default:
        return ch->len;
    }
}

static const char B64[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
static const char B64URL[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

// Whether p[..len] is ASCII (a word at a time).
static int is_ascii(const uint8_t *p, size_t len) {
    size_t i = 0;
    for (; i + 32 <= len; i += 32) {
        uint64_t a, b, d, e;
        memcpy(&a, p + i, 8);
        memcpy(&b, p + i + 8, 8);
        memcpy(&d, p + i + 16, 8);
        memcpy(&e, p + i + 24, 8);
        if ((a | b | d | e) & 0x8080808080808080ull)
            return 0;
    }
    uint8_t acc = 0;
    for (; i < len; i++)
        acc |= p[i];
    return !(acc & 0x80);
}

static JSValue too_long(JSContext *c) {
    return throw_range(c, "ERR_STRING_TOO_LONG", "Cannot create a string longer than 0x3fffffff characters");
}

// The string of p[..len] in encoding `enc` (Buffer's toString).
JSValue beyond_buffer_decode(JSContext *c, const uint8_t *p, size_t len, int enc) {
    switch (enc) {
    case ENC_LATIN1:
        if (len > STRING_MAX_LENGTH)
            return too_long(c);
        return JS_NewStringLatin1(c, p, len);
    case ENC_UCS2: {
        size_t n = len / 2;
        if (n > STRING_MAX_LENGTH)
            return too_long(c);
        uint16_t *u = js_malloc(c, n * 2 + 2);
        if (!u)
            return JS_EXCEPTION;
        for (size_t i = 0; i < n; i++)
            u[i] = (uint16_t)(p[2 * i] | (p[2 * i + 1] << 8));
        JSValue r = JS_NewStringUTF16(c, u, n);
        js_free(c, u);
        return r;
    }
    case ENC_ASCII: {
        if (len > STRING_MAX_LENGTH)
            return too_long(c);
        if (is_ascii(p, len))
            return JS_NewStringLatin1(c, p, len);
        uint8_t *o = js_malloc(c, len + 1);
        if (!o)
            return JS_EXCEPTION;
        for (size_t i = 0; i < len; i++)
            o[i] = p[i] & 0x7f;
        JSValue r = JS_NewStringLatin1(c, o, len);
        js_free(c, o);
        return r;
    }
    case ENC_HEX:
    case ENC_BASE64:
    case ENC_BASE64URL: {
        size_t cap = enc == ENC_HEX ? len * 2 : (len + 2) / 3 * 4;
        if (cap > STRING_MAX_LENGTH)
            return too_long(c);
        uint8_t *o = js_malloc(c, cap + 1);
        if (!o)
            return JS_EXCEPTION;
        size_t n = 0;
        if (enc == ENC_HEX) {
            static const char H[] = "0123456789abcdef";
            for (size_t i = 0; i < len; i++) {
                o[n++] = (uint8_t)H[p[i] >> 4];
                o[n++] = (uint8_t)H[p[i] & 15];
            }
        } else {
            const char *t = enc == ENC_BASE64 ? B64 : B64URL;
            size_t i = 0;
            for (; i + 2 < len; i += 3) {
                uint32_t v = (uint32_t)p[i] << 16 | (uint32_t)p[i + 1] << 8 | p[i + 2];
                o[n++] = (uint8_t)t[v >> 18];
                o[n++] = (uint8_t)t[(v >> 12) & 63];
                o[n++] = (uint8_t)t[(v >> 6) & 63];
                o[n++] = (uint8_t)t[v & 63];
            }
            if (i < len) {
                uint32_t v = (uint32_t)p[i] << 16 | (i + 1 < len ? (uint32_t)p[i + 1] << 8 : 0);
                o[n++] = (uint8_t)t[v >> 18];
                o[n++] = (uint8_t)t[(v >> 12) & 63];
                if (i + 1 < len)
                    o[n++] = (uint8_t)t[(v >> 6) & 63];
                else if (enc == ENC_BASE64)
                    o[n++] = '=';
                if (enc == ENC_BASE64)
                    o[n++] = '=';
            }
        }
        JSValue r = JS_NewStringLatin1(c, o, n);
        js_free(c, o);
        return r;
    }
    default: { // UTF-8: each maximal invalid subpart as U+FFFD
        size_t err;
        if (len == 0)
            return JS_NewStringLatin1(c, (const uint8_t *)"", 0);
        if (is_ascii(p, len)) {
            if (len > STRING_MAX_LENGTH)
                return too_long(c);
            return JS_NewStringLatin1(c, p, len);
        }
        if (beyond_rt_utf8_valid(p, len, &err) == len)
            return JS_NewStringLen(c, (const char *)p, len);
        uint8_t *o = js_malloc(c, 3 * len);
        if (!o)
            return JS_EXCEPTION;
        size_t n = beyond_rt_utf8_lossy(p, len, o);
        JSValue r = JS_NewStringLen(c, (const char *)o, n);
        js_free(c, o);
        return r;
    }
    }
}

// Node's ParseArrayIndex: `def` for undefined, else an integer that must
// not be negative. 1, 0 (out of range: negative), or -1 (exception).
static int array_index(JSContext *c, JSValueConst v, size_t def, size_t *out) {
    if (JS_IsUndefined(v)) {
        *out = def;
        return 1;
    }
    double d;
    if (JS_ToFloat64(c, &d, v))
        return -1;
    // (ToIntegerOrInfinity, saturated: NaN is 0.)
    if (d != d)
        d = 0;
    if (d < 0 && d > -1)
        d = 0;
    if (d < 0)
        return 0;
    *out = d >= 9.0e18 ? (size_t)9000000000000000000ull : (size_t)d;
    return 1;
}

#define INDEX(v, def, out)                         \
    do {                                           \
        int r_ = array_index(c, (v), (def), (out)); \
        if (r_ < 0)                                \
            return JS_EXCEPTION;                   \
        if (r_ == 0)                               \
            return throw_oob(c);                   \
    } while (0)

// An encoding argument: its number, or its name (Node's ParseEncoding).
static int arg_encoding(JSContext *c, JSValueConst v, int def) {
    if (JS_IsString(v)) {
        size_t n;
        const uint8_t *s = JS_GetStringLatin1(v, &n);
        char name[12];
        if (!s || n == 0 || n >= sizeof name)
            return def;
        for (size_t i = 0; i < n; i++)
            name[i] = (char)(s[i] >= 'A' && s[i] <= 'Z' ? s[i] + 32 : s[i]);
        name[n] = 0;
        static const struct {
            const char *name;
            int enc;
        } names[] = {
            {"utf8", ENC_UTF8},     {"utf-8", ENC_UTF8},     {"ucs2", ENC_UCS2},     {"ucs-2", ENC_UCS2},
            {"utf16le", ENC_UCS2},  {"utf-16le", ENC_UCS2},  {"latin1", ENC_LATIN1}, {"binary", ENC_LATIN1},
            {"ascii", ENC_ASCII},   {"base64", ENC_BASE64},  {"base64url", ENC_BASE64URL}, {"hex", ENC_HEX},
            {"buffer", ENC_BUFFER},
        };
        for (size_t i = 0; i < sizeof names / sizeof *names; i++)
            if (!strcmp(name, names[i].name))
                return names[i].enc;
        return def;
    }
    int32_t e;
    if (JS_IsUndefined(v) || JS_ToInt32(c, &e, v))
        return def;
    return e;
}

// ---- The binding ----

// bufferSlice(buf, start, end, encoding): the string of buf[start, end).
static JSValue js_slice(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    uint8_t *p;
    size_t len, start, end;
    if (view_bytes(c, argv[0], &p, &len) < 0)
        return throw_not_buffer(c);
    if (len == 0)
        return JS_NewStringLatin1(c, (const uint8_t *)"", 0);
    INDEX(argv[1], 0, &start);
    INDEX(argv[2], len, &end);
    if (end < start)
        end = start;
    if (end > len)
        return throw_oob(c);
    return beyond_buffer_decode(c, p + start, end - start, arg_encoding(c, argv[3], ENC_UTF8));
}

// bufferWrite(buf, string, offset, length, encoding): the bytes written.
static JSValue js_write(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    uint8_t *p;
    size_t len, offset, max;
    if (view_bytes(c, argv[0], &p, &len) < 0)
        return throw_not_buffer(c);
    if (!JS_IsString(argv[1]))
        return throw_type(c, "ERR_INVALID_ARG_TYPE", "argument must be a string");
    INDEX(argv[2], 0, &offset);
    if (offset > len)
        return throw_range(c, "ERR_BUFFER_OUT_OF_BOUNDS", "\"offset\" is outside of buffer bounds");
    INDEX(argv[3], len - offset, &max);
    if (max > len - offset)
        max = len - offset;
    if (max == 0)
        return JS_NewInt32(c, 0);
    Chars ch;
    if (chars_of(c, argv[1], &ch))
        return JS_EXCEPTION;
    size_t n = string_write(&ch, p + offset, max, arg_encoding(c, argv[4], ENC_UTF8));
    chars_free(c, &ch);
    return JS_NewInt64(c, (int64_t)n);
}

// bufferByteLength(string, encoding): the bytes it takes (base64: decoded).
static JSValue js_byte_length(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    Chars ch;
    if (!JS_IsString(argv[0]))
        return JS_NewInt32(c, 0);
    if (chars_of(c, argv[0], &ch))
        return JS_EXCEPTION;
    size_t n = string_size(&ch, arg_encoding(c, argv[1], ENC_UTF8));
    chars_free(c, &ch);
    return JS_NewInt64(c, (int64_t)n);
}

static int normalize_compare(int v, size_t a, size_t b) {
    if (v == 0)
        return a > b ? 1 : a < b ? -1 : 0;
    return v > 0 ? 1 : -1;
}

// bufferCompare(a, b): -1, 0 or 1.
static JSValue js_compare(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    uint8_t *a, *b;
    size_t al, bl;
    if (view_bytes(c, argv[0], &a, &al) < 0 || view_bytes(c, argv[1], &b, &bl) < 0)
        return throw_not_buffer(c);
    size_t n = al < bl ? al : bl;
    return JS_NewInt32(c, normalize_compare(n ? memcmp(a, b, n) : 0, al, bl));
}

// bufferCompareOffset(source, target, targetStart, sourceStart, targetEnd,
// sourceEnd): -1, 0 or 1.
static JSValue js_compare_offset(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    uint8_t *s, *t;
    size_t sl, tl, ts, ss, te, se;
    if (view_bytes(c, argv[0], &s, &sl) < 0 || view_bytes(c, argv[1], &t, &tl) < 0)
        return throw_not_buffer(c);
    INDEX(argv[2], 0, &ts);
    INDEX(argv[3], 0, &ss);
    INDEX(argv[4], tl, &te);
    INDEX(argv[5], sl, &se);
    if (ss > sl)
        return throw_range(c, "ERR_OUT_OF_RANGE", "The value of \"sourceStart\" is out of range.");
    if (ts > tl)
        return throw_range(c, "ERR_OUT_OF_RANGE", "The value of \"targetStart\" is out of range.");
    if (se < ss)
        se = ss;
    if (te < ts)
        te = ts;
    size_t n = se - ss < te - ts ? se - ss : te - ts;
    if (n > sl - ss)
        n = sl - ss;
    if (n > tl - ts)
        n = tl - ts;
    return JS_NewInt32(c, normalize_compare(n ? memcmp(s + ss, t + ts, n) : 0, se - ss, te - ts));
}

// bufferCopy(source, target, targetStart, sourceStart, count): count (the
// caller has checked the ranges).
static JSValue js_copy(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    uint8_t *s, *t;
    size_t sl, tl;
    uint32_t ts, ss, n;
    if (view_bytes(c, argv[0], &s, &sl) < 0 || view_bytes(c, argv[1], &t, &tl) < 0)
        return throw_not_buffer(c);
    if (JS_ToUint32(c, &ts, argv[2]) || JS_ToUint32(c, &ss, argv[3]) || JS_ToUint32(c, &n, argv[4]))
        return JS_EXCEPTION;
    if ((size_t)ts + n <= tl && (size_t)ss + n <= sl && n > 0)
        memmove(t + ts, s + ss, n);
    return JS_NewUint32(c, n);
}

// bufferFill(buf, value, start, end, encoding): undefined, -1 (the value
// gives no bytes) or -2 (out of range), as Node's: the value's bytes (a
// Buffer's, a string's in `encoding`, or a number's low byte) repeated.
static JSValue js_fill(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    uint8_t *p, *v;
    size_t len, start, end, vl, n;
    if (view_bytes(c, argv[0], &p, &len) < 0)
        return throw_not_buffer(c);
    INDEX(argv[2], 0, &start);
    INDEX(argv[3], 0, &end);
    if (start > end || end > len)
        return JS_NewInt32(c, -2);
    size_t fill = end - start;
    if (JS_IsString(argv[1])) {
        Chars ch;
        if (chars_of(c, argv[1], &ch))
            return JS_EXCEPTION;
        int enc = arg_encoding(c, argv[4], ENC_UTF8);
        if (enc == ENC_UTF8 || enc == ENC_UCS2) {
            // (The whole value's bytes, of which those that fit: a
            // character may be cut.)
            n = string_size(&ch, enc);
            uint8_t *t = js_malloc(c, n ? n : 1);
            if (!t) {
                chars_free(c, &ch);
                return JS_EXCEPTION;
            }
            n = string_write(&ch, t, n, enc);
            memcpy(p + start, t, n < fill ? n : fill);
            js_free(c, t);
        } else {
            n = string_write(&ch, p + start, fill, enc);
        }
        chars_free(c, &ch);
    } else if (JS_GetTypedArrayType(argv[1]) >= 0 || JS_IsDataView(argv[1])) {
        if (view_bytes(c, argv[1], &v, &vl) < 0)
            return throw_not_buffer(c);
        n = vl;
        memmove(p + start, v, n < fill ? n : fill);
    } else {
        uint32_t x;
        if (JS_ToUint32(c, &x, argv[1]))
            return JS_EXCEPTION;
        memset(p + start, (int)(x & 255), fill);
        return JS_UNDEFINED;
    }
    if (n >= fill)
        return JS_UNDEFINED;
    if (n == 0)
        return JS_NewInt32(c, -1);
    // (Doubling copies of what is written.)
    size_t have = n;
    while (have < fill - have) {
        memcpy(p + start + have, p + start, have);
        have *= 2;
    }
    if (have < fill)
        memcpy(p + start + have, p + start, fill - have);
    return JS_UNDEFINED;
}

// Node's IndexOfOffset: where a search starts, or -1 for none.
static int64_t index_offset(size_t length, int64_t offset, int64_t needle, int forward) {
    int64_t len = (int64_t)length;
    if (offset < 0) {
        if (offset + len >= 0)
            return len + offset;
        if (forward || needle == 0)
            return 0;
        return -1;
    }
    if (offset + needle <= len)
        return offset;
    if (needle == 0)
        return len;
    if (forward)
        return -1;
    return len - 1;
}

// The first (or last, starting at `from`) position of n[..nl] in h[..hl]
// (units of `w` bytes), or -1.
static int64_t search(const uint8_t *h, size_t hl, const uint8_t *n, size_t nl, size_t from, int forward, int w) {
    if (nl == 0 || nl > hl)
        return -1;
    if (forward) {
        for (size_t i = from; i + nl <= hl; i += w) {
            if (w == 1) {
                const uint8_t *q = memchr(h + i, n[0], hl - nl - i + 1);
                if (!q)
                    return -1;
                i = (size_t)(q - h);
            }
            if (memcmp(h + i, n, nl) == 0)
                return (int64_t)i;
        }
        return -1;
    }
    size_t i = from;
    if (i + nl > hl)
        i = hl - nl;
    if (w == 2)
        i &= ~(size_t)1;
    for (;;) {
        if (h[i] == n[0] && memcmp(h + i, n, nl) == 0)
            return (int64_t)i;
        if (i < (size_t)w)
            return -1;
        i -= w;
    }
}

static JSValue index_result(JSContext *c, const uint8_t *h, size_t hl, const uint8_t *n, size_t nl, int64_t off,
                            int forward, int enc) {
    int64_t o = index_offset(hl, off, (int64_t)nl, forward);
    if (nl == 0)
        return JS_NewInt64(c, o);
    if (hl == 0 || o <= -1)
        return JS_NewInt32(c, -1);
    if ((forward && nl + (size_t)o > hl) || nl > hl)
        return JS_NewInt32(c, -1);
    if (enc == ENC_UCS2) {
        if (hl < 2 || nl < 2)
            return JS_NewInt32(c, -1);
        return JS_NewInt64(c, search(h, hl & ~(size_t)1, n, nl & ~(size_t)1, (size_t)o & ~(size_t)1, forward, 2));
    }
    return JS_NewInt64(c, search(h, hl, n, nl, (size_t)o, forward, 1));
}

// bufferIndexOfString(buf, string, byteOffset, encoding, forward).
static JSValue js_index_of_string(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    uint8_t *h;
    size_t hl;
    int64_t off;
    if (view_bytes(c, argv[0], &h, &hl) < 0)
        return throw_not_buffer(c);
    if (JS_ToInt64(c, &off, argv[2]))
        return JS_EXCEPTION;
    int enc = arg_encoding(c, argv[3], ENC_UTF8);
    int forward = JS_ToBool(c, argv[4]);
    if (enc == ENC_UCS2)
        hl &= ~(size_t)1;
    Chars ch;
    if (chars_of(c, argv[1], &ch))
        return JS_EXCEPTION;
    size_t nl = string_size(&ch, enc);
    uint8_t stack[256];
    uint8_t *n = nl <= sizeof stack ? stack : js_malloc(c, nl);
    if (!n) {
        chars_free(c, &ch);
        return JS_EXCEPTION;
    }
    nl = string_write(&ch, n, nl, enc);
    chars_free(c, &ch);
    JSValue r = index_result(c, h, hl, n, nl, off, forward, enc);
    if (n != stack)
        js_free(c, n);
    return r;
}

// bufferIndexOfBuffer(buf, needle, byteOffset, encoding, forward).
static JSValue js_index_of_buffer(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    uint8_t *h, *n;
    size_t hl, nl;
    int64_t off;
    if (view_bytes(c, argv[0], &h, &hl) < 0 || view_bytes(c, argv[1], &n, &nl) < 0)
        return throw_not_buffer(c);
    if (JS_ToInt64(c, &off, argv[2]))
        return JS_EXCEPTION;
    return index_result(c, h, hl, n, nl, off, JS_ToBool(c, argv[4]), arg_encoding(c, argv[3], ENC_UTF8));
}

// bufferIndexOfNumber(buf, byte, byteOffset, forward).
static JSValue js_index_of_number(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    uint8_t *h;
    size_t hl;
    uint32_t b;
    int64_t off;
    if (view_bytes(c, argv[0], &h, &hl) < 0)
        return throw_not_buffer(c);
    if (JS_ToUint32(c, &b, argv[1]) || JS_ToInt64(c, &off, argv[2]))
        return JS_EXCEPTION;
    int forward = JS_ToBool(c, argv[3]);
    int64_t o = index_offset(hl, off, 1, forward);
    if (o <= -1 || hl == 0)
        return JS_NewInt32(c, -1);
    if (forward) {
        const uint8_t *q = memchr(h + o, (int)(b & 255), hl - (size_t)o);
        return JS_NewInt64(c, q ? q - h : -1);
    }
    for (int64_t i = o; i >= 0; i--)
        if (h[i] == (uint8_t)b)
            return JS_NewInt64(c, i);
    return JS_NewInt32(c, -1);
}

// bufferSwap(buf, width): the bytes of each 2, 4 or 8 reversed, in place.
static JSValue js_swap(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    uint8_t *p;
    size_t len;
    int32_t w;
    if (view_bytes(c, argv[0], &p, &len) < 0)
        return throw_not_buffer(c);
    if (JS_ToInt32(c, &w, argv[1]))
        return JS_EXCEPTION;
    if (w == 2) {
        for (size_t i = 0; i + 1 < len; i += 2) {
            uint16_t v;
            memcpy(&v, p + i, 2);
            v = __builtin_bswap16(v);
            memcpy(p + i, &v, 2);
        }
    } else if (w == 4) {
        for (size_t i = 0; i + 3 < len; i += 4) {
            uint32_t v;
            memcpy(&v, p + i, 4);
            v = __builtin_bswap32(v);
            memcpy(p + i, &v, 4);
        }
    } else {
        for (size_t i = 0; i + 7 < len; i += 8) {
            uint64_t v;
            memcpy(&v, p + i, 8);
            v = __builtin_bswap64(v);
            memcpy(p + i, &v, 8);
        }
    }
    return JS_DupValue(c, argv[0]);
}

static JSValue validate(JSContext *c, JSValueConst v, int ascii) {
    uint8_t *p;
    size_t len;
    int r = view_bytes(c, v, &p, &len);
    if (r < 0)
        return throw_type(c, "ERR_INVALID_ARG_TYPE", "argument must be a TypedArray or ArrayBuffer");
    if (r > 0)
        return throw_type(c, "ERR_INVALID_STATE", "Invalid state: Cannot validate on a detached buffer");
    if (ascii)
        return JS_NewBool(c, is_ascii(p, len));
    size_t err;
    return JS_NewBool(c, len == 0 || beyond_rt_utf8_valid(p, len, &err) == len);
}

static JSValue js_is_utf8(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    return validate(c, argv[0], 0);
}

static JSValue js_is_ascii(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    return validate(c, argv[0], 1);
}

const JSCFunctionListEntry beyond_buffer_functions[] = {
    JS_CFUNC_DEF("bufferSlice", 4, js_slice),
    JS_CFUNC_DEF("bufferWrite", 5, js_write),
    JS_CFUNC_DEF("bufferByteLength", 2, js_byte_length),
    JS_CFUNC_DEF("bufferCompare", 2, js_compare),
    JS_CFUNC_DEF("bufferCompareOffset", 6, js_compare_offset),
    JS_CFUNC_DEF("bufferCopy", 5, js_copy),
    JS_CFUNC_DEF("bufferFill", 5, js_fill),
    JS_CFUNC_DEF("bufferIndexOfString", 5, js_index_of_string),
    JS_CFUNC_DEF("bufferIndexOfBuffer", 5, js_index_of_buffer),
    JS_CFUNC_DEF("bufferIndexOfNumber", 4, js_index_of_number),
    JS_CFUNC_DEF("bufferSwap", 2, js_swap),
    JS_CFUNC_DEF("bufferIsUtf8", 1, js_is_utf8),
    JS_CFUNC_DEF("bufferIsAscii", 1, js_is_ascii),
};

const int beyond_buffer_function_count = sizeof beyond_buffer_functions / sizeof *beyond_buffer_functions;
