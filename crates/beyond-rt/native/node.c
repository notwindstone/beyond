// Natives of Node.js's modules (lib/node): what JavaScript cannot tell of a
// value without the engine (a proxy's target, the class of an object, which
// util.types tells apart). (A promise's state: web.c.)

#include "quickjs.h"

static JSValue js_promise_mark_handled(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    if (JS_IsPromise(argv[0]))
        JS_PromiseMarkAsHandled(c, argv[0]);
    return JS_UNDEFINED;
}

static JSValue js_is_proxy(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    return JS_NewBool(c, JS_IsProxy(argv[0]));
}

static JSValue js_proxy_target(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    if (!JS_IsProxy(argv[0]))
        return JS_UNDEFINED;
    return JS_GetProxyTarget(c, argv[0]);
}

static JSValue js_proxy_handler(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    if (!JS_IsProxy(argv[0]))
        return JS_UNDEFINED;
    return JS_GetProxyHandler(c, argv[0]);
}

// classId(v): the engine's class of an object (0 for anything else), which
// lib/node/util/types.ts compares with those of objects it makes.
static JSValue js_class_id(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    if (!JS_IsObject(argv[0]))
        return JS_NewInt32(c, 0);
    return JS_NewInt32(c, (int32_t)JS_GetClassID(argv[0]));
}

static JSValue js_is_async_function(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    return JS_NewBool(c, JS_IsAsyncFunction(argv[0]));
}

const JSCFunctionListEntry beyond_node_functions[] = {
    JS_CFUNC_DEF("promiseMarkHandled", 1, js_promise_mark_handled),
    JS_CFUNC_DEF("isProxy", 1, js_is_proxy),
    JS_CFUNC_DEF("proxyTarget", 1, js_proxy_target),
    JS_CFUNC_DEF("proxyHandler", 1, js_proxy_handler),
    JS_CFUNC_DEF("classId", 1, js_class_id),
    JS_CFUNC_DEF("isAsyncFunction", 1, js_is_async_function),
};

const int beyond_node_function_count = sizeof beyond_node_functions / sizeof *beyond_node_functions;
