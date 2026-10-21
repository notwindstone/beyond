// Beyond's native module (`beyond:native`) and its hooks into the program
// Luminous builds (`--init-fn beyond_init --loop-fn beyond_loop`): the
// QuickJS side of the native core. The event loop and the timers are Rust
// (src/lib.rs); the functions here move values between them and JavaScript.

#include <signal.h>
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
// process's hooks (setProcessHooks): 'beforeExit', 'exit', and an error
// nothing caught, for 'uncaughtException' and 'unhandledRejection'.
static JSValue on_before_exit = JS_UNDEFINED, on_exit_hook = JS_UNDEFINED, on_uncaught = JS_UNDEFINED;

void beyond_server_mark(JSRuntime *rt, JS_MarkFunc *mark_func);
void beyond_client_mark(JSRuntime *rt, JS_MarkFunc *mark_func);
void beyond_spawn_mark(JSRuntime *rt, JS_MarkFunc *mark_func);
extern const JSCFunctionListEntry beyond_spawn_functions[];
extern const int beyond_spawn_function_count;
extern const JSCFunctionListEntry beyond_client_functions[];
extern const int beyond_client_function_count;
extern const JSCFunctionListEntry beyond_server_functions[];
extern const int beyond_server_function_count;
extern const JSCFunctionListEntry beyond_web_functions[];
extern const int beyond_web_function_count;
extern const JSCFunctionListEntry beyond_system_functions[];
extern const int beyond_system_function_count;
extern const JSCFunctionListEntry beyond_node_functions[];
extern const int beyond_node_function_count;
extern const JSCFunctionListEntry beyond_fs_functions[];
extern const int beyond_fs_function_count;
extern const JSCFunctionListEntry beyond_os_functions[];
extern const int beyond_os_function_count;
extern const JSCFunctionListEntry beyond_buffer_functions[];
extern const int beyond_buffer_function_count;
void beyond_system_init(int argc, char **argv);
void beyond_system_install_loader(JSContext *c);
void beyond_system_mark(JSRuntime *rt, JS_MarkFunc *mark);

// Promises rejected with no handler yet, and their reasons: reported once
// the jobs running now are done, unless a handler is added by then.
static JSValue *rejected;
static int nrejected, cap_rejected;

static void mark(JSRuntime *rt, void *opaque, JS_MarkFunc *mark_func) {
    beyond_system_mark(rt, mark_func);
    (void)opaque;
    JS_MarkValue(rt, on_timer, mark_func);
    JS_MarkValue(rt, on_before_exit, mark_func);
    JS_MarkValue(rt, on_exit_hook, mark_func);
    JS_MarkValue(rt, on_uncaught, mark_func);
    for (int i = 0; i < nrejected; i++)
        JS_MarkValue(rt, rejected[i], mark_func);
    beyond_server_mark(rt, mark_func);
    beyond_client_mark(rt, mark_func);
    beyond_spawn_mark(rt, mark_func);
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

// An exception nothing caught (in a callback the loop made): to process's
// 'uncaughtException' listeners, else printed, as Bun prints an error a
// handler threw.
void beyond_flush_stdout(void);

int beyond_js_exception(void);
void beyond_js_report(void) {
    // (Unless process's 'uncaughtException' listeners take it.)
    if (beyond_js_exception() == 0)
        return;
    beyond_flush_stdout();
    js_std_dump_error(ctx);
}

// Set when reportError reported an error: the program then exits with 1
// once the task it was reported in is over, as Bun's does.
static int uncaught;

// An error nothing caught (`origin` "uncaughtException", or
// "unhandledRejection" with its promise) to process's listeners: 1 when
// they took it; 0 when there are none; -1 when one threw (pending).
static int to_listeners(JSValueConst err, const char *origin, JSValueConst promise) {
    if (JS_IsUndefined(on_uncaught))
        return 0;
    JSValue args[3] = {JS_DupValue(ctx, err), JS_NewString(ctx, origin), JS_DupValue(ctx, promise)};
    JSValue r = JS_Call(ctx, on_uncaught, JS_UNDEFINED, 3, args);
    for (int i = 0; i < 3; i++)
        JS_FreeValue(ctx, args[i]);
    if (JS_IsException(r))
        return -1;
    int handled = JS_ToBool(ctx, r);
    JS_FreeValue(ctx, r);
    return handled;
}

// The pending exception a callback of the loop threw: 0 when process's
// 'uncaughtException' listeners took it (the loop goes on), else 1 (it
// stays pending, or the one a listener threw is).
int beyond_js_exception(void) {
    if (!JS_HasException(ctx))
        return 1;
    JSValue e = JS_GetException(ctx);
    int h = to_listeners(e, "uncaughtException", JS_UNDEFINED);
    if (h == 0)
        JS_Throw(ctx, e);
    else
        JS_FreeValue(ctx, e);
    return h == 1 ? 0 : 1;
}

// Whether the program is to exit with 1: reportError reported an error,
// or a promise was rejected with no handler (given to process's listeners,
// else reported, as Bun reports an unhandled rejection: as an uncaught
// exception).
int beyond_js_uncaught(void) {
    if (nrejected > 0) {
        beyond_flush_stdout();
        // (Listeners may reject more promises: take the list first.)
        JSValue *list = rejected;
        int n = nrejected;
        rejected = NULL;
        nrejected = cap_rejected = 0;
        for (int i = 0; i < n; i += 2) {
            int h = uncaught ? 0 : to_listeners(list[i + 1], "unhandledRejection", list[i]);
            if (h != 1) {
                if (h == 0)
                    JS_Throw(ctx, JS_DupValue(ctx, list[i + 1]));
                js_std_dump_error(ctx);
                uncaught = 1;
            }
            JS_FreeValue(ctx, list[i]);
            JS_FreeValue(ctx, list[i + 1]);
        }
        free(list);
    }
    return uncaught;
}

// reportError(error): to process's 'uncaughtException' listeners, else
// printed as an uncaught exception.
static void report_error(JSContext *c, JSValueConst err) {
    int h = uncaught ? 0 : to_listeners(err, "uncaughtException", JS_UNDEFINED);
    if (h == 1)
        return;
    beyond_flush_stdout();
    if (h == 0)
        JS_Throw(c, JS_DupValue(c, err));
    js_std_dump_error(c);
    uncaught = 1;
}

static JSValue js_report_error(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    report_error(c, argc > 0 ? argv[0] : JS_UNDEFINED);
    return JS_UNDEFINED;
}

// guardCallback(callback): Bun's (internal/shared): a function that calls
// the callback with its arguments (`this` undefined), and reports what it
// throws as reportError does (Bun's reportUncaughtException). Native: Bun's
// counts its arguments not to make an `arguments` object, which it is here
// (and an ordinary function's closure its `prototype`), a call.
static JSValue guarded_fast(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv, JSValueConst *data) {
    JSValue r = JS_Call(c, data[0], JS_UNDEFINED, argc, argv);
    if (JS_IsException(r)) {
        JSValue e = JS_GetException(c);
        report_error(c, e);
        JS_FreeValue(c, e);
        return JS_UNDEFINED;
    }
    return r;
}

static JSValue guarded(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv, int magic, JSValueConst *data) {
    return guarded_fast(c, this_val, argc, argv, data);
}

static JSValue js_guard_callback(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    static JSAtom name;
    static void *shape;
    if (!name && !(name = JS_NewAtom(c, "guarded")))
        return JS_EXCEPTION;
    return JS_NewCFunctionDataShaped(c, guarded_fast, guarded, name, 3, 0, 1, argv, JS_UNDEFINED, &shape);
}

// setProcessHooks(beforeExit, exit, uncaught): beforeExit() emits the event,
// telling whether it had listeners; exit(code) emits 'exit' (code -1:
// process.exitCode's) and gives the code to exit with; uncaught(error,
// origin, promise) gives an error to the listeners of 'uncaughtException'
// or 'unhandledRejection', telling whether there were any.
static JSValue js_set_process_hooks(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    JS_FreeValue(c, on_before_exit);
    JS_FreeValue(c, on_exit_hook);
    JS_FreeValue(c, on_uncaught);
    on_before_exit = JS_DupValue(c, argv[0]);
    on_exit_hook = JS_DupValue(c, argv[1]);
    on_uncaught = JS_DupValue(c, argv[2]);
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

// getEnv(name): the environment variable's value, or undefined.
static JSValue js_get_env(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    const char *name = JS_ToCString(c, argv[0]);
    if (!name)
        return JS_EXCEPTION;
    const char *v = getenv(name);
    JS_FreeCString(c, name);
    return v ? JS_NewString(c, v) : JS_UNDEFINED;
}

static const JSCFunctionListEntry functions[] = {
    JS_CFUNC_DEF("setTimer", 3, js_set_timer),
    JS_CFUNC_DEF("clearTimer", 1, js_clear_timer),
    JS_CFUNC_DEF("refTimer", 2, js_ref_timer),
    JS_CFUNC_DEF("onTimer", 1, js_on_timer),
    JS_CFUNC_DEF("now", 0, js_now),
    JS_CFUNC_DEF("reportError", 1, js_report_error),
    JS_CFUNC_DEF("guardCallback", 1, js_guard_callback),
    JS_CFUNC_DEF("promiseNew", 0, js_promise_new),
    JS_CFUNC_DEF("promiseSettle", 3, js_promise_settle),
    JS_CFUNC_DEF("getEnv", 1, js_get_env),
    JS_CFUNC_DEF("setProcessHooks", 3, js_set_process_hooks),
};

static int module_init(JSContext *c, JSModuleDef *m) {
    if (JS_SetModuleExportList(c, m, functions, sizeof functions / sizeof *functions))
        return -1;
    if (JS_SetModuleExportList(c, m, beyond_web_functions, beyond_web_function_count))
        return -1;
    if (JS_SetModuleExportList(c, m, beyond_node_functions, beyond_node_function_count))
        return -1;
    if (JS_SetModuleExportList(c, m, beyond_fs_functions, beyond_fs_function_count))
        return -1;
    if (JS_SetModuleExportList(c, m, beyond_os_functions, beyond_os_function_count))
        return -1;
    if (JS_SetModuleExportList(c, m, beyond_buffer_functions, beyond_buffer_function_count))
        return -1;
    if (JS_SetModuleExportList(c, m, beyond_system_functions, beyond_system_function_count))
        return -1;
    if (JS_SetModuleExportList(c, m, beyond_client_functions, beyond_client_function_count))
        return -1;
    if (JS_SetModuleExportList(c, m, beyond_spawn_functions, beyond_spawn_function_count))
        return -1;
    return JS_SetModuleExportList(c, m, beyond_server_functions, beyond_server_function_count);
}

JSModuleDef *js_init_module_beyond(JSContext *c, const char *name) {
    JSModuleDef *m = JS_NewCModule(c, name, module_init);
    if (m) {
        JS_AddModuleExportList(c, m, functions, sizeof functions / sizeof *functions);
        JS_AddModuleExportList(c, m, beyond_web_functions, beyond_web_function_count);
        JS_AddModuleExportList(c, m, beyond_node_functions, beyond_node_function_count);
        JS_AddModuleExportList(c, m, beyond_fs_functions, beyond_fs_function_count);
        JS_AddModuleExportList(c, m, beyond_os_functions, beyond_os_function_count);
        JS_AddModuleExportList(c, m, beyond_buffer_functions, beyond_buffer_function_count);
        JS_AddModuleExportList(c, m, beyond_system_functions, beyond_system_function_count);
        JS_AddModuleExportList(c, m, beyond_client_functions, beyond_client_function_count);
        JS_AddModuleExportList(c, m, beyond_spawn_functions, beyond_spawn_function_count);
        JS_AddModuleExportList(c, m, beyond_server_functions, beyond_server_function_count);
    }
    return m;
}

// ---- The program's hooks ----

int beyond_init(JSContext *c, int argc, char **argv) {
    // (A write past RLIMIT_FSIZE fails with EFBIG instead of ending the
    // program, as Node's and Bun's; children get the default back.)
    signal(SIGXFSZ, SIG_IGN);
    beyond_system_init(argc, argv);
    beyond_system_install_loader(c);
    ctx = c;
    // (JavaScriptCore's, as Bun's.)
    JS_SetStackOverflowMessage(JS_GetRuntime(c), "Maximum call stack size exceeded.");
    on_timer = JS_UNDEFINED;
    JS_SetHostPromiseRejectionTracker(JS_GetRuntime(c), track_rejection, NULL);
    return JS_AddGCMarkHook(JS_GetRuntime(c), mark, NULL) < 0;
}

int beyond_rt_alive(void);

int beyond_loop(JSContext *c) {
    (void)c;
    int r;
    for (;;) {
        r = beyond_rt_loop();
        if (r || JS_IsUndefined(on_before_exit))
            break;
        // ('beforeExit': the loop goes on while its listeners give it work.)
        JSValue v = JS_Call(ctx, on_before_exit, JS_UNDEFINED, 0, NULL);
        if (JS_IsException(v)) {
            if (beyond_js_exception())
                break;
            continue;
        }
        int had = JS_ToBool(ctx, v);
        JS_FreeValue(ctx, v);
        if (!had)
            break;
        if (beyond_js_run_jobs() < 0 && beyond_js_exception()) {
            r = 1;
            break;
        }
        if (beyond_js_uncaught()) {
            r = 1;
            break;
        }
        if (!beyond_rt_alive())
            break;
    }
    // (The error ending the program, printed before 'exit', as Node's.)
    if (r && JS_HasException(ctx)) {
        beyond_flush_stdout();
        js_std_dump_error(ctx);
    }
    if (!JS_IsUndefined(on_exit_hook)) {
        JSValue code = JS_NewInt32(ctx, r ? r : -1);
        JSValue v = JS_Call(ctx, on_exit_hook, JS_UNDEFINED, 1, &code);
        if (JS_IsException(v)) {
            beyond_flush_stdout();
            js_std_dump_error(ctx);
            r = 7;
        } else {
            int32_t x = r;
            if (JS_ToInt32(ctx, &x, v) == 0)
                r = x;
            JS_FreeValue(ctx, v);
        }
    }
    // (Before an exception the program's exit prints, and the exit.)
    beyond_flush_stdout();
    return r;
}
