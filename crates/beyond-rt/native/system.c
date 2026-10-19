// The system beyond the web's APIs: files (node:fs, Bun.file), the process
// (process, node:os), and Beyond.build's bundler and transpiler, a library
// loaded (dlopen) the first time a program needs it (libbeyond_build.so,
// crates/beyond-build).

#include <dirent.h>
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/utsname.h>
#include <time.h>
#include <unistd.h>

#include "quickjs.h"
#include "quickjs-libc.h"

extern char **environ;
void beyond_flush_stdout(void);

static int saved_argc;
static char **saved_argv;

void beyond_system_init(int argc, char **argv) {
    saved_argc = argc;
    saved_argv = argv;
}

// ---- Errors as Node's (libuv's names and messages) ----

static const struct {
    int no;
    const char *code, *message;
} errnos[] = {
    {ENOENT, "ENOENT", "no such file or directory"},
    {EEXIST, "EEXIST", "file already exists"},
    {EACCES, "EACCES", "permission denied"},
    {EPERM, "EPERM", "operation not permitted"},
    {EISDIR, "EISDIR", "illegal operation on a directory"},
    {ENOTDIR, "ENOTDIR", "not a directory"},
    {ENOTEMPTY, "ENOTEMPTY", "directory not empty"},
    {EBADF, "EBADF", "bad file descriptor"},
    {EINVAL, "EINVAL", "invalid argument"},
    {EMFILE, "EMFILE", "too many open files"},
    {ELOOP, "ELOOP", "too many symbolic links encountered"},
    {ENAMETOOLONG, "ENAMETOOLONG", "name too long"},
    {EXDEV, "EXDEV", "cross-device link not permitted"},
    {EBUSY, "EBUSY", "resource busy or locked"},
    {ENOSPC, "ENOSPC", "no space left on device"},
    {EROFS, "EROFS", "read-only file system"},
    {EIO, "EIO", "i/o error"},
};

// Throw `<CODE>: <message>, <syscall> '<path>'` with errno, code, syscall
// and path, as Node's fs does.
static JSValue throw_errno(JSContext *c, int no, const char *syscall, const char *path, const char *dest) {
    const char *code = "UNKNOWN", *message = strerror(no);
    for (size_t i = 0; i < sizeof errnos / sizeof *errnos; i++) {
        if (errnos[i].no == no) {
            code = errnos[i].code;
            message = errnos[i].message;
        }
    }
    char text[PATH_MAX * 2 + 256];
    if (dest)
        snprintf(text, sizeof text, "%s: %s, %s '%s' -> '%s'", code, message, syscall, path, dest);
    else if (path)
        snprintf(text, sizeof text, "%s: %s, %s '%s'", code, message, syscall, path);
    else
        snprintf(text, sizeof text, "%s: %s, %s", code, message, syscall);
    JSValue e = JS_NewError(c);
    JS_DefinePropertyValueStr(c, e, "message", JS_NewString(c, text), JS_PROP_WRITABLE | JS_PROP_CONFIGURABLE);
    JS_SetPropertyStr(c, e, "errno", JS_NewInt32(c, -no));
    JS_SetPropertyStr(c, e, "code", JS_NewString(c, code));
    JS_SetPropertyStr(c, e, "syscall", JS_NewString(c, syscall));
    if (path)
        JS_SetPropertyStr(c, e, "path", JS_NewString(c, path));
    if (dest)
        JS_SetPropertyStr(c, e, "dest", JS_NewString(c, dest));
    return JS_Throw(c, e);
}

// ---- Files ----

// readFile(path, text): the file's content, a string (UTF-8) if `text`,
// else an ArrayBuffer.
static JSValue js_read_file(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    const char *path = JS_ToCString(c, argv[0]);
    if (!path)
        return JS_EXCEPTION;
    int fd = open(path, O_RDONLY | O_CLOEXEC);
    if (fd < 0) {
        JSValue r = throw_errno(c, errno, "open", path, NULL);
        JS_FreeCString(c, path);
        return r;
    }
    struct stat st;
    if (fstat(fd, &st) == 0 && S_ISDIR(st.st_mode)) {
        close(fd);
        JSValue r = throw_errno(c, EISDIR, "read", NULL, NULL);
        JS_FreeCString(c, path);
        return r;
    }
    size_t cap = st.st_size > 0 ? (size_t)st.st_size + 1 : 4096, len = 0;
    char *buf = malloc(cap);
    for (;;) {
        if (!buf) {
            close(fd);
            JS_FreeCString(c, path);
            return JS_ThrowOutOfMemory(c);
        }
        ssize_t n = read(fd, buf + len, cap - len);
        if (n < 0) {
            if (errno == EINTR)
                continue;
            int no = errno;
            free(buf);
            close(fd);
            JSValue r = throw_errno(c, no, "read", path, NULL);
            JS_FreeCString(c, path);
            return r;
        }
        if (n == 0)
            break;
        len += n;
        if (len == cap) {
            cap *= 2;
            char *b = realloc(buf, cap);
            if (!b)
                free(buf);
            buf = b;
        }
    }
    close(fd);
    JS_FreeCString(c, path);
    JSValue r = JS_ToBool(c, argv[1]) ? JS_NewStringLen(c, buf, len) : JS_NewArrayBufferCopy(c, (uint8_t *)buf, len);
    free(buf);
    return r;
}

// writeFile(path, data, append, mode): writes a string (UTF-8) or the
// bytes of an ArrayBuffer or a view; the number of bytes.
static JSValue js_write_file(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    const char *path = JS_ToCString(c, argv[0]);
    if (!path)
        return JS_EXCEPTION;
    size_t len = 0;
    const uint8_t *data;
    const char *str = NULL;
    if (JS_IsString(argv[1])) {
        str = JS_ToCStringLen(c, &len, argv[1]);
        if (!str) {
            JS_FreeCString(c, path);
            return JS_EXCEPTION;
        }
        data = (const uint8_t *)str;
    } else {
        size_t off = 0, size = 0, bpe;
        JSValue ab = JS_GetTypedArrayBuffer(c, argv[1], &off, &size, &bpe);
        if (JS_IsException(ab)) {
            JS_FreeValue(c, JS_GetException(c));
            data = JS_GetArrayBuffer(c, &len, argv[1]);
            if (!data) {
                JS_FreeCString(c, path);
                return JS_ThrowTypeError(c, "the data must be a string, an ArrayBuffer or a view of one");
            }
        } else {
            size_t whole;
            data = JS_GetArrayBuffer(c, &whole, ab) + off;
            len = size;
            JS_FreeValue(c, ab);
        }
    }
    int32_t mode = 0666;
    if (argc > 3 && !JS_IsUndefined(argv[3]))
        JS_ToInt32(c, &mode, argv[3]);
    int flags = O_WRONLY | O_CREAT | O_CLOEXEC | (JS_ToBool(c, argv[2]) ? O_APPEND : O_TRUNC);
    int fd = open(path, flags, mode);
    if (fd < 0) {
        JSValue r = throw_errno(c, errno, "open", path, NULL);
        JS_FreeCString(c, path);
        if (str)
            JS_FreeCString(c, str);
        return r;
    }
    size_t done = 0;
    while (done < len) {
        ssize_t n = write(fd, data + done, len - done);
        if (n < 0) {
            if (errno == EINTR)
                continue;
            int no = errno;
            close(fd);
            JSValue r = throw_errno(c, no, "write", path, NULL);
            JS_FreeCString(c, path);
            if (str)
                JS_FreeCString(c, str);
            return r;
        }
        done += n;
    }
    close(fd);
    JS_FreeCString(c, path);
    if (str)
        JS_FreeCString(c, str);
    return JS_NewInt64(c, (int64_t)len);
}

static double ms(struct timespec t) {
    return (double)t.tv_sec * 1e3 + (double)t.tv_nsec / 1e6;
}

// stat(path, follow, mustExist): {dev, ino, mode, nlink, uid, gid, rdev,
// size, blksize, blocks, atimeMs, mtimeMs, ctimeMs, birthtimeMs}, or
// undefined if it does not exist and need not.
static JSValue js_stat(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    const char *path = JS_ToCString(c, argv[0]);
    if (!path)
        return JS_EXCEPTION;
    struct stat st;
    int follow = JS_ToBool(c, argv[1]);
    if ((follow ? stat(path, &st) : lstat(path, &st)) < 0) {
        int no = errno;
        JSValue r = (no == ENOENT || no == ENOTDIR) && !JS_ToBool(c, argv[2])
            ? JS_UNDEFINED
            : throw_errno(c, no, follow ? "stat" : "lstat", path, NULL);
        JS_FreeCString(c, path);
        return r;
    }
    JS_FreeCString(c, path);
    JSValue o = JS_NewObject(c);
    JS_SetPropertyStr(c, o, "dev", JS_NewFloat64(c, (double)st.st_dev));
    JS_SetPropertyStr(c, o, "ino", JS_NewFloat64(c, (double)st.st_ino));
    JS_SetPropertyStr(c, o, "mode", JS_NewInt32(c, st.st_mode));
    JS_SetPropertyStr(c, o, "nlink", JS_NewFloat64(c, (double)st.st_nlink));
    JS_SetPropertyStr(c, o, "uid", JS_NewInt32(c, st.st_uid));
    JS_SetPropertyStr(c, o, "gid", JS_NewInt32(c, st.st_gid));
    JS_SetPropertyStr(c, o, "rdev", JS_NewFloat64(c, (double)st.st_rdev));
    JS_SetPropertyStr(c, o, "size", JS_NewFloat64(c, (double)st.st_size));
    JS_SetPropertyStr(c, o, "blksize", JS_NewFloat64(c, (double)st.st_blksize));
    JS_SetPropertyStr(c, o, "blocks", JS_NewFloat64(c, (double)st.st_blocks));
    JS_SetPropertyStr(c, o, "atimeMs", JS_NewFloat64(c, ms(st.st_atim)));
    JS_SetPropertyStr(c, o, "mtimeMs", JS_NewFloat64(c, ms(st.st_mtim)));
    JS_SetPropertyStr(c, o, "ctimeMs", JS_NewFloat64(c, ms(st.st_ctim)));
    JS_SetPropertyStr(c, o, "birthtimeMs", JS_NewFloat64(c, ms(st.st_ctim)));
    return o;
}

// realpath(path): the canonical absolute path.
static JSValue js_realpath(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    const char *path = JS_ToCString(c, argv[0]);
    if (!path)
        return JS_EXCEPTION;
    char out[PATH_MAX];
    JSValue r = realpath(path, out) ? JS_NewString(c, out) : throw_errno(c, errno, "realpath", path, NULL);
    JS_FreeCString(c, path);
    return r;
}

// readdir(path): [name, type] of each entry but `.` and `..`, type 1 a
// file, 2 a directory, 3 a symbolic link, 0 other (Node's order: the
// directory's).
static JSValue js_readdir(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    const char *path = JS_ToCString(c, argv[0]);
    if (!path)
        return JS_EXCEPTION;
    DIR *d = opendir(path);
    if (!d) {
        JSValue r = throw_errno(c, errno, "scandir", path, NULL);
        JS_FreeCString(c, path);
        return r;
    }
    JSValue arr = JS_NewArray(c);
    uint32_t i = 0;
    struct dirent *e;
    while ((e = readdir(d))) {
        if (!strcmp(e->d_name, ".") || !strcmp(e->d_name, ".."))
            continue;
        int type = e->d_type == DT_REG ? 1 : e->d_type == DT_DIR ? 2 : e->d_type == DT_LNK ? 3 : 0;
        if (e->d_type == DT_UNKNOWN) {
            char full[PATH_MAX];
            struct stat st;
            snprintf(full, sizeof full, "%s/%s", path, e->d_name);
            if (lstat(full, &st) == 0)
                type = S_ISREG(st.st_mode) ? 1 : S_ISDIR(st.st_mode) ? 2 : S_ISLNK(st.st_mode) ? 3 : 0;
        }
        JSValue pair = JS_NewArray(c);
        JS_SetPropertyUint32(c, pair, 0, JS_NewString(c, e->d_name));
        JS_SetPropertyUint32(c, pair, 1, JS_NewInt32(c, type));
        JS_SetPropertyUint32(c, arr, i++, pair);
    }
    closedir(d);
    JS_FreeCString(c, path);
    return arr;
}

// mkdir(path, mode): creates one directory.
static JSValue js_mkdir(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    const char *path = JS_ToCString(c, argv[0]);
    if (!path)
        return JS_EXCEPTION;
    int32_t mode = 0777;
    if (!JS_IsUndefined(argv[1]))
        JS_ToInt32(c, &mode, argv[1]);
    JSValue r = mkdir(path, mode) == 0 ? JS_UNDEFINED : throw_errno(c, errno, "mkdir", path, NULL);
    JS_FreeCString(c, path);
    return r;
}

// unlink(path), rmdir(path): removes a file, an empty directory.
static JSValue js_unlink(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    const char *path = JS_ToCString(c, argv[0]);
    if (!path)
        return JS_EXCEPTION;
    JSValue r = unlink(path) == 0 ? JS_UNDEFINED : throw_errno(c, errno, "unlink", path, NULL);
    JS_FreeCString(c, path);
    return r;
}

static JSValue js_rmdir(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    const char *path = JS_ToCString(c, argv[0]);
    if (!path)
        return JS_EXCEPTION;
    JSValue r = rmdir(path) == 0 ? JS_UNDEFINED : throw_errno(c, errno, "rmdir", path, NULL);
    JS_FreeCString(c, path);
    return r;
}

// rename(from, to).
static JSValue js_rename(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    const char *from = JS_ToCString(c, argv[0]);
    if (!from)
        return JS_EXCEPTION;
    const char *to = JS_ToCString(c, argv[1]);
    if (!to) {
        JS_FreeCString(c, from);
        return JS_EXCEPTION;
    }
    JSValue r = rename(from, to) == 0 ? JS_UNDEFINED : throw_errno(c, errno, "rename", from, to);
    JS_FreeCString(c, from);
    JS_FreeCString(c, to);
    return r;
}

// access(path, mode): throws if the file is not accessible so.
static JSValue js_access(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    const char *path = JS_ToCString(c, argv[0]);
    if (!path)
        return JS_EXCEPTION;
    int32_t mode = F_OK;
    if (!JS_IsUndefined(argv[1]))
        JS_ToInt32(c, &mode, argv[1]);
    JSValue r = access(path, mode) == 0 ? JS_UNDEFINED : throw_errno(c, errno, "access", path, NULL);
    JS_FreeCString(c, path);
    return r;
}

// readlink(path), symlink(target, path), chmod(path, mode).
static JSValue js_readlink(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    const char *path = JS_ToCString(c, argv[0]);
    if (!path)
        return JS_EXCEPTION;
    char out[PATH_MAX];
    ssize_t n = readlink(path, out, sizeof out);
    JSValue r = n >= 0 ? JS_NewStringLen(c, out, n) : throw_errno(c, errno, "readlink", path, NULL);
    JS_FreeCString(c, path);
    return r;
}

static JSValue js_symlink(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    const char *target = JS_ToCString(c, argv[0]);
    if (!target)
        return JS_EXCEPTION;
    const char *path = JS_ToCString(c, argv[1]);
    if (!path) {
        JS_FreeCString(c, target);
        return JS_EXCEPTION;
    }
    JSValue r = symlink(target, path) == 0 ? JS_UNDEFINED : throw_errno(c, errno, "symlink", target, path);
    JS_FreeCString(c, target);
    JS_FreeCString(c, path);
    return r;
}

static JSValue js_chmod(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    const char *path = JS_ToCString(c, argv[0]);
    if (!path)
        return JS_EXCEPTION;
    int32_t mode = 0;
    JS_ToInt32(c, &mode, argv[1]);
    JSValue r = chmod(path, mode) == 0 ? JS_UNDEFINED : throw_errno(c, errno, "chmod", path, NULL);
    JS_FreeCString(c, path);
    return r;
}

// ---- The process ----

static JSValue js_cwd(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    char out[PATH_MAX];
    return getcwd(out, sizeof out) ? JS_NewString(c, out) : throw_errno(c, errno, "uv_cwd", NULL, NULL);
}

static JSValue js_chdir(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    const char *path = JS_ToCString(c, argv[0]);
    if (!path)
        return JS_EXCEPTION;
    JSValue r = chdir(path) == 0 ? JS_UNDEFINED : throw_errno(c, errno, "chdir", path, NULL);
    JS_FreeCString(c, path);
    return r;
}

// exit(code): flushes standard output and exits.
static JSValue js_exit(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    int32_t code = 0;
    JS_ToInt32(c, &code, argv[0]);
    beyond_flush_stdout();
    fflush(stderr);
    exit(code);
}

// processInfo(): {argv, execPath, pid, ppid, env, platform, arch, release,
// hostname}.
static JSValue js_process_info(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    JSValue o = JS_NewObject(c);
    JSValue args = JS_NewArray(c);
    char exe[PATH_MAX];
    ssize_t n = readlink("/proc/self/exe", exe, sizeof exe - 1);
    exe[n > 0 ? n : 0] = 0;
    // (Node's: the executable, then the program's path, then its
    // arguments.)
    JS_SetPropertyUint32(c, args, 0, JS_NewString(c, exe));
    for (int i = 0; i < saved_argc; i++)
        JS_SetPropertyUint32(c, args, i + 1, JS_NewString(c, saved_argv[i]));
    JS_SetPropertyStr(c, o, "argv", args);
    JS_SetPropertyStr(c, o, "execPath", JS_NewString(c, exe));
    JS_SetPropertyStr(c, o, "pid", JS_NewInt32(c, getpid()));
    JS_SetPropertyStr(c, o, "ppid", JS_NewInt32(c, getppid()));
    JSValue env = JS_NewObject(c);
    for (char **e = environ; *e; e++) {
        const char *eq = strchr(*e, '=');
        if (!eq)
            continue;
        JSAtom k = JS_NewAtomLen(c, *e, eq - *e);
        JS_DefinePropertyValue(c, env, k, JS_NewString(c, eq + 1), JS_PROP_C_W_E);
        JS_FreeAtom(c, k);
    }
    JS_SetPropertyStr(c, o, "env", env);
    struct utsname u;
    if (uname(&u) == 0) {
        JS_SetPropertyStr(c, o, "release", JS_NewString(c, u.release));
        JS_SetPropertyStr(c, o, "hostname", JS_NewString(c, u.nodename));
        JS_SetPropertyStr(c, o, "machine", JS_NewString(c, u.machine));
    }
    return o;
}

// hrtime(): nanoseconds of a monotonic clock, as a BigInt.
static JSValue js_hrtime(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    struct timespec t;
    clock_gettime(CLOCK_MONOTONIC, &t);
    return JS_NewBigUint64(c, (uint64_t)t.tv_sec * 1000000000u + (uint64_t)t.tv_nsec);
}

// ---- Beyond.build's library ----

static void *build_lib;
static char *(*bb_transpile)(const char *);
static char *(*bb_resolve)(const char *);
static void *(*bb_bundle)(const char *);
static char *(*bb_next)(void *, const char *);
static void (*bb_close)(void *);
static void (*bb_free)(char *);

#ifndef BEYOND_BUILD_LIB
#define BEYOND_BUILD_LIB "libbeyond_build.so"
#endif

// The library, loaded once: $BEYOND_BUILD_LIB, else the one built with
// this runtime.
static int load_build_lib(JSContext *c) {
    if (build_lib)
        return 0;
    const char *path = getenv("BEYOND_BUILD_LIB");
    if (!path || !*path)
        path = BEYOND_BUILD_LIB;
    void *h = dlopen(path, RTLD_NOW | RTLD_LOCAL);
    if (!h) {
        JS_ThrowInternalError(c, "Beyond's bundler is not available: %s", dlerror());
        return -1;
    }
    bb_transpile = (char *(*)(const char *))dlsym(h, "beyond_build_transpile");
    bb_resolve = (char *(*)(const char *))dlsym(h, "beyond_build_resolve");
    bb_bundle = (void *(*)(const char *))dlsym(h, "beyond_build_bundle");
    bb_next = (char *(*)(void *, const char *))dlsym(h, "beyond_build_next");
    bb_close = (void (*)(void *))dlsym(h, "beyond_build_close");
    bb_free = (void (*)(char *))dlsym(h, "beyond_build_free");
    if (!bb_transpile || !bb_resolve || !bb_bundle || !bb_next || !bb_close || !bb_free) {
        JS_ThrowInternalError(c, "%s is not Beyond's bundler", path);
        return -1;
    }
    build_lib = h;
    return 0;
}

// A string the library returned, as a JS string (freed).
static JSValue take(JSContext *c, char *s) {
    if (!s)
        return JS_ThrowInternalError(c, "the bundler failed");
    JSValue r = JS_NewString(c, s);
    bb_free(s);
    return r;
}

// Calls of a function of the library with one JSON string.
static JSValue call1(JSContext *c, JSValueConst arg, char *(**f)(const char *)) {
    if (load_build_lib(c))
        return JS_EXCEPTION;
    const char *s = JS_ToCString(c, arg);
    if (!s)
        return JS_EXCEPTION;
    char *r = (*f)(s);
    JS_FreeCString(c, s);
    return take(c, r);
}

// buildTranspile(json), buildResolve(json): see crates/beyond-build.
static JSValue js_build_transpile(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    return call1(c, argv[0], &bb_transpile);
}

static JSValue js_build_resolve(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    return call1(c, argv[0], &bb_resolve);
}

// Bundles under way, by handle (an index).
#define MAX_BUNDLES 64
static void *bundles[MAX_BUNDLES];

// buildStart(json): a bundle's handle.
static JSValue js_build_start(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    if (load_build_lib(c))
        return JS_EXCEPTION;
    int i = 0;
    while (i < MAX_BUNDLES && bundles[i])
        i++;
    if (i == MAX_BUNDLES)
        return JS_ThrowRangeError(c, "too many builds at once");
    const char *s = JS_ToCString(c, argv[0]);
    if (!s)
        return JS_EXCEPTION;
    bundles[i] = bb_bundle(s);
    JS_FreeCString(c, s);
    return JS_NewInt32(c, i);
}

static void *bundle_of(JSContext *c, JSValueConst v) {
    int32_t i;
    if (JS_ToInt32(c, &i, v) || i < 0 || i >= MAX_BUNDLES || !bundles[i]) {
        JS_ThrowTypeError(c, "not a build");
        return NULL;
    }
    return bundles[i];
}

// buildNext(handle, answer): the bundle's next request (it waits for it),
// `answer` answering the last one (null at first).
static JSValue js_build_next(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    void *b = bundle_of(c, argv[0]);
    if (!b)
        return JS_EXCEPTION;
    const char *answer = NULL;
    if (!JS_IsNull(argv[1]) && !JS_IsUndefined(argv[1])) {
        answer = JS_ToCString(c, argv[1]);
        if (!answer)
            return JS_EXCEPTION;
    }
    char *r = bb_next(b, answer);
    if (answer)
        JS_FreeCString(c, answer);
    return take(c, r);
}

// buildClose(handle).
static JSValue js_build_close(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    void *b = bundle_of(c, argv[0]);
    if (!b)
        return JS_EXCEPTION;
    int32_t i;
    JS_ToInt32(c, &i, argv[0]);
    bundles[i] = NULL;
    bb_close(b);
    return JS_UNDEFINED;
}

// ---- Modules loaded at run time ----
//
// The engine's loader for what a program imports at run time (`import()` of
// a computed specifier, and those modules' imports): two functions of
// lib/modules.ts decide, `resolve(specifier, base)` (the module's name: an
// absolute path, or a built-in's specifier) and `load(name)`: `{ code }`, a
// module's JavaScript, with `meta` for its `import.meta`; or `{ exports }`,
// an object whose properties a module made here exports (a module of the
// program, JSON, CommonJS).

static JSValue resolve_hook = JS_UNDEFINED, load_hook = JS_UNDEFINED;

// Objects of the synthetic modules made, until their module is initialized.
typedef struct Synthetic {
    JSModuleDef *m;
    JSValue exports;
    struct Synthetic *next;
} Synthetic;
static Synthetic *synthetics;

// setModuleHooks(resolve, load).
static JSValue js_set_module_hooks(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    JS_FreeValue(c, resolve_hook);
    JS_FreeValue(c, load_hook);
    resolve_hook = JS_DupValue(c, argv[0]);
    load_hook = JS_DupValue(c, argv[1]);
    return JS_UNDEFINED;
}

// The name of `name` imported by `base` (as the engine does without
// hooks: relative to base's directory).
static char *default_normalize(JSContext *c, const char *base, const char *name) {
    if (name[0] != '.')
        return js_strdup(c, name);
    const char *slash = strrchr(base, '/');
    size_t dir = slash ? (size_t)(slash - base) : 0;
    size_t len = dir + 1 + strlen(name) + 1;
    char *out = js_malloc(c, len);
    if (!out)
        return NULL;
    memcpy(out, base, dir);
    out[dir] = 0;
    for (const char *r = name;;) {
        if (r[0] == '.' && r[1] == '/') {
            r += 2;
        } else if (r[0] == '.' && r[1] == '.' && r[2] == '/') {
            char *p = strrchr(out, '/');
            if (p)
                *p = 0;
            else
                out[0] = 0;
            r += 3;
        } else {
            size_t n = strlen(out);
            if (n)
                out[n++] = '/';
            strcpy(out + n, r);
            break;
        }
    }
    return out;
}

static char *beyond_normalize(JSContext *c, const char *base, const char *name, void *opaque) {
    (void)opaque;
    if (JS_IsUndefined(resolve_hook) || !strncmp(name, "beyond:", 7) || !strncmp(name, "qjs:", 4) || !strncmp(name, "luminous:", 9))
        return default_normalize(c, base, name);
    JSValue args[2] = {JS_NewString(c, name), JS_NewString(c, base)};
    JSValue r = JS_Call(c, resolve_hook, JS_UNDEFINED, 2, args);
    JS_FreeValue(c, args[0]);
    JS_FreeValue(c, args[1]);
    if (JS_IsException(r))
        return NULL;
    const char *s = JS_ToCString(c, r);
    JS_FreeValue(c, r);
    if (!s)
        return NULL;
    char *out = js_strdup(c, s);
    JS_FreeCString(c, s);
    return out;
}

static int synthetic_init(JSContext *c, JSModuleDef *m) {
    Synthetic **at = &synthetics;
    while (*at && (*at)->m != m)
        at = &(*at)->next;
    Synthetic *e = *at;
    if (!e)
        return 0;
    *at = e->next;
    JSPropertyEnum *props;
    uint32_t n;
    int r = 0;
    if (JS_GetOwnPropertyNames(c, &props, &n, e->exports, JS_GPN_STRING_MASK | JS_GPN_ENUM_ONLY) == 0) {
        for (uint32_t i = 0; i < n && r == 0; i++) {
            const char *key = JS_AtomToCString(c, props[i].atom);
            JSValue v = JS_GetProperty(c, e->exports, props[i].atom);
            if (!key || JS_IsException(v))
                r = -1;
            else
                r = JS_SetModuleExport(c, m, key, v);
            JS_FreeCString(c, key);
        }
        JS_FreePropertyEnum(c, props, n);
    } else {
        r = -1;
    }
    JS_FreeValue(c, e->exports);
    js_free(c, e);
    return r;
}

static JSModuleDef *beyond_load_module(JSContext *c, const char *name, void *opaque, JSValueConst attributes) {
    if (JS_IsUndefined(load_hook))
        return js_module_loader(c, name, opaque, attributes);
    JSValue arg = JS_NewString(c, name);
    JSValue r = JS_Call(c, load_hook, JS_UNDEFINED, 1, &arg);
    JS_FreeValue(c, arg);
    if (JS_IsException(r))
        return NULL;
    JSModuleDef *m = NULL;
    JSValue exports = JS_GetPropertyStr(c, r, "exports");
    if (!JS_IsUndefined(exports)) {
        // A module of the object's properties (set when it is initialized).
        m = JS_NewCModule(c, name, synthetic_init);
        Synthetic *e = m ? js_malloc(c, sizeof *e) : NULL;
        JSPropertyEnum *props;
        uint32_t n;
        if (!e || JS_GetOwnPropertyNames(c, &props, &n, exports, JS_GPN_STRING_MASK | JS_GPN_ENUM_ONLY)) {
            JS_FreeValue(c, exports);
            JS_FreeValue(c, r);
            return NULL;
        }
        for (uint32_t i = 0; i < n; i++) {
            const char *key = JS_AtomToCString(c, props[i].atom);
            if (key)
                JS_AddModuleExport(c, m, key);
            JS_FreeCString(c, key);
        }
        JS_FreePropertyEnum(c, props, n);
        e->m = m;
        e->exports = exports;
        e->next = synthetics;
        synthetics = e;
        JS_FreeValue(c, r);
        return m;
    }
    JSValue code = JS_GetPropertyStr(c, r, "code");
    size_t len;
    const char *src = JS_ToCStringLen(c, &len, code);
    JS_FreeValue(c, code);
    if (!src) {
        JS_FreeValue(c, r);
        return NULL;
    }
    JSValue f = JS_Eval(c, src, len, name, JS_EVAL_TYPE_MODULE | JS_EVAL_FLAG_COMPILE_ONLY);
    JS_FreeCString(c, src);
    if (JS_IsException(f)) {
        JS_FreeValue(c, r);
        return NULL;
    }
    m = JS_VALUE_GET_PTR(f);
    // Its import.meta: what `meta` has.
    JSValue meta = JS_GetImportMeta(c, m);
    JSValue given = JS_GetPropertyStr(c, r, "meta");
    if (JS_IsObject(meta) && JS_IsObject(given)) {
        JSPropertyEnum *props;
        uint32_t n;
        if (JS_GetOwnPropertyNames(c, &props, &n, given, JS_GPN_STRING_MASK) == 0) {
            for (uint32_t i = 0; i < n; i++)
                JS_DefinePropertyValue(c, meta, props[i].atom, JS_GetProperty(c, given, props[i].atom), JS_PROP_C_W_E);
            JS_FreePropertyEnum(c, props, n);
        }
    }
    JS_FreeValue(c, given);
    JS_FreeValue(c, meta);
    JS_FreeValue(c, f);
    JS_FreeValue(c, r);
    return m;
}

// importModule(name): a promise of the namespace of module `name` (an
// absolute path), loaded and evaluated as the engine's import() does.
static JSValue js_import_module(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    const char *name = JS_ToCString(c, argv[0]);
    if (!name)
        return JS_EXCEPTION;
    JSValue p = JS_LoadModule(c, "", name);
    JS_FreeCString(c, name);
    return p;
}

// importModuleSync(name): the namespace of module `name`, loaded and
// evaluated now (the jobs that takes run here; a module that awaits at the
// top level is an error).
static JSValue js_import_module_sync(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    JSValue p = js_import_module(c, this_val, argc, argv);
    if (JS_IsException(p))
        return p;
    JSContext *jc;
    while (JS_PromiseState(c, p) == JS_PROMISE_PENDING) {
        int r = JS_ExecutePendingJob(JS_GetRuntime(c), &jc);
        if (r < 0) {
            JS_FreeValue(c, p);
            return JS_Throw(c, JS_GetException(jc));
        }
        if (r == 0)
            break;
    }
    JSValue v;
    switch (JS_PromiseState(c, p)) {
    case JS_PROMISE_FULFILLED:
        v = JS_PromiseResult(c, p);
        break;
    case JS_PROMISE_REJECTED:
        v = JS_Throw(c, JS_PromiseResult(c, p));
        break;
    default:
        v = JS_ThrowTypeError(c, "module %s awaits at its top level: import() it instead", "");
    }
    JS_FreeValue(c, p);
    return v;
}

void beyond_system_install_loader(JSContext *c) {
    JS_SetModuleLoaderFunc2(JS_GetRuntime(c), beyond_normalize, beyond_load_module, js_module_check_attributes, NULL);
}

void beyond_system_mark(JSRuntime *rt, JS_MarkFunc *mark) {
    JS_MarkValue(rt, resolve_hook, mark);
    JS_MarkValue(rt, load_hook, mark);
    for (Synthetic *e = synthetics; e; e = e->next)
        JS_MarkValue(rt, e->exports, mark);
}

const JSCFunctionListEntry beyond_system_functions[] = {
    JS_CFUNC_DEF("setModuleHooks", 2, js_set_module_hooks),
    JS_CFUNC_DEF("importModule", 1, js_import_module),
    JS_CFUNC_DEF("importModuleSync", 1, js_import_module_sync),
    JS_CFUNC_DEF("readFile", 2, js_read_file),
    JS_CFUNC_DEF("writeFile", 4, js_write_file),
    JS_CFUNC_DEF("stat", 3, js_stat),
    JS_CFUNC_DEF("realpath", 1, js_realpath),
    JS_CFUNC_DEF("readdir", 1, js_readdir),
    JS_CFUNC_DEF("mkdir", 2, js_mkdir),
    JS_CFUNC_DEF("unlink", 1, js_unlink),
    JS_CFUNC_DEF("rmdir", 1, js_rmdir),
    JS_CFUNC_DEF("rename", 2, js_rename),
    JS_CFUNC_DEF("access", 2, js_access),
    JS_CFUNC_DEF("readlink", 1, js_readlink),
    JS_CFUNC_DEF("symlink", 2, js_symlink),
    JS_CFUNC_DEF("chmod", 2, js_chmod),
    JS_CFUNC_DEF("cwd", 0, js_cwd),
    JS_CFUNC_DEF("chdir", 1, js_chdir),
    JS_CFUNC_DEF("exit", 1, js_exit),
    JS_CFUNC_DEF("processInfo", 0, js_process_info),
    JS_CFUNC_DEF("hrtime", 0, js_hrtime),
    JS_CFUNC_DEF("buildTranspile", 1, js_build_transpile),
    JS_CFUNC_DEF("buildResolve", 1, js_build_resolve),
    JS_CFUNC_DEF("buildStart", 1, js_build_start),
    JS_CFUNC_DEF("buildNext", 2, js_build_next),
    JS_CFUNC_DEF("buildClose", 1, js_build_close),
};

const int beyond_system_function_count = sizeof beyond_system_functions / sizeof *beyond_system_functions;
