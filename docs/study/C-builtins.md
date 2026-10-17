# C. How JSC keeps spec-heavy builtins fast (RegExp, strings, promises, arrays, JSON, watchpoints)

Sources: WebKit `Source/JavaScriptCore` (sparse clone in `study/webkit`, paths below relative to it),
QuickJS-NG as patched for Luminous (`/home/user/beyond/vendor/luminous/build/quickjs-src/quickjs.c`, "Q:" below),
Luminous runtime (`runtime/luminous_rt.{c,h}`), and the Hono callgrind profile
`scratchpad/gap/cg.hono-l3w.1` (10,000 measured requests; all numbers below are **instructions per request**).

## 0. Summary

JSC's recipe is the same for every builtin family:

1. **A per-global "is this still pristine?" bit** (an `InlineWatchpointSet`) per *feature* (not per object):
   "RegExp.prototype's exec/flags/flag getters/Symbol.* are the originals", "Array species is the original",
   "Promise.prototype.then is the original and Object.prototype has no `then`", "String.prototype has no
   Symbol.match", etc. Checking one is a single load+compare.
2. **Adaptive invalidation**: the bit is guarded by a property-replacement watchpoint and a structure-transition
   watchpoint on the holder object. A transition that does *not* break the condition (e.g. adding an unrelated
   method to `Array.prototype`) re-installs the watchpoint on the new structure instead of firing.
   Only a real change (replace/delete/redefine of the watched property, or adding a shadowing property for an
   absence condition) clears the bit, permanently.
3. **Per-object cheap check**: the receiver's Structure is the *original* one for its class (e.g.
   `structure == globalObject->regExpStructure()`), which proves "no own `exec`/`constructor`/`then`, original
   prototype". Fallback: same prototype + `!hasCustomProperties()` or a targeted own-property probe.
4. **Then skip the spec's observable steps entirely** and run a C++ implementation that reads internal state
   directly (regexp flags from the compiled `RegExp`, `lastIndex` from an internal field, array storage
   directly, promise reactions as an enum instead of closures).
5. **Re-check after any step that can run user code** (e.g. `ToString(this)`), and keep the spec-literal
   slow path for everything else.

Luminous already has pieces of this (pins + `lum_shapes`, `JS_WatchPrototype` + one global `js_proto_epoch`,
`JS_CallStringFn`, `JS_AwaitNative`, a ring job queue, `ctx->std_array_prototype`). What is missing is
applying it inside the **engine builtins** that untyped framework code calls: `String.prototype.match` & co,
`Array.prototype.slice`/species, promise resolution, `Object.keys`.

Measured on Hono (per request), the biggest concrete wins:

| Candidate | Now (incl.) | Expected after | Gain | Cost / risk |
|---|---|---|---|---|
| R1 RegExp pristine fast path in `match`/`replace`/`split`/`search`/`test`/`exec` | `str.match(re)` 7,323 | ~1,400 | **~5.9k** | 1-2 days / low |
| A1 Array species pristine + `slice` fast copy (+ map/filter species) | slice 3,757 (2 calls) + species-room 1,119 | ~500 | **~4.3k** | 0.5-1 day / low |
| P1-P3 Promises: non-thenable fast path, inline first reaction, cheaper promise cell, fast settle with native promise | ~6.2k (async start 3.1k, await 1.8k, settle 1.25k) | ~3.5k | **~2.5k** | 2-3 days / medium (tick order) |
| O1 Object.keys / for-in per-shape key cache | 919 + 460 | ~300 | ~1k | 1-2 days / low-medium |
| S1 Atom lookup: reuse cached string hash, small key-atom cache | ~0.5k | ~0.2k | ~0.3-0.5k | 0.5 day / low |
| W1 Per-feature pristine bits with targeted invalidation (infrastructure for all the above) | - | - | enabler | 1-2 days / medium |
| R2 AOT-compile regexp literals (Yarr JIT equivalent) | lre_exec 955 | ~250 | ~0.7k | weeks / medium |

Total plausible: **~13-14k of the 69k JS-side instructions per request** (Hono), mostly in C builtins, with
no change to codegen semantics.

---

## 1. RegExp

### 1.1 What JSC does

**Pristine predicates** - `runtime/RegExpObjectInlines.h:37-185`
`RegExpObject::isSymbolMatchFastAndNonObservable(globalObject)` (and `...Search...`, `...MatchAll...`,
`...Replace...`, `...Split...`) return true iff:

- `globalObject->regExpPrimordialPropertiesWatchpointSet().isStillValid()` - RegExp.prototype's `exec`, `flags`,
  `dotAll`, `global`, `hasIndices`, `ignoreCase`, `multiline`, `sticky`, `unicode`, `unicodeSets`,
  `[Symbol.replace/match/search/matchAll/split]` are all unchanged (installed at
  `runtime/JSGlobalObject.cpp:2194-2208`, one `ObjectPropertyChangeAdaptiveWatchpoint` per property, all
  feeding the same set);
- the string-side absence set (`stringSymbolMatchWatchpointSet` etc.: String.prototype and Object.prototype
  have no own `Symbol.match`... - `JSGlobalObject.cpp:2215-2224`);
- for split/matchAll: `regExpSpeciesWatchpointSet` (RegExp[Symbol.species] and RegExp.prototype.constructor
  unchanged - `JSGlobalObject.cpp:2262-2274`);
- for search: `lastIndexIsWritable()` (search would write lastIndex=0 and restore it; skipping the writes is
  only unobservable when writable - comment at `RegExpObjectInlines.h:72-74`);
- `getLastIndex().isNumber()` (ToLength on a number cannot run user code);
- `structure == globalObject->regExpStructure()` (the fresh-regexp structure: no own properties, original
  prototype) - else same prototype and `!hasCustomProperties()`.

Note `lastIndex` is **not a real property** in JSC: it is an internal field `m_lastIndex` plus a flag bit
`lastIndexIsNotWritableFlag` packed into `m_regExpAndFlags` (`RegExpObject.h:42-104`), surfaced by
`getOwnPropertySlot` (`RegExpObject.cpp:66-69`). Making it non-writable flips the bit and fires
`regExpLastIndexWritableWatchpointSet` (`RegExpObject.cpp:119-120`). So reading/writing lastIndex in the fast
path is a field access.

**Callers** - `runtime/StringPrototype.cpp:1341-1384` (`stringProtoFuncMatch`): if the argument is a
`RegExpObject` passing the predicate, convert `this` to string, **re-check the predicate** (ToString can run
user code that patches RegExp.prototype), then `regExpMatchFast` (`RegExpPrototype.cpp:197-202`):
non-global → `RegExpObject::exec` directly, global → `matchGlobal`. No `Get(rx, @@match)`, no `Get(rx,"flags")`,
no flag getters, no `Get(rx,"exec")`. Same shape in `stringProtoFuncReplace` (`StringPrototype.cpp:605-622`),
`split` (`:1259`), `search` (`:1478`), `matchAll` (`:1524`), and the RegExp.prototype[Symbol.*] entry points
themselves (`RegExpPrototype.cpp:287-309`, `:1122`, `:1743`). `RegExp.prototype.test` uses the weaker
`regExpExecWatchpointIsValid` (`RegExpPrototypeInlines.h:31-46`: proto is RegExp.prototype, primordial set
valid, no own `exec`).

The slow paths are the literal spec (`regExpMatchSlow`, `RegExpPrototype.cpp:205-284`; `flagsString`,
`:358-376`, does the 8 getter `Get`s). Even the `flags` getter itself has a fast path:
`regExpProtoGetterFlags` (`:557-575`) returns `flagsString(regExp()->flags())` when
`regExpFlagsWatchpointIsValid` (`:378-400`).

**Match execution** - `RegExpObjectInlines.h:213-283` (`execInline`/`matchInline`) →
`RegExpGlobalData::performMatch` (`RegExpGlobalDataInlines.h:52-90`) → `RegExp::matchInline`
(`RegExpInlines.h:115-210`):
- `if (s.length() - startOffset < m_minimumSize) return -1;` - min-length precheck (`:122`);
- **atom fast path** (`:145-153`): a pattern that is a plain literal (`YarrPattern.cpp:2794-2798`,
  `SpecificPattern::Atom`) is a `StringView::find` with Boyer-Moore-ish tables, no regex engine;
- else Yarr JIT code (8-bit and 16-bit variants compiled lazily, `RegExp.cpp:302-336`), falling back to the
  Yarr bytecode interpreter (`Yarr::interpret`) when JIT is off or fails;
- the ovector is a per-RegExp buffer (`regExp->ovectorSpan()`), no per-call malloc.

**Result array** - `RegExpMatchesArray.h:66-128`: a dedicated structure `regExpMatchesArrayStructure` with
`index`/`input`/`groups` at fixed out-of-line offsets (`:33-36`); butterfly allocated uninitialized with
exact length; elements written with `initializeIndexWithoutBarrier`; each capture is
`jsSubstringOfResolved` - a 32-byte substring rope (no character copy, §2).

**Legacy RegExp statics** (`RegExp.$1`, `lastMatch`, ...) - `RegExpCachedResult.h:38-82`: each match only
records `(lastRegExp, lastInput, start, end)` (`RegExpCachedResult::record`, 4 stores,
`RegExpGlobalDataInlines.h:36-44`). If someone reads `RegExp.lastMatch`, `lastResult()`
(`RegExpCachedResult.cpp:49-93`) **re-runs** the regexp on the saved input to reify the array. Zero cost
for the 99.99% that never read them.

**Other caches**: `RegExpCache` (pattern+flags → compiled RegExp, weak map + 64-entry strong cache,
`RegExpCache.h:45-80`); `StringReplaceCache` (64 entries: (atom subject, regexp) → result,
`StringReplaceCache.h`); `StringSplitCache`; `RegExpSubstringGlobalAtomCache`.

**DFG**: `RegExpExecIntrinsic`/`RegExpTestIntrinsic`/`RegExpMatchFastIntrinsic` and
`StringPrototypeMatchIntrinsic` (`dfg/DFGByteCodeParser.cpp:3808-3830`, `:4170-4219`) are inlined only if the
primordial set is still valid and `exec` on the prototype is the original (frozen at compile time); they emit
`Check(RegExpObjectUse)` + a node calling `operationRegExpMatchFastString` (`dfg/DFGOperations.cpp:1912-1924`
= the same `execInline`/`matchGlobal`) or, for a known global atom, `operationRegExpMatchFastGlobalString`
(`:1980-1995`, collects atom matches without the regex engine). The compiler adds a watchpoint dependency so
a later patch of RegExp.prototype invalidates the code.

### 1.2 What QuickJS does (and what it costs us)

- `js_string_match` (Q:51597): `JS_GetProperty(regexp, Symbol.match)` (prototype lookup) → `JS_CallFree`.
- `js_regexp_Symbol_match` (Q:54232): `JS_GetProperty(rx, "flags")` → **getter** `js_regexp_get_flags`
  (Q:53695) which does 8 `JS_GetProperty`/**`JS_GetPropertyStr`** (6 of them by C string: each one
  `JS_NewAtom` → `__JS_FindAtom` hashing the C string) and 8 getter calls `js_regexp_get_flag`, builds a
  string, then `string_indexof_char(flags,'g')`.
- `JS_RegExpExec` (Q:54197): `JS_GetProperty(rx,"exec")` + call.
- `js_regexp_exec` (Q:53854): `JS_GetProperty(this,"lastIndex")`, `js_malloc` of the capture buffer
  (freed at the end), `lre_exec` (bytecode backtracking interpreter), result object from
  `ctx->regexp_result_shape` (good), but **each element via `JS_DefinePropertyValueUint32`**, and each capture
  via `js_sub_string` (copies ≤32 chars, slice otherwise).

Profile (Hono, one `str.match(re)` per request, regexp with 8 captures):

```
js_string_match                         7,323 incl.
  Get(re, @@match)                          81
  js_regexp_Symbol_match                7,109
    Get(rx,"flags") -> js_regexp_get_flags 3,744   (JS_GetPropertyStr x6: 2,760, of which __JS_FindAtom 732)
    JS_RegExpExec                        3,296
      Get(rx,"exec")                        98
      js_regexp_exec                     3,064
        JS_DefinePropertyValueUint32 x9  1,056
        lre_exec                           955
        js_sub_string x3                   200
        new result object                  166
        malloc/free capture                105
```

So ~4.3k is pure spec-lookup overhead and ~1.2k is avoidable result-building overhead.

Note the existing hook: QuickJS-NG already has `ctx->regexp_shape` (fresh regexp shape, with `lastIndex` as
slot 0, Q:53419-53424). Changing `lastIndex`'s attributes or adding an own property changes the object's
shape (QuickJS shapes encode attributes), so **`p->shape == ctx->regexp_shape` is exactly JSC's
`structure == regExpStructure()`** check.

### 1.3 Transfer to Luminous

**R1 (do first).** Add an engine-side predicate and fast paths:

```c
/* RegExp.prototype pristine: exec, flags, the 8 flag getters, Symbol.{match,matchAll,replace,search,split}
   unchanged; String.prototype/Object.prototype have no Symbol.{match,...}. */
static inline bool js_regexp_fast(JSContext *ctx, JSValueConst rx) {
    JSObject *p;
    if (JS_VALUE_GET_TAG(rx) != JS_TAG_OBJECT) return false;
    p = JS_VALUE_GET_OBJ(rx);
    return p->shape == ctx->regexp_shape            /* no own props, original proto, lastIndex plain+writable */
        && ctx->regexp_proto_pristine               /* see W1, or epoch-validated */
        && JS_VALUE_GET_TAG(p->prop[0].u.value) == JS_TAG_INT;  /* lastIndex number: ToLength has no side effect */
}
```

- `js_string_match/replace/split/search/matchAll`: when `this` is a primitive string (ToString side-effect
  free) and `js_regexp_fast(rx)`: read flags with `lre_get_flags(re->bytecode)` and go straight to an
  internal exec. If `this` is an object, do ToString first and re-check (JSC pattern).
- `js_regexp_Symbol_*`, `js_regexp_test`, `JS_RegExpExec`: same predicate, skip `Get(flags)` / `Get(exec)`.
- `js_regexp_get_flags` itself: if `this` is a regexp with `regexp_shape` and the proto is pristine, build
  the string from `lre_get_flags`. Independently, replace the 6 `JS_GetPropertyStr` by
  `JS_GetProperty(ctx, this, JS_ATOM_xxx)` (predefined atoms exist or can be added) - this alone removes
  the 732-instruction `__JS_FindAtom` cost even on the slow path.
- Internal exec: capture buffer on the C stack when `alloc_count <= 64` (no malloc/free); build the result
  array as a fast array of exact length filled directly (like `JS_NewArrayFrom`), not 9
  `JS_DefinePropertyValueUint32`; keep `regexp_result_shape` for index/input/groups.
- `lre_exec` cheap prechecks: pattern-is-literal → `memmem`/`string_indexof` (JSC atom path); minimum
  length precheck.
- Codegen: add `match`, `replace`, `test`, `exec`, `split`, `search` to the `Method::StringFn`-style direct
  entry (lower.rs:5654 `string_fn`, Q:52052 `JS_CallStringFn`) - guard "method value == pin" exactly as now,
  to also save the `JS_CallBuiltin`/frame cost (~250-500 per call). For regexp literals the compiler knows
  the flags statically, so `re.test(s)` can lower to a direct `lum_regexp_test(ctx, re, s)` guarded by
  `js_regexp_fast`.

Spec risks and how JSC handles them: re-check after ToString of `this`; require `lastIndex` to be a number
(and writable for `search`); the predicate must also hold for subclass instances (they fail the shape check
and go slow - fine); `RegExp.prototype` itself as receiver fails (`js_get_regexp` fails). For global
`match`/`replace` the internal loop must still write `lastIndex` back as the spec does (JSC's `matchGlobal`
sets `lastIndex = 0` at the end).

**R2 (later).** JSC's Yarr JIT is an ahead-of-time opportunity for us: regexp literals are known at compile
time, so Luminous can compile them to native code (or to specialized C) at build time instead of
interpreting `lre` bytecode (955 instructions here). This is a project of its own; the atom/min-length
prechecks give part of the benefit cheaply.

**Legacy statics**: QuickJS-NG does not implement `RegExp.$1`-style statics; if Beyond ever needs them for
Bun compatibility, copy JSC's lazy design (record 4 words, reify on read by re-running the match).

---

## 2. Strings

### 2.1 JSC

- **Layout** (`runtime/JSString.h:79-94`): `JSString` = 16 bytes (header + `String` impl pointer);
  `JSRopeString` = 32 bytes with up to 3 fibers (`s_maxInternalRopeLength = 3`, `:375`), length and
  is8Bit/isSubstring/isRope flags packed into the fiber pointer bits (`:376-381`). `a + b` creates a rope;
  resolution is lazy (on first character access) and in-place.
- **Substring ropes**: `jsSubstringOfResolved` (`JSStringInlines.h:831-869`) - empty → shared empty string;
  length 1 → `vm.smallStrings.singleCharacterString(c)` (all Latin-1 chars preallocated,
  `SmallStrings.h:59-75`); length 2 ASCII → atomized through `KeyAtomStringCache`; otherwise a 32-byte
  rope `{base, offset}` that shares the base's characters (substring of a substring flattens to the base).
  RegExp captures, `slice`, `substring`, `split` all produce these.
- **8-bit vs 16-bit**: `StringImpl` is Latin-1 when possible; most algorithms are templated on both
  (`span8()`/`span16()`), Yarr JIT compiles separate 8-bit and 16-bit code.
- **Hash caching**: `StringImpl` caches its hash in `m_hashAndFlags` after first use; every hash-table
  lookup (atom table, Map/Set, `KeyAtomStringCache`) reuses it.
- **Property keys from strings** (`obj[str]`): `JSString::toIdentifier` (`JSString.h:896-914`):
  already-atom → done; else one-entry cache `vm.lastAtomizedIdentifierStringImpl`; else
  `AtomStringImpl::add` (hash cached) and then **`swapToAtomString`** (`:876-894`): the JSString cell's
  impl pointer is replaced by the atom, so the *next* use of the same JSString is a pointer test. Ropes are
  resolved directly into an atom (`resolveRopeToAtomString`) without materializing a non-atom string.
- **KeyAtomStringCache** (`KeyAtomStringCache.h:35-50`, `KeyAtomStringCacheInlines.h:36-58`): 512-entry
  direct-mapped cache (by hash) of atom JSStrings for strings ≤64 chars, used when producing strings that
  are likely to become keys (DFG `MakeAtomString` for `obj["a"+b]`, 2-char substrings, JSON.parse keys).
- **Small/common strings**: `SmallStrings` (`SmallStrings.h:36-48`: typeof results, "true", "null", ...,
  plus 256 single-character strings); `NumericStrings` caches number→string.
- **indexOf**: `stringProtoFuncIndexOf` with single-char and SIMD searches; DFG `StringIndexOf` intrinsics.

### 2.2 QuickJS-NG / Luminous

QuickJS-NG already has ropes (`JSStringRope`, Q:968, `JS_STRING_ROPE_SHORT_LEN` 512) and slices
(`JSStringSlice`, Q:963; `js_sub_string` copies ≤32 chars, slices above, Q:5842-5863), 8/16-bit strings,
and Luminous caches a non-atom string's hash in `hash_next` for Map keys (Q:58049-58074).

Gaps:
- `JS_ValueToAtomInternal` (Q:12920-12950): a non-atom string goes through `JS_NewAtomStr` →
  `__JS_NewAtom` (Q:4953) which **re-hashes the string every time** (ignores the cached `hash_next`).
  If no atom exists the string itself becomes the atom (good, like `swapToAtomString`), but if an atom with
  the same content already exists (the common case: `obj[key]` where `key` came from `split`/`slice`/a
  header), every access re-hashes and re-probes. Hono: `JS_GetPropertyValue` 7 calls, `JS_ValueToAtomInternal`
  ~480 + lookup ~500.
- `JS_GetPropertyStr`/`JS_NewAtom(const char*)` inside builtins hash C strings at run time (the regexp flags
  getter, 732 per request in `__JS_FindAtom`).
- Per-request strings cost (5.2k) is mostly in Beyond's runtime glue (`JS_ToCStringLen2` from `write_head`
  701, `JS_NewStringLen` from `add_header` 501, memcpy) - not an engine issue; pre-atomized/interned common
  header names (there is already `beyond_common_string`) and writing JS strings to the socket without the
  C-string conversion would address it.

### 2.3 Transfer

- **S1**: in `__JS_NewAtom`, use `p->hash_next` when non-zero (and store it when computed). Add a
  "found atom" cache: either a JSC-style direct-mapped key-atom cache (e.g. 256 entries of
  `{JSString*, JSAtom}` keyed by the cached hash, cleared at GC), or store the atom index in the non-atom
  string (the 28-bit `hash` field is unused for non-atoms; would need to hold an atom reference that the
  sweeper releases). Cheap and safe with the cache variant.
- Replace every `JS_GetPropertyStr`/`JS_NewAtom(literal)` on hot builtin paths with predefined atoms.
- Single-character string cache (if NG does not already intern them) for `charAt`, `s[i]`, 1-char
  captures/splits.

---

## 3. Promises and async/await

### 3.1 JSC

- **JSPromise is 2 words** beyond the cell header (`runtime/JSPromise.h:37-90`, `:228-229`):
  `m_packed` = (cell pointer, 16 flag bits: status, isHandled, first-resolving-function-called,
  `InlineReactionKind`, an `InternalMicrotask` id) and `m_slot` (result, or inline handler/context).
  The **first reaction is stored inline** in the promise (`setInlineMicrotaskReaction`,
  `setInlineHandlerReaction`, `JSPromise.cpp:240-268`); a reaction object is allocated only for the second
  one (`spillInlineReaction`, `:269`).
- **`InternalMicrotask`** (`runtime/Microtask.h`): an enum of ~45 internal jobs (`PromiseReactionJob`,
  `PromiseResolveThenableJobFast`, `AsyncFunctionResume`, `PromiseAllResolveJob`, ...). Internal
  continuations are `(enum, payload byte, ≤3 JSValues)` instead of JS closures + reaction records.
- **Microtask queue**: `QueuedTask` is 32 bytes (`MicrotaskQueue.h:99-150`, `static_assert(sizeof <= 32)`),
  stored by value in a `Deque` ring; `drainImpl` (`MicrotaskQueue.cpp:172-235`) switches on the enum
  (`runInternalMicrotask`, `JSMicrotask.cpp:~1700-2000`) and uses a `MicrotaskCallCache` so repeated calls
  of the same JS function during one drain reuse the call setup (`callMicrotask`, `JSMicrotask.cpp:87-...`).
- **Await** (`asyncFunctionArrangeAwaitResume`, `JSMicrotask.cpp:1646-1652` →
  `JSPromise::resolveWithInternalMicrotaskForAsyncAwait`, `JSPromise.cpp:824-852`):
  - value is a same-realm JSPromise and `promiseSpeciesWatchpointIsValid` (constructor/species pristine,
    `JSGlobalObject.cpp:2259`) → `performPromiseThenWithInternalMicrotask(AsyncFunctionResume, generator)`
    (`:382-411`): pending → stored inline (no allocation); settled → one `queueMicrotask` (no allocation);
  - else `resolveWithInternalMicrotask` (`:854-887`): non-object → `fulfillWithInternalMicrotask` = one
    queued task; pristine JSPromise → `PromiseResolveThenableJobWithInternalMicrotaskFast` (keeps the extra
    tick the spec requires, but no resolving functions); **`isDefinitelyNonThenable`** (`:414-461`) → fulfil
    directly without reading `then`; otherwise the spec `Get(then)` path.
  - Resume: `AsyncFunctionResume` case (`JSMicrotask.cpp:1898-1906`) → `asyncFunctionGeneratorBodyCall`
    (`:1655-...`) calls the generator body function (cached call).
- **`isDefinitelyNonThenable`** (`JSPromise.cpp:414-461`): requires `promiseThenWatchpointSet` (Promise.prototype.then
  original **and Object.prototype has no `then`**, `JSGlobalObject.cpp:2210-2211`); the answer is cached per
  Structure (`definitelyNonThenableState`), cacheable only for chains [self] or [self, Object.prototype]
  that the watchpoint protects; dictionaries are never cached.
- **`then`** (`JSPromise::then`, `:966-990`): pristine species → result promise allocated directly, no
  capability object/resolving functions; `isThenFastAndNonObservable` (`:899-916`) for "does resolving with
  this promise need a `then` call".
- **Resolving functions** are `JSFunctionWithFields` (fields in the function cell) and are not created at all
  for internal flows.

**Cost of `await v` for an already-resolved value in JSC**: non-promise or non-thenable `v` → 0 heap
objects, 1 32-byte queue entry, 1 enum dispatch, 1 (cached) call of the generator body. Fulfilled native
promise → same. Pending native promise (first waiter) → 0 allocations (inline reaction), 1 queue entry on
settlement. The spec's naive cost is 1 promise (PromiseResolve) + 2 closures + 2 reaction records + 1 job
record (+ a throwaway promise in old spec versions). Per async *call* JSC allocates the
`JSAsyncFunctionGenerator` and the result `JSPromise`.

### 3.2 Luminous today

Luminous already did the big part (patches 0003/0007, `JS_AwaitNative` Q:61190-61211, ring job queue
`JS_EnqueueJob` Q:3984-4005, native reactions `js_promise_react_native` Q:61154-61183): `await primitive` =
one ring entry; `await nativePromise` = a 48-byte reaction record when pending, a ring entry when settled.

Profile (Hono, 4 async calls and 4 awaits per request):

```
lum_async_start x4               3,143   (lum_frame_new 1,486; JS_NewPendingPromise 1,445 -> js_promise_alloc 339 each)
JS_AwaitNative  x4               1,841   (js_promise_resolve for one non-promise object: 1,016; react_native 627)
JS_SettlePromise x4              1,250   (js_promise_resolve_with: Get(then) on result objects 396, fulfill 560)
js_promise_then x1                 732   (+ resolving functions 264, capability)
```

### 3.3 Transfer

- **P1 non-thenable fast path**: `js_is_definitely_non_thenable(ctx, obj)` = "Promise.prototype.then
  pristine and Object.prototype has no `then`" (one pristine bit, W1) && shape's proto chain is
  [Object.prototype] or null && the shape has no `then` and is not a dictionary/exotic. Cache the answer in
  the `JSShape` (one bit, valid for hashed shapes). Use it in `js_promise_resolve_with` (skip `Get(then)`),
  in `JS_AwaitNative` (`await plainObject` → enqueue the job directly, no promise: saves ~1k), and in
  `js_promise_resolve`/`Promise.resolve`.
- **P2 settle with a native promise**: when an async function returns an intrinsic pristine promise,
  `js_promise_resolve_with` currently goes through `Get(then)` + `PromiseResolveThenableJob` (with resolving
  functions). Use the JSC trick: queue a native job (same tick count as the spec: one job for the thenable
  job, then the reaction) that attaches a native reaction - no resolving functions, no `then` lookup.
  Keep exact tick ordering (test262 `async-*` ordering tests and Node's `await` ordering tests catch errors).
- **P3 promise cell**: make `JSPromiseData` part of the promise object cell (already `own_cell`), and store
  the **first reaction inline** (an `await_job` + data + data2 fits in the promise; spill to the list only
  for the second reaction) so the common single-await case allocates nothing. Investigate why
  `js_promise_alloc` costs 339 instructions (generic `js_new_object_data` + shape dup + opaque set): a
  dedicated fixed-size allocation from `ctx->promise_shape` should be ~60-80.
- Async frames (`lum_frame_new` 371 each) are outside this topic but compare with JSC's generator object:
  pooling or bump-allocating frames would be the analogue.

---

## 4. Arrays

### 4.1 JSC

- **Indexing types** (`runtime/IndexingType.h`): Int32 / Double / Contiguous / ArrayStorage shapes, plus
  `CopyOnWrite` variants (`:83-116`). Constant array literals (`[1,2,3]`, `["a","b"]`) are compiled to
  `op_new_array_buffer` pointing at a shared immutable butterfly (`bytecompiler/NodesCodegen.cpp:~500-511`);
  the first write copies it. Object.keys results also use COW butterflies (§5).
- **Array species watchpoint** (`arraySpeciesWatchpointIsValid`, `ArrayPrototypeInlines.h:49-66`): realm's
  Array.prototype is the receiver's proto, `arraySpeciesWatchpointSet` valid (Array.prototype.constructor and
  Array[Symbol.species] unchanged, installed by `tryInstallSpeciesWatchpoint`, `JSGlobalObject.cpp:3224-3319`),
  no own `constructor`. `speciesConstructArray` (`:93-140`) returns `FastPath` without any `Get`.
- **slice** (`ArrayPrototype.cpp:736-790`): species fast path → `JSArray::fastSlice` (memcpy of the
  butterfly). Same for `splice` (`:1193-1200`), `concat` (`:1797-1806`, plus the `isConcatSpreadable`
  absence watchpoint), `toSpliced`/`with`...
- **JS-implemented builtins** (`builtins/ArrayPrototype.js:27-335`): `forEach`, `map`, `filter`, `some`,
  `every`, `find*`, `reduce*`, `flatMap`, `at` are JS so the DFG/FTL inline both the builtin and the callback;
  `@newArrayWithSpecies` (bytecode intrinsic → `slow_path_new_array_with_species`,
  `runtime/CommonSlowPaths.cpp:1706-1731`, same species fast path). Recently many other builtins moved from
  JS to C++ (`RegExpPrototype.js`, `StringPrototype.js`, `PromisePrototype.js` no longer exist): C++ wins when
  there is no callback to inline.
- **Iterator protocol watchpoints** (`JSGlobalObject.cpp:2180-2249`): `arrayIteratorProtocolWatchpointSet`
  = ArrayIteratorPrototype.next, Array.prototype[Symbol.iterator] unchanged and `return` absent on the
  iterator prototypes; for-of/spread/destructuring over arrays then index directly.
- **Sane chain** (`installSaneChainWatchpoints`, `:3321-3369`): Array.prototype/Object.prototype have no
  indexed properties → out-of-bounds/hole reads return undefined without a prototype walk.

### 4.2 QuickJS / Luminous

`js_array_slice` (Q:48254): `js_get_length64` (generic Get length), `JS_ToInt64Clamp`,
`JS_ArraySpeciesCreate` (Q:47006: `Get(constructor)` on the prototype, `JS_GetFunctionRealm`,
`Get(Symbol.species)` → **getter call**, then `js_array_constructor`), element-wise
`JS_CreateDataPropertyUint32Const`, then generic `JS_SetProperty(length)`.
Hono: 2 slices = **3,757** (species 2,475), plus `JS_ArraySpeciesCreateRoom` from a map/filter-like function
1,119. QuickJS-NG already has a pristine-ish flag `ctx->std_array_prototype` (Q:810, cleared at Q:11716,
13153, 13207) for indexed properties on Array.prototype - the analogue of JSC's sane-chain watchpoint.
Luminous has `lum_array_iter_ok`, `lum_array_push_ok`, `LUM_PIN_ARRAY_LOOPS` (native forEach/map/... loops).

### 4.3 Transfer

- **A1**: `js_array_species_fast(ctx, obj)` = fast array whose shape is `ctx->array_shape` (no own
  `constructor`, original prototype) && "Array.prototype.constructor is Array and Array[Symbol.species] is
  the original getter" (pristine bit or pin compare: two `JS_OwnDataIs`-style slot checks). Use it in
  `JS_ArraySpeciesCreate`/`...Room` (return a plain array without any Get) and give `slice` (and `splice`'s
  removed array, `concat` when `isConcatSpreadable` is absent) a direct copy: allocate a fast array of
  `count`, copy + dup values from `u.array.u.values`, set `count`/length directly. Expected ~150-250 per
  slice instead of ~1,880.
- Array literal COW: lower priority (we create 8 arrays/request; most are not constant literals).

---

## 5. JSON and own-keys caches

- **JSON.stringify** `FastStringifier` (`runtime/JSONObject.cpp:701-1700`): one pass writing into a stack
  buffer; bails out to the generic `Stringifier` on any irregularity (callable, poly proto, non-final object
  with non-standard proto, getters, indexed props, symbols, 16-bit names, buffer full - `:1485-1530`).
  `toJSON` absence is cached per Structure (`mayHaveToJSON`, `:1045-1057`, `CachedSpecialPropertyKey::ToJSON`
  in `StructureRareData.h:51-58`) and Object.prototype is checked once per call. Property iteration walks the
  Structure's property table (`forEachProperty`) - no key array; SIMD escape scanning (`:1205-1311`).
  `JSONCache`/`JSONParse` fast paths exist for parse (keys atomized via the key-atom cache).
  Luminous already has `js_json_fast`/`js_json_fast_string` (patch 0005; 950/request total), so the
  remaining ideas are the per-shape `toJSON`-absence bit and SIMD escaping - small gains.
- **Object.keys** (`ownPropertyKeys`, `ObjectConstructor.cpp:1296-1352`): per-Structure cache of the key array
  as an immutable COW butterfly (`StructureRareData::m_cachedPropertyNames`, `StructureRareData.h:43,169`);
  first call on a structure only sets a sentinel, the second caches (avoids caching one-off shapes); a hit is
  a single `JSArray` allocation sharing the butterfly. **for-in** uses a cached `JSPropertyNameEnumerator` per
  Structure (`cachedPropertyNameEnumerator`, guarded by structure-chain watchpoints) with indexed fast
  property access by enumerator index.
  Luminous: `js_object_keys` 919 (1 call), `JS_ForInIteratorObject` ~460.
- **O1**: cache in a hashed `JSShape` the enumerable own string keys as an atom array (sentinel-then-cache
  like JSC); `Object.keys` = allocate array of N + `JS_AtomToString` dup per key (or share a frozen value
  array if COW arrays are added). for-in: reuse the same cached list when the prototype chain has no
  enumerable properties (pristine Object.prototype bit + proto shapes).

---

## 6. The general pattern: watchpoints JSGlobalObject keeps

`runtime/JSGlobalObject.h:493-552` (declarations), installation `JSGlobalObject.cpp:2180-2277`,
`3224-3519`:

| Set | Condition watched (holder: property) | Used by |
|---|---|---|
| `masqueradesAsUndefined`, `havingABadTime` | document.all exists; any indexed accessor on Array/Object.prototype (makes all arrays SlowPut) | everything |
| `varInjection`, `varReadOnly` | eval injecting vars; global var made read-only | global var access |
| `regExpRecompiled`, `regExpLastIndexWritable` | a RegExp recompiled (`compile()`); any lastIndex made non-writable | DFG regexp |
| `arrayBufferDetach` | any ArrayBuffer detached | typed arrays |
| `arrayIteratorProtocol` | ArrayIteratorPrototype.next, Array.prototype[@@iterator]; absence of `return` on iterator protos and Object.prototype | for-of, spread |
| `map/set/stringIteratorProtocol` | same for Map/Set/String | for-of |
| `stringSymbol{Match,Search,MatchAll,Replace,Split,ToPrimitive}` | absence of the symbol on String.prototype and Object.prototype | string methods |
| `arraySymbolToPrimitive`, `arrayNegativeOne`, `arrayIsConcatSpreadable` | absence on Array.prototype / Object.prototype | ToPrimitive, `at(-1)`, concat |
| `regExpPrimordialProperties` | RegExp.prototype exec, flags, 8 flag getters, 5 symbol methods | §1 |
| `mapSet`, `setAdd`, `setPrimordialProperties` | Map.prototype.set; Set.prototype.add/has/keys | constructors from iterables, set methods |
| `promiseThen` | Promise.prototype.then; absence of `then` on Object.prototype | §3 |
| `promiseResolve` | Promise.resolve | combinators |
| `promiseSpecies`, `arraySpecies`, `regExpSpecies`, `arrayBufferSpecies`, typed array species | prototype.constructor and constructor[@@species] | species creation |
| `arrayJoin`, `arrayToString`, `numberToString`, `stringToString`, `stringValueOf`, `objectPrototypeValueOf`, `arrayPrototypeValueOf` | those methods unchanged | string conversion fast paths |
| `array/object/string/promisePrototypeChainIsSane` | no indexed properties on those prototypes (object one chained into the others) | hole/out-of-bounds reads |
| `structureCacheCleared`, `propertyDescriptorFastPath`, typed array iterator/species sets | misc | misc |

Mechanics:
- `setupAdaptiveWatchpoint` (`JSGlobalObject.cpp:932-954`) builds an `Equivalence` `ObjectPropertyCondition`
  ("holder.prop === this value"); `setupAbsenceAdaptiveWatchpoint` (`:956-972`) an `Absence` condition.
- `ObjectPropertyChangeAdaptiveWatchpoint` (`ObjectPropertyChangeAdaptiveWatchpoint.h`) is an
  `AdaptiveInferredPropertyValueWatchpointBase` (`bytecode/AdaptiveInferredPropertyValueWatchpointBase.cpp:51-80`):
  it adds itself to the holder structure's **transition** watchpoint set and to the property's
  **replacement** watchpoint set. On fire it re-checks the condition: still true (an unrelated transition)
  → re-install on the new structure; false → `handleFire` → `fireAll` on the feature's set.
- `ObjectAdaptiveStructureWatchpoint` (`ObjectAdaptiveStructureWatchpoint.h:60-78`) does the same for
  absence conditions (transition watchpoint only).
- `ChainedWatchpoint` propagates one set's firing to others (`installChainedWatchpoint`, `:3531`).
- Sets are one-way: once fired they stay invalid (code depending on them is jettisoned; C++ fast paths just
  stop being taken).

**Comparison with Luminous**: `js_proto_epoch` is *one* counter for *all* watched prototypes and any change
to any watched object (including adding an unrelated method) bumps it, invalidating every IC's prototype
entry (with `LUM_IC_REFRESHES` damping). The pins are checked by value compare (`JS_OwnDataIs`,
`lum_char_code_at_ok` caches shape+slot). That is fine for ICs, but for engine builtins the JSC structure
is better:

**W1 (enabler)**: per-feature pristine bits in `JSContext` (e.g. `uint32_t intrinsic_ok`), cleared - never
set again - when a watched holder's *specific* property is written/redefined/deleted or a watched-absent
property is added (including via `setPrototypeOf` on the holder and Proxy-free paths). Implementation in
QuickJS terms: watched objects already route writes through the `is_watched` hook (patch 0004); give each
watched object a tiny table `{atom → bit mask}` (most features watch ≤16 atoms) and clear the bits for the
atom being changed; any change of the holder's prototype clears all its bits; Object.prototype additions
check the "absence" table (then, Symbol.match..., indexed). Builtins then test `ctx->intrinsic_ok & BIT`
(one load + test) instead of re-validating pins. This also lets codegen guard inlined builtin behaviour with
the same bit.

Risk notes: every way of changing a property must hit the hook (`JS_DefineProperty`, `delete`,
`Object.setPrototypeOf`, `__proto__`, freeze/seal/preventExtensions, `JS_SetPropertyInternal` fast paths that
bypass shapes, and C API writes like `JS_SetPropertyFunctionList` after startup). A conservative fallback:
any write to a watched object with an atom not in its table is ignored; any shape change of a *non-hashed*
watched object clears all its bits.

---

## 7. Ranked candidate changes (Hono numbers per request)

1. **R1 RegExp fast paths** - gain ~5.9k (str.match 7.3k → ~1.4k); also fixes `replace`/`split`/`test`
   sites in other frameworks. Cost 1-2 days. Low risk: guarded by `regexp_shape` + pristine bit + numeric
   lastIndex, re-check after ToString of object `this`. Includes: no flags getter, no exec lookup, flags from
   bytecode, stack capture buffer, direct array fill, predefined atoms in `js_regexp_get_flags`, literal-atom
   `memmem` path, direct entries in codegen.
2. **A1 Array species + slice/splice/concat fast copy** - gain ~4.3k. Cost 0.5-1 day. Low risk (shape ==
   array_shape, constructor/species pins).
3. **P1-P3 promise/async** - gain ~2.5k (non-thenable bit per shape, native settle for pristine promises,
   inline first reaction, cheaper promise allocation). Cost 2-3 days. Medium risk: microtask tick order must
   stay identical to the spec (keep the extra tick for thenables as JSC does).
4. **O1 Object.keys/for-in shape key cache** - gain ~1k. Cost 1-2 days. Low-medium risk (hashed shapes only;
   sentinel-then-cache).
5. **S1 atom lookup** (reuse cached hash, small key-atom cache; no `JS_GetPropertyStr` in hot builtins) -
   gain ~0.3-0.5k beyond R1. Cost 0.5 day. Low risk.
6. **W1 per-feature pristine bits** - infrastructure for 1-4 and for future intrinsics (Map/Set,
   iterator protocol, `instanceof` via a pristine `Function.prototype[Symbol.hasInstance]` bit: 2.5k/request
   of `JS_IsInstanceOf` is a separate topic but the same pattern). Cost 1-2 days. Medium risk (hook coverage).
7. **R2 AOT regexp compilation** - ~0.7k here, more for regexp-heavy apps. Weeks. Medium risk.
8. JSON per-shape `toJSON` bit / SIMD escaping; COW array literals - small (<0.3k) for these workloads.
