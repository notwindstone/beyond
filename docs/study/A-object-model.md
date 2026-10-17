# A. JSC object model and property access, and what an AOT compiler can take from it

Scope: WebKit `Source/JavaScriptCore` (shallow clone at
`scratchpad/study/webkit`), compared with Luminous (`runtime/luminous_rt.{h,c}`,
`crates/luminous-codegen/src/lower.rs`) and the patched QuickJS-NG
(`build/quickjs-src/quickjs.c`). Paths below are relative to
`Source/JavaScriptCore/` unless they start with `luminous:` (= `/home/user/beyond/vendor/luminous/`).

Note on naming: in this WebKit revision `StructureStubInfo` has been renamed
**`PropertyInlineCache`** (`bytecode/PropertyInlineCache.{h,cpp}`), with two
subclasses: `RepatchingPropertyInlineCache` (classic patched code) and
`HandlerPropertyInlineCache` (the data / handler IC).

Instruction counts are estimates from reading the assembly / macro-assembler
sequences, not measurements. (I started callgrind micro-benchmarks for Bun vs
Beyond but stopped when the coordinator asked to wrap up; a first attempt failed
only because `process` is not defined in Beyond. The harness idea is in section 8.)

---------------------------------------------------------------------------

## 0. Bottom line

* JSC's **hit paths are not where Bun beats us** in the untyped tiers. LLInt and
  Baseline already use data-only, metadata-driven ICs; the Baseline hit path is
  about as long as ours (≈10–14 instructions vs our ≈12–13 for an own property).
  JSC's hit paths get much shorter only in DFG/FTL, through speculation plus OSR
  exit (CheckStructure hoisting and elimination, constant-folded prototype loads,
  inlined getters). Without a JIT we can't reproduce that in general.
* What *is* transferable, and where our per-request profile shows the cost:
  1. **What happens on a miss**: JSC almost never falls back to a full generic
     lookup. A miss goes down a chain of shared handlers, and after
     `maxAccessVariantListSize` (8) cases it goes to a **VM-wide megamorphic
     (structure, uid) → (holder, offset) hash cache** (about 25 instructions). We
     fall back to `JS_GetProperty` (7.5k/request is "generic lookups, IC misses").
  2. **Transitions are cached** (put transition ICs, including butterfly
     reallocation). Adding a property costs about 12–15 instructions in Baseline. We
     never cache adds (`luminous:runtime/luminous_rt.c:1163-1178`), which is the
     1.7k/request in `add_property`.
  3. **instanceof is an IC** (structure + prototype → bool), and
     `ImplementsDefaultHasInstance` is a type-info bit, so the common case is a
     couple of compares. We pay about 180 instructions × 14.
  4. **Allocation sites carry a precomputed (allocator, structure)**
     (`ObjectAllocationProfile`), and the runtime keeps premade structures for
     objects it creates itself (iterator results, …). We pay about 250
     instructions per `JS_NewObjectProtoClass`.
  5. **Prototype-chain validity is enforced by targeted watchpoints** (per
     Structure transition sets plus per-offset replacement sets), so hits check
     nothing beyond the receiver's structure. Our equivalent, the global
     `js_proto_epoch`, costs a load and compare per prototype hit. More
     importantly, it is bumped by *value* writes to any watched object, so one
     mutable watched object invalidates every prototype IC in the program.
     (JSC's own megamorphic cache also uses a VM-wide epoch, but it is bumped only
     on structural changes to "mayBePrototype" objects, never on value
     replacement.)

---------------------------------------------------------------------------

## 1. Structures, transitions, storage, inline capacity, dictionaries

### 1.1 Structure (hidden class)
* `runtime/Structure.h:194-1040`. A Structure holds the prototype
  (`m_prototype`, `:1019`; "mono proto"; poly-proto stores it in inline slot 0,
  `PropertyOffset.h:35`), `m_inlineCapacity` (`:1001`), `m_maxOffset` and
  `m_transitionOffset` (`:1011-1012`), a bitfield of summary flags (`:823-844`:
  `hasAnyKindOfGetterSetterProperties`, `hasReadOnlyOrGetterSetterPropertiesExcludingProto`,
  `mayBePrototype`, `didPreventExtensions`, dictionary kind, …), a 32-bit
  `m_propertyHash` plus a `TinyBloomFilter` of seen property names
  (`m_seenProperties`, `:1014-1015`, used for fast negative lookups), the
  transition table (`m_transitionTable`), a lazily materialized `PropertyTable`
  (`m_propertyTableUnsafe`, `:1032`), and the **transition watchpoint set**
  (`m_transitionWatchpointSet`, `:1034`).
* Objects reference the structure through a 32-bit `StructureID` in the cell
  header, so a structure check is `load32; cmp; jne`.
* **The PropertyTable moves to the newest structure.** `addNewPropertyTransition`
  (`runtime/Structure.cpp:571-631`) creates the child, *takes* the parent's table
  (`takePropertyTableOrCloneIfPinned`, `:607`) and adds one entry. Older structures
  rebuild their table on demand by replaying the `previousID` chain
  (`materializePropertyTable`, around `:480-530`). Memory stays O(n) for a chain
  of n transitions. QuickJS instead copies the whole property array into every
  shape (`js_clone_shape`), which is O(n²).
* **The transition table** (`runtime/StructureTransitionTable.h`) has a
  single-transition fast slot plus a weak map keyed by (uid, attributes, kind).
  Lookup is pointer-keyed and O(1). In QuickJS, `find_hashed_shape_prop`
  (`luminous:build/quickjs-src/quickjs.c:7863-7890`) hashes into a *global* table
  and then compares **every property** of the candidate shape (O(n)) before it
  accepts a match.
* **Storage layout** (`runtime/PropertyOffset.h:33-140`). Offsets 0..63 are
  *inline* slots directly after the 16-byte header (cell header + butterfly
  pointer). Offsets 64 and up are *out-of-line* slots stored at negative
  indexes from the butterfly pointer (`offsetInOutOfLineStorage = -(off-64)-1`),
  so indexed elements and named properties share one allocation. The load is
  `loadProperty` (`jit/AssemblyHelpers.cpp:374-397`, LLInt
  `llint/LowLevelInterpreter64.asm:1610-1620`): one compare against 64 picks the
  base (object, or butterfly) and is followed by one load. When the offset is
  constant (DFG) the compare goes away, and an inline slot costs **one load with
  no indirection**.
* Out-of-line growth: initial capacity 4, then ×2 (`Structure.h:97-103`).
* Size limits (`runtime/JSObject.h:943-950`): `defaultSizeInBytes = 64`, which
  gives 6 inline slots; `maxSizeInBytes = 512`, which gives 62 inline slots.

### 1.2 How inline capacity is chosen
* **Static analysis in the bytecode generator**:
  `bytecompiler/StaticPropertyAnalyzer.h:33-160`. A flow-insensitive pass counts
  the distinct `put_by_id` names stored into the register that holds the result of
  `create_this` (a constructor's `this`) or `new_object` (an object literal, or
  `{}` followed by `o.x = …`). It follows `mov` aliases and stops on register
  reuse. When the analysis dies, it patches the count back into the instruction's
  `inlineCapacity` operand (`BytecodeGenerator.cpp:3202-3203`, `:3436-3439`,
  `:2897`; operands in `bytecode/BytecodeList.rb:588-605`).
* **Runtime heuristics on top**, in `bytecode/ObjectAllocationProfileInlines.h:35-152`:
  * If the estimate is below the default, add the number of non-function data
    properties on the prototype (`possibleDefaultPropertyCount`, `:155-172`),
    because classes often shadow them. A count of 0 means "the analyzer didn't see
    the initializer", so it uses the default of 6.
  * Class constructors add the number of field definitions from every
    `instanceFieldInitializer` up the super chain
    (`runtime/FunctionRareData.cpp:87-130`).
  * The capacity is rounded up to the free space in the allocator's size class
    ("slop", `:110-116`).
  * The result is a cached `(Allocator, Structure)` pair in the
    `ObjectAllocationProfile`: per `new_object` site in its metadata
    (`CodeBlock.cpp:478`), and per constructor in `FunctionRareData` for
    `create_this` (`cachedCallee` in the metadata). The JITs allocate inline from
    that allocator and store the structure ID. That is a bump-pointer allocation
    with a known header, roughly 10–15 instructions.
* **Poly-proto**: when one constructor's `this` objects end up with different
  prototypes (factory functions), the structure stops encoding the prototype and
  keeps it in slot 0 (`ObjectAllocationProfileInlines.h:44-63`). This avoids
  structure explosion.
* **Premade structures for objects the runtime creates**: for example,
  `createIteratorResultObjectStructure` (`runtime/IteratorOperations.cpp:198-217`)
  builds the `{value, done}` structure once per global object, and
  `createIteratorResultObject` is then an allocation plus two
  `putDirectOffset` stores at constant offsets. `JSGlobalObject` keeps dozens of
  these.

### 1.3 Dictionary mode
* After `s_maxTransitionLength` (128) transitions, or 512 for `put_by_id`
  (`Structure.h:206-208`, `:250-258`), or after removes and attribute changes
  beyond 4096, a structure becomes a **cacheable dictionary**
  (`toDictionaryTransition`, `Structure.cpp:866-881`). In that state the object owns
  a pinned table and adds/removes happen in place without transitions. An
  *uncacheable* dictionary results from deletes in a dictionary.
* **Flattening** (`Structure.cpp:1025-1110`): when an IC wants to cache through a
  dictionary (a prototype that was mutated heavily during setup is the typical
  case), `prepareChainForCaching` (`bytecode/ObjectPropertyConditionSet.cpp:577-671`)
  calls `flattenDictionaryStructure`. That compacts the offsets and turns it back
  into a normal, watchable structure, once only (`hasBeenFlattenedBefore`).
  Luminous' `JS_ShareObjectShape` does the same job for QuickJS's unhashed shapes.

### 1.4 Cheap adds after creation
* **Put transition IC** (`bytecode/Repatch.cpp:1130-1204`). On a `NewProperty`
  put, the IC records `oldStructure → newStructure`, the slot offset, and an
  `ObjectPropertyConditionSet` from `generateConditionsForPropertySetterMiss`
  (`ObjectPropertyConditionSet.cpp:375`). That set says no prototype has a setter
  or readonly property with this name, and it is enforced by watchpoints, so the hit
  does **not** walk the prototype chain. Puts onto `mayBePrototype` objects and
  dictionaries are not cached (`:1141-1147`).
* Handler code (`bytecode/InlineCacheCompiler.cpp:5665-5800`):
  * Non-allocating: check structure, `storeProperty`, then store
    `newStructureID`. About 10 instructions plus the caller's write barrier.
  * Newly-allocating / reallocating: allocate the butterfly inline
    (`emitAllocateVariableSized`), zero-fill, copy the old out-of-line slots, then
    `nukeStructureAndStoreButterfly` and store the new ID. On allocation failure it
    calls `operationReallocateButterflyAndTransition`.
* LLInt does the same without JIT and **without watchpoints**
  (`llint/LowLevelInterpreter64.asm:1764-1825`). Its metadata holds old ID, new ID,
  offset, and an optional `StructureChain` (the vector of prototype structure IDs).
  The hit compares every prototype's structure ID against the vector, which is an
  explicit-check variant. LLInt caches only transitions that don't change
  out-of-line capacity (`llint/LLIntSlowPaths.cpp:1135`).

### 1.5 Our side (QuickJS shapes)
* `JSShape` (`quickjs.c:1399-1424`) holds the prototype, a hash table *before* the
  struct, and a `JSShapeProperty[]` of (atom, flags) with values in a separate
  `JSProperty[]`. Shapes are refcounted. Shared shapes are "hashed" into a global
  table, and a unique shape (after delete or redefine) is "unhashed", like a
  dictionary. Luminous added `pinned` (allocation-site shapes that are never freed)
  and `watched`.
* A `JSObject` has `shape` and `prop` pointers. Plain objects keep the property
  array in the same allocation (`JS_PLAIN_OBJECT_SIZE`, `:1521`), but every access
  still loads `p->prop` first: two dependent loads, where JSC needs one for an
  inline slot.
* `add_property` (`quickjs.c:13141-13190`) does `js_proto_changed`, then
  `find_hashed_shape_prop` (O(n) compare), then possibly a realloc of the property
  array, then shape refcount dup and free. `JS_SetProperty` adds a full
  own-property lookup and a prototype-chain walk for setters before it gets
  there. Together that is about 210 instructions per add (1.7k / 8 adds per
  request).
* Object literals in compiled code already work like JSC's allocation profile:
  `lum_new_object` caches the final shape with `JS_ShapeAllocInfo`, and native code
  allocates inline with `JS_NewObjectWithCachedShape`
  (`luminous:runtime/luminous_rt.c:2112-2210`). `JS_NewObjectProtoClass`
  (`quickjs.c:8125-8139`) has none of this. It does a
  `find_hashed_shape_proto` hash lookup, shape dup, `js_trigger_gc`, a generic GC
  allocation, a class switch and `add_gc_object`, about 250 instructions.

### 1.6 Transferability
| JSC mechanism | Status for us |
|---|---|
| Inline slots without indirection | Possible in principle (plain-object `prop` inline), but it means changing QuickJS's `p->prop` contract everywhere. High risk, small gain (1 load per access). |
| Static inline-capacity analysis | **Copy directly.** Luminous has the AST. Count `this.x=` in constructors and `o.x=` after `{}`, and size the first allocation (prop_size) to match, so later adds don't realloc. |
| Per-site `(allocator, structure)` | **Copy directly** for untyped `new F()` sites (cache F, F.prototype and the shape; check F.prototype identity on use) and for runtime-created objects (premade shapes per context, like `iteratorResultObjectStructure`). |
| Transition table O(1) | **Copy directly** into QuickJS: a per-shape "last transition" cache `(atom, flags) → child` checked before `find_hashed_shape_prop`. |
| Put transition IC | **Copy, data-driven** (see 6.2). |
| Dictionary flattening on caching | Already have the analogue (`JS_ShareObjectShape`). |

---------------------------------------------------------------------------

## 2. Inline caches

### 2.1 The pieces
* `AccessCase` (`bytecode/AccessCase.h:57-196`): about 150 kinds. The
  important ones are Load, Miss, Replace, Transition, Getter, Setter,
  CustomValue/AccessorGetter/Setter, IntrinsicGetter, InHit/InMiss,
  InstanceOfHit/Miss, ArrayLength/StringLength, the Megamorphic variants
  (LoadMegamorphic, **LoadMegamorphicGetter**, StoreMegamorphic, InMegamorphic,
  InstanceOfMegamorphic, Indexed*Megamorphic) and many indexed typed-array kinds.
  Each case carries a structure, an offset, an `ObjectPropertyConditionSet` and an
  optional `PolyProtoAccessChain`.
* `PolymorphicAccess` / `InlineCacheCompiler` (`bytecode/InlineCacheCompiler.cpp`,
  8.3k lines) generates either one stub per IC site covering all cases (repatching
  IC, still used by DFG/FTL) or **one handler per case** (handler IC).
* Repatching IC: an inline patchable fast path at the site plus a jump to the stub.
  Buffered regeneration, megamorphic folding after 8 cases
  (`runtime/OptionsList.h:267`, `tryFoldToMegamorphic` `InlineCacheCompiler.cpp:4680`).

### 2.2 Handler (data) ICs
These need no code generation per site, which is what makes them relevant to us.
* `bytecode/InlineCacheHandler.h:52-170`. A handler is a refcounted, cache-line-aligned
  record: `m_structureID`, `m_next`, `m_callTarget` / `m_jumpTarget` (code
  pointers), `m_offset`, `m_uid`, and a union of `{newStructureID, newSize, oldSize}`
  (transitions), `{holder, globalObject, customAccessor}` (prototype loads,
  customs) or `{moduleNamespaceObject, slot}`. It also holds the watchpoint that
  clears the IC.
* Design comment: `bytecode/PropertyInlineCache.h:375-421`.
  * The site keeps a **singly linked list of handlers, newest first**, ending in a
    slow-path handler.
  * Each handler's code is a **shared thunk** (`vm.getCTIStub(...)`,
    `InlineCacheCompiler.cpp:5248-5800`: `getByIdLoadOwnPropertyHandler`,
    `getByIdLoadPrototypePropertyHandler`, `getByIdMissHandler`,
    `getByIdGetterHandler`, `putByIdReplaceHandler`,
    `putByIdTransition{NonAllocating,NewlyAllocating,Reallocating,ReallocatingOutOfLine}Handler`,
    `instanceOf{Hit,Miss}Handler`, …).
  * Thunks read everything from the handler. As the comment puts it, "sharing
    works because everything is data only".
* Dispatch (`jit/JITInlineCacheGenerator.cpp:58-62`): `handler = ic->m_handler;
  call [handler + callTarget]`. Each thunk does:
  1. `emitDataICPrologue`: `push rbp` on x86. The call frame register is left
     untouched, so exception unwinding needs no special casing (`:1342-1365`).
  2. Structure check against `handler->m_structureID` (`:1403-1408`).
  3. The action.
  4. `ret`.
  5. On a mismatch, `handler = handler->m_next; jmp [handler + jumpTarget]`
     (`:1429-1433`).
* **Inlined first handler** (`PropertyInlineCache.cpp:865-881`, `.h:379-387`).
  When the Baseline JIT compiles a site, it reads the LLInt's cache state
  (`preconfiguredCacheType`: GetByIdSelf, GetByIdPrototype, PutByIdReplace,
  InByIdSelf, ArrayLength…). It then emits an inline check of
  `ic->m_inlineAccessBaseStructureID` with load offset `ic->byIdSelfOffset` and
  holder `ic->m_inlineHolder`, all read from IC memory
  (`JITInlineCacheGenerator.cpp:152-190, 260-267`). The first matching handler's
  data is copied into those fields, so the monomorphic case never calls anything.
  This is exactly the shape of our `LumIC` hit path.
* Precompiled vs generated: a handler uses a shared thunk only when every
  condition can be *watched* (`checkingConditions.isEmpty()`,
  `InlineCacheCompiler.cpp:7257, 7284`). Otherwise it generates code that checks the
  conditions at run time.
* A precompiled prototype load also calls `startWatchingPropertyForReplacements`
  on the holder (`:7260-7263`), so DFG can later constant-fold the value.

### 2.3 get_by_id hit paths (estimated x86-64 instructions)

| Tier | Mechanism | Own property | Prototype property |
|---|---|---|---|
| LLInt | `GetByIdModeMetadata` (`bytecode/GetByIdMetadata.h:34-133`): a 16-byte union with modes Default (structureID, offset), ProtoLoad (structureID, offset, holder pointer), Unset, ArrayLength. Asm: `LowLevelInterpreter64.asm:1660-1714`. | ≈25–28 including operand decode, value profiling and dispatch (≈12 for the IC logic itself) | ≈28–30. No chain check: the holder is cached and the conditions are watched (`LLIntSlowPaths.cpp:812-870`) |
| Baseline (handler IC, inlined handler) | Inline check against IC memory | ≈10–14 | ≈11–15 (the holder comes from the IC) |
| Baseline, n-th handler in chain | Indirect call into the shared thunk | ≈18–22 + 5 per skipped handler | same |
| DFG/FTL | `CheckStructure` (3, or 0 when proven or hoisted) + `GetByOffset` (1 load inline, 2 out-of-line) | 1–4 | 0–1: a load from a constant holder, or a constant when Equivalence/replacement is watched (`dfg/DFGByteCodeParser.cpp:7129-7260`) |
| Megamorphic (shared) | `findMegamorphicCacheEntry` + `loadMegamorphicProperty` (`jit/AssemblyHelpers.cpp:423-533`) | ≈25 on a primary-table hit | ≈25 (holder from the entry) |
| **Luminous** own hit | `ic_hit_split` (`luminous:crates/luminous-codegen/src/lower.rs:7699-7730`) | ≈12–13: tag check 3, pointer 1, load shape, load `ic->shape`, cmp/br, load `p->prop`, load `ic->slot`, load value | ≈18–20 (alt_shape compare, kind, global epoch load + compare, cached value). The fallback without an epoch walks the shapes: ≈25–30 |
| Luminous poly entries | C call `lum_ic_poly_addr`, loop over 4 entries | ≈35–60 | |
| Luminous full miss | `lum_ic_get_proto` → `JS_GetProperty` (+ refill attempts) | 100–300+ | |

Conclusion: our own-property hit already matches JSC Baseline. Our epoch-guarded
prototype hit is about as cheap as Baseline's and is value-constant-folded like
DFG's. The difference is in polymorphic and megamorphic sites and in misses.

### 2.4 Megamorphic cache (`runtime/MegamorphicCache.h:36-320`)
* One per VM. Tables: load (2048 primary + 512 secondary), store (2048+512),
  has (512+128), and **getter** (256+64). Entries are
  `{uid (RefPtr), StructureID, uint16 epoch, uint16 offset, holder}`. The holder is
  a sentinel for "own property" and null for a miss. Store entries carry
  `{old, new StructureID, offset, reallocating}`.
* Primary hash: `((sid>>4) ^ (sid>>15)) + uid->hash()`. Secondary hash:
  `sid + (uintptr)uid`, shifted. Evicted primary entries move to the secondary
  table (`initAsHit`, `:263-273`).
* **Invalidation:** a 16-bit VM-wide epoch (`bumpEpoch`, `:299-304`).
  * It is bumped by `VM::invalidateStructureChainIntegrity` (`runtime/VM.cpp:2080-2084`),
    which runs whenever an object with `mayBePrototype()` adds a property, changes
    an attribute, or changes its prototype (`runtime/JSObjectInlines.h:409-410,
    545, 559, 584, 606`; `JSObject.cpp:2131, 2412, …`).
  * It is **not** bumped by value replacement, because entries hold
    (holder, offset), not values.
  * It is also aged on GC (`age(CollectionScope)`), since StructureIDs can be
    reused.
* When a site goes megamorphic: when the case list reaches 8, or when
  `canBeMegamorphic` is set from profiling (`tryFoldToMegamorphic`,
  `InlineCacheCompiler.cpp:4680+`). `length` is excluded. If all cases are getters,
  the site uses `LoadMegamorphicGetter`
  (`getByIdMegamorphicGetterHandler`, `:5484-5517`). There are also
  `IndexedMegamorphicLoad`/`Store`/`In` for `o[key]` with string or symbol keys.
* **Fully transferable to C.** It is pure data, keyed on (shape pointer, atom).
  For us the key would be `(JSShape*, JSAtom)`. Invalidation would be
  "structural change to a watched or `is_prototype` object, or a shape freed"
  (or clear it on every GC cycle).

### 2.5 Transferability of the IC machinery
* **Data ICs with a precomputed first-entry check:** we already do this; it is what
  JSC converged on for its unoptimized tiers.
* **Shared handler chain:** a variant is possible. Native code calls one C (or
  hand-written asm) "miss dispatcher" per access kind, which walks a small
  per-site array of `{shape, kind, slot, holder|new_shape, value}` entries. That
  is our `LumIC.poly` generalized to *all* kinds (proto getters, transitions,
  misses/undefined, string methods), plus a pointer to the global megamorphic
  cache once the site is full. Per-site machine code is impossible, and we don't
  need it.
* **Not reproducible without a JIT:** per-site specialized stubs with immediate
  structure IDs, repatching, and DFG's elimination of checks via abstract
  interpretation + OSR exit.

---------------------------------------------------------------------------

## 3. Watchpoints and ObjectPropertyConditions vs our epoch

### 3.1 JSC
* `PropertyCondition` kinds (`bytecode/PropertyCondition.h:38-47`): Presence
  (uid at offset with attributes), Replacement, Absence, **AbsenceOfSetEffect**
  (for transitions), AbsenceOfIndexedProperties, **Equivalence** (uid holds a
  specific value, which allows constant folding), HasStaticProperty, HasPrototype.
  An `ObjectPropertyCondition` binds a condition to a specific object (usually a
  prototype). `generateConditionsForPrototypePropertyHit` /
  `…PropertyMiss` / `…PropertySetterMiss` (`ObjectPropertyConditionSet.cpp:360-420`)
  emit one condition per object on the chain.
* Enforcement by **Structure transition watchpoints**. Every condition requires
  watching the transition set of the object's current structure
  (`watchingRequiresStructureTransitionWatchpoint`, `.h:343-347`). Any
  add/remove/attribute/prototype change moves the object to a new structure and
  fires the *old* structure's set (`didTransitionFromThisStructure`,
  `Structure.cpp:1383-1405`). Equivalence additionally needs a per-offset
  **replacement watchpoint set** (`ensurePropertyReplacementWatchpointSet`,
  `didReplaceProperty`, `Structure.h:754-763`). Those sets start "clear", become
  "watched" when a compiler asks, and are invalidated on the first write after
  that, so they stay valid only for properties that are never rewritten.
* `isWatchableWhenValid` (`PropertyCondition.cpp:368-420`) refuses to watch
  structures whose transition set is already invalidated. `dfgMayWatchIfPossible`
  (`Structure.h:712-731`) refuses structures that were dictionaries or whose
  ancestors fired while being watched (`transitionWatchpointIsLikelyToBeFired`).
  These heuristics avoid repeated invalidation.
* **Adaptive watchpoints.** `LLIntPrototypeLoadAdaptiveStructureWatchpoint::fireInternal`
  (`bytecode/LLIntPrototypeLoadAdaptiveStructureWatchpoint.cpp:64-80`) and
  `StructureTransitionPropertyInlineCacheClearingWatchpoint` (`PropertyInlineCacheClearingWatchpoint.cpp:61+`)
  both work like this: when a watched structure transitions, they check whether
  the *condition* still holds on the object's new structure (adding an unrelated
  method to a prototype doesn't break "`foo` is at offset 3"). If it does, they
  re-install on the new structure. Otherwise they clear that single IC
  (`PropertyInlineCache::reset`, `:48-59`). Invalidation is **targeted**: only
  ICs depending on the changed object are touched.
* Cost model: **0 instructions on the hit path**. The work is paid when a
  prototype changes (rare, after startup), and memory goes into watchpoint lists.
* Everything except DFG/FTL jettisoning also works in the interpreter: the LLInt
  `ProtoLoad` mode is entirely watchpoint-based (`LLIntSlowPaths.cpp:812-870`).
  **This mechanism doesn't need a JIT.**

### 3.2 Luminous
* `JS_WatchPrototype` (`quickjs.c:61234-61262`) gives the object a shape of its
  own and sets `is_watched`. `js_proto_changed` (`:1886-1891`) bumps the global
  `js_proto_epoch` on any add, delete, *value* change or prototype change of a
  watched object.
* Prototype-kind IC entries cache the **value** (method or getter function) plus
  the epoch (`luminous:runtime/luminous_rt.h:113-160`, `luminous_rt.c:966-1029`).
  Native code compares the epoch (load of a global + load of `ic->epoch` + cmp/br)
  and uses `ic->value` (`lower.rs:7470-7520`).
* On a stale epoch it calls `lum_ic_refresh` (cold path), which re-reads through
  the shapes. After 64 refreshes the IC gives up its epoch for good and walks the
  shapes on every access.

### 3.3 Comparison
* Our scheme gives a DFG-like constant fold (the value itself) at Baseline-like cost,
  for about 3 extra instructions per prototype hit. That is a good trade.
* The weakness is **granularity**. One watched object whose values change during
  steady state invalidates every prototype IC in the program. Examples: a
  prototype with a mutable counter or cache, a class with a static field written
  per request, an object used as `Object.create(o)` prototype and then mutated.
  The ICs that refresh more than 64 times are degraded permanently.
* JSC separates three cases:
  - structural changes, which fire transition sets (targeted);
  - value changes to properties used in constant folding, which fire per-offset
    replacement sets (targeted, one time, after which the IC loads from the holder);
  - its one global epoch (megamorphic cache), which ignores value changes.
* Transferable variants:
  1. **Measure first:** count `js_proto_epoch` bumps and `lum_ic_refresh` calls
     per request in Hono and Elysia. If they are non-zero, the fixes below
     matter.
  2. Split the epoch into a *structure epoch* (add/delete/attribute/prototype on
     watched objects) and per-slot "replaced" bits. When a watched slot is
     written, mark that slot "varying" in its (own, unshared) shape and bump only
     the epoch of ICs that folded that value. The simplest form is a per-IC-kind
     switch from "cached value" to "load from holder" (+1 load), which is what
     JSC's Replacement vs Equivalence distinction does.
  3. Targeted watch lists. Each watched object keeps a list of `LumIC*` that
     depend on it. On change, re-validate the condition (adaptive) and, if broken,
     clear `ic->alt_shape` so the receiver-shape compare fails. That removes the
     epoch load and compare from every prototype hit. Medium complexity (list
     maintenance, GC of ICs isn't an issue because ICs are static).

---------------------------------------------------------------------------

## 4. instanceof

### 4.1 JSC
* `op_instanceof` (`bytecode/BytecodeList.rb:254-271`) is one bytecode with
  three checkpoints and two embedded get_by_id caches
  (`hasInstanceModeMetadata`, `prototypeModeMetadata`). LLInt sequence
  (`LowLevelInterpreter64.asm:3250-3305`):
  1. Get `C[Symbol.hasInstance]` through the get_by_id cache. That is a ProtoLoad
     to `Function.prototype`, watched.
  2. `overridesHasInstance`: compare it with
     `globalObject->m_functionProtoHasInstanceSymbolFunction` and test the
     **`ImplementsDefaultHasInstance`** type-info flag on C
     (`runtime/JSTypeInfo.h:43`). The flag is set for JSFunction/InternalFunction
     and cleared for bound functions (`JSBoundFunction.h:40`).
  3. Get `C.prototype` through the second cache (an own property of the function).
  4. The prototype-chain walk (slow path in LLInt).
* Baseline/handler IC for step 4: `InstanceOfHit`/`InstanceOfMiss` handlers
  (`InlineCacheCompiler.cpp:6131-6170`). Key: (value's structure, prototype
  object). Hit: check structure, compare the prototype pointer with
  `handler->holder`, return a constant boolean. The chain is enforced by watched
  conditions. With more than 8 cases it switches to `InstanceOfMegamorphic`: an
  inline loop `emitLoadPrototype`, compare, repeat (`:2826-2864`), about 5
  instructions per level.
* DFG (`dfg/DFGByteCodeParser.cpp:8898-9110`). It builds the branches. It folds
  `OverridesHasInstance` when hasInstance is the constant default
  (`DFGSpeculativeJIT.cpp:3885-3919`). With `InstanceOfStatus` giving a common
  prototype, it emits `CheckIsConstant(prototype)` plus **`MatchStructure`**, a
  switch on the value's structure ID to a constant true/false. When followed by a
  branch, it fuses the two. Total about 5–8 instructions.
* Estimated cost: Baseline about 35–45 instructions; DFG/FTL about 5–8.

### 4.2 Luminous
* `JS_BinaryOperator` → `JS_IsInstanceOf` (`quickjs.c:11893-11920`):
  1. `js_default_has_instance` walks C's prototype chain with
     `find_own_property1` hash lookups.
  2. `JS_GetProperty(C, "prototype")` does a generic lookup.
  3. Chain walk with refcount dup/free of the prototype.
* Measured at about 180 instructions × 14 per request = 2.2k.

### 4.3 Transfer
* All of it can be copied without a JIT. Per-site `LumInstanceOfIC`:
  `{ctor_ptr, ctor_shape, proto_slot, proto_ptr, epoch}`. Hit:
  1. Check C is an object.
  2. Check `C == ic->ctor` and `C->shape == ic->ctor_shape`. The shape fixes the
     absence of an own `@@hasInstance` and the slot of `prototype`. The epoch
     guards `@@hasInstance` on the constructor's prototype chain, which is watched.
  3. `proto = C->prop[slot]`, then `proto == ic->proto` (handles writable
     `F.prototype`).
  4. Walk the value's chain inline: `p = p->shape->proto` per level, compare, stop
     at null. Bail out to C for Proxy (`class_id`).
* About 20–30 instructions for typical depth 1–3, with no hash lookups.
* Optional second level: a `{value_shape → bool}` 2-entry table guarded by the
  structure epoch, which turns the walk into one compare.
* Expected: 2.2k down to about 0.3–0.4k per request.

---------------------------------------------------------------------------

## 5. Getters and setters on prototypes

### 5.1 JSC
* `GetterSetter` cells hold getter and setter (`Null…Function` placeholders when
  absent). An access case of kind `Getter` / `Setter`
  (`bytecode/GetterSetterAccessCase.*`) does three things:
  1. checks the receiver structure (prototype conditions watched);
  2. loads the GetterSetter from the holder at a known offset
     (`getterHandlerImpl`, `InlineCacheCompiler.cpp:5447-5454`);
  3. makes a JS call through an embedded **DataOnlyCallLinkInfo** in the handler
     (`InlineCacheHandlerWithJSCall`, `InlineCacheHandler.h:172-185`;
     `getterCallFromGetterSetterImpl`, `:5405-5445`).
  The call itself is a monomorphic data call IC: compare the callee, then a direct
  call to its entry.
* `LoadMegamorphicGetter` caches (structure, uid) → (holder, offset of the
  GetterSetter) for sites that see many structures but always a getter.
* `IntrinsicGetter`: known getters such as typed-array `length`/`byteOffset` and
  `__proto__` are inlined as loads.
* DFG (`DFGByteCodeParser.cpp:7500-7594`). With `GetByStatus` saying "getter at
  holder H" and a `CallLinkStatus` for the getter, it:
  1. checks the receiver structure;
  2. folds the GetterSetter to a constant through watched conditions
     (`tryGetConstantGetter`);
  3. emits a `Call` with `InlineCallFrame::GetterCall`, which **inlines the
     getter's body**, so `get req() { return this.#req }` becomes a field load;
  4. lets OSR exit points inside the getter return to the get_by_id
     (`getterSetterOSRExitReturnPoint`).

### 5.2 Luminous
* `LUM_IC_PROTO_GETTER` / `LUM_IC_OWN_GETTER` cache the getter function and its
  native entry, guarded by the epoch.
* The call goes through `lum_call_getter` → `JS_CallFast` (generic call
  machinery), unless the compiler *statically* predicted the getter (`Pred`,
  `call_or_inline`, `lower.rs:4207+`), in which case it is inlined behind a callee
  check.

### 5.3 Transfer
* Static getter inlining already exists. Extend the prediction to the
  framework-heavy cases: class getters visible in the same compilation unit,
  including node_modules classes such as Hono's `Context`.
* For unpredicted getters whose cached value is a compiled function
  (`ic->entry != NULL`), call the native entry directly from native code instead
  of `lum_call_getter` → `JS_CallFast`. Saves the generic call overhead, likely
  30–60 instructions per call.
* A megamorphic getter cache comes for free with the global cache (kind = getter).
* Inlining getters discovered at run time (DFG style) is not possible without a
  JIT.

---------------------------------------------------------------------------

## 6. Candidate changes, ranked by expected gain on the Hono gap

Baseline: Beyond is 83.5k instructions per request vs Bun 43.8k; the JS side is
about 69k vs 21.6k. The gains below are rough estimates.

1. **Global megamorphic (shape, atom) cache in the C runtime.**
   * Gain: about 3–5k per request. Targets the 7.5k "property get (generic
     lookups, IC misses)", plus parts of regexp (2.0k: `exec`/`flags` spec
     lookups), promises (`then` lookups) and C-builtin `JS_GetProperty` calls.
   * What: a 2-level table like JSC's: `(shape, atom) → {holder or own, slot,
     kind ∈ data/getter/miss}`, about 2k entries. Consult it:
     - in `lum_ic_get_proto`, `lum_ic_get` and `lum_ic_own_data` before
       `JS_GetProperty`, and after the poly entries are full;
     - for `get_elem` with atom or string keys;
     - inside QuickJS's `JS_GetPropertyInternal` for hashed shapes, so C builtins
       benefit too.
     Analogous store/has tables come later.
   * Invalidation: a global "structure epoch" bumped on add/delete/attribute/
     prototype change of `is_prototype` or watched objects (not on value writes),
     plus a clear when a shape is freed (or on every GC, as JSC ages it).
     Restrict to hashed (shared) shapes and non-exotic classes.
   * Cost: medium (about 300–500 lines). Risk: medium (stale entries after a shape
     is freed and its address reused; must key only on shapes kept alive or flush
     on free).
2. **Allocation fast paths for objects not created by literals.**
   * Gain: about 3–4k per request, if most of the 21 × ~250 `JS_NewObjectProtoClass`
     calls can drop to about 40–60 instructions each.
   * First attribute the 21 objects to their callers: untyped `new F()`,
     `Object.create`, promise/iterator-result/runtime objects.
   * Then two mechanisms:
     (a) a per-site `new` cache `{F, F.prototype, shape(pinned), alloc size}`, the
         equivalent of JSC's `create_this` + `ObjectAllocationProfile`, sized from
         static `this.x=` counting (`StaticPropertyAnalyzer`) or from the final
         shape observed after the first construction;
     (b) premade per-context shapes and inline allocation for runtime-created
         objects (iterator results, Beyond's Request/Response/Headers wrappers,
         …), like `iteratorResultObjectStructure`.
   * Also cache the prototype → empty shape mapping (`find_hashed_shape_proto`) per
     site.
   * Cost: medium. Risk: low to medium.
3. **instanceof IC (section 4.3).**
   * Gain: about 1.8–1.9k per request (2.2k → about 0.3k).
   * Cost: low (one IC kind plus a codegen path). Risk: low; the only special cases
     are Proxy, bound functions and a custom `@@hasInstance`, all detected by
     shape/class.
4. **Put-transition IC plus a per-shape transition cache.**
   * Gain: about 1.3–1.5k per request (1.7k bucket; also makes `{}` + `o.x=` and
     untyped constructors cheap).
   * IC kind TRANSITION: `{old_shape, new_shape (both pinned/held), slot,
     needs_grow}`. The no-setter/readonly condition on the prototype chain is
     guarded by watching the whole chain (absence) under the structure epoch.
     Also check `p->extensible`, because in QuickJS that flag is on the object,
     not the shape.
   * Hit: tag, shape compare, epoch compare, extensible bit, store slot, store
     shape, write barrier: about 12–15 instructions. A grow goes through a C
     helper that reallocs and then does the same.
   * Independently, in QuickJS: a `(atom, flags) → child` single-entry cache on
     each `JSShape`, ahead of `find_hashed_shape_prop` (JSC's single-transition
     slot).
   * Cost: low to medium. Risk: medium (shape refcount/pinning, watched objects
     must stay excluded).
5. **Epoch hygiene (section 3.3).**
   * Gain: 0 to several k per request, unknown until measured.
   * First count `js_proto_epoch` bumps and `lum_ic_refresh` calls per request.
     If non-zero, separate structural from value invalidation (the structure
     epoch above serves both 1 and 4) and add per-slot "varying" handling, which
     falls back to loading from the holder instead of invalidating globally.
   * Optional later step: targeted watch lists, which remove about 3 instructions
     from each prototype hit.
   * Cost: low to measure, medium to fix.
6. **Getter calls.**
   * Gain: about 0.5–1.5k per request, depending on Hono/Elysia getter density
     (`c.req`, `c.res`, header accessors).
   * Direct native-entry call for cached compiled getters and setters, plus wider
     static getter prediction (5.3).
   * Cost: low to medium.
7. **Generalized data-handler miss path** (all kinds in `poly`, plus megamorphic
   fallback when full).
   * Gain: about 0.5–1k per request on polymorphic framework sites (middleware
     arrays, varied context objects).
   * Cost: medium.
8. **Inline slots without the `p->prop` indirection** for plain objects.
   * Gain: about 0.3k per request.
   * Cost and risk: high (QuickJS invariant). Not recommended now.

Total realistic upside of 1–6: about 10–14k of the 83.5k. The rest of the gap
(compiled code 13.5k vs 3.5k, GC 9.6k vs 6.2k) comes from speculation and the
allocator/GC, which other reports cover.

## 7. What is impossible or impractical without a JIT
* Speculative removal of checks with OSR exit: CheckStructure hoisting,
  abstract-interpretation-proven structures, MatchStructure turning instanceof
  into a structure switch with *profiled* structures. AOT can approximate this
  only with guarded fast paths that keep the slow path in line (the register
  pressure and spills seen in the profile), or with static types.
* Inlining getters or methods discovered at run time.
* Per-site machine code (repatching ICs, per-case stubs with immediate structure
  IDs). This hardly matters: JSC's own Baseline moved to data ICs with shared
  thunks.
* Everything else in this report (watchpoints, adaptive re-installation,
  megamorphic caches, transition caching, allocation profiles, premade
  structures, instanceof caching) is runtime data structures plus fixed code and
  works in an AOT/C setting. JSC's LLInt uses most of it with no JIT.

## 8. Measurement harness (not run)
* Micro-benchmarks for Bun (`scratchpad/study/bunprof/bun-linux-x64-profile/bun-profile`)
  and Beyond (`/home/user/beyond/target/release/beyond build x.js`), run under
  `valgrind --tool=callgrind` at N and 2N iterations. The per-iteration
  difference gives steady-state cost per operation: own get, prototype method,
  prototype getter, 8 adds after `{}`, instanceof with depth 2, a megamorphic
  get over 10 shapes, untyped `new F()`.
* Beyond has no `process`, so read N from a constant or `Bun.argv`-like API. A
  first attempt failed on `process.argv`.
