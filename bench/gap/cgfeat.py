#!/usr/bin/env python3
"""Exclusive instructions per request grouped by engine feature, for a
callgrind file of a Beyond/Luminous program. Usage: cgfeat.py FILE REQUESTS [-v FEATURE]"""
import re, sys, collections
path, reqs = sys.argv[1], int(sys.argv[2])
show = sys.argv[sys.argv.index('-v') + 1] if '-v' in sys.argv else None
names, objs = {}, {}
cost = collections.Counter(); fobj = {}
cur_fn = cur_ob = None; after_calls = False
def resolve(table, s):
    m = re.match(r'\((\d+)\)(?: (.*))?', s)
    if not m: return s
    if m.group(2) is not None: table[m.group(1)] = m.group(2)
    return table.get(m.group(1), '?')
for line in open(path, errors='replace'):
    line = line.rstrip('\n')
    if line.startswith('ob='): cur_ob = resolve(objs, line[3:]); continue
    if line.startswith('cob='): resolve(objs, line[4:]); continue
    if line.startswith('fn='): cur_fn = resolve(names, line[3:]); fobj[cur_fn] = cur_ob; continue
    if line.startswith('cfn='): resolve(names, line[4:]); continue
    if line.startswith('calls='): after_calls = True; continue
    if line and (line[0].isdigit() or line[0] in '+-*'):
        if after_calls: after_calls = False; continue
        parts = line.split()
        if len(parts) > 1 and cur_fn: cost[re.sub(r"'\d+$", '', cur_fn)] += int(parts[1])
RULES = [
 ('memset (uWS request zeroing)', r'__memset'),
 ('native code (compiled JS)', r'lum_(fn|fast)_\d+'),
 ('interpreter', r'JS_CallInternal'),
 ('HTTP server (uWS, Beyond C/Rust)', r'(us_|uWS|_ZN3uWS|bsd_|beyond_|uws_|write_head|js_respond|on_request|write_reply|dispatch|bytes_of|<std|std::|bun_epoll|auto$|0x0)'),
 ('promises, async, jobs', r'(js_promise|JS_AwaitNative|lum_async|lum_await|fulfill_or_reject|perform_promise_then|JS_EnqueueJob|JS_ExecutePendingJob|js_create_resolving|JS_SettlePromise|JS_NewPendingPromise|promise_reaction_job|lum_resume_job|js_new_promise_capability|JS_NewPromise)'),
 ('object creation', r'(JS_NewObject|add_property|js_realloc_props|js_create_from_ctor|js_object_create|JS_DefineProperty|lum_define_field|JS_CreateProperty|lum_box_new|JS_NewObjectClass|lum_make_closure|js_closure|JS_SetOpaque|lum_object_spread|JS_CopyDataProperties|js_create_shape|js_new_shape|resize_properties|JS_NewCFunction|lum_new_object)'),
 ('property get (generic + IC misses)', r'(JS_GetPropertyInternal|lum_ic_get|JS_GetPropertyValue|JS_GetOwnDataHint|JS_GetPropertyStr|lum_call_getter|find_own_property|JS_Cache|JS_WatchProto|JS_GetPropertyInt64|lum_ic_fill|lum_ic_full|lum_ic_poly|JS_OwnDataIs|JS_GetOwnPropertyInternal|JS_GetProperty$|JS_GetOpaque|JS_GetClassID|JS_GetLength|lum_ic_)'),
 ('property set', r'(JS_SetPropertyInternal|lum_ic_set|JS_SetProperty)'),
 ('calls (C builtins, frames)', r'(JS_CallBuiltin|js_call_c_function|JS_CallStringFn|JS_CallFast|js_call_fast|js_call_bound_function|lum_call$|lum_frame|JS_CallMapFn|JS_Call$|JS_CallFree|js_call_|lum_rest|JS_GetFunctionRealm)'),
 ('instanceof, brand checks', r'(JS_IsInstanceOf|JS_OrdinaryIsInstanceOf|JS_PrivateCheckBrand)'),
 ('regexp', r'(lre_|js_regexp|JS_RegExp|js_string_match)'),
 ('JSON', r'(js_json|JS_JSON)'),
 ('arrays', r'(add_fast_array|expand_fast_array|js_array|JS_NewArray|set_array_length|JS_ArrayPush|JS_ArraySpecies|lum_new_array|js_get_fast_array|JS_ToArrayLength|js_get_length|JS_DefinePropertyValueUint32|lum_array|js_is_array|js_allocate_fast_array|js_create_array|free_property|convert_fast_array)'),
 ('strings and atoms', r'(JS_ToCString|JS_NewString|js_alloc_string|string_|js_sub_string|JS_ConcatStrings|js_string|__JS_FindAtom|__JS_NewAtom|JS_NewAtom|__JS_AtomToValue|JS_ValueToAtom|hash_string|js_encode_utf8|JS_ToString|js_strict_eq|JS_AtomIsArrayIndex|JS_FreeAtom|js_concat|JS_NewAtomStr|JS_AtomGetStr|js_new_string|lum_str|JS_FreeCString)'),
 ('for-in, own keys', r'(JS_ForIn|js_for_in|JS_GetOwnPropertyNames|lum_for_in|js_build_for_in|JS_GetOwnPropertyNames2)'),
 ('typed arrays, buffers', r'(JS_NewUint8Array|typed_array|JS_GetTypedArray|JS_GetUint8Array|JS_GetArrayBuffer|js_array_buffer|JS_IsArrayBuffer|JS_NewArrayBuffer)'),
 ('arithmetic, conversions', r'(JS_BinaryOperator|JS_UnaryOperator|JS_ToBool|JS_ToInt|JS_ToFloat|JS_AddValues|js_number|__popcount|JS_ToObject|JS_ToNumber)'),
 ('GC, allocation, freeing', r'(js_gc|mark_children|gc_|js_arena|js_free|free_|.*_finalizer|lum_state_mark|lum_mark|JS_Malloc|js_malloc|js_realloc|js_mallocz|JS_MarkValue|slot_free|js_trigger_gc|JS_FreeValue|JS_DupValue|__JS_FreeValue|js_def_)'),
]
RULES = [(k, re.compile(r)) for k, r in RULES]
def feature(fn, ob):
    if 'libc.so' in (ob or '') or 'ld-linux' in (ob or ''):
        return 'memset (uWS request zeroing)' if fn.startswith('__memset') else 'libc (memcpy, strlen...)'
    for k, r in RULES:
        if r.match(fn): return k
    return 'other'
tot = sum(cost.values()); feats = collections.Counter(); byf = collections.defaultdict(collections.Counter)
for fn, c in cost.items():
    k = feature(fn, fobj.get(fn)); feats[k] += c; byf[k][fn] += c
for k, c in feats.most_common(): print(f"{c/reqs:9,.0f}  {100*c/tot:5.1f}%  {k}")
print(f"{tot/reqs:9,.0f}  total per request")
if show:
    for fn, c in byf[show].most_common(50): print(f"{c/reqs:9,.0f}  {fn[:150]}")
