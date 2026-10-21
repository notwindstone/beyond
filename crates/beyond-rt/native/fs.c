// node:fs's natives (lib/node/internal/bindings/node_fs_binding.ts): the
// file system calls of Bun's node_fs.rs (Linux), and the values they make
// (Stats, Dirent, StatFs: objects of shapes cached from templates the
// binding gives fsInit, as Bun's C++ makes them of fixed structures).
//
// The binding parses and validates the arguments (Bun's from_js); these
// take them parsed: a path is a string or a Uint8Array (its bytes), an fd
// an int32, flags and modes numbers. A path with a NUL byte is not one: the
// function returns null and the binding throws Bun's
// error. A system call's failure is thrown here, as Bun's SystemError:
// `<CODE>: <description>, <syscall> '<path>' -> '<dest>'` with `code`,
// `path`, `dest`, `fd`, `syscall` and `errno` (libuv's names and
// descriptions, as Bun's tables have them).

#define _GNU_SOURCE
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <linux/fs.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/inotify.h>
#include <sys/ioctl.h>
#include <sys/sendfile.h>
#include <sys/stat.h>
#include <sys/statfs.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/uio.h>
#include <time.h>
#include <unistd.h>

#include "quickjs.h"

// (fs.watch's inotify descriptors are polls of uSockets' loop, as Bun's
// event loop's: their callback kind is an internal one.)
#include "libusockets.h"
#include "internal/internal.h"

void beyond_rt_wtf8_fix(uint8_t *p, size_t len);
size_t beyond_rt_utf8_valid(const uint8_t *p, size_t len, size_t *error_len);
size_t beyond_rt_utf8_lossy(const uint8_t *p, size_t len, uint8_t *out);

// Bun's MAX_PATH_BYTES: a path this long or longer is ENAMETOOLONG before
// any system call.
#define FS_PATH_MAX 4096

// ---- Errors, as Bun's (src/sys/Error.rs to_system_error) ----

// Bun's SystemErrno names on Linux (src/errno/linux_errno.rs), by errno.
static const char *const errno_names[] = {
    "SUCCESS", "EPERM", "ENOENT", "ESRCH", "EINTR", "EIO", "ENXIO", "E2BIG", "ENOEXEC", "EBADF",
    "ECHILD", "EAGAIN", "ENOMEM", "EACCES", "EFAULT", "ENOTBLK", "EBUSY", "EEXIST", "EXDEV", "ENODEV",
    "ENOTDIR", "EISDIR", "EINVAL", "ENFILE", "EMFILE", "ENOTTY", "ETXTBSY", "EFBIG", "ENOSPC", "ESPIPE",
    "EROFS", "EMLINK", "EPIPE", "EDOM", "ERANGE", "EDEADLK", "ENAMETOOLONG", "ENOLCK", "ENOSYS", "ENOTEMPTY",
    "ELOOP", "EWOULDBLOCK", "ENOMSG", "EIDRM", "ECHRNG", "EL2NSYNC", "EL3HLT", "EL3RST", "ELNRNG", "EUNATCH",
    "ENOCSI", "EL2HLT", "EBADE", "EBADR", "EXFULL", "ENOANO", "EBADRQC", "EBADSLT", "EDEADLOCK", "EBFONT",
    "ENOSTR", "ENODATA", "ETIME", "ENOSR", "ENONET", "ENOPKG", "EREMOTE", "ENOLINK", "EADV", "ESRMNT",
    "ECOMM", "EPROTO", "EMULTIHOP", "EDOTDOT", "EBADMSG", "EOVERFLOW", "ENOTUNIQ", "EBADFD", "EREMCHG", "ELIBACC",
    "ELIBBAD", "ELIBSCN", "ELIBMAX", "ELIBEXEC", "EILSEQ", "ERESTART", "ESTRPIPE", "EUSERS", "ENOTSOCK", "EDESTADDRREQ",
    "EMSGSIZE", "EPROTOTYPE", "ENOPROTOOPT", "EPROTONOSUPPORT", "ESOCKTNOSUPPORT", "ENOTSUP", "EPFNOSUPPORT", "EAFNOSUPPORT", "EADDRINUSE", "EADDRNOTAVAIL",
    "ENETDOWN", "ENETUNREACH", "ENETRESET", "ECONNABORTED", "ECONNRESET", "ENOBUFS", "EISCONN", "ENOTCONN", "ESHUTDOWN", "ETOOMANYREFS",
    "ETIMEDOUT", "ECONNREFUSED", "EHOSTDOWN", "EHOSTUNREACH", "EALREADY", "EINPROGRESS", "ESTALE", "EUCLEAN", "ENOTNAM", "ENAVAIL",
    "EISNAM", "EREMOTEIO", "EDQUOT", "ENOMEDIUM", "EMEDIUMTYPE", "ECANCELED", "ENOKEY", "EKEYEXPIRED", "EKEYREVOKED", "EKEYREJECTED",
    "EOWNERDEAD", "ENOTRECOVERABLE", "ERFKILL", "EHWPOISON",
};

// libuv's descriptions (Bun's LIBUV_ERROR_MAP: "unknown error" for the rest).
static const char *uv_description(int no) {
    switch (no) {
    case E2BIG: return "argument list too long";
    case EACCES: return "permission denied";
    case EADDRINUSE: return "address already in use";
    case EADDRNOTAVAIL: return "address not available";
    case EAFNOSUPPORT: return "address family not supported";
    case EAGAIN: return "resource temporarily unavailable";
    case EALREADY: return "connection already in progress";
    case EBADF: return "bad file descriptor";
    case EBUSY: return "resource busy or locked";
    case ECANCELED: return "operation canceled";
    case ECONNABORTED: return "software caused connection abort";
    case ECONNREFUSED: return "connection refused";
    case ECONNRESET: return "connection reset by peer";
    case EDESTADDRREQ: return "destination address required";
    case EEXIST: return "file already exists";
    case EFAULT: return "bad address in system call argument";
    case EFBIG: return "file too large";
    case EHOSTUNREACH: return "host is unreachable";
    case EINTR: return "interrupted system call";
    case EINVAL: return "invalid argument";
    case EIO: return "i/o error";
    case EISCONN: return "socket is already connected";
    case EISDIR: return "illegal operation on a directory";
    case ELOOP: return "too many symbolic links encountered";
    case EMFILE: return "too many open files";
    case EMSGSIZE: return "message too long";
    case ENAMETOOLONG: return "name too long";
    case ENETDOWN: return "network is down";
    case ENETUNREACH: return "network is unreachable";
    case ENFILE: return "file table overflow";
    case ENOBUFS: return "no buffer space available";
    case ENODEV: return "no such device";
    case ENOENT: return "no such file or directory";
    case ENOMEM: return "not enough memory";
    case ENONET: return "machine is not on the network";
    case ENOPROTOOPT: return "protocol not available";
    case ENOSPC: return "no space left on device";
    case ENOSYS: return "function not implemented";
    case ENOTCONN: return "socket is not connected";
    case ENOTDIR: return "not a directory";
    case ENOTEMPTY: return "directory not empty";
    case ENOTSOCK: return "socket operation on non-socket";
    case ENOTSUP: return "operation not supported on socket";
    case EOVERFLOW: return "value too large for defined data type";
    case EPERM: return "operation not permitted";
    case EPIPE: return "broken pipe";
    case EPROTO: return "protocol error";
    case EPROTONOSUPPORT: return "protocol not supported";
    case EPROTOTYPE: return "protocol wrong type for socket";
    case ERANGE: return "result too large";
    case EROFS: return "read-only file system";
    case ESHUTDOWN: return "cannot send after transport endpoint shutdown";
    case ESPIPE: return "invalid seek";
    case ESRCH: return "no such process";
    case ETIMEDOUT: return "connection timed out";
    case ETXTBSY: return "text file is busy";
    case EXDEV: return "cross-device link not permitted";
    case ENXIO: return "no such device or address";
    case EMLINK: return "too many links";
    case EHOSTDOWN: return "host is down";
    case EREMOTEIO: return "remote I/O error";
    case ENOTTY: return "inappropriate ioctl for device";
    case EILSEQ: return "illegal byte sequence";
    case ESOCKTNOSUPPORT: return "socket type not supported";
    case ENODATA: return "no data available";
    case EUNATCH: return "protocol driver not attached";
    default: return "unknown error";
    }
}

// A path as an error tells it: its bytes, and the string it was given as
// (or undefined: then a string is made of the bytes).
typedef struct {
    const char *p;
    size_t len;
    JSValueConst js;
} ErrPath;

#define ERR_NO_SYSCALL_PROP 1 // (Bun's ENAMETOOLONG before the call: the message names `open`, no `syscall`)

static void append(char *buf, size_t *pos, size_t cap, const char *s, size_t n) {
    if (*pos >= cap)
        return;
    if (n > cap - *pos)
        n = cap - *pos;
    memcpy(buf + *pos, s, n);
    *pos += n;
}

static JSValue path_value(JSContext *c, const ErrPath *ep) {
    if (JS_IsString(ep->js))
        return JS_DupValue(c, ep->js);
    return JS_NewStringLen(c, ep->p, ep->len);
}

// The SystemError of `no` from `syscall` (path, dest and fd as given: NULL
// and -1 when there are none, an empty path being none).
static JSValue make_sys(JSContext *c, int no, const char *syscall, const ErrPath *path, const ErrPath *dest, int fd,
                        int flags) {
    const char *code = no > 0 && no < (int)(sizeof errno_names / sizeof *errno_names) ? errno_names[no] : NULL;
    const char *desc = code ? uv_description(no) : "Unknown Error";
    if (path && path->len == 0)
        path = NULL;
    if (dest && dest->len == 0)
        dest = NULL;
    // (Bun's message buffer: 4096 bytes.)
    char msg[4096];
    size_t pos = 0, cap = sizeof msg;
    if (code) {
        append(msg, &pos, cap, code, strlen(code));
        append(msg, &pos, cap, ": ", 2);
    }
    append(msg, &pos, cap, desc, strlen(desc));
    append(msg, &pos, cap, ", ", 2);
    append(msg, &pos, cap, syscall, strlen(syscall));
    if (path) {
        append(msg, &pos, cap, " '", 2);
        append(msg, &pos, cap, path->p, path->len);
        append(msg, &pos, cap, "'", 1);
        if (dest) {
            append(msg, &pos, cap, " -> '", 5);
            append(msg, &pos, cap, dest->p, dest->len);
            append(msg, &pos, cap, "'", 1);
        }
    }
    JSValue e = JS_NewError(c);
    if (JS_IsException(e))
        return e;
    JS_DefinePropertyValueStr(c, e, "message", JS_NewStringLen(c, msg, pos), JS_PROP_WRITABLE | JS_PROP_CONFIGURABLE);
    if (code)
        JS_DefinePropertyValueStr(c, e, "code", JS_NewString(c, code), JS_PROP_C_W_E);
    if (path) {
        JS_DefinePropertyValueStr(c, e, "path", path_value(c, path), JS_PROP_C_W_E);
        if (dest)
            JS_DefinePropertyValueStr(c, e, "dest", path_value(c, dest), JS_PROP_C_W_E);
    }
    if (fd >= 0)
        JS_DefinePropertyValueStr(c, e, "fd", JS_NewInt32(c, fd), JS_PROP_C_W_E);
    if (!(flags & ERR_NO_SYSCALL_PROP))
        JS_DefinePropertyValueStr(c, e, "syscall", JS_NewString(c, syscall), JS_PROP_C_W_E);
    JS_DefinePropertyValueStr(c, e, "errno", JS_NewInt32(c, -no), JS_PROP_C_W_E);
    return e;
}

// The same, thrown.
static JSValue throw_sys(JSContext *c, int no, const char *syscall, const ErrPath *path, const ErrPath *dest, int fd,
                         int flags) {
    JSValue e = make_sys(c, no, syscall, path, dest, fd, flags);
    if (JS_IsException(e))
        return e;
    return JS_Throw(c, e);
}

// fsError(errno, syscall, path, dest, fd): the SystemError (a path or dest
// that is not a string is none, an fd < 0 too).
static JSValue js_fs_error(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    int32_t no, fd = -1;
    if (JS_ToInt32(c, &no, argv[0]) || (JS_IsNumber(argv[4]) && JS_ToInt32(c, &fd, argv[4])))
        return JS_EXCEPTION;
    const char *sc = JS_ToCString(c, argv[1]);
    if (!sc)
        return JS_EXCEPTION;
    const char *ps = NULL, *ds = NULL;
    size_t pl = 0, dl = 0;
    if (JS_IsString(argv[2]))
        ps = JS_ToCStringLen(c, &pl, argv[2]);
    if (JS_IsString(argv[3]))
        ds = JS_ToCStringLen(c, &dl, argv[3]);
    ErrPath ep = {ps, pl, argv[2]}, ed = {ds, dl, argv[3]};
    JSValue e = make_sys(c, no, sc, ps ? &ep : NULL, ds ? &ed : NULL, fd, 0);
    JS_FreeCString(c, sc);
    if (ps)
        JS_FreeCString(c, ps);
    if (ds)
        JS_FreeCString(c, ds);
    return e;
}

// ---- Arguments ----

// A path argument (a string or a Uint8Array): its bytes, NUL-terminated.
typedef struct {
    const char *p;
    size_t len;
    JSValueConst js;
    const char *cstr; // (JS_FreeCString)
    char buf[FS_PATH_MAX + 1];
} Path;

#define PATH_OK 0
#define PATH_EXCEPTION -1
#define PATH_NUL 1

static int is_ascii(const uint8_t *p, size_t len);

static int get_path(JSContext *c, JSValueConst v, Path *p) {
    p->js = v;
    p->cstr = NULL;
    size_t n8;
    const uint8_t *s8 = JS_GetStringLatin1(v, &n8);
    // (An ASCII string's characters are its UTF-8 bytes: copied here,
    // without the engine's conversion and its allocation.)
    if (s8 && n8 < sizeof p->buf && is_ascii(s8, n8)) {
        if (memchr(s8, 0, n8))
            return PATH_NUL;
        memcpy(p->buf, s8, n8);
        p->buf[n8] = 0;
        p->p = p->buf;
        p->len = n8;
        if (n8 >= FS_PATH_MAX) {
            ErrPath ep = {p->p, p->len, p->js};
            throw_sys(c, ENAMETOOLONG, "open", &ep, NULL, -1, ERR_NO_SYSCALL_PROP);
            return PATH_EXCEPTION;
        }
        return PATH_OK;
    }
    if (JS_IsString(v)) {
        size_t len;
        const char *s = JS_ToCStringLen(c, &len, v);
        if (!s)
            return PATH_EXCEPTION;
        p->cstr = s;
        p->p = s;
        p->len = len;
        if (memchr(s, 0, len)) {
            JS_FreeCString(c, s);
            p->cstr = NULL;
            return PATH_NUL;
        }
    } else {
        size_t len;
        uint8_t *b = JS_GetUint8Array(c, &len, v);
        if (!b)
            return PATH_EXCEPTION;
        if (memchr(b, 0, len))
            return PATH_NUL;
        if (len < sizeof p->buf) {
            memcpy(p->buf, b, len);
            p->buf[len] = 0;
            p->p = p->buf;
        } else {
            p->p = (const char *)b; // (too long: only the error reads it)
        }
        p->len = len;
    }
    if (p->len >= FS_PATH_MAX) {
        ErrPath ep = {p->p, p->len, p->js};
        throw_sys(c, ENAMETOOLONG, "open", &ep, NULL, -1, ERR_NO_SYSCALL_PROP);
        if (p->cstr)
            JS_FreeCString(c, p->cstr);
        p->cstr = NULL;
        return PATH_EXCEPTION;
    }
    return PATH_OK;
}

static void free_path(JSContext *c, Path *p) {
    if (p->cstr)
        JS_FreeCString(c, p->cstr);
    p->cstr = NULL;
}

static ErrPath err_path(const Path *p) {
    ErrPath e = {p->p, p->len, p->js};
    return e;
}

static JSValue path_fail(int r) {
    return r == PATH_NUL ? JS_NULL : JS_EXCEPTION;
}

static JSValue throw_path(JSContext *c, int no, const char *syscall, Path *p) {
    ErrPath ep = err_path(p);
    JSValue r = throw_sys(c, no, syscall, &ep, NULL, -1, 0);
    free_path(c, p);
    return r;
}

static int to_i32(JSContext *c, JSValueConst v, int32_t *out) {
    if (JS_VALUE_GET_TAG(v) == JS_TAG_INT) {
        *out = JS_VALUE_GET_INT(v);
        return 0;
    }
    return JS_ToInt32(c, out, v);
}

// A position: a number or a BigInt, < 0 for none.
static int to_pos(JSContext *c, JSValueConst v, int64_t *out) {
    if (JS_VALUE_GET_TAG(v) == JS_TAG_INT) {
        *out = JS_VALUE_GET_INT(v);
        return 0;
    }
    if (JS_IsUndefined(v) || JS_IsNull(v)) {
        *out = -1;
        return 0;
    }
    if (JS_IsBigInt(v))
        return JS_ToBigInt64(c, out, v);
    double d;
    if (JS_ToFloat64(c, &d, v))
        return -1;
    *out = d >= 0 ? (int64_t)d : -1;
    return 0;
}

// ---- Encodings (Bun's Encoding: the binding's numbers) ----

enum { ENC_UTF8, ENC_UCS2, ENC_UTF16LE, ENC_LATIN1, ENC_ASCII, ENC_BASE64, ENC_BASE64URL, ENC_HEX, ENC_BUFFER };

// Values the binding gave fsInit, which native code keeps (marked).
static JSValue buffer_proto = JS_UNDEFINED, dirent_proto = JS_UNDEFINED, dirent_type = JS_UNDEFINED;
static JSValue templates[5] = {JS_UNDEFINED, JS_UNDEFINED, JS_UNDEFINED, JS_UNDEFINED, JS_UNDEFINED};
static void *shapes[5]; // Stats, BigIntStats, StatFs, BigIntStatFs, Dirent
static JSAtom dirent_type_atom;
static int marking;

enum { SHAPE_STATS, SHAPE_BIGSTATS, SHAPE_STATFS, SHAPE_BIGSTATFS, SHAPE_DIRENT };

// fs.watch's dispatcher (fsWatchStart's): (id, kind, value, close).
static JSValue watch_dispatch = JS_UNDEFINED;

static void pool_mark(JSRuntime *rt, JS_MarkFunc *mark_func);

static void fs_mark(JSRuntime *rt, void *opaque, JS_MarkFunc *mark_func) {
    (void)opaque;
    pool_mark(rt, mark_func);
    JS_MarkValue(rt, watch_dispatch, mark_func);
    JS_MarkValue(rt, buffer_proto, mark_func);
    JS_MarkValue(rt, dirent_proto, mark_func);
    JS_MarkValue(rt, dirent_type, mark_func);
    for (int i = 0; i < 5; i++)
        JS_MarkValue(rt, templates[i], mark_func);
}

static void *js_realloc_ab(JSRuntime *rt, void *opaque, void *ptr, size_t size) {
    (void)opaque;
    if (size == 0) {
        js_free_rt(rt, ptr);
        return NULL;
    }
    return js_realloc_rt(rt, ptr, size);
}

// A Buffer of `len` bytes: of `data` (js_malloc'd, taken) or a copy of
// `copy`.
static JSValue new_buffer(JSContext *c, uint8_t *data, const uint8_t *copy, size_t len) {
    JSValue u8;
    if (data)
        u8 = JS_NewUint8Array(c, data, len, js_realloc_ab, NULL, false);
    else
        u8 = JS_NewUint8ArrayCopy(c, copy, len);
    if (JS_IsException(u8))
        return u8;
    if (JS_IsObject(buffer_proto) && JS_SetPrototype(c, u8, buffer_proto) < 0) {
        JS_FreeValue(c, u8);
        return JS_EXCEPTION;
    }
    return u8;
}

// Whether p[..len] is ASCII (a word at a time).
static int is_ascii(const uint8_t *p, size_t len) {
    size_t i = 0;
    uint64_t acc = 0;
    for (; i + 32 <= len; i += 32) {
        uint64_t a, b, d, e;
        memcpy(&a, p + i, 8);
        memcpy(&b, p + i + 8, 8);
        memcpy(&d, p + i + 16, 8);
        memcpy(&e, p + i + 24, 8);
        if ((a | b | d | e) & 0x8080808080808080ull)
            return 0;
    }
    for (; i < len; i++)
        acc |= p[i];
    return !(acc & 0x80);
}

static const char B64[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
static const char B64URL[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

// The string of bytes p[..len] in encoding `enc` (as Buffer's toString), or
// a Buffer of them for ENC_BUFFER. `owned` (js_malloc'd, or NULL) is taken.
static JSValue encode_bytes(JSContext *c, const uint8_t *p, size_t len, int enc, uint8_t *owned) {
    JSValue r;
    switch (enc) {
    case ENC_BUFFER:
        if (owned)
            return new_buffer(c, owned, NULL, len);
        return new_buffer(c, NULL, p, len);
    case ENC_LATIN1:
        r = JS_NewStringLatin1(c, p, len);
        break;
    case ENC_UCS2:
    case ENC_UTF16LE: {
        size_t n = len / 2;
        uint16_t *u = js_malloc(c, n * 2 + 2);
        if (!u) {
            r = JS_EXCEPTION;
            break;
        }
        for (size_t i = 0; i < n; i++)
            u[i] = (uint16_t)(p[2 * i] | (p[2 * i + 1] << 8));
        r = JS_NewStringUTF16(c, u, n);
        js_free(c, u);
        break;
    }
    case ENC_ASCII:
    case ENC_HEX:
    case ENC_BASE64:
    case ENC_BASE64URL: {
        size_t cap = enc == ENC_ASCII ? len : enc == ENC_HEX ? len * 2 : (len + 2) / 3 * 4;
        char *o = js_malloc(c, cap + 1);
        if (!o) {
            r = JS_EXCEPTION;
            break;
        }
        size_t n = 0;
        if (enc == ENC_ASCII) {
            for (size_t i = 0; i < len; i++)
                o[n++] = (char)(p[i] & 0x7f);
        } else if (enc == ENC_HEX) {
            static const char H[] = "0123456789abcdef";
            for (size_t i = 0; i < len; i++) {
                o[n++] = H[p[i] >> 4];
                o[n++] = H[p[i] & 15];
            }
        } else {
            const char *t = enc == ENC_BASE64 ? B64 : B64URL;
            size_t i = 0;
            for (; i + 2 < len; i += 3) {
                uint32_t v = (uint32_t)p[i] << 16 | (uint32_t)p[i + 1] << 8 | p[i + 2];
                o[n++] = t[v >> 18];
                o[n++] = t[(v >> 12) & 63];
                o[n++] = t[(v >> 6) & 63];
                o[n++] = t[v & 63];
            }
            if (i < len) {
                uint32_t v = (uint32_t)p[i] << 16 | (i + 1 < len ? (uint32_t)p[i + 1] << 8 : 0);
                o[n++] = t[v >> 18];
                o[n++] = t[(v >> 12) & 63];
                if (i + 1 < len)
                    o[n++] = t[(v >> 6) & 63];
                else if (enc == ENC_BASE64)
                    o[n++] = '=';
                if (enc == ENC_BASE64)
                    o[n++] = '=';
            }
        }
        r = JS_NewStringLen(c, o, n);
        js_free(c, o);
        break;
    }
    default: { // UTF-8, invalid sequences as U+FFFD
        size_t err;
        if (len == 0) {
            r = JS_NewStringLen(c, "", 0);
        } else if (is_ascii(p, len)) {
            // (A copy: the engine's UTF-8 reading goes a byte at a time.)
            r = JS_NewStringLatin1(c, p, len);
        } else if (beyond_rt_utf8_valid(p, len, &err) == len) {
            r = JS_NewStringLen(c, (const char *)p, len);
        } else {
            uint8_t *o = js_malloc(c, 3 * len);
            if (!o) {
                r = JS_EXCEPTION;
                break;
            }
            size_t n = beyond_rt_utf8_lossy(p, len, o);
            r = JS_NewStringLen(c, (const char *)o, n);
            js_free(c, o);
        }
    }
    }
    if (owned)
        js_free(c, owned);
    return r;
}

// fsEncode(bytes, encoding): the string (or Buffer) of a Uint8Array's bytes.
static JSValue js_fs_encode(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    size_t len;
    uint8_t *p = JS_GetUint8Array(c, &len, argv[0]);
    int32_t enc;
    if (!p || to_i32(c, argv[1], &enc))
        return JS_EXCEPTION;
    return encode_bytes(c, p, len, enc, NULL);
}

// ---- Stats ----

typedef struct {
    uint64_t dev, ino, mode, nlink, uid, gid, rdev, size, blksize, blocks;
    int64_t ts[8]; // atime, mtime, ctime, birthtime: sec, nsec each
} FsStat;

static int statx_works = 1;

static uint64_t statx_makedev(uint32_t major, uint32_t minor) {
    uint64_t maj = major & 0xFFF, min = minor & 0xFFFFF;
    return (maj << 8) | (min & 0xFF) | ((min & 0xFFF00) << 12);
}

static void from_stat(const struct stat *st, FsStat *s) {
    s->dev = st->st_dev;
    s->ino = st->st_ino;
    s->mode = st->st_mode;
    s->nlink = st->st_nlink;
    s->uid = st->st_uid;
    s->gid = st->st_gid;
    s->rdev = st->st_rdev;
    s->size = (uint64_t)st->st_size;
    s->blksize = (uint64_t)st->st_blksize;
    s->blocks = (uint64_t)st->st_blocks;
    s->ts[0] = st->st_atim.tv_sec, s->ts[1] = st->st_atim.tv_nsec;
    s->ts[2] = st->st_mtim.tv_sec, s->ts[3] = st->st_mtim.tv_nsec;
    s->ts[4] = st->st_ctim.tv_sec, s->ts[5] = st->st_ctim.tv_nsec;
    // (Linux's stat has no birth time: libuv's, the change time.)
    s->ts[6] = st->st_ctim.tv_sec, s->ts[7] = st->st_ctim.tv_nsec;
}

// stat, lstat (AT_SYMLINK_NOFOLLOW) or fstat (AT_EMPTY_PATH) by statx, as
// Bun's (falling back on stat where libuv does): 0, or -1 and errno.
static int do_stat(int dirfd, const char *path, int flags, FsStat *s) {
    if (statx_works) {
        struct statx sx;
        int r;
        do
            r = statx(dirfd, path, flags, STATX_BASIC_STATS | STATX_BTIME, &sx);
        while (r < 0 && errno == EINTR);
        if (r == 0) {
            s->dev = statx_makedev(sx.stx_dev_major, sx.stx_dev_minor);
            s->ino = sx.stx_ino;
            s->mode = sx.stx_mode;
            s->nlink = sx.stx_nlink;
            s->uid = sx.stx_uid;
            s->gid = sx.stx_gid;
            s->rdev = statx_makedev(sx.stx_rdev_major, sx.stx_rdev_minor);
            s->size = sx.stx_size;
            s->blksize = sx.stx_blksize;
            s->blocks = sx.stx_blocks;
            s->ts[0] = sx.stx_atime.tv_sec, s->ts[1] = sx.stx_atime.tv_nsec;
            s->ts[2] = sx.stx_mtime.tv_sec, s->ts[3] = sx.stx_mtime.tv_nsec;
            s->ts[4] = sx.stx_ctime.tv_sec, s->ts[5] = sx.stx_ctime.tv_nsec;
            if (sx.stx_mask & STATX_BTIME)
                s->ts[6] = sx.stx_btime.tv_sec, s->ts[7] = sx.stx_btime.tv_nsec;
            else
                s->ts[6] = 0, s->ts[7] = 0;
            return 0;
        }
        if (r < 0 && errno != ENOSYS && errno != EOPNOTSUPP && errno != EPERM && errno != EINVAL)
            return -1;
        statx_works = 0;
    }
    struct stat st;
    int r;
    if (flags & AT_EMPTY_PATH)
        r = fstat(dirfd, &st);
    else
        r = fstatat(dirfd, path, &st, flags & AT_SYMLINK_NOFOLLOW);
    if (r < 0)
        return -1;
    from_stat(&st, s);
    return 0;
}

static JSValue u64_number(JSContext *c, uint64_t v) {
    return v <= INT32_MAX ? JS_NewInt32(c, (int32_t)v) : JS_NewFloat64(c, (double)v);
}

static JSValue make_stats(JSContext *c, const FsStat *s, int big) {
    JSValue v[18];
    const uint64_t *f = &s->dev;
    if (!big) {
        if (!shapes[SHAPE_STATS])
            return JS_ThrowInternalError(c, "fsInit was not called");
        for (int i = 0; i < 10; i++)
            v[i] = u64_number(c, f[i]);
        for (int i = 0; i < 4; i++)
            v[10 + i] = JS_NewFloat64(c, (double)s->ts[2 * i] * 1000.0 + (double)s->ts[2 * i + 1] / 1000000.0);
        return JS_NewObjectWithCachedShape(c, shapes[SHAPE_STATS], v);
    }
    if (!shapes[SHAPE_BIGSTATS])
        return JS_ThrowInternalError(c, "fsInit was not called");
    for (int i = 0; i < 10; i++)
        v[i] = JS_NewBigInt64(c, (int64_t)f[i]);
    for (int i = 0; i < 4; i++) {
        int64_t ns = s->ts[2 * i] * 1000000000 + s->ts[2 * i + 1];
        v[10 + i] = JS_NewBigInt64(c, ns / 1000000);
        v[14 + i] = JS_NewBigInt64(c, ns);
    }
    return JS_NewObjectWithCachedShape(c, shapes[SHAPE_BIGSTATS], v);
}

// fsStat(path, lstat, bigint, throwIfNoEntry): Stats, or undefined when it
// does not exist and need not.
static JSValue js_fs_stat(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    Path p;
    int r = get_path(c, argv[0], &p);
    if (r)
        return path_fail(r);
    int l = JS_ToBool(c, argv[1]);
    FsStat s;
    if (do_stat(AT_FDCWD, p.p, l ? AT_SYMLINK_NOFOLLOW : 0, &s) < 0) {
        if (errno == ENOENT && !JS_ToBool(c, argv[3])) {
            free_path(c, &p);
            return JS_UNDEFINED;
        }
        return throw_path(c, errno, l ? "lstat" : "stat", &p);
    }
    free_path(c, &p);
    return make_stats(c, &s, JS_ToBool(c, argv[2]));
}

// fsFstat(fd, bigint).
static JSValue js_fs_fstat(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    int32_t fd;
    if (to_i32(c, argv[0], &fd))
        return JS_EXCEPTION;
    FsStat s;
    if (do_stat(fd, "", AT_EMPTY_PATH, &s) < 0)
        return throw_sys(c, errno, "fstat", NULL, NULL, -1, 0);
    return make_stats(c, &s, JS_ToBool(c, argv[1]));
}

// fsStatfs(path, bigint).
static JSValue js_fs_statfs(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    Path p;
    int r = get_path(c, argv[0], &p);
    if (r)
        return path_fail(r);
    struct statfs sf;
    if (statfs(p.p, &sf) < 0)
        return throw_path(c, errno, "statfs", &p);
    free_path(c, &p);
    int64_t f[8] = {(int64_t)sf.f_type, (int64_t)sf.f_bsize, (int64_t)sf.f_frsize, (int64_t)sf.f_blocks,
                    (int64_t)sf.f_bfree, (int64_t)sf.f_bavail, (int64_t)sf.f_files, (int64_t)sf.f_ffree};
    JSValue v[8];
    int big = JS_ToBool(c, argv[1]);
    void *shape = shapes[big ? SHAPE_BIGSTATFS : SHAPE_STATFS];
    if (!shape)
        return JS_ThrowInternalError(c, "fsInit was not called");
    for (int i = 0; i < 8; i++)
        v[i] = big ? JS_NewBigInt64(c, f[i]) : JS_NewInt64(c, f[i]);
    return JS_NewObjectWithCachedShape(c, shape, v);
}

// fsInit(BufferPrototype, DirentPrototype, statsTemplate, bigIntStatsTemplate,
// statFsTemplate, bigIntStatFsTemplate): the objects natives make are of
// the templates' shapes (and a Dirent of name, path, its type under a
// symbol only native code sees, parentPath).
static JSValue js_fs_init(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    static const int counts[4] = {14, 18, 8, 8};
    if (!marking) {
        if (JS_AddGCMarkHook(JS_GetRuntime(c), fs_mark, NULL) < 0)
            return JS_ThrowOutOfMemory(c);
        marking = 1;
    }
    JS_FreeValue(c, buffer_proto);
    buffer_proto = JS_DupValue(c, argv[0]);
    JS_FreeValue(c, dirent_proto);
    dirent_proto = JS_DupValue(c, argv[1]);
    for (int i = 0; i < 4; i++) {
        JS_FreeValue(c, templates[i]);
        templates[i] = JS_DupValue(c, argv[2 + i]);
        if (JS_CachePlainShape(c, templates[i], counts[i], &shapes[i]) < 0)
            return JS_ThrowTypeError(c, "fsInit: template %d is not a plain object of %d properties", i, counts[i]);
    }
    if (JS_IsUndefined(dirent_type)) {
        dirent_type = JS_NewPrivateSymbol(c, "type");
        dirent_type_atom = JS_ValueToAtom(c, dirent_type);
    }
    JSValue t = JS_NewObjectProto(c, dirent_proto);
    if (JS_IsException(t))
        return t;
    JS_DefinePropertyValueStr(c, t, "name", JS_UNDEFINED, JS_PROP_C_W_E);
    JS_DefinePropertyValueStr(c, t, "path", JS_UNDEFINED, JS_PROP_C_W_E);
    JS_DefinePropertyValue(c, t, dirent_type_atom, JS_UNDEFINED, JS_PROP_C_W_E);
    JS_DefinePropertyValueStr(c, t, "parentPath", JS_UNDEFINED, JS_PROP_C_W_E);
    JS_FreeValue(c, templates[4]);
    templates[4] = t;
    if (JS_CachePlainShape(c, t, 4, &shapes[SHAPE_DIRENT]) < 0)
        return JS_ThrowTypeError(c, "fsInit: the Dirent template's shape cannot be cached");
    return JS_UNDEFINED;
}

// ---- Dirent ----

static JSValue new_dirent(JSContext *c, JSValue name, int type, JSValueConst path) {
    JSValue v[4] = {name, JS_DupValue(c, path), JS_NewInt32(c, type), JS_DupValue(c, path)};
    return JS_NewObjectWithCachedShape(c, shapes[SHAPE_DIRENT], v);
}

// fsMakeDirent(prototype, name, type, path): `new Dirent(name, type, path)`.
static JSValue js_fs_make_dirent(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    if (JS_IsObject(argv[0]) && JS_IsSameValue(c, argv[0], dirent_proto) && shapes[SHAPE_DIRENT]) {
        JSValue v[4] = {JS_DupValue(c, argv[1]), JS_DupValue(c, argv[3]), JS_DupValue(c, argv[2]),
                        JS_DupValue(c, argv[3])};
        return JS_NewObjectWithCachedShape(c, shapes[SHAPE_DIRENT], v);
    }
    JSValue o = JS_NewObjectProto(c, JS_IsObject(argv[0]) ? argv[0] : dirent_proto);
    if (JS_IsException(o))
        return o;
    if (JS_DefinePropertyValueStr(c, o, "name", JS_DupValue(c, argv[1]), JS_PROP_C_W_E) < 0 ||
        JS_DefinePropertyValueStr(c, o, "path", JS_DupValue(c, argv[3]), JS_PROP_C_W_E) < 0 ||
        JS_DefinePropertyValue(c, o, dirent_type_atom, JS_DupValue(c, argv[2]), JS_PROP_C_W_E) < 0 ||
        JS_DefinePropertyValueStr(c, o, "parentPath", JS_DupValue(c, argv[3]), JS_PROP_C_W_E) < 0) {
        JS_FreeValue(c, o);
        return JS_EXCEPTION;
    }
    return o;
}

// fsDirentType(dirent): its type (libuv's UV_DIRENT_*), or -1.
static JSValue js_fs_dirent_type(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    if (!JS_IsObject(argv[0]) || JS_IsUndefined(dirent_type))
        return JS_NewInt32(c, -1);
    JSValue t = JS_GetProperty(c, argv[0], dirent_type_atom);
    if (JS_IsException(t))
        return t;
    if (JS_VALUE_GET_TAG(t) == JS_TAG_INT)
        return t;
    double d;
    int32_t r = -1;
    if (JS_IsNumber(t) && JS_ToFloat64(c, &d, t) == 0 && d == (int32_t)d)
        r = (int32_t)d;
    JS_FreeValue(c, t);
    return JS_NewInt32(c, r);
}

// ---- Files ----

static int open_retry(const char *path, int flags, int mode) {
    int fd;
    do
        fd = open(path, flags | O_CLOEXEC, mode);
    while (fd < 0 && errno == EINTR);
    return fd;
}

// fsOpen(path, flags, mode): the fd.
static JSValue js_fs_open(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    Path p;
    int32_t flags, mode;
    int r = get_path(c, argv[0], &p);
    if (r)
        return path_fail(r);
    if (to_i32(c, argv[1], &flags) || to_i32(c, argv[2], &mode)) {
        free_path(c, &p);
        return JS_EXCEPTION;
    }
    int fd = open_retry(p.p, flags, mode);
    if (fd < 0)
        return throw_path(c, errno, "open", &p);
    free_path(c, &p);
    return JS_NewInt32(c, fd);
}

// fsClose(fd).
static JSValue js_fs_close(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    int32_t fd;
    if (to_i32(c, argv[0], &fd))
        return JS_EXCEPTION;
    if (close(fd) < 0 && errno != EINTR)
        return throw_sys(c, errno, "close", NULL, NULL, fd, 0);
    return JS_UNDEFINED;
}

// fsRead(fd, uint8array, offset, length, position): the bytes read
// (pread at a position >= 0).
static JSValue js_fs_read(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    int32_t fd;
    size_t size;
    int64_t off, len, pos;
    if (to_i32(c, argv[0], &fd))
        return JS_EXCEPTION;
    uint8_t *b = JS_GetUint8Array(c, &size, argv[1]);
    if (!b && size == 0 && JS_HasException(c))
        return JS_EXCEPTION;
    if (JS_ToInt64(c, &off, argv[2]) || JS_ToInt64(c, &len, argv[3]) || to_pos(c, argv[4], &pos))
        return JS_EXCEPTION;
    if (off < 0 || len < 0 || (uint64_t)off > size || (uint64_t)len > size - (uint64_t)off)
        return JS_ThrowRangeError(c, "read out of the buffer's bounds");
    ssize_t n;
    do
        n = pos >= 0 ? pread(fd, b + off, len, pos) : read(fd, b + off, len);
    while (n < 0 && errno == EINTR);
    if (n < 0)
        return throw_sys(c, errno, "read", NULL, NULL, pos >= 0 ? fd : -1, 0);
    return JS_NewInt64(c, n);
}

// fsWrite(fd, uint8array, offset, length, position): the bytes written
// (one write, as Bun's); the length -1: the rest of the buffer. Null when
// the offset is past the buffer's end, or the length past it or 2^31 - 1.
static JSValue js_fs_write(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    int32_t fd;
    size_t size;
    int64_t off, len, pos;
    if (to_i32(c, argv[0], &fd))
        return JS_EXCEPTION;
    uint8_t *b = JS_GetUint8Array(c, &size, argv[1]);
    if (!b && size == 0 && JS_HasException(c))
        return JS_EXCEPTION;
    if (JS_ToInt64(c, &off, argv[2]) || JS_ToInt64(c, &len, argv[3]) || to_pos(c, argv[4], &pos))
        return JS_EXCEPTION;
    if (off < 0 || (uint64_t)off > size)
        return JS_NULL;
    if (len == -1)
        len = (int64_t)(size - (uint64_t)off);
    else if (len < 0 || len > INT32_MAX || (uint64_t)len > size - (uint64_t)off)
        return JS_NULL;
    ssize_t n;
    do
        n = pos >= 0 ? pwrite(fd, b + off, len, pos) : write(fd, b + off, len);
    while (n < 0 && errno == EINTR);
    if (n < 0)
        return throw_sys(c, errno, "write", NULL, NULL, pos >= 0 ? fd : -1, 0);
    return JS_NewInt64(c, n);
}

// fsWriteString(fd, string, position): writes its UTF-8 (lone surrogates
// as U+FFFD); the bytes written.
static JSValue js_fs_write_string(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    int32_t fd;
    int64_t pos;
    size_t len;
    if (to_i32(c, argv[0], &fd) || to_pos(c, argv[2], &pos))
        return JS_EXCEPTION;
    const char *s = JS_ToCStringLen(c, &len, argv[1]);
    if (!s)
        return JS_EXCEPTION;
    beyond_rt_wtf8_fix((uint8_t *)s, len);
    ssize_t n;
    do
        n = pos >= 0 ? pwrite(fd, s, len, pos) : write(fd, s, len);
    while (n < 0 && errno == EINTR);
    JS_FreeCString(c, s);
    if (n < 0)
        return throw_sys(c, errno, "write", NULL, NULL, pos >= 0 ? fd : -1, 0);
    return JS_NewInt64(c, n);
}

// The iovecs of an array of Uint8Arrays (at most IOV_MAX): their count, or
// -1 with an exception.
static int get_iovecs(JSContext *c, JSValueConst arr, struct iovec *iov, int max) {
    int64_t n;
    if (JS_GetLength(c, arr, &n))
        return -1;
    if (n > max)
        n = max;
    for (int64_t i = 0; i < n; i++) {
        JSValue v = JS_GetPropertyUint32(c, arr, (uint32_t)i);
        if (JS_IsException(v))
            return -1;
        size_t len;
        uint8_t *b = JS_GetUint8Array(c, &len, v);
        JS_FreeValue(c, v);
        if (!b && JS_HasException(c))
            return -1;
        iov[i].iov_base = b;
        iov[i].iov_len = len;
    }
    return (int)n;
}

// fsReadv(fd, buffers, position), fsWritev(fd, buffers, position).
static JSValue js_fs_rwv(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv, int magic) {
    int32_t fd;
    int64_t pos;
    if (to_i32(c, argv[0], &fd) || to_pos(c, argv[2], &pos))
        return JS_EXCEPTION;
    struct iovec stack_iov[64], *iov = stack_iov;
    int64_t n;
    if (JS_GetLength(c, argv[1], &n))
        return JS_EXCEPTION;
    if (n > 64) {
        iov = js_malloc(c, sizeof *iov * (n > IOV_MAX ? IOV_MAX : n));
        if (!iov)
            return JS_EXCEPTION;
    }
    int cnt = get_iovecs(c, argv[1], iov, IOV_MAX);
    if (cnt < 0) {
        if (iov != stack_iov)
            js_free(c, iov);
        return JS_EXCEPTION;
    }
    ssize_t r;
    do {
        if (magic)
            r = pos >= 0 ? pwritev(fd, iov, cnt, pos) : writev(fd, iov, cnt);
        else
            r = pos >= 0 ? preadv(fd, iov, cnt, pos) : readv(fd, iov, cnt);
    } while (r < 0 && errno == EINTR);
    if (iov != stack_iov)
        js_free(c, iov);
    if (r < 0) {
        // (Bun's: no fd on pwritev's error.)
        const char *sc = magic ? (pos >= 0 ? "pwritev" : "writev") : (pos >= 0 ? "preadv" : "readv");
        return throw_sys(c, errno, sc, NULL, NULL, magic && pos >= 0 ? -1 : fd, 0);
    }
    return JS_NewInt64(c, r);
}

// ---- Whole files ----

#define SCRATCH_SIZE (256 * 1024)
static uint8_t *scratch;

static ssize_t read_retry(int fd, void *b, size_t n) {
    ssize_t r;
    do
        r = read(fd, b, n);
    while (r < 0 && errno == EINTR);
    return r;
}

// The rest of a file (`total` bytes of it, read into the scratch buffer,
// first; about `size` bytes in all, as fstat said) as a string of Latin-1
// or UTF-8 (`enc`): its bytes read into an 8-bit string, which is the
// result if they are Latin-1 or ASCII, else what they decode to. An errno
// in *no (ENOMEM past the limit of a string), JS_EXCEPTION.
static JSValue read_into_string(JSContext *c, int fd, size_t total, off_t size, int enc, int *no) {
    size_t cap = (size_t)(size > (off_t)total ? size : (off_t)total) + 1;
    const size_t limit = (1u << 30) - 1;
    if (cap > limit)
        cap = limit;
    uint8_t *b;
    JSValue str = JS_NewStringUninit(c, cap, 0, (void **)&b);
    if (JS_IsException(str))
        return str;
    memcpy(b, scratch, total);
    for (;;) {
        if (total == cap) {
            // (It grew: a string of room for more, the bytes so far copied.)
            if (cap == limit) {
                JS_FreeValue(c, str);
                *no = ENOMEM;
                return JS_EXCEPTION;
            }
            size_t ncap = cap + (cap >> 1) + 8192;
            if (ncap > limit)
                ncap = limit;
            uint8_t *nb;
            JSValue bigger = JS_NewStringUninit(c, ncap, 0, (void **)&nb);
            if (JS_IsException(bigger)) {
                JS_FreeValue(c, str);
                return bigger;
            }
            memcpy(nb, b, total);
            JS_FreeValue(c, str);
            str = bigger;
            b = nb;
            cap = ncap;
        }
        ssize_t n = read_retry(fd, b + total, cap - total);
        if (n < 0) {
            *no = errno;
            JS_FreeValue(c, str);
            return JS_EXCEPTION;
        }
        if (n == 0)
            break;
        total += n;
    }
    JS_ShrinkNewString(c, str, total);
    if (enc == ENC_LATIN1 || is_ascii(b, total))
        return str;
    JSValue r = encode_bytes(c, b, total, enc, NULL);
    JS_FreeValue(c, str);
    return r;
}

// fsReadFile(pathOrFd, flags, encoding): the file's content, decoded.
static JSValue js_fs_read_file(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    Path p;
    int32_t flags, enc, fd;
    int is_path = !JS_IsNumber(argv[0]);
    if (to_i32(c, argv[1], &flags) || to_i32(c, argv[2], &enc))
        return JS_EXCEPTION;
    if (is_path) {
        int r = get_path(c, argv[0], &p);
        if (r)
            return path_fail(r);
        fd = open_retry(p.p, flags | O_NOCTTY, 0666);
        if (fd < 0)
            return throw_path(c, errno, "open", &p);
    } else if (to_i32(c, argv[0], &fd)) {
        return JS_EXCEPTION;
    }
    if (!scratch && !(scratch = malloc(SCRATCH_SIZE))) {
        if (is_path) {
            close(fd);
            free_path(c, &p);
        }
        return JS_ThrowOutOfMemory(c);
    }
    // Up to 256 KB before a stat, which a file that fits needs not (as Bun).
    size_t total = 0;
    int eof = 0;
    while (total < SCRATCH_SIZE) {
        ssize_t n = read_retry(fd, scratch + total, SCRATCH_SIZE - total);
        if (n < 0)
            goto read_error;
        if (n == 0) {
            eof = 1;
            break;
        }
        total += n;
    }
    if (eof) {
        if (is_path) {
            close(fd);
            free_path(c, &p);
        }
        return encode_bytes(c, scratch, total, enc, NULL);
    }
    {
        struct stat st;
        if (fstat(fd, &st) < 0) {
            int no = errno;
            if (is_path) {
                close(fd);
                free_path(c, &p);
            }
            return throw_sys(c, no, "fstat", NULL, NULL, -1, 0);
        }
        if (enc == ENC_UTF8 || enc == ENC_LATIN1) {
            // (Read straight into an 8-bit string: kept if Latin-1 or
            // ASCII, else decoded from it as UTF-8.)
            int no = 0;
            JSValue r = read_into_string(c, fd, total, st.st_size, enc, &no);
            if (is_path) {
                close(fd);
                ErrPath ep = err_path(&p);
                if (no)
                    r = throw_sys(c, no, "read", no == ENOMEM ? &ep : NULL, NULL, -1, 0);
                free_path(c, &p);
            } else if (no) {
                r = throw_sys(c, no, "read", NULL, NULL, -1, 0);
            }
            return r;
        }
        size_t cap = (size_t)(st.st_size > (off_t)total ? st.st_size : (off_t)total) + 16;
        uint8_t *buf = js_malloc(c, cap);
        if (!buf)
            goto oom;
        memcpy(buf, scratch, total);
        for (;;) {
            if (total == cap) {
                size_t ncap = cap + (cap >> 1) + 8192;
                uint8_t *nb = js_realloc(c, buf, ncap);
                if (!nb) {
                    js_free(c, buf);
                    goto oom;
                }
                buf = nb;
                cap = ncap;
            }
            ssize_t n = read_retry(fd, buf + total, cap - total);
            if (n < 0) {
                js_free(c, buf);
                goto read_error;
            }
            if (n == 0)
                break;
            total += n;
            if (total > (enc == ENC_BUFFER ? (size_t)INT32_MAX : (size_t)(1 << 30) - 1)) {
                js_free(c, buf);
                if (is_path) {
                    close(fd);
                    ErrPath ep = err_path(&p);
                    JSValue e = throw_sys(c, ENOMEM, "read", &ep, NULL, -1, 0);
                    free_path(c, &p);
                    return e;
                }
                return throw_sys(c, ENOMEM, "read", NULL, NULL, -1, 0);
            }
        }
        if (is_path) {
            close(fd);
            free_path(c, &p);
        }
        if (enc == ENC_BUFFER)
            return new_buffer(c, buf, NULL, total);
        return encode_bytes(c, buf, total, enc, buf);
    }
read_error: {
    int no = errno;
    if (is_path) {
        close(fd);
        free_path(c, &p);
    }
    return throw_sys(c, no, "read", NULL, NULL, -1, 0);
}
oom:
    if (is_path) {
        close(fd);
        free_path(c, &p);
    }
    return JS_ThrowOutOfMemory(c);
}

// fsWriteFile(pathOrFd, data, flags, mode, flush): writes a string's UTF-8
// or a Uint8Array's bytes, the whole of them.
static JSValue js_fs_write_file(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    Path p;
    int32_t flags, mode, fd;
    int is_path = !JS_IsNumber(argv[0]);
    if (to_i32(c, argv[2], &flags) || to_i32(c, argv[3], &mode))
        return JS_EXCEPTION;
    const uint8_t *data;
    size_t len;
    const char *str = NULL;
    if (JS_IsString(argv[1])) {
        str = JS_ToCStringLen(c, &len, argv[1]);
        if (!str)
            return JS_EXCEPTION;
        beyond_rt_wtf8_fix((uint8_t *)str, len);
        data = (const uint8_t *)str;
    } else {
        data = JS_GetUint8Array(c, &len, argv[1]);
        if (!data && JS_HasException(c))
            return JS_EXCEPTION;
    }
    if (is_path) {
        int r = get_path(c, argv[0], &p);
        if (r) {
            if (str)
                JS_FreeCString(c, str);
            return path_fail(r);
        }
        // As Bun: O_TRUNC is left out (rewriting the file in place, it
        // keeps its blocks, and ext4 does not flush it at close as it does
        // a file truncated then written), the file cut to what was written
        // after.
        fd = open_retry(p.p, (flags & O_APPEND) ? flags : flags & ~O_TRUNC, mode);
        if (fd < 0) {
            if (str)
                JS_FreeCString(c, str);
            return throw_path(c, errno, "open", &p);
        }
        free_path(c, &p);
    } else if (to_i32(c, argv[0], &fd)) {
        if (str)
            JS_FreeCString(c, str);
        return JS_EXCEPTION;
    }
    size_t done = 0;
    int no = 0;
    while (done < len) {
        ssize_t n = write(fd, data + done, len - done);
        if (n < 0) {
            if (errno == EINTR)
                continue;
            no = errno;
            break;
        }
        if (n == 0)
            break;
        done += n;
    }
    if (str)
        JS_FreeCString(c, str);
    if (is_path && (flags & O_TRUNC) && !(flags & O_APPEND)) {
        int r;
        do
            r = ftruncate(fd, (off_t)done);
        while (r < 0 && errno == EINTR);
    }
    if (!no && JS_ToBool(c, argv[4]))
        fsync(fd);
    if (is_path)
        close(fd);
    if (no)
        return throw_sys(c, no, "write", NULL, NULL, -1, 0);
    return JS_UNDEFINED;
}

// ---- Paths ----

// fsAccess(path, mode).
static JSValue js_fs_access(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    Path p;
    int32_t mode;
    int r = get_path(c, argv[0], &p);
    if (r)
        return path_fail(r);
    if (to_i32(c, argv[1], &mode)) {
        free_path(c, &p);
        return JS_EXCEPTION;
    }
    if (access(p.p, mode) < 0)
        return throw_path(c, errno, "access", &p);
    free_path(c, &p);
    return JS_UNDEFINED;
}

// fsExists(path): whether it exists.
static JSValue js_fs_exists(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    Path p;
    int r = get_path(c, argv[0], &p);
    if (r)
        return path_fail(r);
    int ok = access(p.p, F_OK) == 0;
    free_path(c, &p);
    return JS_NewBool(c, ok);
}

// Calls of one path: fsUnlink, fsRmdir, fsChmod(path, mode), fsLchmod,
// fsChown(path, uid, gid), fsLchown, fsTruncate(path, len).
enum { OP_UNLINK, OP_RMDIR, OP_CHMOD, OP_LCHMOD, OP_CHOWN, OP_LCHOWN, OP_TRUNCATE };

static JSValue js_fs_path_op(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv, int magic) {
    Path p;
    int r = get_path(c, argv[0], &p);
    if (r)
        return path_fail(r);
    int64_t a = 0, b = 0;
    if ((magic >= OP_CHMOD && JS_ToInt64(c, &a, argv[1])) || ((magic == OP_CHOWN || magic == OP_LCHOWN) && JS_ToInt64(c, &b, argv[2]))) {
        free_path(c, &p);
        return JS_EXCEPTION;
    }
    const char *sc;
    switch (magic) {
    case OP_UNLINK:
        r = unlink(p.p), sc = "unlink";
        break;
    case OP_RMDIR:
        r = rmdir(p.p), sc = "rmdir";
        break;
    case OP_CHMOD:
        r = chmod(p.p, (mode_t)a), sc = "chmod";
        break;
    case OP_LCHMOD:
        r = fchmodat(AT_FDCWD, p.p, (mode_t)a, AT_SYMLINK_NOFOLLOW), sc = "lchmod";
        break;
    case OP_CHOWN:
        r = chown(p.p, (uid_t)a, (gid_t)b), sc = "chown";
        break;
    case OP_LCHOWN:
        r = lchown(p.p, (uid_t)a, (gid_t)b), sc = "lchown";
        break;
    default:
        r = truncate(p.p, a & INT64_MAX), sc = "truncate";
    }
    if (r < 0)
        return throw_path(c, errno, sc, &p);
    free_path(c, &p);
    return JS_UNDEFINED;
}

// Calls of an fd: fsFsync, fsFdatasync, fsFchmod(fd, mode), fsFchown(fd,
// uid, gid), fsFtruncate(fd, len).
enum { OP_FSYNC, OP_FDATASYNC, OP_FCHMOD, OP_FCHOWN, OP_FTRUNCATE };

static JSValue js_fs_fd_op(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv, int magic) {
    int32_t fd;
    int64_t a = 0, b = 0;
    if (to_i32(c, argv[0], &fd) || (magic >= OP_FCHMOD && JS_ToInt64(c, &a, argv[1])) ||
        (magic == OP_FCHOWN && JS_ToInt64(c, &b, argv[2])))
        return JS_EXCEPTION;
    int r;
    const char *sc;
    int efd = -1;
    switch (magic) {
    case OP_FSYNC:
        r = fsync(fd), sc = "fsync";
        break;
    case OP_FDATASYNC:
        r = fdatasync(fd), sc = "fdatasync", efd = fd;
        break;
    case OP_FCHMOD:
        r = fchmod(fd, (mode_t)a), sc = "fchmod";
        break;
    case OP_FCHOWN:
        r = fchown(fd, (uid_t)a, (gid_t)b), sc = "fchown";
        break;
    default:
        do
            r = ftruncate(fd, a & INT64_MAX);
        while (r < 0 && errno == EINTR);
        sc = "ftruncate";
    }
    if (r < 0)
        return throw_sys(c, errno, sc, NULL, NULL, efd, 0);
    return JS_UNDEFINED;
}

// Calls of two paths: fsRename(from, to), fsLink(existing, new),
// fsSymlink(target, path).
enum { OP_RENAME, OP_LINK, OP_SYMLINK };

static JSValue js_fs_two_paths(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv, int magic) {
    Path *a = js_malloc(c, 2 * sizeof(Path)), *b;
    if (!a)
        return JS_EXCEPTION;
    b = a + 1;
    int r = get_path(c, argv[0], a);
    if (r) {
        js_free(c, a);
        return path_fail(r);
    }
    r = get_path(c, argv[1], b);
    if (r) {
        free_path(c, a);
        js_free(c, a);
        return path_fail(r);
    }
    const char *sc;
    switch (magic) {
    case OP_RENAME:
        r = rename(a->p, b->p), sc = "rename";
        break;
    case OP_LINK:
        r = link(a->p, b->p), sc = "link";
        break;
    default:
        r = symlink(a->p, b->p), sc = "symlink";
    }
    JSValue ret = JS_UNDEFINED;
    if (r < 0) {
        ErrPath ea = err_path(a), eb = err_path(b);
        ret = throw_sys(c, errno, sc, &ea, &eb, -1, 0);
    }
    free_path(c, a);
    free_path(c, b);
    js_free(c, a);
    return ret;
}

// fsUtimes(path, atimeSec, atimeNsec, mtimeSec, mtimeNsec, nofollow),
// fsFutimes(fd, ...): an nsec of -1 is now (UTIME_NOW).
static int get_times(JSContext *c, JSValueConst *argv, struct timespec *ts) {
    for (int i = 0; i < 2; i++) {
        double s, ns;
        if (JS_ToFloat64(c, &s, argv[2 * i]) || JS_ToFloat64(c, &ns, argv[2 * i + 1]))
            return -1;
        ts[i].tv_sec = (time_t)s;
        ts[i].tv_nsec = ns < 0 ? UTIME_NOW : (long)ns;
    }
    return 0;
}

static JSValue js_fs_utimes(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    Path p;
    struct timespec ts[2];
    int r = get_path(c, argv[0], &p);
    if (r)
        return path_fail(r);
    if (get_times(c, argv + 1, ts)) {
        free_path(c, &p);
        return JS_EXCEPTION;
    }
    int l = JS_ToBool(c, argv[5]);
    if (utimensat(AT_FDCWD, p.p, ts, l ? AT_SYMLINK_NOFOLLOW : 0) < 0)
        return throw_path(c, errno, l ? "lutime" : "utime", &p);
    free_path(c, &p);
    return JS_UNDEFINED;
}

static JSValue js_fs_futimes(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    int32_t fd;
    struct timespec ts[2];
    if (to_i32(c, argv[0], &fd) || get_times(c, argv + 1, ts))
        return JS_EXCEPTION;
    if (futimens(fd, ts) < 0)
        return throw_sys(c, errno, "futime", NULL, NULL, -1, 0);
    return JS_UNDEFINED;
}

// fsReadlink(path, encoding).
static JSValue js_fs_readlink(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    Path p;
    int32_t enc;
    int r = get_path(c, argv[0], &p);
    if (r)
        return path_fail(r);
    if (to_i32(c, argv[1], &enc)) {
        free_path(c, &p);
        return JS_EXCEPTION;
    }
    char out[FS_PATH_MAX + 1];
    ssize_t n = readlink(p.p, out, sizeof out - 1);
    if (n < 0)
        return throw_path(c, errno, "readlink", &p);
    free_path(c, &p);
    return encode_bytes(c, (uint8_t *)out, n, enc, NULL);
}

// The lexical resolution of `path` against the working directory (as
// path.resolve): its length in out (FS_PATH_MAX), or -1 when too long.
static ssize_t resolve_path(const char *path, size_t len, char *out) {
    size_t n = 0;
    if (len == 0 || path[0] != '/') {
        if (!getcwd(out, FS_PATH_MAX))
            return -1;
        n = strlen(out);
    }
    if (n == 1 && out[0] == '/')
        n = 0;
    const char *s = path, *end = path + len;
    while (s < end) {
        while (s < end && *s == '/')
            s++;
        const char *e = s;
        while (e < end && *e != '/')
            e++;
        size_t sl = e - s;
        if (sl == 0)
            break;
        if (sl == 1 && s[0] == '.') {
        } else if (sl == 2 && s[0] == '.' && s[1] == '.') {
            while (n > 0 && out[n - 1] != '/')
                n--;
            if (n > 0)
                n--;
        } else {
            if (n + 1 + sl >= FS_PATH_MAX)
                return -1;
            out[n++] = '/';
            memcpy(out + n, s, sl);
            n += sl;
        }
        s = e;
    }
    if (n == 0)
        out[n++] = '/';
    out[n] = 0;
    return (ssize_t)n;
}

// fsRealpath(path, encoding, native): the canonical path (the binding's
// realpath reports errors as lstat's, its native one as realpath's).
static JSValue js_fs_realpath(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    Path p;
    int32_t enc;
    int r = get_path(c, argv[0], &p);
    if (r)
        return path_fail(r);
    if (to_i32(c, argv[1], &enc)) {
        free_path(c, &p);
        return JS_EXCEPTION;
    }
    const char *sc = JS_ToBool(c, argv[2]) ? "realpath" : "lstat";
    char abs[FS_PATH_MAX + 1], out[FS_PATH_MAX + 1];
    if (resolve_path(p.p, p.len, abs) < 0)
        return throw_path(c, ENAMETOOLONG, sc, &p);
    int fd = open_retry(abs, O_PATH, 0);
    if (fd < 0)
        return throw_path(c, errno, sc, &p);
    char proc[64];
    snprintf(proc, sizeof proc, "/proc/self/fd/%d", fd);
    ssize_t n = readlink(proc, out, sizeof out - 1);
    int no = errno;
    close(fd);
    if (n < 0) {
        // (No /proc: the C library's.)
        if (!realpath(abs, out))
            return throw_path(c, no, sc, &p);
        n = strlen(out);
    }
    if (enc == ENC_UTF8 && JS_IsString(p.js) && (size_t)n == p.len && memcmp(out, p.p, n) == 0) {
        free_path(c, &p);
        return JS_DupValue(c, p.js);
    }
    free_path(c, &p);
    return encode_bytes(c, (uint8_t *)out, n, enc, NULL);
}

// ---- Directories ----

// Bun's mkdir with `recursive` (no JavaScript): 0 and in *first the length
// of the first directory made (MKDIR_NONE: none was), or an errno and in
// *err_len the length of its path, of `path`'s bytes (`w`, FS_PATH_MAX + 1
// bytes, is the work buffer).
#define MKDIR_NONE ((size_t)-1)
static int mkdir_recursive_core(const char *path, size_t len, mode_t mode, char *w, size_t *first, size_t *err_len) {
    *err_len = len;
    if (mkdir(path, mode) == 0) {
        *first = len;
        return 0;
    }
    int no = errno;
    if (no == EEXIST || no == EISDIR) {
        struct stat st;
        if (stat(path, &st) == 0 && S_ISDIR(st.st_mode)) {
            *first = MKDIR_NONE;
            return 0;
        }
        return no;
    }
    if (no != ENOENT)
        return no;
    memcpy(w, path, len);
    w[len] = 0;
    size_t i = len - 1;
    // Back up the path until a parent can be made (or exists).
    while (i > 0) {
        if (path[i] == '/') {
            w[i] = 0;
            if (mkdir(w, mode) == 0) {
                w[i] = '/';
                break;
            }
            no = errno;
            w[i] = '/';
            if (no == EEXIST)
                break;
            if (no != ENOENT) {
                *err_len = i;
                return no;
            }
            i--;
            continue;
        }
        i--;
    }
    *first = i;
    // Then forward from it.
    for (i++; i < len; i++) {
        if (path[i] == '/') {
            w[i] = 0;
            if (mkdir(w, mode) < 0 && errno != EEXIST)
                return errno;
            w[i] = '/';
        }
    }
    if (mkdir(w, mode) < 0 && errno != EEXIST)
        return errno;
    return 0;
}

// Bun's mkdir with `recursive`: the first directory made, or undefined.
static JSValue mkdir_recursive(JSContext *c, const char *path, size_t len, mode_t mode, ErrPath *ep) {
    char w[FS_PATH_MAX + 1];
    size_t first, el;
    int no = mkdir_recursive_core(path, len, mode, w, &first, &el);
    if (no) {
        ErrPath pe = {path, el, el == len ? ep->js : JS_UNDEFINED};
        return throw_sys(c, no, "mkdir", &pe, NULL, -1, 0);
    }
    if (first == MKDIR_NONE)
        return JS_UNDEFINED;
    return JS_NewStringLen(c, path, first);
}

// fsMkdir(path, mode, recursive).
static JSValue js_fs_mkdir(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    Path p;
    int32_t mode;
    int r = get_path(c, argv[0], &p);
    if (r)
        return path_fail(r);
    if (to_i32(c, argv[1], &mode)) {
        free_path(c, &p);
        return JS_EXCEPTION;
    }
    if (p.len == 0)
        return throw_path(c, ENOENT, "mkdir", &p);
    JSValue ret = JS_UNDEFINED;
    if (JS_ToBool(c, argv[2])) {
        ErrPath ep = err_path(&p);
        ret = mkdir_recursive(c, p.p, p.len, (mode_t)mode, &ep);
    } else if (mkdir(p.p, (mode_t)mode) < 0) {
        return throw_path(c, errno, "mkdir", &p);
    }
    free_path(c, &p);
    return ret;
}

// fsMkdtemp(prefix, encoding).
static JSValue js_fs_mkdtemp(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    Path p;
    int32_t enc;
    int r = get_path(c, argv[0], &p);
    if (r)
        return path_fail(r);
    if (to_i32(c, argv[1], &enc)) {
        free_path(c, &p);
        return JS_EXCEPTION;
    }
    if (p.len == 0) {
        free_path(c, &p);
        ErrPath ep = {"XXXXX", 5, JS_UNDEFINED};
        return throw_sys(c, EINVAL, "mkdtemp", &ep, NULL, -1, 0);
    }
    char t[FS_PATH_MAX + 8];
    size_t n = p.len < FS_PATH_MAX ? p.len : FS_PATH_MAX;
    memcpy(t, p.p, n);
    memcpy(t + n, "XXXXXX", 7);
    free_path(c, &p);
    if (!mkdtemp(t)) {
        ErrPath ep = {t, n + 6, JS_UNDEFINED};
        return throw_sys(c, errno, "mkdtemp", &ep, NULL, -1, 0);
    }
    return encode_bytes(c, (uint8_t *)t, n + 6, enc, NULL);
}

static int dirent_kind(unsigned char t) {
    switch (t) {
    case DT_REG: return 1;
    case DT_DIR: return 2;
    case DT_LNK: return 3;
    case DT_FIFO: return 4;
    case DT_SOCK: return 5;
    case DT_CHR: return 6;
    case DT_BLK: return 7;
    default: return 0;
    }
}

static int mode_kind(mode_t m) {
    if (S_ISREG(m)) return 1;
    if (S_ISDIR(m)) return 2;
    if (S_ISLNK(m)) return 3;
    if (S_ISFIFO(m)) return 4;
    if (S_ISSOCK(m)) return 5;
    if (S_ISCHR(m)) return 6;
    if (S_ISBLK(m)) return 7;
    return 0;
}

enum { RD_NAMES, RD_DIRENTS, RD_BUFFERS };

// The lexical join of a and b (as Bun's resolve_path join: `.` and `..`
// resolved, slashes collapsed), then its dirname, into out.
static size_t join_dirname(const char *a, size_t al, const char *b, size_t bl, char *out, size_t cap) {
    char tmp[2 * FS_PATH_MAX + 2];
    size_t n = 0;
    if (al + 1 + bl >= sizeof tmp)
        return 0;
    memcpy(tmp, a, al);
    n = al;
    tmp[n++] = '/';
    memcpy(tmp + n, b, bl);
    n += bl;
    // normalize
    int abs = tmp[0] == '/';
    size_t o = 0;
    size_t segs = 0; // segments that `..` can remove
    const char *s = tmp, *end = tmp + n;
    while (s < end) {
        while (s < end && *s == '/')
            s++;
        const char *e = s;
        while (e < end && *e != '/')
            e++;
        size_t sl = e - s;
        if (sl == 0)
            break;
        if (sl == 1 && s[0] == '.') {
        } else if (sl == 2 && s[0] == '.' && s[1] == '.') {
            if (segs > 0) {
                while (o > 0 && out[o - 1] != '/')
                    o--;
                if (o > 0)
                    o--;
                segs--;
            } else if (!abs) {
                if (o + 3 >= cap)
                    return 0;
                if (o > 0)
                    out[o++] = '/';
                out[o++] = '.';
                out[o++] = '.';
            }
        } else {
            if (o + sl + 2 >= cap)
                return 0;
            if (o > 0 || abs)
                out[o++] = '/';
            memcpy(out + o, s, sl);
            o += sl;
            segs++;
        }
        s = e;
    }
    // (o is never 0 here: b names an entry)
    // dirname
    while (o > 0 && out[o - 1] != '/')
        o--;
    if (o > 1)
        o--;
    else if (o == 0) {
        out[o++] = '.';
    }
    out[o] = 0;
    return o;
}

typedef struct {
    char *p;
    size_t len;
} QItem;

// fsReaddir(path, kind, recursive, encoding): the names (strings of the
// encoding, or Buffers), or Dirents, of the directory's entries.
static JSValue js_fs_readdir(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    Path p;
    int32_t kind, enc;
    int r = get_path(c, argv[0], &p);
    if (r)
        return path_fail(r);
    if (to_i32(c, argv[1], &kind) || to_i32(c, argv[3], &enc)) {
        free_path(c, &p);
        return JS_EXCEPTION;
    }
    int recursive = JS_ToBool(c, argv[2]);
    JSValue arr = JS_NewArray(c);
    if (JS_IsException(arr)) {
        free_path(c, &p);
        return arr;
    }
    uint32_t count = 0;
    JSValue dpath = JS_UNDEFINED;
    if (!recursive) {
        int fd = open_retry(p.p, O_DIRECTORY | O_RDONLY, 0);
        DIR *d = fd < 0 ? NULL : fdopendir(fd);
        if (!d) {
            int no = errno;
            if (fd >= 0)
                close(fd);
            JS_FreeValue(c, arr);
            return throw_path(c, no, "scandir", &p);
        }
        if (kind == RD_DIRENTS) {
            dpath = enc == ENC_UTF8 && JS_IsString(p.js) ? JS_DupValue(c, p.js)
                                                         : encode_bytes(c, (const uint8_t *)p.p, p.len, enc, NULL);
            if (JS_IsException(dpath))
                goto fail_dir;
        }
        for (;;) {
            errno = 0;
            struct dirent *e = readdir(d);
            if (!e) {
                if (errno) {
                    int no = errno;
                    closedir(d);
                    JS_FreeValue(c, dpath);
                    JS_FreeValue(c, arr);
                    return throw_path(c, no, "scandir", &p);
                }
                break;
            }
            const char *n = e->d_name;
            if (n[0] == '.' && (n[1] == 0 || (n[1] == '.' && n[2] == 0)))
                continue;
            size_t nl = strlen(n);
            JSValue v;
            if (kind == RD_BUFFERS) {
                v = new_buffer(c, NULL, (const uint8_t *)n, nl);
            } else {
                JSValue name = encode_bytes(c, (const uint8_t *)n, nl, enc, NULL);
                if (kind == RD_DIRENTS && !JS_IsException(name)) {
                    int t = dirent_kind(e->d_type);
                    if (e->d_type == DT_UNKNOWN) {
                        struct stat st;
                        if (fstatat(dirfd(d), n, &st, AT_SYMLINK_NOFOLLOW) == 0)
                            t = mode_kind(st.st_mode);
                    }
                    v = new_dirent(c, name, t, dpath);
                } else {
                    v = name;
                }
            }
            if (JS_IsException(v) || JS_SetPropertyUint32(c, arr, count++, v) < 0) {
            fail_dir:
                closedir(d);
                JS_FreeValue(c, dpath);
                JS_FreeValue(c, arr);
                free_path(c, &p);
                return JS_EXCEPTION;
            }
        }
        closedir(d);
        JS_FreeValue(c, dpath);
        free_path(c, &p);
        return arr;
    }

    // Recursive: breadth first, as Bun's (a queue of paths relative to
    // the root, symbolic links followed as directories).
    QItem *q = NULL;
    size_t qh = 0, qn = 0, qcap = 0;
    int root = -1;
    JSValue err = JS_UNDEFINED;
    char *joinbuf = js_malloc(c, 2 * FS_PATH_MAX + 4);
    char *dbuf = js_malloc(c, 2 * FS_PATH_MAX + 4);
    char *prev = js_malloc(c, 2 * FS_PATH_MAX + 4);
    size_t prevlen = (size_t)-1;
    if (!joinbuf || !dbuf || !prev)
        goto rec_oom;
    for (int first = 1;; first = 0) {
        const char *rel = NULL;
        size_t rl = 0;
        if (!first) {
            if (qh == qn)
                break;
            rel = q[qh].p;
            rl = q[qh].len;
            qh++;
        }
        int fd = first ? open_retry(p.p, O_DIRECTORY | O_RDONLY, 0)
                       : openat(root, rel, O_DIRECTORY | O_RDONLY | O_CLOEXEC);
        if (fd < 0) {
            int no = errno;
            if (first) {
                err = throw_path(c, no, "scandir", &p);
                goto rec_done;
            }
            if (no == ENOENT || no == ENOTDIR || no == EPERM)
                continue;
            err = throw_sys(c, no, "scandir", NULL, NULL, -1, 0);
            goto rec_done;
        }
        if (first)
            root = dup(fd);
        DIR *d = fdopendir(fd);
        if (!d) {
            close(fd);
            err = throw_path(c, errno, "scandir", &p);
            goto rec_done;
        }
        for (;;) {
            errno = 0;
            struct dirent *e = readdir(d);
            if (!e) {
                int no = errno;
                if (no && (first || !(no == ENOENT || no == ENOTDIR || no == EPERM))) {
                    closedir(d);
                    err = throw_path(c, no, "scandir", &p);
                    goto rec_done;
                }
                break;
            }
            const char *n = e->d_name;
            if (n[0] == '.' && (n[1] == 0 || (n[1] == '.' && n[2] == 0)))
                continue;
            size_t nl = strlen(n);
            // The entry's path relative to the root.
            const char *name = n;
            size_t namel = nl;
            if (!first) {
                if (rl + 1 + nl > 2 * FS_PATH_MAX)
                    continue;
                memcpy(joinbuf, rel, rl);
                joinbuf[rl] = '/';
                memcpy(joinbuf + rl + 1, n, nl);
                joinbuf[rl + 1 + nl] = 0;
                name = joinbuf;
                namel = rl + 1 + nl;
            }
            int t = dirent_kind(e->d_type);
            int enqueue = t == 2 || t == 3;
            if (e->d_type == DT_UNKNOWN) {
                struct stat st;
                if (fstatat(dirfd(d), n, &st, AT_SYMLINK_NOFOLLOW) == 0) {
                    t = mode_kind(st.st_mode);
                    enqueue = t == 2 || t == 3;
                }
            }
            if (enqueue && nl + 1 + namel <= FS_PATH_MAX) {
                if (qn == qcap) {
                    size_t ncap = qcap ? qcap * 2 : 16;
                    QItem *nq = js_realloc(c, q, ncap * sizeof *q);
                    if (!nq) {
                        closedir(d);
                        goto rec_oom;
                    }
                    q = nq;
                    qcap = ncap;
                }
                char *copy = js_malloc(c, namel + 1);
                if (!copy) {
                    closedir(d);
                    goto rec_oom;
                }
                memcpy(copy, name, namel + 1);
                q[qn].p = copy;
                q[qn].len = namel;
                qn++;
            }
            JSValue v;
            if (kind == RD_BUFFERS) {
                v = new_buffer(c, NULL, (const uint8_t *)name, namel);
            } else if (kind == RD_DIRENTS) {
                size_t dl = join_dirname(p.p, p.len, name, namel, dbuf, 2 * FS_PATH_MAX + 4);
                if (dl != prevlen || memcmp(dbuf, prev, dl) != 0) {
                    JS_FreeValue(c, dpath);
                    dpath = encode_bytes(c, (const uint8_t *)dbuf, dl, enc, NULL);
                    if (JS_IsException(dpath)) {
                        dpath = JS_UNDEFINED;
                        closedir(d);
                        err = JS_EXCEPTION;
                        goto rec_done;
                    }
                    memcpy(prev, dbuf, dl);
                    prevlen = dl;
                }
                JSValue nm = encode_bytes(c, (const uint8_t *)n, nl, enc, NULL);
                v = JS_IsException(nm) ? nm : new_dirent(c, nm, t, dpath);
            } else {
                v = encode_bytes(c, (const uint8_t *)name, namel, enc, NULL);
            }
            if (JS_IsException(v) || JS_SetPropertyUint32(c, arr, count++, v) < 0) {
                closedir(d);
                err = JS_EXCEPTION;
                goto rec_done;
            }
        }
        closedir(d);
    }
    goto rec_done;
rec_oom:
    err = JS_ThrowOutOfMemory(c);
rec_done:
    if (root >= 0)
        close(root);
    for (size_t i = qh; i < qn; i++)
        js_free(c, q[i].p);
    for (size_t i = 0; i < qh; i++)
        js_free(c, q[i].p);
    js_free(c, q);
    js_free(c, joinbuf);
    js_free(c, dbuf);
    js_free(c, prev);
    JS_FreeValue(c, dpath);
    free_path(c, &p);
    if (JS_IsException(err)) {
        JS_FreeValue(c, arr);
        return JS_EXCEPTION;
    }
    return arr;
}

// Zig's deleteTree (as Bun's zig_delete_tree): removes `name` in dirfd, a
// file or a directory and all it holds; 0 or an errno.
static int delete_tree(int parent, const char *name, int depth) {
    if (unlinkat(parent, name, 0) == 0)
        return 0;
    int no = errno;
    if (no != EISDIR && no != EPERM)
        return no;
    if (depth > 256)
        return ENAMETOOLONG;
    int fd = openat(parent, name, O_DIRECTORY | O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
    if (fd < 0)
        return errno == ENOTDIR ? no : errno;
    DIR *d = fdopendir(fd);
    if (!d) {
        no = errno;
        close(fd);
        return no;
    }
    for (int attempt = 0; attempt < 2; attempt++) {
        for (;;) {
            errno = 0;
            struct dirent *e = readdir(d);
            if (!e) {
                if (errno) {
                    no = errno;
                    closedir(d);
                    return no;
                }
                break;
            }
            const char *n = e->d_name;
            if (n[0] == '.' && (n[1] == 0 || (n[1] == '.' && n[2] == 0)))
                continue;
            if (e->d_type == DT_DIR) {
                no = delete_tree(dirfd(d), n, depth + 1);
            } else {
                no = unlinkat(dirfd(d), n, 0) == 0 ? 0 : errno;
                if (no == EISDIR || no == EPERM)
                    no = delete_tree(dirfd(d), n, depth + 1);
            }
            if (no && no != ENOENT) {
                closedir(d);
                return no;
            }
        }
        closedir(d);
        if (unlinkat(parent, name, AT_REMOVEDIR) == 0)
            return 0;
        no = errno;
        if (no != ENOTEMPTY || attempt == 1)
            return no;
        // (entries made meanwhile: once more)
        fd = openat(parent, name, O_DIRECTORY | O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
        if (fd < 0)
            return errno;
        d = fdopendir(fd);
        if (!d) {
            no = errno;
            close(fd);
            return no;
        }
    }
    return no;
}

// Bun's map_anyerror_to_errno_rm_tree (through its dt_err names).
static int rm_tree_errno(int no) {
    switch (no) {
    case ENOENT: case EACCES: case EPERM: case ELOOP: case ENAMETOOLONG: case ENOMEM: case EROFS: case EIO:
    case EBUSY: case ENOTDIR: case EISDIR: case ENOTEMPTY: case EMFILE: case ENFILE: case EINVAL: case EFBIG:
        return no;
    default:
        return EFAULT;
    }
}

// fsRm(path, recursive, force): Bun's rm (the binding checks a directory
// without `recursive` first).
static JSValue js_fs_rm(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    Path p;
    int r = get_path(c, argv[0], &p);
    if (r)
        return path_fail(r);
    int recursive = JS_ToBool(c, argv[1]), force = JS_ToBool(c, argv[2]);
    int no;
    if (recursive) {
        no = p.len == 0 ? ENOENT : delete_tree(AT_FDCWD, p.p, 0);
        if (no && no != ENOENT)
            no = rm_tree_errno(no);
    } else {
        no = unlink(p.p) == 0 ? 0 : errno;
        if (no && no != ENOENT) {
            switch (no) {
            case EACCES: case ELOOP: case ENAMETOOLONG: case ENOMEM: case EROFS: case EBUSY:
                break;
            default:
                no = EFAULT;
            }
        }
    }
    if (no == ENOENT) {
        if (force) {
            free_path(c, &p);
            return JS_UNDEFINED;
        }
        return throw_path(c, ENOENT, "lstat", &p);
    }
    if (no)
        return throw_path(c, no, "rm", &p);
    free_path(c, &p);
    return JS_UNDEFINED;
}

// fsRmdirRecursive(path): rmdir with `recursive` (Bun's: the error without
// its path).
static JSValue js_fs_rmdir_recursive(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    Path p;
    int r = get_path(c, argv[0], &p);
    if (r)
        return path_fail(r);
    int no = p.len == 0 ? ENOENT : delete_tree(AT_FDCWD, p.p, 0);
    free_path(c, &p);
    if (no) {
        switch (no) {
        case EACCES: no = EPERM; break;
        case ENOENT: case EPERM: case ELOOP: case ENAMETOOLONG: case ENOMEM: case EROFS: case EIO: case EBUSY:
        case ENOTDIR: case EISDIR: case EMFILE: case ENFILE: case EINVAL: case EFBIG:
            break;
        default:
            no = EFAULT;
        }
        return throw_sys(c, no, "rmdir", NULL, NULL, -1, 0);
    }
    return JS_UNDEFINED;
}

// ---- Copies ----

static int ficlone_works = 1, copy_range_works = 1;

// Copies src_fd's `size` bytes (to EOF when 0) to dest_fd: 0 or an errno;
// *wrote counts them.
static int copy_data(int src_fd, int dest_fd, size_t size, uint64_t *wrote) {
    if (copy_range_works) {
        loff_t in = 0, out = 0;
        for (;;) {
            size_t want = size ? size - *wrote : 64 * 1024;
            if (size && *wrote >= size)
                return 0;
            ssize_t n = copy_file_range(src_fd, &in, dest_fd, &out, want, 0);
            if (n < 0) {
                if (errno == EINTR)
                    continue;
                if (errno == EXDEV || errno == ENOSYS || errno == EINVAL || errno == EOPNOTSUPP) {
                    if (errno == ENOSYS || errno == EOPNOTSUPP)
                        copy_range_works = 0;
                    break;
                }
                return errno;
            }
            if (n == 0)
                return 0;
            *wrote += n;
        }
    }
    // read/write from where copy_file_range stopped
    if (lseek(src_fd, (off_t)*wrote, SEEK_SET) < 0 || lseek(dest_fd, (off_t)*wrote, SEEK_SET) < 0)
        return errno;
    uint8_t buf[64 * 1024];
    for (;;) {
        ssize_t n = read(src_fd, buf, sizeof buf);
        if (n < 0) {
            if (errno == EINTR)
                continue;
            return errno;
        }
        if (n == 0)
            return 0;
        size_t off = 0;
        while (off < (size_t)n) {
            ssize_t w = write(dest_fd, buf + off, n - off);
            if (w < 0) {
                if (errno == EINTR)
                    continue;
                return errno;
            }
            off += w;
        }
        *wrote += n;
    }
}

// fsCopyFile(src, dest, mode): Bun's copyFile (every error is copyfile's,
// of src and dest).
static JSValue js_fs_copy_file(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    Path *a = js_malloc(c, 2 * sizeof(Path)), *b;
    int32_t mode;
    if (!a)
        return JS_EXCEPTION;
    b = a + 1;
    int r = get_path(c, argv[0], a);
    if (r) {
        js_free(c, a);
        return path_fail(r);
    }
    r = get_path(c, argv[1], b);
    if (r) {
        free_path(c, a);
        js_free(c, a);
        return path_fail(r);
    }
    int no = 0;
    if (to_i32(c, argv[2], &mode)) {
        free_path(c, a);
        free_path(c, b);
        js_free(c, a);
        return JS_EXCEPTION;
    }
    int src = open_retry(a->p, O_RDONLY, 0644), dest = -1;
    struct stat st;
    if (src < 0) {
        no = errno;
        goto done;
    }
    if (fstat(src, &st) < 0) {
        no = errno;
        goto done;
    }
    if (!S_ISREG(st.st_mode)) {
        no = ENOTSUP;
        goto done;
    }
    dest = open_retry(b->p, O_CREAT | O_WRONLY | ((mode & 1) ? O_EXCL : 0), st.st_mode);
    if (dest < 0) {
        no = errno;
        goto done;
    }
    if (mode & 4) {
        if (ioctl(dest, FICLONE, src) < 0) {
            no = errno;
            close(dest);
            dest = -1;
            unlink(b->p);
            goto done;
        }
        fchmod(dest, st.st_mode);
        goto done;
    }
    if (ficlone_works) {
        if (ioctl(dest, FICLONE, src) == 0) {
            fchmod(dest, st.st_mode);
            goto done;
        }
        ficlone_works = 0;
    }
    {
        uint64_t wrote = 0;
        no = copy_data(src, dest, (size_t)st.st_size, &wrote);
        ftruncate(dest, (off_t)wrote);
        fchmod(dest, st.st_mode);
    }
done:
    if (src >= 0)
        close(src);
    if (dest >= 0)
        close(dest);
    JSValue ret = JS_UNDEFINED;
    if (no) {
        ErrPath ea = err_path(a), eb = err_path(b);
        ret = throw_sys(c, no, "copyfile", &ea, &eb, -1, 0);
    }
    free_path(c, a);
    free_path(c, b);
    js_free(c, a);
    return ret;
}

// ---- cp (Bun's cp_sync_inner, for what the binding's fast path takes) ----

// (No JavaScript: the pool's threads run it too. Its error is kept: an
// errno, the system call, and a path of the copy's buffers, if any.)
typedef struct {
    int error_on_exist, force, recursive;
    int no;
    const char *syscall;
    int has_path;
    char err_path[FS_PATH_MAX + 1];
    char src[FS_PATH_MAX + 1], dest[FS_PATH_MAX + 1];
} Cp;

// Keeps the copy's error.
static int cp_throw(Cp *cp, int no, const char *syscall, const char *path) {
    cp->no = no;
    cp->syscall = syscall;
    cp->has_path = path != NULL;
    if (path)
        snprintf(cp->err_path, sizeof cp->err_path, "%s", path);
    return -1;
}

// The copy's error, thrown.
static JSValue cp_error(JSContext *c, Cp *cp) {
    ErrPath ep = {cp->err_path, strlen(cp->err_path), JS_UNDEFINED};
    return make_sys(c, cp->no, cp->syscall, cp->has_path ? &ep : NULL, NULL, -1, 0);
}

static int mkdir_p(const char *path, mode_t mode) {
    char w[FS_PATH_MAX + 1];
    size_t len = strlen(path);
    if (len == 0 || len >= sizeof w)
        return len == 0 ? 0 : ENAMETOOLONG;
    memcpy(w, path, len + 1);
    for (size_t i = 1; i <= len; i++) {
        if (w[i] == '/' || w[i] == 0) {
            char ch = w[i];
            w[i] = 0;
            if (mkdir(w, mode) < 0 && errno != EEXIST)
                return errno;
            w[i] = ch;
        }
    }
    return 0;
}

// A symbolic link's copy (its target made absolute against the source's
// directory when relative).
static int cp_symlink(Cp *cp, const char *src, const char *dest) {
    char target[FS_PATH_MAX + 1];
    ssize_t n = readlink(src, target, sizeof target - 1);
    if (n < 0)
        return cp_throw(cp, errno, "readlink", src);
    target[n] = 0;
    if (target[0] == '/') {
        if (symlink(target, dest) < 0)
            return cp_throw(cp, errno, "symlink", NULL);
        return 0;
    }
    char joined[2 * FS_PATH_MAX + 2], resolved[FS_PATH_MAX + 1];
    const char *slash = strrchr(src, '/');
    size_t dl = slash ? (size_t)(slash - src) : 0;
    if (dl + 1 + n >= sizeof joined)
        return cp_throw(cp, ENAMETOOLONG, "symlink", src);
    memcpy(joined, src, dl);
    joined[dl] = '/';
    memcpy(joined + dl + 1, target, n + 1);
    if (!slash) {
        memcpy(joined, target, n + 1);
        dl = 0;
    }
    if (resolve_path(joined, strlen(joined), resolved) < 0)
        return cp_throw(cp, ENAMETOOLONG, "symlink", src);
    if (symlink(resolved, dest) < 0)
        return cp_throw(cp, errno, "symlink", NULL);
    return 0;
}

// One file (not a directory): 0, 1 when it exists and need not be copied
// over (EEXIST), or -1 with an exception.
static int cp_file(Cp *cp, const char *src, const char *dest) {
    int excl = cp->error_on_exist || !cp->force;
    int s = open_retry(src, O_RDONLY | O_NOFOLLOW, 0644);
    if (s < 0) {
        if (errno == ELOOP)
            return cp_symlink(cp, src, dest);
        return cp_throw(cp, errno, "open", NULL);
    }
    struct stat st;
    if (fstat(s, &st) < 0) {
        int no = errno;
        close(s);
        return cp_throw(cp, no, "fstat", NULL);
    }
    if (!S_ISREG(st.st_mode)) {
        close(s);
        return cp_throw(cp, ENOTSUP, "copyfile", NULL);
    }
    int flags = O_CREAT | O_WRONLY | (excl ? O_EXCL : 0);
    int d = open_retry(dest, flags, st.st_mode);
    if (d < 0 && errno == ENOENT) {
        char parent[FS_PATH_MAX + 1];
        snprintf(parent, sizeof parent, "%s", dest);
        char *sl = strrchr(parent, '/');
        if (sl) {
            *sl = 0;
            int no = mkdir_p(parent, 0777);
            if (no) {
                close(s);
                return cp_throw(cp, no, "mkdir", parent);
            }
            d = open_retry(dest, flags, st.st_mode);
        }
    }
    if (d < 0) {
        int no = errno;
        close(s);
        if (no == EEXIST && !cp->error_on_exist)
            return 1;
        return cp_throw(cp, no, "open", dest);
    }
    if (ficlone_works && ioctl(d, FICLONE, s) == 0) {
        fchmod(d, st.st_mode);
        close(d);
        close(s);
        return 0;
    }
    ficlone_works = 0;
    uint64_t wrote = 0;
    int no = copy_data(s, d, (size_t)st.st_size, &wrote);
    ftruncate(d, (off_t)wrote);
    fchmod(d, st.st_mode);
    close(d);
    close(s);
    if (no)
        return cp_throw(cp, no, "copy_file_range", dest);
    return 0;
}

static int cp_inner(Cp *cp, size_t sl, size_t dl, int top) {
    struct stat st;
    if (top) {
        if (lstat(cp->src, &st) < 0)
            return cp_throw(cp, errno, "lstat", cp->src);
        if (!S_ISDIR(st.st_mode)) {
            int r = cp_file(cp, cp->src, cp->dest);
            return r < 0 ? -1 : 0;
        }
        if (!cp->recursive)
            return cp_throw(cp, EISDIR, "copyfile", cp->src);
    }
    int fd = open_retry(cp->src, O_DIRECTORY | O_RDONLY | O_NOFOLLOW, 0);
    if (fd < 0)
        return cp_throw(cp, errno, "open", cp->src);
    int no = mkdir_p(cp->dest, 0777);
    if (no) {
        close(fd);
        return cp_throw(cp, no, "mkdir", cp->dest);
    }
    DIR *d = fdopendir(fd);
    if (!d) {
        no = errno;
        close(fd);
        return cp_throw(cp, no, "opendir", cp->src);
    }
    for (;;) {
        errno = 0;
        struct dirent *e = readdir(d);
        if (!e) {
            no = errno;
            closedir(d);
            cp->src[sl] = 0;
            cp->dest[dl] = 0;
            return no ? cp_throw(cp, no, "readdir", cp->src) : 0;
        }
        const char *n = e->d_name;
        if (n[0] == '.' && (n[1] == 0 || (n[1] == '.' && n[2] == 0)))
            continue;
        size_t nl = strlen(n);
        if (sl + 1 + nl >= FS_PATH_MAX || dl + 1 + nl >= FS_PATH_MAX) {
            closedir(d);
            cp->src[sl] = 0;
            return cp_throw(cp, ENAMETOOLONG, "copyfile", cp->src);
        }
        cp->src[sl] = '/';
        memcpy(cp->src + sl + 1, n, nl + 1);
        cp->dest[dl] = '/';
        memcpy(cp->dest + dl + 1, n, nl + 1);
        int r;
        if (e->d_type == DT_DIR)
            r = cp_inner(cp, sl + 1 + nl, dl + 1 + nl, 0);
        else
            r = cp_file(cp, cp->src, cp->dest) < 0 ? -1 : 0;
        cp->src[sl] = 0;
        cp->dest[dl] = 0;
        if (r < 0) {
            closedir(d);
            return -1;
        }
    }
}

// fsCp(src, dest, recursive, errorOnExist, force).
static JSValue js_fs_cp(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    Cp *cp = js_malloc(c, sizeof *cp);
    if (!cp)
        return JS_EXCEPTION;
    Path *a = js_malloc(c, 2 * sizeof(Path)), *b;
    if (!a) {
        js_free(c, cp);
        return JS_EXCEPTION;
    }
    b = a + 1;
    int r = get_path(c, argv[0], a);
    if (r) {
        js_free(c, a);
        js_free(c, cp);
        return path_fail(r);
    }
    r = get_path(c, argv[1], b);
    if (r) {
        free_path(c, a);
        js_free(c, a);
        js_free(c, cp);
        return path_fail(r);
    }
    cp->recursive = JS_ToBool(c, argv[2]);
    cp->error_on_exist = JS_ToBool(c, argv[3]);
    cp->force = JS_ToBool(c, argv[4]);
    memcpy(cp->src, a->p, a->len + 1);
    memcpy(cp->dest, b->p, b->len + 1);
    r = cp_inner(cp, a->len, b->len, 1);
    free_path(c, a);
    free_path(c, b);
    js_free(c, a);
    JSValue ret = JS_UNDEFINED;
    if (r < 0) {
        JSValue e = cp_error(c, cp);
        ret = JS_IsException(e) ? e : JS_Throw(c, e);
    }
    js_free(c, cp);
    return ret;
}

// ---- The event loop ----

// fsJobsPending(): whether jobs (promise reactions, microtasks) are queued
// besides the one running.
// ---- fs.watch: inotify, as Bun's path_watcher.rs on Linux ----
//
// Each watcher has an inotify descriptor of its own, a poll of the event
// loop (keeping it alive while referenced), and its watch descriptors: the
// root's and, recursive, its directories' (each with its path relative to
// the root). The events a read gives are made Bun's (kind, path relative to
// the root, the same duplicate suppression), queued, then handed to the
// binding's dispatcher one by one, the jobs they queue run after each (as
// Bun's run_callback does), until the watcher is closed.

struct us_loop_t *uws_get_loop(void);
JSContext *beyond_js_context(void);
int beyond_js_run_jobs(void);
void beyond_js_report(void);

#define WATCH_FILE_MASK (IN_MODIFY | IN_ATTRIB | IN_MOVE_SELF | IN_DELETE_SELF)
#define WATCH_DIR_MASK                                                                                                  \
    (IN_MODIFY | IN_ATTRIB | IN_CREATE | IN_DELETE | IN_DELETE_SELF | IN_MOVED_FROM | IN_MOVED_TO | IN_MOVE_SELF |     \
     IN_ONLYDIR)

enum { WEV_RENAME, WEV_CHANGE, WEV_ERROR, WEV_OVERFLOW };

typedef struct {
    int kind;
    char *name; // (malloc'd; the error's path)
    size_t len;
    int no, close;
    const char *syscall;
} WatchEvent;

typedef struct {
    WatchEvent *v;
    int n, cap;
} WatchQueue;

typedef struct {
    int wd;
    char *sub;
} WatchWd;

typedef struct {
    struct us_internal_callback_t cb; // (first: the poll)
    int id, ifd, recursive, is_file, enc, refd, closed, dispatching;
    char *root;
    size_t root_len;
    WatchWd *wds;
    int nwds, capwds;
    // (Bun's ChangeEvent: the last event emitted.)
    uint64_t last_hash;
    int last_kind;
    int64_t last_ms;
} Watch;

static Watch **watches;
static int nwatches;

// The loop's polls of fs.c that do not keep the program alive (they are
// still polled while something else does): unreferenced watchers, and the
// thread pool's while it has no job (the loop leaves them out: src/lib.rs).
static int fs_unrefd;

int beyond_fs_unrefd(void) { return fs_unrefd; }

static uint64_t watch_hash(const char *p, size_t n) {
    uint64_t h = 1469598103934665603ULL;
    for (size_t i = 0; i < n; i++)
        h = (h ^ (uint8_t)p[i]) * 1099511628211ULL;
    return h;
}

static int64_t watch_now_ms(void) {
    struct timespec ts;
    clock_gettime(CLOCK_REALTIME, &ts);
    return (int64_t)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

static void queue_push(WatchQueue *q, int kind, const char *name, size_t len, int no, const char *syscall, int close) {
    if (q->n == q->cap) {
        int cap = q->cap ? q->cap * 2 : 16;
        WatchEvent *v = realloc(q->v, sizeof *v * cap);
        if (!v)
            return;
        q->v = v;
        q->cap = cap;
    }
    WatchEvent *e = &q->v[q->n++];
    e->kind = kind;
    e->name = NULL;
    e->len = len;
    if (name) {
        e->name = malloc(len + 1);
        if (e->name) {
            memcpy(e->name, name, len);
            e->name[len] = 0;
        }
    }
    e->no = no;
    e->syscall = syscall;
    e->close = close;
}

// Bun's PathWatcher.emit: an exact duplicate (path, kind) within 1 ms is
// dropped.
static void watch_emit(Watch *w, WatchQueue *q, int kind, const char *rel, size_t len) {
    uint64_t h = watch_hash(rel, len);
    int64_t t = watch_now_ms();
    if (w->last_ms != 0 && t - w->last_ms <= 1 && w->last_kind == kind && w->last_hash == h)
        return;
    w->last_ms = t;
    w->last_kind = kind;
    w->last_hash = h;
    queue_push(q, kind, rel, len, 0, NULL, 0);
}

static int wd_index(Watch *w, int wd) {
    for (int i = 0; i < w->nwds; i++)
        if (w->wds[i].wd == wd)
            return i;
    return -1;
}

static const char *watch_basename(Watch *w, size_t *len) {
    const char *b = w->root + w->root_len;
    while (b > w->root && b[-1] != '/')
        b--;
    *len = w->root + w->root_len - b;
    return b;
}

// Bun's Linux.add_one: watches `abs` (its path relative to the root:
// `sub`), 0 or the errno (a directory gone in a walk is not an error).
static int watch_add_one(Watch *w, const char *abs, const char *sub) {
    uint32_t mask = w->is_file && !*sub ? WATCH_FILE_MASK : WATCH_DIR_MASK;
    int wd = inotify_add_watch(w->ifd, abs, mask);
    if (wd < 0) {
        int no = errno;
        if (*sub && (no == ENOENT || no == ENOTDIR))
            return 0;
        return no;
    }
    // (The same wd again: a directory moved within the tree; its new path.)
    int i = wd_index(w, wd);
    char *copy = strdup(sub);
    if (!copy)
        return ENOMEM;
    if (i >= 0) {
        free(w->wds[i].sub);
        w->wds[i].sub = copy;
        return 0;
    }
    if (w->nwds == w->capwds) {
        int cap = w->capwds ? w->capwds * 2 : 8;
        WatchWd *v = realloc(w->wds, sizeof *v * cap);
        if (!v) {
            free(copy);
            return ENOMEM;
        }
        w->wds = v;
        w->capwds = cap;
    }
    w->wds[w->nwds].wd = wd;
    w->wds[w->nwds].sub = copy;
    w->nwds++;
    return 0;
}

// a + "/" + b in out (FS_PATH_MAX + 1): its length, or -1 when too long.
static ssize_t watch_join(const char *a, size_t al, const char *b, size_t bl, char *out) {
    if (al == 0) {
        if (bl > FS_PATH_MAX)
            return -1;
        memcpy(out, b, bl);
        out[bl] = 0;
        return (ssize_t)bl;
    }
    int slash = a[al - 1] != '/';
    if (al + slash + bl > FS_PATH_MAX)
        return -1;
    memmove(out, a, al);
    if (slash)
        out[al] = '/';
    memcpy(out + al + slash, b, bl);
    out[al + slash + bl] = 0;
    return (ssize_t)(al + slash + bl);
}

// Bun's walk_subtree: each entry under `abs` (relative path `rel`), its
// directories first watched (dirs_only) or each entry watched if a
// directory and emitted as a "rename"; the first watch error in *err_no
// and err_path.
static void watch_walk(Watch *w, const char *abs, const char *rel, int dirs_only, WatchQueue *q, int *err_no,
                       char *err_path) {
    int dfd = open(abs, O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    if (dfd < 0)
        return;
    DIR *d = fdopendir(dfd);
    if (!d) {
        close(dfd);
        return;
    }
    size_t al = strlen(abs), rl = strlen(rel);
    char *child_abs = malloc(2 * (FS_PATH_MAX + 1));
    if (!child_abs) {
        closedir(d);
        return;
    }
    char *child_rel = child_abs + FS_PATH_MAX + 1;
    struct dirent *e;
    while ((e = readdir(d))) {
        const char *name = e->d_name;
        if (name[0] == '.' && (name[1] == 0 || (name[1] == '.' && name[2] == 0)))
            continue;
        int is_dir = e->d_type == DT_DIR;
        if (dirs_only && !is_dir)
            continue;
        size_t nl = strlen(name);
        if (watch_join(abs, al, name, nl, child_abs) < 0)
            continue;
        ssize_t cl = watch_join(rel, rl, name, nl, child_rel);
        if (cl < 0)
            continue;
        if (is_dir) {
            int no = watch_add_one(w, child_abs, child_rel);
            if (no && !*err_no) {
                *err_no = no;
                strcpy(err_path, child_abs);
            }
        }
        if (!dirs_only)
            watch_emit(w, q, WEV_RENAME, child_rel, (size_t)cl);
        if (is_dir)
            watch_walk(w, child_abs, child_rel, dirs_only, q, err_no, err_path);
    }
    free(child_abs);
    closedir(d);
}

static void watch_free(Watch *w) {
    for (int i = 0; i < w->nwds; i++)
        free(w->wds[i].sub);
    free(w->wds);
    free(w->root);
    us_poll_free(&w->cb.p, uws_get_loop());
}

// Stops watching: no event is handed over after this.
static void watch_stop(Watch *w) {
    if (w->closed)
        return;
    w->closed = 1;
    if (!w->refd) {
        w->refd = 1;
        fs_unrefd--;
    }
    us_poll_stop(&w->cb.p, uws_get_loop());
    close(w->ifd);
    w->ifd = -1;
    if (w->id > 0 && w->id <= nwatches && watches[w->id - 1] == w)
        watches[w->id - 1] = NULL;
}

// The events of what the descriptor has (Bun's Linux.thread_main, for one
// watcher), queued.
static void watch_read(Watch *w, WatchQueue *q) {
    static _Alignas(struct inotify_event) char buf[64 * 1024];
    char *abs = malloc(2 * (FS_PATH_MAX + 1));
    if (!abs)
        return;
    char *rel = abs + FS_PATH_MAX + 1;
    for (;;) {
        ssize_t n = read(w->ifd, buf, sizeof buf);
        if (n < 0) {
            if (errno == EINTR)
                continue;
            if (errno != EAGAIN)
                queue_push(q, WEV_ERROR, NULL, 0, errno, "read", 1);
            break;
        }
        if (n == 0)
            break;
        for (ssize_t i = 0; i < n;) {
            struct inotify_event *ev = (struct inotify_event *)(buf + i);
            i += sizeof *ev + ev->len;
            if (ev->mask & IN_Q_OVERFLOW) {
                queue_push(q, WEV_OVERFLOW, NULL, 0, 0, NULL, 0);
                continue;
            }
            int k = wd_index(w, ev->wd);
            if (ev->mask & IN_IGNORED) {
                // (The kernel retired the wd, its inode gone: the root of a
                // file's or a non-recursive watch reports one more "rename".)
                if (k >= 0) {
                    if (!w->wds[k].sub[0] && (w->is_file || !w->recursive)) {
                        size_t bl;
                        const char *b = watch_basename(w, &bl);
                        queue_push(q, WEV_RENAME, b, bl, 0, NULL, 0);
                    }
                    free(w->wds[k].sub);
                    w->wds[k] = w->wds[--w->nwds];
                }
                continue;
            }
            if (k < 0)
                continue;
            const char *name = ev->len ? ev->name : "";
            size_t nl = strlen(name);
            int is_dir_child = (ev->mask & IN_ISDIR) != 0;
            int kind =
                ev->mask & (IN_CREATE | IN_DELETE | IN_DELETE_SELF | IN_MOVE_SELF | IN_MOVED_FROM | IN_MOVED_TO)
                    ? WEV_RENAME
                    : WEV_CHANGE;
            const char *sub = w->wds[k].sub;
            size_t sl = strlen(sub), rl;
            if (w->is_file || (!sl && !nl && !w->recursive)) {
                const char *b = watch_basename(w, &rl);
                memcpy(rel, b, rl);
            } else if (!sl) {
                memcpy(rel, name, nl);
                rl = nl;
            } else if (!nl) {
                memcpy(rel, sub, sl);
                rl = sl;
            } else {
                ssize_t r = watch_join(sub, sl, name, nl, rel);
                if (r < 0)
                    continue;
                rl = (size_t)r;
            }
            rel[rl] = 0;
            watch_emit(w, q, kind, rel, rl);
            // (Recursive: a directory that appeared is watched, and what
            // it already has reported.)
            if (w->recursive && is_dir_child && (ev->mask & (IN_CREATE | IN_MOVED_TO)) && nl) {
                ssize_t r = watch_join(w->root, w->root_len, sub, sl, abs);
                if (r < 0 || watch_join(abs, (size_t)r, name, nl, abs) < 0)
                    continue;
                int no = watch_add_one(w, abs, rel), err_no = 0;
                char *err_path = malloc(FS_PATH_MAX + 1);
                if (!err_path)
                    continue;
                if (no) {
                    err_no = no;
                    strcpy(err_path, abs);
                }
                watch_walk(w, abs, rel, 0, q, &err_no, err_path);
                if (err_no)
                    queue_push(q, WEV_ERROR, err_path, strlen(err_path), err_no, "watch", 0);
                free(err_path);
            }
        }
    }
    free(abs);
}

// The queued events to the dispatcher, until the watcher is closed.
static void watch_dispatch_queue(Watch *w, WatchQueue *q) {
    JSContext *c = beyond_js_context();
    w->dispatching++;
    for (int k = 0; k < q->n; k++) {
        WatchEvent *e = &q->v[k];
        if (!w->closed && (e->name || e->kind == WEV_OVERFLOW || e->kind == WEV_ERROR)) {
            JSValue args[4];
            args[0] = JS_NewInt32(c, w->id);
            args[3] = JS_FALSE;
            if (e->kind == WEV_ERROR) {
                ErrPath ep = {e->name, e->len, JS_UNDEFINED};
                args[1] = JS_NewInt32(c, WEV_ERROR);
                args[2] = make_sys(c, e->no, e->syscall, e->name ? &ep : NULL, NULL, -1, 0);
                args[3] = JS_NewBool(c, e->close);
            } else if (e->kind == WEV_OVERFLOW) {
                args[1] = JS_NewInt32(c, WEV_CHANGE);
                args[2] = JS_NULL;
            } else {
                args[1] = JS_NewInt32(c, e->kind);
                args[2] = e->len ? encode_bytes(c, (const uint8_t *)e->name, e->len, w->enc, NULL) : JS_UNDEFINED;
            }
            if (JS_IsException(args[2])) {
                beyond_js_report();
            } else {
                JSValue r = JS_Call(c, watch_dispatch, JS_UNDEFINED, 4, args);
                if (JS_IsException(r))
                    beyond_js_report();
                JS_FreeValue(c, r);
                JS_FreeValue(c, args[2]);
            }
            if (beyond_js_run_jobs() < 0)
                beyond_js_report();
        }
        free(e->name);
    }
    free(q->v);
    q->v = NULL;
    q->n = q->cap = 0;
    w->dispatching--;
}

static void watch_on_ready(struct us_internal_callback_t *cb) {
    Watch *w = (Watch *)cb;
    if (w->closed)
        return;
    WatchQueue q = {0};
    watch_read(w, &q);
    watch_dispatch_queue(w, &q);
    if (w->closed && !w->dispatching)
        watch_free(w);
}

// fsWatchStart(path, recursive, persistent, encoding, dispatcher):
// [id, the error of watching a directory of the tree, or undefined]; its
// failure to watch the path is thrown (syscall `watch`); null for a path
// with a NUL.
static JSValue js_fs_watch_start(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    Path p;
    int32_t enc;
    int recursive = JS_ToBool(c, argv[1]), persistent = JS_ToBool(c, argv[2]);
    if (to_i32(c, argv[3], &enc))
        return JS_EXCEPTION;
    int r = get_path(c, argv[0], &p);
    if (r)
        return path_fail(r);
    if (!JS_IsUndefined(argv[4]))
        watch_dispatch = JS_DupValue(c, argv[4]);
    const char *s = p.p;
    size_t len = p.len;
    if (len >= 7 && memcmp(s, "file://", 7) == 0)
        s += 7, len -= 7;
    char joined[FS_PATH_MAX + 1], resolved[FS_PATH_MAX + 1];
    ssize_t jl = resolve_path(s, len, joined);
    if (jl < 0)
        return throw_path(c, ENAMETOOLONG, "watch", &p);
    int is_file = 0;
    int pfd = open(joined, O_PATH | O_DIRECTORY | O_CLOEXEC);
    if (pfd < 0 && errno == ENOTDIR) {
        is_file = 1;
        pfd = open(joined, O_PATH | O_CLOEXEC);
    }
    if (pfd < 0)
        return throw_path(c, errno, "watch", &p);
    char proc[64];
    snprintf(proc, sizeof proc, "/proc/self/fd/%d", pfd);
    ssize_t rl = readlink(proc, resolved, FS_PATH_MAX);
    close(pfd);
    if (rl <= 0) {
        memcpy(resolved, joined, (size_t)jl + 1);
        rl = jl;
    }
    resolved[rl] = 0;
    int ifd = inotify_init1(IN_NONBLOCK | IN_CLOEXEC);
    if (ifd < 0)
        return throw_path(c, errno, "watch", &p);
    struct us_loop_t *loop = uws_get_loop();
    Watch *w = (Watch *)us_create_poll(loop, 0, sizeof(Watch) - sizeof(struct us_poll_t));
    if (!w) {
        close(ifd);
        free_path(c, &p);
        return JS_ThrowOutOfMemory(c);
    }
    memset((char *)w + sizeof(struct us_poll_t), 0, sizeof(Watch) - sizeof(struct us_poll_t));
    us_poll_init(&w->cb.p, ifd, POLL_TYPE_CALLBACK);
    w->cb.loop = loop;
    w->cb.cb_expects_the_loop = 0;
    w->cb.leave_poll_ready = 1;
    w->cb.cb = watch_on_ready;
    w->ifd = ifd;
    w->recursive = recursive;
    w->is_file = is_file;
    w->enc = enc;
    w->refd = 1;
    w->root = strdup(resolved);
    w->root_len = (size_t)rl;
    int no = w->root ? watch_add_one(w, w->root, "") : ENOMEM;
    if (no) {
        close(ifd);
        watch_free(w);
        return throw_path(c, no, "watch", &p);
    }
    free_path(c, &p);
    JSValue walk_err = JS_UNDEFINED;
    if (recursive && !is_file) {
        int err_no = 0;
        char err_path[FS_PATH_MAX + 1];
        watch_walk(w, w->root, "", 1, NULL, &err_no, err_path);
        if (err_no) {
            ErrPath ep = {err_path, strlen(err_path), JS_UNDEFINED};
            walk_err = make_sys(c, err_no, "watch", &ep, NULL, -1, 0);
        }
    }
    us_poll_start(&w->cb.p, loop, LIBUS_SOCKET_READABLE);
    if (!persistent) {
        w->refd = 0;
        fs_unrefd++;
    }
    int id = 0;
    for (int i = 0; i < nwatches; i++)
        if (!watches[i]) {
            id = i + 1;
            break;
        }
    if (!id) {
        Watch **v = realloc(watches, sizeof *v * (nwatches + 1));
        if (!v) {
            watch_stop(w);
            watch_free(w);
            return JS_ThrowOutOfMemory(c);
        }
        watches = v;
        watches[nwatches++] = NULL;
        id = nwatches;
    }
    watches[id - 1] = w;
    w->id = id;
    JSValue out = JS_NewArray(c);
    JS_SetPropertyUint32(c, out, 0, JS_NewInt32(c, id));
    JS_SetPropertyUint32(c, out, 1, walk_err);
    return out;
}

static Watch *watch_of(JSContext *c, JSValueConst v) {
    int32_t id;
    if (to_i32(c, v, &id) || id <= 0 || id > nwatches)
        return NULL;
    return watches[id - 1];
}

// fsWatchClose(id).
static JSValue js_fs_watch_close(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    Watch *w = watch_of(c, argv[0]);
    if (w) {
        watch_stop(w);
        if (!w->dispatching)
            watch_free(w);
    }
    return JS_UNDEFINED;
}

// fsWatchRef(id, ref): whether it keeps the program alive.
static JSValue js_fs_watch_ref(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    Watch *w = watch_of(c, argv[0]);
    int ref = JS_ToBool(c, argv[1]);
    if (w && !w->closed && ref != w->refd) {
        w->refd = ref;
        fs_unrefd += ref ? -1 : 1;
    }
    return JS_UNDEFINED;
}

static JSValue js_fs_jobs_pending(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    return JS_NewBool(c, JS_IsJobPending(JS_GetRuntime(c)));
}

// ---- The thread pool: the asynchronous calls (Bun's work pool) ----
//
// An asynchronous call is a job: made on the JavaScript thread (its
// arguments copied, paths and a string's UTF-8; a buffer's bytes stay the
// buffer's, which the job holds), run on one of the pool's threads (the
// system calls only), then finished on the JavaScript thread once the
// loop finds it done (an eventfd, polled by uSockets' loop, as Bun's
// completions come to its event loop): its value made, or its error (as
// the synchronous call's), its promise settled or its callback called, and
// the jobs (microtasks) those queued run before the next one finishes.

#include <pthread.h>
#include <sys/eventfd.h>

void beyond_flush_stdout(void);

enum { JOB_PROMISE, JOB_CALLBACK };
// What the error of a job names (with its errno and system call).
#define JERR_PATH 1
#define JERR_DEST 2
#define JERR_FD 4
#define JERR_OWN 8 // a path of its own (err_buf)

typedef struct FsJob FsJob;
struct FsJob {
    FsJob *next;               // (in the queue, then the list of done jobs)
    FsJob *live_prev, *live_next; // (the jobs not finished: their values marked)
    void (*run)(FsJob *);      // on a pool thread
    JSValue (*done)(JSContext *, FsJob *); // its value, on the JavaScript thread
    int kind;
    JSValue target;            // the promise, or the callback
    JSValue hold[2];           // what it reads (buffers), its error's paths' strings
    JSValue signal;            // an AbortSignal, aborted by when it is done: an AbortError
    // The result: 0, or an errno and its system call.
    int no;
    const char *syscall;
    int err_what, err_fd, err_flags;
    char *err_buf;
    size_t err_len;
    // Arguments.
    char *path, *path2;
    size_t plen, p2len;
    int32_t fd, flags, mode, enc, i1, i2, i3;
    int64_t a, b, pos;
    uint8_t *buf;
    size_t blen;
    struct iovec *iov;
    int iovcnt;
    // Results.
    int64_t r;
    FsStat st;
    uint8_t *data;
    size_t dlen;
    char inline_path[2][192];
};

static pthread_mutex_t pool_lock = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t pool_cond = PTHREAD_COND_INITIALIZER;
static FsJob *pool_head, *pool_tail;
static int pool_threads, pool_idle, pool_max;
static pthread_mutex_t done_lock = PTHREAD_MUTEX_INITIALIZER;
static FsJob *done_head;
static int pool_efd = -1;
static struct us_internal_callback_t *pool_poll;
static FsJob *live; // (JavaScript thread)
static int inflight;
static JSValue abort_error_hook = JS_UNDEFINED; // (signal reason) -> its AbortError

static void pool_mark(JSRuntime *rt, JS_MarkFunc *mark_func) {
    JS_MarkValue(rt, abort_error_hook, mark_func);
    for (FsJob *j = live; j; j = j->live_next) {
        JS_MarkValue(rt, j->target, mark_func);
        JS_MarkValue(rt, j->hold[0], mark_func);
        JS_MarkValue(rt, j->hold[1], mark_func);
        JS_MarkValue(rt, j->signal, mark_func);
    }
}

static void *pool_main(void *arg) {
    (void)arg;
    pthread_mutex_lock(&pool_lock);
    for (;;) {
        while (!pool_head) {
            pool_idle++;
            pthread_cond_wait(&pool_cond, &pool_lock);
            pool_idle--;
        }
        FsJob *j = pool_head;
        pool_head = j->next;
        if (!pool_head)
            pool_tail = NULL;
        pthread_mutex_unlock(&pool_lock);
        if (!j->no)
            j->run(j);
        pthread_mutex_lock(&done_lock);
        int first = done_head == NULL;
        j->next = done_head;
        done_head = j;
        pthread_mutex_unlock(&done_lock);
        if (first) {
            uint64_t one = 1;
            while (write(pool_efd, &one, sizeof one) < 0 && errno == EINTR)
                ;
        }
        pthread_mutex_lock(&pool_lock);
    }
    return NULL;
}

static void pool_on_ready(struct us_internal_callback_t *cb);

static int pool_start(void) {
    if (pool_poll)
        return 0;
    pool_efd = eventfd(0, EFD_NONBLOCK | EFD_CLOEXEC);
    if (pool_efd < 0)
        return -1;
    struct us_loop_t *loop = uws_get_loop();
    pool_poll = (struct us_internal_callback_t *)us_create_poll(loop, 0, sizeof(struct us_internal_callback_t) - sizeof(struct us_poll_t));
    if (!pool_poll) {
        close(pool_efd);
        pool_efd = -1;
        return -1;
    }
    us_poll_init(&pool_poll->p, pool_efd, POLL_TYPE_CALLBACK);
    pool_poll->loop = loop;
    pool_poll->cb_expects_the_loop = 0;
    pool_poll->leave_poll_ready = 1;
    pool_poll->cb = pool_on_ready;
    us_poll_start(&pool_poll->p, loop, LIBUS_SOCKET_READABLE);
    // (It keeps the program alive while jobs are out.)
    fs_unrefd++;
    long n = sysconf(_SC_NPROCESSORS_ONLN);
    pool_max = n < 2 ? 2 : n > 64 ? 64 : (int)n;
    return 0;
}

static FsJob *job_new(JSContext *c, JSValueConst kind, JSValueConst target) {
    FsJob *j = malloc(sizeof *j);
    if (!j) {
        JS_ThrowOutOfMemory(c);
        return NULL;
    }
    // (Only what a job reads before setting it.)
    j->kind = JS_ToBool(c, kind) ? JOB_CALLBACK : JOB_PROMISE;
    j->target = JS_DupValue(c, target);
    j->hold[0] = j->hold[1] = JS_UNDEFINED;
    j->signal = JS_UNDEFINED;
    j->no = 0;
    j->syscall = NULL;
    j->err_what = 0;
    j->err_fd = -1;
    j->err_flags = 0;
    j->err_buf = NULL;
    j->path = j->path2 = NULL;
    j->plen = j->p2len = 0;
    j->iov = NULL;
    j->data = NULL;
    j->dlen = 0;
    j->r = 0;
    j->done = NULL;
    return j;
}

static void job_free(JSContext *c, FsJob *j) {
    JS_FreeValue(c, j->target);
    JS_FreeValue(c, j->hold[0]);
    JS_FreeValue(c, j->hold[1]);
    JS_FreeValue(c, j->signal);
    if (j->path && j->path != j->inline_path[0])
        free(j->path);
    if (j->path2 && j->path2 != j->inline_path[1])
        free(j->path2);
    free(j->err_buf);
    free(j->iov);
    free(j->data);
    free(j);
}

// A path argument of the job (`which`: 0 its path, 1 its dest), copied: as
// get_path's, PATH_NUL for one with a NUL (the job is to be freed), or one
// too long the job's error (ENAMETOOLONG of `open`, without a syscall).
static int job_path(JSContext *c, FsJob *j, JSValueConst v, int which) {
    Path p;
    int r;
    p.js = v;
    p.cstr = NULL;
    const char *s;
    size_t len;
    if (JS_IsString(v)) {
        s = JS_ToCStringLen(c, &len, v);
        if (!s)
            return PATH_EXCEPTION;
        p.cstr = s;
    } else {
        s = (const char *)JS_GetUint8Array(c, &len, v);
        if (!s)
            return PATH_EXCEPTION;
    }
    if (memchr(s, 0, len)) {
        free_path(c, &p);
        return PATH_NUL;
    }
    char *d = len < sizeof j->inline_path[which] ? j->inline_path[which] : malloc(len + 1);
    if (!d) {
        free_path(c, &p);
        JS_ThrowOutOfMemory(c);
        return PATH_EXCEPTION;
    }
    memcpy(d, s, len);
    d[len] = 0;
    free_path(c, &p);
    if (which) {
        j->path2 = d;
        j->p2len = len;
    } else {
        j->path = d;
        j->plen = len;
    }
    j->hold[which] = JS_DupValue(c, v);
    r = PATH_OK;
    if (len >= FS_PATH_MAX && !j->no) {
        j->no = ENAMETOOLONG;
        j->syscall = "open";
        j->err_what = which ? JERR_DEST : JERR_PATH;
        j->err_flags = ERR_NO_SYSCALL_PROP;
    }
    return r;
}

// (On a pool thread.) The job's error: errno, its system call, what it names.
static void job_errno(FsJob *j, const char *syscall, int what) {
    j->no = errno;
    j->syscall = syscall;
    j->err_what = what;
}

// The job's error, as the synchronous call's.
static JSValue job_error(JSContext *c, FsJob *j) {
    ErrPath ep = {j->path, j->plen, j->hold[0]}, ed = {j->path2, j->p2len, j->hold[1]};
    if (j->err_what & JERR_OWN) {
        ep.p = j->err_buf;
        ep.len = j->err_len;
        ep.js = JS_UNDEFINED;
    }
    if (j->err_what & JERR_DEST && !(j->err_what & JERR_PATH)) {
        ep = ed;
        return make_sys(c, j->no, j->syscall, &ep, NULL, -1, j->err_flags);
    }
    return make_sys(c, j->no, j->syscall, (j->err_what & (JERR_PATH | JERR_OWN)) ? &ep : NULL,
                    (j->err_what & JERR_DEST) ? &ed : NULL, (j->err_what & JERR_FD) ? j->err_fd : -1, j->err_flags);
}

// Hands the job to the pool: JS_TRUE (the binding's: it is queued).
static JSValue job_submit(JSContext *c, FsJob *j) {
    if (pool_start() < 0) {
        job_free(c, j);
        return JS_ThrowInternalError(c, "the thread pool could not be started");
    }
    j->live_prev = NULL;
    j->live_next = live;
    if (live)
        live->live_prev = j;
    live = j;
    if (inflight++ == 0)
        fs_unrefd--;
    pthread_mutex_lock(&pool_lock);
    j->next = NULL;
    if (pool_tail)
        pool_tail->next = j;
    else
        pool_head = j;
    pool_tail = j;
    if (pool_idle > 0) {
        pthread_cond_signal(&pool_cond);
    } else if (pool_threads < pool_max) {
        pthread_t t;
        pthread_attr_t attr;
        pthread_attr_init(&attr);
        pthread_attr_setdetachstate(&attr, PTHREAD_CREATE_DETACHED);
        pthread_attr_setstacksize(&attr, 512 * 1024);
        if (pthread_create(&t, &attr, pool_main, NULL) == 0)
            pool_threads++;
        pthread_attr_destroy(&attr);
    }
    pthread_mutex_unlock(&pool_lock);
    return JS_TRUE;
}

static void job_finish(JSContext *c, FsJob *j) {
    JSValue v;
    int is_err = 0;
    if (j->no) {
        v = job_error(c, j);
        is_err = 1;
    } else {
        v = j->done ? j->done(c, j) : JS_UNDEFINED;
    }
    if (JS_IsException(v)) {
        v = JS_GetException(c);
        is_err = 1;
    }
    if (!is_err && !JS_IsUndefined(j->signal)) {
        JSValue aborted = JS_GetPropertyStr(c, j->signal, "aborted");
        if (JS_ToBool(c, aborted)) {
            JSValue reason = JS_GetPropertyStr(c, j->signal, "reason");
            JSValue e = JS_Call(c, abort_error_hook, JS_UNDEFINED, 1, &reason);
            JS_FreeValue(c, reason);
            JS_FreeValue(c, v);
            v = JS_IsException(e) ? JS_GetException(c) : e;
            is_err = 1;
        }
        JS_FreeValue(c, aborted);
    }
    JSValue target = j->target;
    j->target = JS_UNDEFINED;
    int kind = j->kind;
    if (j->live_prev)
        j->live_prev->live_next = j->live_next;
    else
        live = j->live_next;
    if (j->live_next)
        j->live_next->live_prev = j->live_prev;
    job_free(c, j);
    if (--inflight == 0)
        fs_unrefd++;
    if (kind == JOB_PROMISE) {
        JS_SettlePromise(c, target, v, is_err);
    } else {
        JSValue args[2] = {JS_NULL, v};
        JSValue r = is_err ? JS_Call(c, target, JS_UNDEFINED, 1, &v) : JS_Call(c, target, JS_UNDEFINED, 2, args);
        if (JS_IsException(r))
            beyond_js_report();
        JS_FreeValue(c, r);
    }
    JS_FreeValue(c, v);
    JS_FreeValue(c, target);
    if (beyond_js_run_jobs() < 0)
        beyond_js_report();
}

static void pool_on_ready(struct us_internal_callback_t *cb) {
    (void)cb;
    uint64_t v;
    while (read(pool_efd, &v, sizeof v) < 0 && errno == EINTR)
        ;
    pthread_mutex_lock(&done_lock);
    FsJob *list = done_head;
    done_head = NULL;
    pthread_mutex_unlock(&done_lock);
    // (In the order they were done.)
    FsJob *rev = NULL;
    while (list) {
        FsJob *n = list->next;
        list->next = rev;
        rev = list;
        list = n;
    }
    JSContext *c = beyond_js_context();
    while (rev) {
        FsJob *j = rev;
        rev = j->next;
        job_finish(c, j);
    }
}

// fsPoolInit(abortError): the AbortError of an aborted signal's reason.
static JSValue js_fs_pool_init(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    JS_FreeValue(c, abort_error_hook);
    abort_error_hook = JS_DupValue(c, argv[0]);
    return JS_UNDEFINED;
}

// The job's path argument, or the native's own return for a bad one.
#define JOB_PATH(j, v, which)                                                                                           \
    do {                                                                                                               \
        int jp_ = job_path(c, j, v, which);                                                                            \
        if (jp_) {                                                                                                     \
            job_free(c, j);                                                                                            \
            return path_fail(jp_);                                                                                     \
        }                                                                                                              \
    } while (0)

// The kind and target of a job, the native's last two arguments.
#define JOB_NEW(n)                                                                                                     \
    FsJob *j = job_new(c, argv[n], argv[(n) + 1]);                                                                     \
    if (!j)                                                                                                            \
    return JS_EXCEPTION

// ---- The jobs ----
//
// Each `fsXJob(..., kind, target)` takes what `fsX` takes, then whether a
// callback (else a promise) is the target, and it: true once queued; null
// for a path with a NUL (as fsX: the binding throws Bun's error).

// stat, lstat.
static void run_stat(FsJob *j) {
    if (do_stat(AT_FDCWD, j->path, j->i1 ? AT_SYMLINK_NOFOLLOW : 0, &j->st) < 0) {
        if (errno == ENOENT && !j->i3) {
            j->r = -1;
            return;
        }
        job_errno(j, j->i1 ? "lstat" : "stat", JERR_PATH);
    }
}

static JSValue done_stat(JSContext *c, FsJob *j) {
    return j->r < 0 ? JS_UNDEFINED : make_stats(c, &j->st, j->i2);
}

// fsStatJob(path, lstat, bigint, throwIfNoEntry, kind, target).
static JSValue js_fs_stat_job(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    JOB_NEW(4);
    JOB_PATH(j, argv[0], 0);
    j->i1 = JS_ToBool(c, argv[1]);
    j->i2 = JS_ToBool(c, argv[2]);
    j->i3 = JS_ToBool(c, argv[3]);
    j->run = run_stat;
    j->done = done_stat;
    return job_submit(c, j);
}

static void run_fstat(FsJob *j) {
    if (do_stat(j->fd, "", AT_EMPTY_PATH, &j->st) < 0)
        job_errno(j, "fstat", 0);
}

// fsFstatJob(fd, bigint, kind, target).
static JSValue js_fs_fstat_job(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    JOB_NEW(2);
    j->i2 = JS_ToBool(c, argv[1]);
    if (to_i32(c, argv[0], &j->fd)) {
        job_free(c, j);
        return JS_EXCEPTION;
    }
    j->run = run_fstat;
    j->done = done_stat;
    return job_submit(c, j);
}

static void run_statfs(FsJob *j) {
    struct statfs sf;
    if (statfs(j->path, &sf) < 0) {
        job_errno(j, "statfs", JERR_PATH);
        return;
    }
    // (Its fields, in the FsStat's.)
    uint64_t *f = &j->st.dev;
    f[0] = (uint64_t)sf.f_type, f[1] = (uint64_t)sf.f_bsize, f[2] = (uint64_t)sf.f_frsize;
    f[3] = (uint64_t)sf.f_blocks, f[4] = (uint64_t)sf.f_bfree, f[5] = (uint64_t)sf.f_bavail;
    f[6] = (uint64_t)sf.f_files, f[7] = (uint64_t)sf.f_ffree;
}

static JSValue done_statfs(JSContext *c, FsJob *j) {
    const uint64_t *f = &j->st.dev;
    void *shape = shapes[j->i2 ? SHAPE_BIGSTATFS : SHAPE_STATFS];
    if (!shape)
        return JS_ThrowInternalError(c, "fsInit was not called");
    JSValue v[8];
    for (int i = 0; i < 8; i++)
        v[i] = j->i2 ? JS_NewBigInt64(c, (int64_t)f[i]) : JS_NewInt64(c, (int64_t)f[i]);
    return JS_NewObjectWithCachedShape(c, shape, v);
}

// fsStatfsJob(path, bigint, kind, target).
static JSValue js_fs_statfs_job(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    JOB_NEW(2);
    JOB_PATH(j, argv[0], 0);
    j->i2 = JS_ToBool(c, argv[1]);
    j->run = run_statfs;
    j->done = done_statfs;
    return job_submit(c, j);
}

static JSValue done_int(JSContext *c, FsJob *j) {
    return JS_NewInt64(c, j->r);
}

static JSValue done_bool(JSContext *c, FsJob *j) {
    return JS_NewBool(c, j->r != 0);
}

static void run_open(FsJob *j) {
    int fd = open_retry(j->path, j->flags, j->mode);
    if (fd < 0)
        job_errno(j, "open", JERR_PATH);
    else
        j->r = fd;
}

// fsOpenJob(path, flags, mode, kind, target).
static JSValue js_fs_open_job(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    JOB_NEW(3);
    JOB_PATH(j, argv[0], 0);
    if (to_i32(c, argv[1], &j->flags) || to_i32(c, argv[2], &j->mode)) {
        job_free(c, j);
        return JS_EXCEPTION;
    }
    j->run = run_open;
    j->done = done_int;
    return job_submit(c, j);
}

static void run_close(FsJob *j) {
    if (close(j->fd) < 0 && errno != EINTR) {
        job_errno(j, "close", JERR_FD);
        j->err_fd = j->fd;
    }
}

// fsCloseJob(fd, kind, target).
static JSValue js_fs_close_job(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    JOB_NEW(1);
    if (to_i32(c, argv[0], &j->fd)) {
        job_free(c, j);
        return JS_EXCEPTION;
    }
    j->run = run_close;
    return job_submit(c, j);
}

static void run_rw(FsJob *j) {
    ssize_t n;
    do {
        if (j->i1)
            n = j->pos >= 0 ? pwrite(j->fd, j->buf, j->blen, j->pos) : write(j->fd, j->buf, j->blen);
        else
            n = j->pos >= 0 ? pread(j->fd, j->buf, j->blen, j->pos) : read(j->fd, j->buf, j->blen);
    } while (n < 0 && errno == EINTR);
    if (n < 0) {
        job_errno(j, j->i1 ? "write" : "read", j->pos >= 0 ? JERR_FD : 0);
        j->err_fd = j->fd;
    } else {
        j->r = n;
    }
}

// fsReadJob(fd, uint8array, offset, length, position, kind, target),
// fsWriteJob(...): as fsRead, fsWrite (the buffer held while it runs).
static JSValue js_fs_rw_job(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv, int magic) {
    int32_t fd;
    size_t size;
    int64_t off, len, pos;
    if (to_i32(c, argv[0], &fd))
        return JS_EXCEPTION;
    uint8_t *b = JS_GetUint8Array(c, &size, argv[1]);
    if (!b && size == 0 && JS_HasException(c))
        return JS_EXCEPTION;
    if (JS_ToInt64(c, &off, argv[2]) || JS_ToInt64(c, &len, argv[3]) || to_pos(c, argv[4], &pos))
        return JS_EXCEPTION;
    if (magic) {
        if (off < 0 || (uint64_t)off > size)
            return JS_NULL;
        if (len == -1)
            len = (int64_t)(size - (uint64_t)off);
        else if (len < 0 || len > INT32_MAX || (uint64_t)len > size - (uint64_t)off)
            return JS_NULL;
    } else if (off < 0 || len < 0 || (uint64_t)off > size || (uint64_t)len > size - (uint64_t)off) {
        return JS_ThrowRangeError(c, "read out of the buffer's bounds");
    }
    JOB_NEW(5);
    j->fd = fd;
    j->buf = b + off;
    j->blen = (size_t)len;
    j->pos = pos;
    j->i1 = magic;
    j->hold[0] = JS_DupValue(c, argv[1]);
    j->run = run_rw;
    j->done = done_int;
    return job_submit(c, j);
}

// fsWriteStringJob(fd, string, position, kind, target).
static JSValue js_fs_write_string_job(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    int32_t fd;
    int64_t pos;
    size_t len;
    if (to_i32(c, argv[0], &fd) || to_pos(c, argv[2], &pos))
        return JS_EXCEPTION;
    const char *s = JS_ToCStringLen(c, &len, argv[1]);
    if (!s)
        return JS_EXCEPTION;
    JOB_NEW(3);
    j->data = malloc(len ? len : 1);
    if (!j->data) {
        JS_FreeCString(c, s);
        job_free(c, j);
        return JS_ThrowOutOfMemory(c);
    }
    memcpy(j->data, s, len);
    JS_FreeCString(c, s);
    beyond_rt_wtf8_fix(j->data, len);
    j->fd = fd;
    j->buf = j->data;
    j->blen = len;
    j->pos = pos;
    j->i1 = 1;
    j->run = run_rw;
    j->done = done_int;
    return job_submit(c, j);
}

static void run_rwv(FsJob *j) {
    ssize_t r;
    do {
        if (j->i1)
            r = j->pos >= 0 ? pwritev(j->fd, j->iov, j->iovcnt, j->pos) : writev(j->fd, j->iov, j->iovcnt);
        else
            r = j->pos >= 0 ? preadv(j->fd, j->iov, j->iovcnt, j->pos) : readv(j->fd, j->iov, j->iovcnt);
    } while (r < 0 && errno == EINTR);
    if (r < 0) {
        const char *sc = j->i1 ? (j->pos >= 0 ? "pwritev" : "writev") : (j->pos >= 0 ? "preadv" : "readv");
        job_errno(j, sc, j->i1 && j->pos >= 0 ? 0 : JERR_FD);
        j->err_fd = j->fd;
    } else {
        j->r = r;
    }
}

// fsReadvJob(fd, buffers, position, kind, target), fsWritevJob(...).
static JSValue js_fs_rwv_job(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv, int magic) {
    int32_t fd;
    int64_t pos, n;
    if (to_i32(c, argv[0], &fd) || to_pos(c, argv[2], &pos) || JS_GetLength(c, argv[1], &n))
        return JS_EXCEPTION;
    if (n > IOV_MAX)
        n = IOV_MAX;
    JOB_NEW(3);
    j->iov = malloc(sizeof *j->iov * (n ? n : 1));
    // (The buffers held: an array of them, of its own.)
    JSValue held = JS_NewArray(c);
    if (!j->iov || JS_IsException(held)) {
        JS_FreeValue(c, held);
        job_free(c, j);
        return JS_ThrowOutOfMemory(c);
    }
    j->hold[0] = held;
    for (int64_t i = 0; i < n; i++) {
        JSValue v = JS_GetPropertyUint32(c, argv[1], (uint32_t)i);
        size_t len;
        uint8_t *b = JS_IsException(v) ? NULL : JS_GetUint8Array(c, &len, v);
        if (!b && JS_HasException(c)) {
            JS_FreeValue(c, v);
            job_free(c, j);
            return JS_EXCEPTION;
        }
        j->iov[i].iov_base = b;
        j->iov[i].iov_len = b ? len : 0;
        JS_SetPropertyUint32(c, held, (uint32_t)i, v);
    }
    j->iovcnt = (int)n;
    j->fd = fd;
    j->pos = pos;
    j->i1 = magic;
    j->run = run_rwv;
    j->done = done_int;
    return job_submit(c, j);
}

// readFile: the file read into memory of the job's (malloc'd), then made
// a Buffer of it (taken) or decoded.
static void run_read_file(FsJob *j) {
    int fd = j->fd;
    if (j->path) {
        fd = open_retry(j->path, j->flags | O_NOCTTY, 0666);
        if (fd < 0) {
            job_errno(j, "open", JERR_PATH);
            return;
        }
    }
    struct stat st;
    size_t cap = 64 * 1024;
    if (fstat(fd, &st) == 0 && S_ISREG(st.st_mode) && st.st_size > 0)
        cap = (size_t)st.st_size + 1;
    size_t limit = j->enc == ENC_BUFFER ? (size_t)INT32_MAX : (size_t)(1 << 30) - 1;
    uint8_t *b = malloc(cap);
    size_t total = 0;
    if (!b) {
        errno = ENOMEM;
        job_errno(j, "read", 0);
        goto out;
    }
    for (;;) {
        if (total == cap) {
            size_t ncap = cap + (cap >> 1) + 8192;
            uint8_t *nb = realloc(b, ncap);
            if (!nb) {
                errno = ENOMEM;
                job_errno(j, "read", 0);
                goto out;
            }
            b = nb;
            cap = ncap;
        }
        ssize_t n = read_retry(fd, b + total, cap - total);
        if (n < 0) {
            job_errno(j, "read", 0);
            goto out;
        }
        if (n == 0)
            break;
        total += n;
        if (total > limit) {
            errno = ENOMEM;
            job_errno(j, "read", j->path ? JERR_PATH : 0);
            goto out;
        }
    }
    j->data = b;
    j->dlen = total;
    b = NULL;
out:
    free(b);
    if (j->path)
        close(fd);
}

// (Memory of the C library's, which a job read a file into.)
static void *sys_realloc_ab(JSRuntime *rt, void *opaque, void *ptr, size_t size) {
    (void)rt;
    (void)opaque;
    if (size == 0) {
        free(ptr);
        return NULL;
    }
    return realloc(ptr, size);
}

static JSValue done_read_file(JSContext *c, FsJob *j) {
    if (j->enc == ENC_BUFFER) {
        // (The job's memory, the Buffer's now.)
        uint8_t *d = j->data;
        size_t n = j->dlen;
        if (n == 0)
            return new_buffer(c, NULL, (const uint8_t *)"", 0);
        JSValue u8 = JS_NewUint8Array(c, d, n, sys_realloc_ab, NULL, false);
        if (JS_IsException(u8))
            return u8;
        j->data = NULL;
        if (JS_IsObject(buffer_proto) && JS_SetPrototype(c, u8, buffer_proto) < 0) {
            JS_FreeValue(c, u8);
            return JS_EXCEPTION;
        }
        return u8;
    }
    return encode_bytes(c, j->data ? j->data : (const uint8_t *)"", j->dlen, j->enc, NULL);
}

// fsReadFileJob(pathOrFd, flags, encoding, signal, kind, target).
static JSValue js_fs_read_file_job(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    JOB_NEW(4);
    if (to_i32(c, argv[1], &j->flags) || to_i32(c, argv[2], &j->enc)) {
        job_free(c, j);
        return JS_EXCEPTION;
    }
    if (JS_IsNumber(argv[0])) {
        if (to_i32(c, argv[0], &j->fd)) {
            job_free(c, j);
            return JS_EXCEPTION;
        }
    } else {
        JOB_PATH(j, argv[0], 0);
    }
    if (JS_IsObject(argv[3]))
        j->signal = JS_DupValue(c, argv[3]);
    j->run = run_read_file;
    j->done = done_read_file;
    return job_submit(c, j);
}

static void run_write_file(FsJob *j) {
    int fd = j->fd;
    if (j->path) {
        // (As fsWriteFile: O_TRUNC left out, the file cut after.)
        fd = open_retry(j->path, (j->flags & O_APPEND) ? j->flags : j->flags & ~O_TRUNC, j->mode);
        if (fd < 0) {
            job_errno(j, "open", JERR_PATH);
            return;
        }
    }
    size_t done = 0;
    int no = 0;
    while (done < j->blen) {
        ssize_t n = write(fd, j->buf + done, j->blen - done);
        if (n < 0) {
            if (errno == EINTR)
                continue;
            no = errno;
            break;
        }
        if (n == 0)
            break;
        done += n;
    }
    if (j->path && (j->flags & O_TRUNC) && !(j->flags & O_APPEND)) {
        int r;
        do
            r = ftruncate(fd, (off_t)done);
        while (r < 0 && errno == EINTR);
    }
    if (!no && j->i1)
        fsync(fd);
    if (j->path)
        close(fd);
    if (no) {
        errno = no;
        job_errno(j, "write", 0);
    }
}

// fsWriteFileJob(pathOrFd, data, flags, mode, flush, signal, kind, target).
static JSValue js_fs_write_file_job(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    JOB_NEW(6);
    if (to_i32(c, argv[2], &j->flags) || to_i32(c, argv[3], &j->mode)) {
        job_free(c, j);
        return JS_EXCEPTION;
    }
    j->i1 = JS_ToBool(c, argv[4]);
    if (JS_IsString(argv[1])) {
        size_t len;
        const char *s = JS_ToCStringLen(c, &len, argv[1]);
        if (!s) {
            job_free(c, j);
            return JS_EXCEPTION;
        }
        j->data = malloc(len ? len : 1);
        if (!j->data) {
            JS_FreeCString(c, s);
            job_free(c, j);
            return JS_ThrowOutOfMemory(c);
        }
        memcpy(j->data, s, len);
        JS_FreeCString(c, s);
        beyond_rt_wtf8_fix(j->data, len);
        j->buf = j->data;
        j->blen = len;
    } else {
        size_t len;
        uint8_t *b = JS_GetUint8Array(c, &len, argv[1]);
        if (!b && JS_HasException(c)) {
            job_free(c, j);
            return JS_EXCEPTION;
        }
        j->buf = b;
        j->blen = b ? len : 0;
        j->hold[1] = JS_DupValue(c, argv[1]);
    }
    if (JS_IsNumber(argv[0])) {
        if (to_i32(c, argv[0], &j->fd)) {
            job_free(c, j);
            return JS_EXCEPTION;
        }
    } else {
        // (The data held in hold[1]: the path's string is hold[0].)
        JOB_PATH(j, argv[0], 0);
    }
    if (JS_IsObject(argv[5]))
        j->signal = JS_DupValue(c, argv[5]);
    j->run = run_write_file;
    return job_submit(c, j);
}

static JSValue done_null(JSContext *c, FsJob *j) {
    return JS_NULL;
}

static void run_access(FsJob *j) {
    if (access(j->path, j->mode) < 0)
        job_errno(j, "access", JERR_PATH);
}

// fsAccessJob(path, mode, kind, target).
static JSValue js_fs_access_job(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    JOB_NEW(2);
    JOB_PATH(j, argv[0], 0);
    if (to_i32(c, argv[1], &j->mode)) {
        job_free(c, j);
        return JS_EXCEPTION;
    }
    j->run = run_access;
    j->done = done_null;
    return job_submit(c, j);
}

static void run_exists(FsJob *j) {
    j->r = access(j->path, F_OK) == 0;
}

// fsExistsJob(path, kind, target).
static JSValue js_fs_exists_job(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    JOB_NEW(1);
    JOB_PATH(j, argv[0], 0);
    j->run = run_exists;
    j->done = done_bool;
    return job_submit(c, j);
}

static void run_path_op(FsJob *j) {
    int r;
    const char *sc;
    switch (j->i1) {
    case OP_UNLINK:
        r = unlink(j->path), sc = "unlink";
        break;
    case OP_RMDIR:
        r = rmdir(j->path), sc = "rmdir";
        break;
    case OP_CHMOD:
        r = chmod(j->path, (mode_t)j->a), sc = "chmod";
        break;
    case OP_LCHMOD:
        r = fchmodat(AT_FDCWD, j->path, (mode_t)j->a, AT_SYMLINK_NOFOLLOW), sc = "lchmod";
        break;
    case OP_CHOWN:
        r = chown(j->path, (uid_t)j->a, (gid_t)j->b), sc = "chown";
        break;
    case OP_LCHOWN:
        r = lchown(j->path, (uid_t)j->a, (gid_t)j->b), sc = "lchown";
        break;
    default:
        r = truncate(j->path, j->a & INT64_MAX), sc = "truncate";
    }
    if (r < 0)
        job_errno(j, sc, JERR_PATH);
}

// fsUnlinkJob(path, kind, target), ... as fsUnlink and the others.
static JSValue js_fs_path_op_job(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv, int magic) {
    int nargs = magic == OP_CHOWN || magic == OP_LCHOWN ? 3 : magic >= OP_CHMOD ? 2 : 1;
    JOB_NEW(nargs);
    JOB_PATH(j, argv[0], 0);
    j->a = j->b = 0;
    if ((nargs > 1 && JS_ToInt64(c, &j->a, argv[1])) || (nargs > 2 && JS_ToInt64(c, &j->b, argv[2]))) {
        job_free(c, j);
        return JS_EXCEPTION;
    }
    j->i1 = magic;
    j->run = run_path_op;
    return job_submit(c, j);
}

static void run_fd_op(FsJob *j) {
    int r;
    const char *sc;
    int what = 0;
    switch (j->i1) {
    case OP_FSYNC:
        r = fsync(j->fd), sc = "fsync";
        break;
    case OP_FDATASYNC:
        r = fdatasync(j->fd), sc = "fdatasync", what = JERR_FD;
        break;
    case OP_FCHMOD:
        r = fchmod(j->fd, (mode_t)j->a), sc = "fchmod";
        break;
    case OP_FCHOWN:
        r = fchown(j->fd, (uid_t)j->a, (gid_t)j->b), sc = "fchown";
        break;
    default:
        do
            r = ftruncate(j->fd, j->a & INT64_MAX);
        while (r < 0 && errno == EINTR);
        sc = "ftruncate";
    }
    if (r < 0) {
        job_errno(j, sc, what);
        j->err_fd = j->fd;
    }
}

// fsFsyncJob(fd, kind, target), ... as fsFsync and the others.
static JSValue js_fs_fd_op_job(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv, int magic) {
    int nargs = magic == OP_FCHOWN ? 3 : magic >= OP_FCHMOD ? 2 : 1;
    JOB_NEW(nargs);
    j->a = j->b = 0;
    if (to_i32(c, argv[0], &j->fd) || (nargs > 1 && JS_ToInt64(c, &j->a, argv[1])) ||
        (nargs > 2 && JS_ToInt64(c, &j->b, argv[2]))) {
        job_free(c, j);
        return JS_EXCEPTION;
    }
    j->i1 = magic;
    j->run = run_fd_op;
    return job_submit(c, j);
}

static void run_two_paths(FsJob *j) {
    int r;
    const char *sc;
    switch (j->i1) {
    case OP_RENAME:
        r = rename(j->path, j->path2), sc = "rename";
        break;
    case OP_LINK:
        r = link(j->path, j->path2), sc = "link";
        break;
    default:
        r = symlink(j->path, j->path2), sc = "symlink";
    }
    if (r < 0)
        job_errno(j, sc, JERR_PATH | JERR_DEST);
}

// fsRenameJob(from, to, kind, target), fsLinkJob, fsSymlinkJob.
static JSValue js_fs_two_paths_job(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv, int magic) {
    JOB_NEW(2);
    JOB_PATH(j, argv[0], 0);
    JOB_PATH(j, argv[1], 1);
    j->i1 = magic;
    j->run = run_two_paths;
    return job_submit(c, j);
}

static void run_utimes(FsJob *j) {
    struct timespec ts[2] = {{(time_t)j->a, (long)j->i2}, {(time_t)j->b, (long)j->i3}};
    if (j->path) {
        if (utimensat(AT_FDCWD, j->path, ts, j->i1 ? AT_SYMLINK_NOFOLLOW : 0) < 0)
            job_errno(j, j->i1 ? "lutime" : "utime", JERR_PATH);
    } else if (futimens(j->fd, ts) < 0) {
        job_errno(j, "futime", 0);
    }
}

// fsUtimesJob(path, atimeSec, atimeNsec, mtimeSec, mtimeNsec, nofollow,
// kind, target), fsFutimesJob(fd, ..., kind, target).
static JSValue js_fs_utimes_job(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv, int magic) {
    struct timespec ts[2];
    if (get_times(c, argv + 1, ts))
        return JS_EXCEPTION;
    JOB_NEW(magic ? 5 : 6);
    if (magic) {
        if (to_i32(c, argv[0], &j->fd)) {
            job_free(c, j);
            return JS_EXCEPTION;
        }
    } else {
        JOB_PATH(j, argv[0], 0);
        j->i1 = JS_ToBool(c, argv[5]);
    }
    j->a = ts[0].tv_sec, j->i2 = (int32_t)ts[0].tv_nsec;
    j->b = ts[1].tv_sec, j->i3 = (int32_t)ts[1].tv_nsec;
    j->run = run_utimes;
    return job_submit(c, j);
}

static JSValue done_bytes(JSContext *c, FsJob *j) {
    return encode_bytes(c, j->data ? j->data : (const uint8_t *)"", j->dlen, j->enc, NULL);
}

static void run_readlink(FsJob *j) {
    j->data = malloc(FS_PATH_MAX + 1);
    if (!j->data) {
        errno = ENOMEM;
        job_errno(j, "readlink", JERR_PATH);
        return;
    }
    ssize_t n = readlink(j->path, (char *)j->data, FS_PATH_MAX);
    if (n < 0)
        job_errno(j, "readlink", JERR_PATH);
    else
        j->dlen = (size_t)n;
}

// fsReadlinkJob(path, encoding, kind, target).
static JSValue js_fs_readlink_job(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    JOB_NEW(2);
    JOB_PATH(j, argv[0], 0);
    if (to_i32(c, argv[1], &j->enc)) {
        job_free(c, j);
        return JS_EXCEPTION;
    }
    j->run = run_readlink;
    j->done = done_bytes;
    return job_submit(c, j);
}

static void run_realpath(FsJob *j) {
    const char *sc = j->i1 ? "realpath" : "lstat";
    char abs[FS_PATH_MAX + 1];
    if (resolve_path(j->path, j->plen, abs) < 0) {
        errno = ENAMETOOLONG;
        job_errno(j, sc, JERR_PATH);
        return;
    }
    j->data = malloc(FS_PATH_MAX + 1);
    if (!j->data) {
        errno = ENOMEM;
        job_errno(j, sc, JERR_PATH);
        return;
    }
    char *out = (char *)j->data;
    int fd = open_retry(abs, O_PATH, 0);
    if (fd < 0) {
        job_errno(j, sc, JERR_PATH);
        return;
    }
    char proc[64];
    snprintf(proc, sizeof proc, "/proc/self/fd/%d", fd);
    ssize_t n = readlink(proc, out, FS_PATH_MAX);
    int no = errno;
    close(fd);
    if (n < 0) {
        if (!realpath(abs, out)) {
            errno = no;
            job_errno(j, sc, JERR_PATH);
            return;
        }
        n = strlen(out);
    }
    j->dlen = (size_t)n;
}

static JSValue done_realpath(JSContext *c, FsJob *j) {
    // (The path given, when it is the canonical one.)
    if (j->enc == ENC_UTF8 && JS_IsString(j->hold[0]) && j->dlen == j->plen && memcmp(j->data, j->path, j->dlen) == 0)
        return JS_DupValue(c, j->hold[0]);
    return done_bytes(c, j);
}

// fsRealpathJob(path, encoding, native, kind, target).
static JSValue js_fs_realpath_job(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    JOB_NEW(3);
    JOB_PATH(j, argv[0], 0);
    if (to_i32(c, argv[1], &j->enc)) {
        job_free(c, j);
        return JS_EXCEPTION;
    }
    j->i1 = JS_ToBool(c, argv[2]);
    j->run = run_realpath;
    j->done = done_realpath;
    return job_submit(c, j);
}

static void run_mkdir(FsJob *j) {
    if (j->plen == 0) {
        errno = ENOENT;
        job_errno(j, "mkdir", JERR_PATH);
        return;
    }
    if (!j->i1) {
        if (mkdir(j->path, (mode_t)j->mode) < 0)
            job_errno(j, "mkdir", JERR_PATH);
        j->r = -1;
        return;
    }
    char w[FS_PATH_MAX + 1];
    size_t first, el;
    int no = mkdir_recursive_core(j->path, j->plen, (mode_t)j->mode, w, &first, &el);
    if (no) {
        j->no = no;
        j->syscall = "mkdir";
        if (el == j->plen) {
            j->err_what = JERR_PATH;
        } else {
            j->err_buf = malloc(el + 1);
            if (j->err_buf) {
                memcpy(j->err_buf, j->path, el);
                j->err_buf[el] = 0;
                j->err_len = el;
                j->err_what = JERR_OWN;
            }
        }
        return;
    }
    j->r = first == MKDIR_NONE ? -1 : (int64_t)first;
}

static JSValue done_mkdir(JSContext *c, FsJob *j) {
    return j->r < 0 ? JS_UNDEFINED : JS_NewStringLen(c, j->path, (size_t)j->r);
}

// fsMkdirJob(path, mode, recursive, kind, target).
static JSValue js_fs_mkdir_job(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    JOB_NEW(3);
    JOB_PATH(j, argv[0], 0);
    if (to_i32(c, argv[1], &j->mode)) {
        job_free(c, j);
        return JS_EXCEPTION;
    }
    j->i1 = JS_ToBool(c, argv[2]);
    j->run = run_mkdir;
    j->done = done_mkdir;
    return job_submit(c, j);
}

static void run_mkdtemp(FsJob *j) {
    size_t n = j->plen < FS_PATH_MAX ? j->plen : FS_PATH_MAX;
    j->data = malloc(n + 8);
    if (!j->data) {
        errno = ENOMEM;
        job_errno(j, "mkdtemp", JERR_PATH);
        return;
    }
    char *t = (char *)j->data;
    memcpy(t, j->path, n);
    memcpy(t + n, "XXXXXX", 7);
    if (!mkdtemp(t)) {
        j->no = errno;
        j->syscall = "mkdtemp";
        j->err_buf = malloc(n + 7);
        if (j->err_buf) {
            memcpy(j->err_buf, t, n + 7);
            j->err_len = n + 6;
            j->err_what = JERR_OWN;
        }
        return;
    }
    j->dlen = n + 6;
}

// fsMkdtempJob(prefix, encoding, kind, target).
static JSValue js_fs_mkdtemp_job(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    JOB_NEW(2);
    JOB_PATH(j, argv[0], 0);
    if (to_i32(c, argv[1], &j->enc)) {
        job_free(c, j);
        return JS_EXCEPTION;
    }
    if (j->plen == 0) {
        j->no = EINVAL;
        j->syscall = "mkdtemp";
        j->err_buf = strdup("XXXXX");
        j->err_len = 5;
        j->err_what = j->err_buf ? JERR_OWN : 0;
    }
    j->run = run_mkdtemp;
    j->done = done_bytes;
    return job_submit(c, j);
}

// readdir: the entries collected (type, then the name's length and bytes:
// recursive, the path relative to the root), then made the JavaScript
// values fsReaddir makes.
typedef struct {
    uint8_t *b;
    size_t len, cap;
} Bytes;

static int bytes_put(Bytes *o, int type, const char *n, size_t nl) {
    if (o->len + 5 + nl > o->cap) {
        size_t cap = o->cap ? o->cap * 2 : 4096;
        while (cap < o->len + 5 + nl)
            cap *= 2;
        uint8_t *b = realloc(o->b, cap);
        if (!b)
            return -1;
        o->b = b;
        o->cap = cap;
    }
    uint8_t *p = o->b + o->len;
    uint32_t l = (uint32_t)nl;
    p[0] = (uint8_t)type;
    memcpy(p + 1, &l, 4);
    memcpy(p + 5, n, nl);
    o->len += 5 + nl;
    return 0;
}

static void run_readdir(FsJob *j) {
    Bytes o = {0};
    int count = 0;
    if (!j->i1) {
        int fd = open_retry(j->path, O_DIRECTORY | O_RDONLY, 0);
        DIR *d = fd < 0 ? NULL : fdopendir(fd);
        if (!d) {
            int no = errno;
            if (fd >= 0)
                close(fd);
            errno = no;
            job_errno(j, "scandir", JERR_PATH);
            return;
        }
        for (;;) {
            errno = 0;
            struct dirent *e = readdir(d);
            if (!e) {
                if (errno)
                    job_errno(j, "scandir", JERR_PATH);
                break;
            }
            const char *n = e->d_name;
            if (n[0] == '.' && (n[1] == 0 || (n[1] == '.' && n[2] == 0)))
                continue;
            int t = dirent_kind(e->d_type);
            if (j->i2 == RD_DIRENTS && e->d_type == DT_UNKNOWN) {
                struct stat st;
                if (fstatat(dirfd(d), n, &st, AT_SYMLINK_NOFOLLOW) == 0)
                    t = mode_kind(st.st_mode);
            }
            if (bytes_put(&o, t, n, strlen(n)) < 0) {
                errno = ENOMEM;
                job_errno(j, "scandir", JERR_PATH);
                break;
            }
            count++;
        }
        closedir(d);
        goto out;
    }
    // Recursive: as fsReaddir's (breadth first, symbolic links followed as
    // directories, entries that vanish meanwhile left out).
    {
        Bytes q = {0}; // the directories to read: their paths relative to the root
        size_t qh = 0;
        int root = -1;
        char joinbuf[2 * FS_PATH_MAX + 4];
        for (int first = 1;; first = 0) {
            const char *rel = NULL;
            size_t rl = 0;
            if (!first) {
                if (qh >= q.len)
                    break;
                uint32_t l;
                memcpy(&l, q.b + qh + 1, 4);
                rel = (const char *)q.b + qh + 5;
                rl = l;
                memcpy(joinbuf, rel, rl);
                joinbuf[rl] = 0;
                rel = joinbuf;
                qh += 5 + l;
            }
            char relbuf[2 * FS_PATH_MAX + 4];
            if (!first) {
                memcpy(relbuf, rel, rl + 1);
                rel = relbuf;
            }
            int fd = first ? open_retry(j->path, O_DIRECTORY | O_RDONLY, 0)
                           : openat(root, rel, O_DIRECTORY | O_RDONLY | O_CLOEXEC);
            if (fd < 0) {
                if (first) {
                    job_errno(j, "scandir", JERR_PATH);
                    break;
                }
                if (errno == ENOENT || errno == ENOTDIR || errno == EPERM)
                    continue;
                job_errno(j, "scandir", 0);
                break;
            }
            if (first)
                root = dup(fd);
            DIR *d = fdopendir(fd);
            if (!d) {
                close(fd);
                job_errno(j, "scandir", JERR_PATH);
                break;
            }
            int failed = 0;
            for (;;) {
                errno = 0;
                struct dirent *e = readdir(d);
                if (!e) {
                    int no = errno;
                    if (no && (first || !(no == ENOENT || no == ENOTDIR || no == EPERM))) {
                        job_errno(j, "scandir", JERR_PATH);
                        failed = 1;
                    }
                    break;
                }
                const char *n = e->d_name;
                if (n[0] == '.' && (n[1] == 0 || (n[1] == '.' && n[2] == 0)))
                    continue;
                size_t nl = strlen(n);
                const char *name = n;
                size_t namel = nl;
                char full[2 * FS_PATH_MAX + 4];
                if (!first) {
                    if (rl + 1 + nl > 2 * FS_PATH_MAX)
                        continue;
                    memcpy(full, rel, rl);
                    full[rl] = '/';
                    memcpy(full + rl + 1, n, nl);
                    full[rl + 1 + nl] = 0;
                    name = full;
                    namel = rl + 1 + nl;
                }
                int t = dirent_kind(e->d_type);
                int enqueue = t == 2 || t == 3;
                if (e->d_type == DT_UNKNOWN) {
                    struct stat st;
                    if (fstatat(dirfd(d), n, &st, AT_SYMLINK_NOFOLLOW) == 0) {
                        t = mode_kind(st.st_mode);
                        enqueue = t == 2 || t == 3;
                    }
                }
                if ((enqueue && nl + 1 + namel <= FS_PATH_MAX && bytes_put(&q, 0, name, namel) < 0) ||
                    bytes_put(&o, t, name, namel) < 0) {
                    errno = ENOMEM;
                    job_errno(j, "scandir", JERR_PATH);
                    failed = 1;
                    break;
                }
                count++;
            }
            closedir(d);
            if (failed)
                break;
        }
        if (root >= 0)
            close(root);
        free(q.b);
    }
out:
    j->data = o.b;
    j->dlen = o.len;
    j->r = count;
}

static JSValue done_readdir(JSContext *c, FsJob *j) {
    int kind = j->i2, enc = j->enc;
    JSValue arr = JS_NewArray(c);
    if (JS_IsException(arr))
        return arr;
    JSValue dpath = JS_UNDEFINED;
    char *dbuf = NULL, *prev = NULL;
    size_t prevlen = (size_t)-1;
    if (kind == RD_DIRENTS && !j->i1) {
        dpath = enc == ENC_UTF8 && JS_IsString(j->hold[0]) ? JS_DupValue(c, j->hold[0])
                                                           : encode_bytes(c, (const uint8_t *)j->path, j->plen, enc, NULL);
        if (JS_IsException(dpath))
            goto fail;
    }
    if (kind == RD_DIRENTS && j->i1) {
        dbuf = malloc(2 * FS_PATH_MAX + 4);
        prev = malloc(2 * FS_PATH_MAX + 4);
        if (!dbuf || !prev) {
            JS_ThrowOutOfMemory(c);
            goto fail;
        }
    }
    uint32_t count = 0;
    for (size_t i = 0; i < j->dlen;) {
        int t = j->data[i];
        uint32_t l;
        memcpy(&l, j->data + i + 1, 4);
        const char *name = (const char *)j->data + i + 5;
        i += 5 + l;
        JSValue v;
        if (kind == RD_BUFFERS) {
            v = new_buffer(c, NULL, (const uint8_t *)name, l);
        } else if (kind == RD_DIRENTS) {
            const char *base = name;
            size_t bl = l;
            if (j->i1) {
                size_t dl = join_dirname(j->path, j->plen, name, l, dbuf, 2 * FS_PATH_MAX + 4);
                if (dl != prevlen || memcmp(dbuf, prev, dl) != 0) {
                    JS_FreeValue(c, dpath);
                    dpath = encode_bytes(c, (const uint8_t *)dbuf, dl, enc, NULL);
                    if (JS_IsException(dpath)) {
                        dpath = JS_UNDEFINED;
                        goto fail;
                    }
                    memcpy(prev, dbuf, dl);
                    prevlen = dl;
                }
                const char *slash = memrchr(name, '/', l);
                if (slash) {
                    base = slash + 1;
                    bl = l - (size_t)(base - name);
                }
            }
            JSValue nm = encode_bytes(c, (const uint8_t *)base, bl, enc, NULL);
            v = JS_IsException(nm) ? nm : new_dirent(c, nm, t, dpath);
        } else {
            v = encode_bytes(c, (const uint8_t *)name, l, enc, NULL);
        }
        if (JS_IsException(v) || JS_SetPropertyUint32(c, arr, count++, v) < 0)
            goto fail;
    }
    JS_FreeValue(c, dpath);
    free(dbuf);
    free(prev);
    return arr;
fail:
    JS_FreeValue(c, dpath);
    free(dbuf);
    free(prev);
    JS_FreeValue(c, arr);
    return JS_EXCEPTION;
}

// fsReaddirJob(path, kind, recursive, encoding, kind, target).
static JSValue js_fs_readdir_job(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    JOB_NEW(4);
    JOB_PATH(j, argv[0], 0);
    if (to_i32(c, argv[1], &j->i2) || to_i32(c, argv[3], &j->enc)) {
        job_free(c, j);
        return JS_EXCEPTION;
    }
    j->i1 = JS_ToBool(c, argv[2]);
    j->run = run_readdir;
    j->done = done_readdir;
    return job_submit(c, j);
}

static void run_rm(FsJob *j) {
    int no;
    if (j->i1) {
        no = j->plen == 0 ? ENOENT : delete_tree(AT_FDCWD, j->path, 0);
        if (no && no != ENOENT)
            no = rm_tree_errno(no);
    } else {
        no = unlink(j->path) == 0 ? 0 : errno;
        if (no && no != ENOENT) {
            switch (no) {
            case EACCES: case ELOOP: case ENAMETOOLONG: case ENOMEM: case EROFS: case EBUSY:
                break;
            default:
                no = EFAULT;
            }
        }
    }
    if (no == ENOENT) {
        if (!j->i2) {
            errno = ENOENT;
            job_errno(j, "lstat", JERR_PATH);
        }
        return;
    }
    if (no) {
        errno = no;
        job_errno(j, "rm", JERR_PATH);
    }
}

// fsRmJob(path, recursive, force, kind, target).
static JSValue js_fs_rm_job(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    JOB_NEW(3);
    JOB_PATH(j, argv[0], 0);
    j->i1 = JS_ToBool(c, argv[1]);
    j->i2 = JS_ToBool(c, argv[2]);
    j->run = run_rm;
    return job_submit(c, j);
}

static void run_rmdir_recursive(FsJob *j) {
    int no = j->plen == 0 ? ENOENT : delete_tree(AT_FDCWD, j->path, 0);
    if (!no)
        return;
    switch (no) {
    case EACCES: no = EPERM; break;
    case ENOENT: case EPERM: case ELOOP: case ENAMETOOLONG: case ENOMEM: case EROFS: case EIO: case EBUSY:
    case ENOTDIR: case EISDIR: case EMFILE: case ENFILE: case EINVAL: case EFBIG:
        break;
    default:
        no = EFAULT;
    }
    errno = no;
    job_errno(j, "rmdir", 0);
}

// fsRmdirRecursiveJob(path, kind, target).
static JSValue js_fs_rmdir_recursive_job(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    JOB_NEW(1);
    JOB_PATH(j, argv[0], 0);
    j->run = run_rmdir_recursive;
    return job_submit(c, j);
}

static void run_copy_file(FsJob *j) {
    int no = 0, mode = j->mode;
    int src = open_retry(j->path, O_RDONLY, 0644), dest = -1;
    struct stat st;
    if (src < 0) {
        no = errno;
        goto done;
    }
    if (fstat(src, &st) < 0) {
        no = errno;
        goto done;
    }
    if (!S_ISREG(st.st_mode)) {
        no = ENOTSUP;
        goto done;
    }
    dest = open_retry(j->path2, O_CREAT | O_WRONLY | ((mode & 1) ? O_EXCL : 0), st.st_mode);
    if (dest < 0) {
        no = errno;
        goto done;
    }
    if (mode & 4) {
        if (ioctl(dest, FICLONE, src) < 0) {
            no = errno;
            close(dest);
            dest = -1;
            unlink(j->path2);
            goto done;
        }
        fchmod(dest, st.st_mode);
        goto done;
    }
    if (ficlone_works) {
        if (ioctl(dest, FICLONE, src) == 0) {
            fchmod(dest, st.st_mode);
            goto done;
        }
        ficlone_works = 0;
    }
    {
        uint64_t wrote = 0;
        no = copy_data(src, dest, (size_t)st.st_size, &wrote);
        if (ftruncate(dest, (off_t)wrote) < 0) {
        }
        fchmod(dest, st.st_mode);
    }
done:
    if (src >= 0)
        close(src);
    if (dest >= 0)
        close(dest);
    if (no) {
        errno = no;
        job_errno(j, "copyfile", JERR_PATH | JERR_DEST);
    }
}

// fsCopyFileJob(src, dest, mode, kind, target).
static JSValue js_fs_copy_file_job(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    JOB_NEW(3);
    JOB_PATH(j, argv[0], 0);
    JOB_PATH(j, argv[1], 1);
    if (to_i32(c, argv[2], &j->mode)) {
        job_free(c, j);
        return JS_EXCEPTION;
    }
    j->run = run_copy_file;
    return job_submit(c, j);
}

static void run_cp(FsJob *j) {
    Cp *cp = malloc(sizeof *cp);
    if (!cp) {
        errno = ENOMEM;
        job_errno(j, "copyfile", 0);
        return;
    }
    cp->recursive = j->i1;
    cp->error_on_exist = j->i2;
    cp->force = j->i3;
    memcpy(cp->src, j->path, j->plen + 1);
    memcpy(cp->dest, j->path2, j->p2len + 1);
    if (cp_inner(cp, j->plen, j->p2len, 1) < 0) {
        j->no = cp->no;
        j->syscall = cp->syscall;
        if (cp->has_path) {
            j->err_buf = strdup(cp->err_path);
            if (j->err_buf) {
                j->err_len = strlen(j->err_buf);
                j->err_what = JERR_OWN;
            }
        }
    }
    free(cp);
}

// fsCpJob(src, dest, recursive, errorOnExist, force, kind, target).
static JSValue js_fs_cp_job(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    JOB_NEW(5);
    JOB_PATH(j, argv[0], 0);
    JOB_PATH(j, argv[1], 1);
    j->i1 = JS_ToBool(c, argv[2]);
    j->i2 = JS_ToBool(c, argv[3]);
    j->i3 = JS_ToBool(c, argv[4]);
    j->run = run_cp;
    return job_submit(c, j);
}

const JSCFunctionListEntry beyond_fs_functions[] = {
    JS_CFUNC_DEF("fsInit", 6, js_fs_init),
    JS_CFUNC_DEF("fsError", 5, js_fs_error),
    JS_CFUNC_DEF("fsEncode", 2, js_fs_encode),
    JS_CFUNC_DEF("fsStat", 4, js_fs_stat),
    JS_CFUNC_DEF("fsFstat", 2, js_fs_fstat),
    JS_CFUNC_DEF("fsStatfs", 2, js_fs_statfs),
    JS_CFUNC_DEF("fsMakeDirent", 4, js_fs_make_dirent),
    JS_CFUNC_DEF("fsDirentType", 1, js_fs_dirent_type),
    JS_CFUNC_DEF("fsOpen", 3, js_fs_open),
    JS_CFUNC_DEF("fsClose", 1, js_fs_close),
    JS_CFUNC_DEF("fsRead", 5, js_fs_read),
    JS_CFUNC_DEF("fsWrite", 5, js_fs_write),
    JS_CFUNC_DEF("fsWriteString", 3, js_fs_write_string),
    JS_CFUNC_MAGIC_DEF("fsReadv", 3, js_fs_rwv, 0),
    JS_CFUNC_MAGIC_DEF("fsWritev", 3, js_fs_rwv, 1),
    JS_CFUNC_DEF("fsReadFile", 3, js_fs_read_file),
    JS_CFUNC_DEF("fsWriteFile", 5, js_fs_write_file),
    JS_CFUNC_DEF("fsAccess", 2, js_fs_access),
    JS_CFUNC_DEF("fsExists", 1, js_fs_exists),
    JS_CFUNC_MAGIC_DEF("fsUnlink", 1, js_fs_path_op, OP_UNLINK),
    JS_CFUNC_MAGIC_DEF("fsRmdir", 1, js_fs_path_op, OP_RMDIR),
    JS_CFUNC_MAGIC_DEF("fsChmod", 2, js_fs_path_op, OP_CHMOD),
    JS_CFUNC_MAGIC_DEF("fsLchmod", 2, js_fs_path_op, OP_LCHMOD),
    JS_CFUNC_MAGIC_DEF("fsChown", 3, js_fs_path_op, OP_CHOWN),
    JS_CFUNC_MAGIC_DEF("fsLchown", 3, js_fs_path_op, OP_LCHOWN),
    JS_CFUNC_MAGIC_DEF("fsTruncate", 2, js_fs_path_op, OP_TRUNCATE),
    JS_CFUNC_MAGIC_DEF("fsFsync", 1, js_fs_fd_op, OP_FSYNC),
    JS_CFUNC_MAGIC_DEF("fsFdatasync", 1, js_fs_fd_op, OP_FDATASYNC),
    JS_CFUNC_MAGIC_DEF("fsFchmod", 2, js_fs_fd_op, OP_FCHMOD),
    JS_CFUNC_MAGIC_DEF("fsFchown", 3, js_fs_fd_op, OP_FCHOWN),
    JS_CFUNC_MAGIC_DEF("fsFtruncate", 2, js_fs_fd_op, OP_FTRUNCATE),
    JS_CFUNC_MAGIC_DEF("fsRename", 2, js_fs_two_paths, OP_RENAME),
    JS_CFUNC_MAGIC_DEF("fsLink", 2, js_fs_two_paths, OP_LINK),
    JS_CFUNC_MAGIC_DEF("fsSymlink", 2, js_fs_two_paths, OP_SYMLINK),
    JS_CFUNC_DEF("fsUtimes", 6, js_fs_utimes),
    JS_CFUNC_DEF("fsFutimes", 5, js_fs_futimes),
    JS_CFUNC_DEF("fsReadlink", 2, js_fs_readlink),
    JS_CFUNC_DEF("fsRealpath", 3, js_fs_realpath),
    JS_CFUNC_DEF("fsMkdir", 3, js_fs_mkdir),
    JS_CFUNC_DEF("fsMkdtemp", 2, js_fs_mkdtemp),
    JS_CFUNC_DEF("fsReaddir", 4, js_fs_readdir),
    JS_CFUNC_DEF("fsRm", 3, js_fs_rm),
    JS_CFUNC_DEF("fsRmdirRecursive", 1, js_fs_rmdir_recursive),
    JS_CFUNC_DEF("fsCopyFile", 3, js_fs_copy_file),
    JS_CFUNC_DEF("fsCp", 5, js_fs_cp),
    JS_CFUNC_DEF("fsJobsPending", 0, js_fs_jobs_pending),
    JS_CFUNC_DEF("fsWatchStart", 5, js_fs_watch_start),
    JS_CFUNC_DEF("fsWatchClose", 1, js_fs_watch_close),
    JS_CFUNC_DEF("fsWatchRef", 2, js_fs_watch_ref),
    JS_CFUNC_DEF("fsPoolInit", 1, js_fs_pool_init),
    JS_CFUNC_DEF("fsStatJob", 6, js_fs_stat_job),
    JS_CFUNC_DEF("fsFstatJob", 4, js_fs_fstat_job),
    JS_CFUNC_DEF("fsStatfsJob", 4, js_fs_statfs_job),
    JS_CFUNC_DEF("fsOpenJob", 5, js_fs_open_job),
    JS_CFUNC_DEF("fsCloseJob", 3, js_fs_close_job),
    JS_CFUNC_MAGIC_DEF("fsReadJob", 7, js_fs_rw_job, 0),
    JS_CFUNC_MAGIC_DEF("fsWriteJob", 7, js_fs_rw_job, 1),
    JS_CFUNC_DEF("fsWriteStringJob", 5, js_fs_write_string_job),
    JS_CFUNC_MAGIC_DEF("fsReadvJob", 5, js_fs_rwv_job, 0),
    JS_CFUNC_MAGIC_DEF("fsWritevJob", 5, js_fs_rwv_job, 1),
    JS_CFUNC_DEF("fsReadFileJob", 6, js_fs_read_file_job),
    JS_CFUNC_DEF("fsWriteFileJob", 8, js_fs_write_file_job),
    JS_CFUNC_DEF("fsAccessJob", 4, js_fs_access_job),
    JS_CFUNC_DEF("fsExistsJob", 3, js_fs_exists_job),
    JS_CFUNC_MAGIC_DEF("fsUnlinkJob", 3, js_fs_path_op_job, OP_UNLINK),
    JS_CFUNC_MAGIC_DEF("fsRmdirJob", 3, js_fs_path_op_job, OP_RMDIR),
    JS_CFUNC_MAGIC_DEF("fsChmodJob", 4, js_fs_path_op_job, OP_CHMOD),
    JS_CFUNC_MAGIC_DEF("fsLchmodJob", 4, js_fs_path_op_job, OP_LCHMOD),
    JS_CFUNC_MAGIC_DEF("fsChownJob", 5, js_fs_path_op_job, OP_CHOWN),
    JS_CFUNC_MAGIC_DEF("fsLchownJob", 5, js_fs_path_op_job, OP_LCHOWN),
    JS_CFUNC_MAGIC_DEF("fsTruncateJob", 4, js_fs_path_op_job, OP_TRUNCATE),
    JS_CFUNC_MAGIC_DEF("fsFsyncJob", 3, js_fs_fd_op_job, OP_FSYNC),
    JS_CFUNC_MAGIC_DEF("fsFdatasyncJob", 3, js_fs_fd_op_job, OP_FDATASYNC),
    JS_CFUNC_MAGIC_DEF("fsFchmodJob", 4, js_fs_fd_op_job, OP_FCHMOD),
    JS_CFUNC_MAGIC_DEF("fsFchownJob", 5, js_fs_fd_op_job, OP_FCHOWN),
    JS_CFUNC_MAGIC_DEF("fsFtruncateJob", 4, js_fs_fd_op_job, OP_FTRUNCATE),
    JS_CFUNC_MAGIC_DEF("fsRenameJob", 4, js_fs_two_paths_job, OP_RENAME),
    JS_CFUNC_MAGIC_DEF("fsLinkJob", 4, js_fs_two_paths_job, OP_LINK),
    JS_CFUNC_MAGIC_DEF("fsSymlinkJob", 4, js_fs_two_paths_job, OP_SYMLINK),
    JS_CFUNC_MAGIC_DEF("fsUtimesJob", 8, js_fs_utimes_job, 0),
    JS_CFUNC_MAGIC_DEF("fsFutimesJob", 7, js_fs_utimes_job, 1),
    JS_CFUNC_DEF("fsReadlinkJob", 4, js_fs_readlink_job),
    JS_CFUNC_DEF("fsRealpathJob", 5, js_fs_realpath_job),
    JS_CFUNC_DEF("fsMkdirJob", 5, js_fs_mkdir_job),
    JS_CFUNC_DEF("fsMkdtempJob", 4, js_fs_mkdtemp_job),
    JS_CFUNC_DEF("fsReaddirJob", 6, js_fs_readdir_job),
    JS_CFUNC_DEF("fsRmJob", 5, js_fs_rm_job),
    JS_CFUNC_DEF("fsRmdirRecursiveJob", 3, js_fs_rmdir_recursive_job),
    JS_CFUNC_DEF("fsCopyFileJob", 5, js_fs_copy_file_job),
    JS_CFUNC_DEF("fsCpJob", 7, js_fs_cp_job),
};

const int beyond_fs_function_count = sizeof beyond_fs_functions / sizeof *beyond_fs_functions;
