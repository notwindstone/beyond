// Beyond's native module (`beyond:native`) and its hooks into the program
// Luminous builds (`--init-fn beyond_init --loop-fn beyond_loop`): the
// QuickJS side of the native core. The event loop and the timers are Rust
// (src/lib.rs); the functions here move values between them and JavaScript.

#include <stdint.h>
#include <stdlib.h>
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
void beyond_client_mark(JSRuntime *rt, JS_MarkFunc *mark_func);
extern const JSCFunctionListEntry beyond_client_functions[];
extern const int beyond_client_function_count;
extern const JSCFunctionListEntry beyond_server_functions[];
extern const int beyond_server_function_count;
extern const JSCFunctionListEntry beyond_web_functions[];
extern const int beyond_web_function_count;

// Promises rejected with no handler yet, and their reasons: reported once
// the jobs running now are done, unless a handler is added by then.
static JSValue *rejected;
static int nrejected, cap_rejected;

static void mark(JSRuntime *rt, void *opaque, JS_MarkFunc *mark_func) {
    (void)opaque;
    JS_MarkValue(rt, on_timer, mark_func);
    for (int i = 0; i < nrejected; i++)
        JS_MarkValue(rt, rejected[i], mark_func);
    beyond_server_mark(rt, mark_func);
    beyond_client_mark(rt, mark_func);
}

static void track_rejection(JSContext *c, JSValueConst promise, JSValueConst reason, bool is_handled, void *opaque) {
    (void)opaque;
    if (!is_handled) {
        if (nrejected + 2 > cap_rejected) {
            cap_rejected = cap_rejected ? cap_rejected * 2 : 16;
            rejected = realloc(rejected, cap_rejected * sizeof *rejected);
        }
        rejected[nrejected++] = JS_DupValue(c, promise);
        rejected[nrejected++] = JS_DupValue(c, reason);
        return;
    }
    for (int i = 0; i < nrejected; i += 2) {
        if (JS_IsSameValue(c, rejected[i], promise)) {
            JS_FreeValue(c, rejected[i]);
            JS_FreeValue(c, rejected[i + 1]);
            memmove(rejected + i, rejected + i + 2, (nrejected - i - 2) * sizeof *rejected);
            nrejected -= 2;
            return;
        }
    }
}

JSContext *beyond_js_context(void) { return ctx; }

// An exception nothing caught (in a callback the loop made): printed, as
// Bun prints an error a handler threw.
void beyond_flush_stdout(void);

void beyond_js_report(void) {
    beyond_flush_stdout();
    js_std_dump_error(ctx);
}

// Set when reportError reported an error: the program then exits with 1
// once the task it was reported in is over, as Bun's does.
static int uncaught;

// Whether the program is to exit with 1: reportError reported an error,
// or a promise was rejected with no handler (reported here, as Bun reports
// an unhandled rejection: as an uncaught exception).
int beyond_js_uncaught(void) {
    if (nrejected > 0) {
        beyond_flush_stdout();
        for (int i = 0; i < nrejected; i += 2) {
            JS_FreeValue(ctx, rejected[i]);
            JS_Throw(ctx, rejected[i + 1]);
            js_std_dump_error(ctx);
        }
        nrejected = 0;
        uncaught = 1;
    }
    return uncaught;
}

// reportError(error): printed as an uncaught exception.
static JSValue js_report_error(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    beyond_flush_stdout();
    JS_Throw(c, JS_DupValue(c, argc > 0 ? argv[0] : JS_UNDEFINED));
    js_std_dump_error(c);
    uncaught = 1;
    return JS_UNDEFINED;
}

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

// promiseNew(): a pending promise that only promiseSettle settles (it has
// no resolving functions).
static JSValue js_promise_new(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    return JS_NewPendingPromise(c);
}

// promiseSettle(promise, value, rejected): as its resolve function (its
// reject function if `rejected`) would, once.
static JSValue js_promise_settle(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    JS_SettlePromise(c, argv[0], argv[1], JS_ToBool(c, argv[2]));
    return JS_UNDEFINED;
}

static const JSCFunctionListEntry functions[] = {
    JS_CFUNC_DEF("setTimer", 3, js_set_timer),
    JS_CFUNC_DEF("clearTimer", 1, js_clear_timer),
    JS_CFUNC_DEF("refTimer", 2, js_ref_timer),
    JS_CFUNC_DEF("onTimer", 1, js_on_timer),
    JS_CFUNC_DEF("now", 0, js_now),
    JS_CFUNC_DEF("reportError", 1, js_report_error),
    JS_CFUNC_DEF("promiseNew", 0, js_promise_new),
    JS_CFUNC_DEF("promiseSettle", 3, js_promise_settle),
};

static int module_init(JSContext *c, JSModuleDef *m) {
    if (JS_SetModuleExportList(c, m, functions, sizeof functions / sizeof *functions))
        return -1;
    if (JS_SetModuleExportList(c, m, beyond_web_functions, beyond_web_function_count))
        return -1;
    if (JS_SetModuleExportList(c, m, beyond_client_functions, beyond_client_function_count))
        return -1;
    return JS_SetModuleExportList(c, m, beyond_server_functions, beyond_server_function_count);
}

JSModuleDef *js_init_module_beyond(JSContext *c, const char *name) {
    JSModuleDef *m = JS_NewCModule(c, name, module_init);
    if (m) {
        JS_AddModuleExportList(c, m, functions, sizeof functions / sizeof *functions);
        JS_AddModuleExportList(c, m, beyond_web_functions, beyond_web_function_count);
        JS_AddModuleExportList(c, m, beyond_client_functions, beyond_client_function_count);
        JS_AddModuleExportList(c, m, beyond_server_functions, beyond_server_function_count);
    }
    return m;
}

// ---- The program's hooks ----

int beyond_init(JSContext *c, int argc, char **argv) {
    (void)argc, (void)argv;
    ctx = c;
    on_timer = JS_UNDEFINED;
    JS_SetHostPromiseRejectionTracker(JS_GetRuntime(c), track_rejection, NULL);
    return JS_AddGCMarkHook(JS_GetRuntime(c), mark, NULL) < 0;
}

int beyond_loop(JSContext *c) {
    (void)c;
    int r = beyond_rt_loop();
    // (Before an exception the program's exit prints, and the exit.)
    beyond_flush_stdout();
    return r;
}
