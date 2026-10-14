// Beyond's native module (`beyond:native`) and its hooks into the program
// Luminous builds (`--init-fn beyond_init --loop-fn beyond_loop`): the
// QuickJS side of the native core. The event loop and the timers are Rust
// (src/lib.rs); the functions here move values between them and JavaScript.

#include <stdint.h>
#include <string.h>

#include "quickjs-libc.h"
#include "quickjs.h"

// The Rust side.
void beyond_rt_timer_set(uint32_t id, double ms, int repeat);
void beyond_rt_timer_clear(uint32_t id);
void beyond_rt_timer_ref(uint32_t id, int ref);
double beyond_rt_now_ms(void);
int beyond_rt_loop(void);

static JSContext *ctx;
// JavaScript functions native code calls: held here, marked by mark().
static JSValue on_timer;

void beyond_server_mark(JSRuntime *rt, JS_MarkFunc *mark_func);
extern const JSCFunctionListEntry beyond_server_functions[];
extern const int beyond_server_function_count;

static void mark(JSRuntime *rt, void *opaque, JS_MarkFunc *mark_func) {
    (void)opaque;
    JS_MarkValue(rt, on_timer, mark_func);
    beyond_server_mark(rt, mark_func);
}

JSContext *beyond_js_context(void) { return ctx; }

// An exception nothing caught (in a callback the loop made): printed, as
// Bun prints an error a handler threw.
void beyond_js_report(void) { js_std_dump_error(ctx); }

// ---- Called by the Rust side ----

// Runs the pending jobs (promise reactions): -1 if one threw (pending).
int beyond_js_run_jobs(void) {
    JSContext *c;
    for (;;) {
        int r = JS_ExecutePendingJob(JS_GetRuntime(ctx), &c);
        if (r <= 0)
            return r;
    }
}

// Timer `id` is due: its callback, then the jobs it queued. -1: it threw.
int beyond_js_fire_timer(uint32_t id) {
    JSValue arg = JS_NewUint32(ctx, id);
    JSValue r = JS_Call(ctx, on_timer, JS_UNDEFINED, 1, &arg);
    if (JS_IsException(r))
        return -1;
    JS_FreeValue(ctx, r);
    return beyond_js_run_jobs();
}

// ---- beyond:native ----

static JSValue js_set_timer(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    uint32_t id;
    double ms;
    if (JS_ToUint32(c, &id, argv[0]) || JS_ToFloat64(c, &ms, argv[1]))
        return JS_EXCEPTION;
    beyond_rt_timer_set(id, ms, JS_ToBool(c, argv[2]));
    return JS_UNDEFINED;
}

static JSValue js_clear_timer(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    uint32_t id;
    if (JS_ToUint32(c, &id, argv[0]))
        return JS_EXCEPTION;
    beyond_rt_timer_clear(id);
    return JS_UNDEFINED;
}

static JSValue js_ref_timer(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    uint32_t id;
    if (JS_ToUint32(c, &id, argv[0]))
        return JS_EXCEPTION;
    beyond_rt_timer_ref(id, JS_ToBool(c, argv[1]));
    return JS_UNDEFINED;
}

static JSValue js_on_timer(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    JS_FreeValue(c, on_timer);
    on_timer = JS_DupValue(c, argv[0]);
    return JS_UNDEFINED;
}

static JSValue js_now(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    return JS_NewFloat64(c, beyond_rt_now_ms());
}

// encodeUtf8(string): an ArrayBuffer of its UTF-8 bytes (lone surrogates
// as U+FFFD, as TextEncoder's).
static JSValue js_encode_utf8(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    size_t len;
    const char *s = JS_ToCStringLen(c, &len, argv[0]);
    if (!s)
        return JS_EXCEPTION;
    JSValue r = JS_NewArrayBufferCopy(c, (const uint8_t *)s, len);
    JS_FreeCString(c, s);
    return r;
}

// decodeUtf8(bytes): the string of UTF-8 bytes (an ArrayBuffer or a view of
// one), invalid sequences as U+FFFD.
static JSValue js_decode_utf8(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    size_t len, off = 0, bpe;
    uint8_t *p = JS_GetArrayBuffer(c, &len, argv[0]);
    if (!p) {
        JS_FreeValue(c, JS_GetException(c));
        JSValue ab = JS_GetTypedArrayBuffer(c, argv[0], &off, &len, &bpe);
        if (JS_IsException(ab))
            return JS_EXCEPTION;
        size_t total;
        p = JS_GetArrayBuffer(c, &total, ab);
        JS_FreeValue(c, ab);
        if (!p)
            return JS_EXCEPTION;
        p += off;
    }
    return JS_NewStringLen(c, (const char *)p, len);
}

static const JSCFunctionListEntry functions[] = {
    JS_CFUNC_DEF("encodeUtf8", 1, js_encode_utf8),
    JS_CFUNC_DEF("decodeUtf8", 1, js_decode_utf8),
    JS_CFUNC_DEF("setTimer", 3, js_set_timer),
    JS_CFUNC_DEF("clearTimer", 1, js_clear_timer),
    JS_CFUNC_DEF("refTimer", 2, js_ref_timer),
    JS_CFUNC_DEF("onTimer", 1, js_on_timer),
    JS_CFUNC_DEF("now", 0, js_now),
};

static int module_init(JSContext *c, JSModuleDef *m) {
    if (JS_SetModuleExportList(c, m, functions, sizeof functions / sizeof *functions))
        return -1;
    return JS_SetModuleExportList(c, m, beyond_server_functions, beyond_server_function_count);
}

JSModuleDef *js_init_module_beyond(JSContext *c, const char *name) {
    JSModuleDef *m = JS_NewCModule(c, name, module_init);
    if (m) {
        JS_AddModuleExportList(c, m, functions, sizeof functions / sizeof *functions);
        JS_AddModuleExportList(c, m, beyond_server_functions, beyond_server_function_count);
    }
    return m;
}

// ---- The program's hooks ----

int beyond_init(JSContext *c, int argc, char **argv) {
    (void)argc, (void)argv;
    ctx = c;
    on_timer = JS_UNDEFINED;
    return JS_AddGCMarkHook(JS_GetRuntime(c), mark, NULL) < 0;
}

int beyond_loop(JSContext *c) {
    (void)c;
    return beyond_rt_loop();
}
