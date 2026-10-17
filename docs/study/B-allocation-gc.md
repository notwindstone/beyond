# B. JSC allocation, garbage collector and allocation elimination vs. Luminous

Paths: `JSC/` = webkit/Source/JavaScriptCore (study clone), `QJS` = /home/user/beyond/vendor/luminous/build/quickjs-src/quickjs.c,
`RT` = /home/user/beyond/vendor/luminous/runtime/luminous_rt.c. Line numbers are from the current trees.

Bottom line: JSC's per-object cost is low for three reasons. (1) Allocation is a bump of a thread-local free-list interval with the
size class and Structure known when the code is compiled, so the cell header goes in with one 64-bit immediate store (~6-15 instructions
inline). (2) GC work per object is proportional to *survivors*: sticky-mark Eden collections, sweeping driven by mark bitsets and
done lazily at allocation, and no destructor for plain objects or for butterflies. (3) In FTL, objects that never escape are not
allocated at all. Our allocator is already a bump allocator over runs (close to JSC's design). We lose instructions **around** it:
a hashed-shape lookup on every creation, per-allocation accounting and GC checks, bitfield header writes, finalizer bits on
non-plain objects, and C calls where JSC emits inline code.

---

## 1. Allocation fast path

### 1.1 Data structures
- **MarkedBlock**: 16 KB blocks (`JSC/heap/MarkedBlock.h:77-86`, atom = 16 bytes). Every cell in a block has the same size. The
  header holds the mark bitset and the newlyAllocated bitset (`MarkedBlock.h:353-357`) and a *biased* mark count, so that marking
  can retire nearly full blocks with a single sign test (`MarkedBlock.h:288-313`).
- **Size classes** (`JSC/heap/MarkedSpace.h:53-69`, `MarkedSpace.cpp:40-135`): every 16 bytes up to 80 bytes, then a 1.4x
  progression (`runtime/OptionsList.h:245`), each class rounded to minimize waste at the end of a block, plus an injected 256.
  The largest class is half the block payload (~8 KB). Bigger cells are PreciseAllocations.
- **BlockDirectory** = one size class within one subspace. It keeps a set of per-block bit vectors: live, empty, allocated,
  canAllocate, destructible, eden, unswept, inUse, markingNotEmpty, markingRetired (`BlockDirectoryBits.h:42-54`).
  `findBlockForAllocation` is a `findBit` over `canAllocate & ~inUse` (`BlockDirectory.cpp:120-145`).
- **LocalAllocator** (`LocalAllocator.h:39-83`) holds a **FreeList** of *intervals* (`FreeList.h:82-123`): `[intervalStart,
  intervalEnd)` is bumped. When an interval runs out, the next one is decoded from a scrambled `FreeCell` (offset to the next
  interval and length, XOR a per-sweep secret, `FreeList.h:39-80`). An empty block yields a single interval, so pure bump allocation.

### 1.2 Fast path code
- C++: `FreeList::allocateWithCellSize` (`FreeListInlines.h:35-54`): `if (start < end) { r = start; start += size; return r; }`.
  Otherwise it decodes the next interval, or calls the slow path. `LocalAllocator::allocate` (`LocalAllocatorInlines.h:33-43`)
  wraps it, and the **slow path first calls `sanitizeStackForVM`** (line 40), then `allocateSlowCase`.
- JIT: `AssemblyHelpers::emitAllocateWithNonNullAllocator` (`jit/AssemblyHelpers.cpp:916-1039`). On x86-64 (972-996) the hot
  path is:
  `mov $allocator,%r; mov start(%r),%res; cmp end(%r),%res; jae pop; add $cellSize,start(%r); jmp done`
  which is **5-6 instructions**. The "pop next interval" path adds ~10 more, and runs once per interval.
- Header: `emitStoreStructureWithTypeInfo` (`AssemblyHelpers.cpp:351-354`) writes StructureID, indexingType, JSType, inline flags
  and cellState with **one 64-bit immediate store**, since all of them are known when the code is compiled.
  `emitAllocateJSObject` adds one store for the butterfly (null) (`AssemblyHelpers.h:1521-1526`). Inline slots are zero-filled with
  paired stores (`AssemblyHelpers.h:1609-1650`). `mutatorFence` emits nothing on x86 (`AssemblyHelpers.h:1348-1355`), and on ARM
  only a branch while a GC is running.
- Per tier: LLInt `new_object` is a C slow-path call (`llint/LLIntSlowPaths.cpp:681-687`). Baseline allocates inline from the
  site's ObjectAllocationProfile (allocator + Structure loaded as a pair, `jit/JITOpcodes.cpp:79-100`). DFG and FTL use a
  constant allocator: FTL wraps the same assembly in a B3 patchpoint (`ftl/FTLLowerDFGToB3.cpp:23412-23496`), stores the
  structure as two constant 32-bit stores (`23498-23504`), and splats zeroes over the inline storage (`23538-23562`). Array
  literals allocate the butterfly and the cell inline, back to back (`dfg/DFGSpeculativeJIT.cpp:389-447`).
- **Total for `{}` (6 inline slots) in DFG/FTL code: about 15 instructions, with no call.** The C++ path `JSFinalObject::create`
  (`runtime/JSObject.h:1002-1011` → `JSCellInlines.h:152-167` → `CompleteSubspaceInlines.h:33-41`, which takes the allocator
  from a size-step table, `CompleteSubspace.h:67`) costs roughly 30-50 instructions.

### 1.3 Why the header is laid out this way (`runtime/JSCell.h:293-302`)
`StructureID m_structureID` (32 bits, a compressed Structure pointer) is followed by a 32-bit blob: indexingTypeAndMisc, JSType,
inline type flags and cellState, one byte each. The Structure keeps the same 4 bytes as a `typeInfoBlob`, so creating a cell
copies 8 bytes. Every hot check reads one byte at a fixed offset: type checks read `m_type`, array-shape checks read
`m_indexingTypeAndMisc`, the write barrier reads `m_cellState` (an object can be "black" without consulting the mark bitmap),
and structure checks are a 32-bit compare. JSFinalObject = header (8) + butterfly pointer (8) + inline slots
(`JSObject.h:883-892`). The default size is 64 bytes = 6 inline slots, up to 512 bytes (`JSObject.h:944-950`).

### 1.4 Inline capacity is predicted, so most objects are one allocation
- Object literals: `StaticPropertyAnalyzer` (`bytecompiler/StaticPropertyAnalyzer.h:34-101`, `BytecodeGenerator.cpp:3436-3442`)
  counts the `put_by_id`s applied to a fresh `new_object` until its register dies.
- `new F()`: `FunctionRareData::initializeObjectAllocationProfile` (`runtime/FunctionRareData.cpp:120-130`) takes the maximum
  field count found along the class chain. `ObjectAllocationProfileBase::initializeProfile`
  (`bytecode/ObjectAllocationProfileInlines.h:35-146`) clamps the count, adds a guess from the prototype's non-function
  properties, and then *grows the capacity to fill the size class* ("slop", lines 104-110).
- Properties beyond the inline capacity go to the **butterfly**, an auxiliary cell in `auxiliarySpace` (`heap/Heap.h:1033-1036`,
  `runtime/ButterflyInlines.h:74-93`). Named properties sit at negative offsets and indexed elements at positive offsets after an
  8-byte IndexingHeader. A butterfly is marked by its owner (`markAuxiliary`), has **no destructor**, and costs nothing when it dies.

## 2. The collector (Riptide)
- **Phases** (`heap/CollectorPhase.h:41-64`, `heap/Collector.cpp:389-672`): Begin → Fixpoint (world stopped: run marking
  constraints, drain in parallel) → Concurrent (mutator runs, helper threads drain) → Reloop → … → End. The collector and the
  mutator pass the "conn" back and forth. The mutator polls on allocation slow paths (`Collector.cpp:579-591`).
- **Generational through sticky mark bits**: Eden collections do not clear the marks. Only Full collections bump
  `m_markingVersion`, which makes every mark bit stale in O(1) (`heap/MarkedSpace.cpp:393-423`, `BlockDirectory.cpp:306-315`).
  Old objects stay marked and are not traced again. The remembered set is the mutator mark stack: old objects that were
  barriered get rescanned. An Eden collection sweeps only blocks with eden bits (`BlockDirectory.cpp:367-377`).
- **Marking**: `SlotVisitor::appendJSCellOrAuxiliary` / `setMarkedAndAppendToMarkStack` (`heap/SlotVisitor.cpp:141-269`)
  test-and-set the mark bit, set cellState to PossiblyGrey, and push. `visitChildren` sets PossiblyBlack, issues a store-load
  fence, and switches on type, with fast cases for strings, final objects and arrays (`SlotVisitor.cpp:368-420`).
- **Write barrier**: `if (cellState <= barrierThreshold) slowPath` (`heap/HeapInlines.h:97-121`). The threshold is
  `blackThreshold` (0) when idle and `tautologicalThreshold` while marking, which forces the fenced slow path
  (`Heap.cpp:2189-2200, 2705-2709`; `CellState.h:31-47`). Inline it is one load plus a compare
  (`AssemblyHelpers.h:1302-1339`). DFG/FTL **elide barriers** on stores into objects allocated in the current "GC epoch", that
  is, with no GC point between the allocation and the store (`dfg/DFGStoreBarrierInsertionPhase.cpp:52-69`).
- **Sweeping** is lazy, and its cost is paid when allocating. `tryAllocateIn` sweeps a block into the free list just before using
  it (`LocalAllocator.cpp:244-271`). `specializedSweep` (`heap/MarkedBlockInlines.h:238-408`) has a fast path for empty blocks
  (a single interval, 295-331). Otherwise it ORs marks with newlyAllocated and walks **only the set bits** to emit free
  intervals (354-400). **The cost is O(live cells + bitmap words), not O(dead cells)**, unless the block holds destructors.
  An IncrementalSweeper on a timer (10 ms slices, at most 10% CPU) sweeps the rest and frees empty blocks
  (`IncrementalSweeper.cpp:37-127`).
- **When to collect**: the allocation slow path calls `heap.didAllocate(freeList.originalSize())` once per *free list* (not per
  object), then `collectIfNecessaryOrDefer` (`LocalAllocator.cpp:137-143`, `Heap.cpp:2032-2046, 2238-2300`). The Eden budget is
  `m_maxHeapSize - m_sizeAfterLastCollect`, with a minimum of 32 MB for a large heap (`OptionsList.h:215-238`,
  `Heap.cpp:146-200`). After a Full collection, `maxHeapSize = growthFactor(heap) × live` (`Heap.cpp:1912-1931`). When Eden room
  falls below 1/3, the next collection is Full (`Heap.cpp:1940-1943`). The Eden and Full GCActivityCallback timers also collect
  when idle.
- **Destructors**: objects with a destructor live in `destructibleObjectSpace` or in IsoSubspaces (`Heap.h:1057-1063`,
  `heap/IsoSubspace.h:42-71`, `DestructionMode.h:32-36`). Blocks track "destructible" bits, and only those blocks pay a
  per-dead-cell `destroy` during the sweep (`MarkedBlockInlines.h:316-320, 360-363`). Plain objects, arrays and butterflies have
  no destructor.

## 3. Conservative stack scanning and sanitizeStackForVM
- Roots: the registers (setjmp'd RegisterState) and the stack from `stackTop` to `stackOrigin` (`MachineStackMarker.cpp:44-53`),
  plus JIT scratch buffers (`Heap.cpp:783-796`). This runs as a marking constraint with the world stopped (`Heap.cpp:2405-2448`).
  **JIT frames (Baseline, DFG and FTL) are scanned conservatively as well.** JSC has no GC stack maps. Its stackmaps exist only
  for OSR exit.
- Per word (`ConservativeRoots.cpp:70-192`): `TinyBloomFilter::ruleOut` checks `(bits & filter) != bits` against the OR of all
  block addresses (`TinyBloomFilter.h:69-78`), which costs one AND and one compare to reject most words. Survivors go through a
  hash-set lookup of the block, `cellAlign`, an `isLiveCell` check against the bitsets, and handling of interior pointers and
  butterfly end-pointers.
- **sanitizeStackForVM** (`runtime/VM.cpp:1509-1525`, implemented in `llint/LowLevelInterpreter.asm:1974-2036`) zero-fills the
  stack from `vm.m_lastStackTop` up to the current `sp` when the last recorded top is deeper, then records the current sp. The
  purpose is that dead stack below sp does not later appear *inside new frames* (uninitialized spill slots, padding) and pin
  garbage through the conservative scan. It is called from the **allocation slow path** (`LocalAllocatorInlines.h:40`), every
  **virtual, polymorphic or link call slow path** (`jit/JITOperations.cpp:2360,2382,2399`;
  `LLIntSlowPaths.cpp:634,649,665`), `CompleteSubspace` slow paths (`CompleteSubspace.cpp:118,161`), before GC
  (`Heap.cpp:1620`, `Collector.cpp:295,323,746`), and OSR entry. That accounts for Bun's 2.9k instructions per request: frequent
  calls, each zeroing hundreds of bytes.

## 4. Allocation elimination
- **ObjectAllocationSinkingPhase** (`dfg/DFGObjectAllocationSinkingPhase.cpp`, FTL only: `dfg/DFGPlan.cpp:395-398`). It is a
  points-to plus escape analysis over SSA, working like an abstract interpreter of a "local heap" (comment at 61-141). It covers
  objects, arrays and butterflies, activations, functions and closures, RegExp objects, promises and internal-field objects (150).
  `PutByOffset`, `GetByOffset`, `PutStructure` and `CheckStructure` on a local allocation become promoted SSA values (1202-1241).
  **Every other use escapes the operands** (1434-1441), so the phase depends on inlining. It sinks each allocation to the points
  where it escapes, `placeMaterializations` / `createMaterialization` → `MaterializeNewObject` (1682-1926). An allocation that
  never escapes becomes `PhantomNewObject`. At an OSR exit, `operationMaterializeObjectInOSR` (`ftl/FTLOperations.cpp:277`)
  rebuilds the object from the exit values.
- Related phases: **ArgumentsElimination** (no `arguments` or rest object when it does not escape,
  `DFGArgumentsEliminationPhase.h:34-37`), **VarargsForwarding**, and **PutStackSinking** (`DFGPutStackSinkingPhase.cpp:53-80`),
  which sinks stores to the stack frame and so removes stores that only matter for OSR exit and calls. They run around SSA
  conversion (`DFGPlan.cpp:376-398`).
- **What an AOT compiler can do statically**: the analysis is the same, and simpler, because we have no OSR exit. A sunk object's
  "materialization at exit" becomes ordinary code on the path where it escapes. The obstacles are untyped operations, which are
  calls into C (`JS_GetProperty` and so on) and must count as escapes unless the compiler knows the object's shape: it allocated
  the object, so it does know. The other obstacle is getters and setters on the prototype for missing properties: a sunk `{a,b}`
  has proto Object.prototype, and our runtime already guards that with the prototype epoch. Good targets: iterator result objects
  `{value, done}` (for-of over arrays, Map and Set, generators), destructured returns `return {a, b}` → `const {a, b} = f()`
  after inlining, option-bag literals passed to inlined callees, rest and arguments arrays, spread temporaries, and closures passed
  only to inlined higher-order functions (`arr.map(x => …)`).

## 5. Memory per object
| | JSC | Luminous (patched QuickJS) |
|---|---|---|
| header | 8 bytes (StructureID + 4 info bytes) | 8-byte block header (`QJS:297-313`: block_idx, size idx, type/remembered/mark bits, **ref_count**) + 8 bytes (flags, class_id, **weak_index**) |
| shape | in the header (32-bit ID) | `JSShape *shape` 8 bytes |
| property storage | butterfly pointer 8 bytes; 6 inline slots by default, sized by profile plus slop | `JSProperty *prop` 8 bytes (points into the object itself for plain objects, `QJS:8012-8017`) |
| `{a,b}` | 16 + 6×8 = 64 bytes (or 32 with exact capacity), **1 allocation** | 8 + 24 + 2×8 = **48 bytes, 1 allocation** (inline props for plain objects already: `QJS:1452-1455, 1521`) |
| array of n | 16-byte cell + butterfly (8 + n×8), 2 allocations, both inline and neither with a destructor | JSObject + values from the arena (`js_malloc`), 2 allocations, plus a **finalizer bit** (`QJS:8118-8120`) |

Luminous has already closed the "object + property array = 2 allocations" gap for plain objects. What remains is ~16 bytes of
header overhead per object: `prop`, `ref_count` and `weak_index`, plus a 64-bit `shape` where a 32-bit reference would do. The
other remaining gap is finalizers on every non-plain object.

## 6. Our side: where ~250 instructions per object go
Measured: callgrind on the current `build/quickjs/qjs` running `Object.create(proto)` 200k times, objects dying young (script in
scratchpad/gcexp). Inclusive cost per object:
- `JS_NewObjectProtoClass`: **155 instructions** in total.
  - **49** of its own: `find_hashed_shape_proto` (hash the proto, walk the hash chain, compare four fields, `QJS:7844-7859`) plus
    `js_dup_shape` (`7588`) plus the call.
  - **~94** in `JS_NewObjectFromShapeExtra` (`QJS:7993-8122`), which is a call (not inlined). This covers: `js_trigger_gc` (a
    call, ~7 instructions, `2066-2078`; it is redundant with the threshold check in `js_gc_new_run`, `3059`); the malloc_limit and
    malloc_size checks; the size-class lookup through `size_index[]`; `js_gc_take` with the free_cells test and three bitfield
    read-modify-writes on the header (`3141-3166`); `js_object_set_header`; the shape and prop stores; a `switch(class_id)`;
    `JS_REF_COUNT=1`; `add_gc_object` (another bitfield write, `9149-9153`); and, for a non-plain class, `js_gc_set_fin`
    (chunk, index by multiplying by the inverse, set a bit).
  - **~4-10** of amortized GC (minor collections are almost free when everything dies).
- In Hono, 250 instructions = this plus the caller: `js_create_from_ctor` does a generic `prototype` lookup, and there is
  class-specific setup (promises and their resolving functions, Map, Error…), with the 8 properties added one by one afterwards
  (`add_property`, shape transitions, hashed `find_hashed_shape_prop`).
- JSC equivalent: 6 instructions to allocate, 2 for the header, 1 for the butterfly and ~4 to zero, about **15 in total**, with
  the final Structure known from the profile, so no transitions while the constructor runs.
- The 9.6k of GC, allocation and freeing per request is not explained by allocation of short-lived plain objects, which costs
  about 10 instructions each. Candidates to profile, in order: finalization of non-plain objects (`js_gc_finalize_chunk` →
  `js_gc_finalize_cell` → class finalizer → `js_free` of arena storage); fixed per-collection work (root scanning, the conservative
  scan through `js_gc_find` with a hash-table probe per in-range word, `QJS:3279-3304, 9521-9550`, without a bloom-style
  pre-filter; `js_gc_sweep_atoms` on every collection, `10076`); arena `js_malloc` and `js_free` for property arrays that outgrow
  their inline storage and for array element storage.

## 7. Candidate changes (ranked by expected gain per request in Hono)
1. **Allocate every known-class creation site inline, with its final shape (≈4-6k instructions).** Extend the object-literal
   IC/alloc-info path (`RT:2118-2181`, `ic->slot = JS_ShapeAllocInfo`) to `new C()` for compiled classes. The compiler sees the
   constructor body, which is a static StaticPropertyAnalyzer: it can count `this.x =` assignments, cache the *final* shape per
   site, size the object for it, and store the fields directly. Do the same for array literals (cell + element storage, back to back)
   and, in C, for promises and resolving functions and the other per-request built-ins, with a per-realm cached shape and
   allocation info (no hash lookup, no generic `prototype` get when the constructor is the intrinsic). Cost: medium. Risk: low to
   medium (shape invalidation, which the same epoch guards handle).
2. **Slim the C allocation path (≈1-2k across all GC cells: objects, strings, shapes, var refs, closures).**
   - Drop `js_trigger_gc` before each object; the threshold is already checked when a run is refilled.
   - Drop the per-allocation malloc_limit and malloc_size checks; account per run, which `js_gc_new_run` already does.
   - Write the 8-byte cell header with one store instead of bitfield read-modify-writes.
   - Make `JS_NewObjectFromShapeExtra` always_inline for constant `class_id`, so the switch folds away.
   - Keep the free_cells pop off the plain bump path.
   Cost: low. Risk: low.
3. **No finalizers for common classes (≈1-2k, plus fewer frees).** Make array elements, the outgrown property arrays of plain
   objects, and promise, Map and similar data GC *auxiliary* cells traced by their owner, as JSC does with butterflies, instead of
   arena memory freed by a finalizer. A dead array then costs nothing at sweep. Cost: medium to high. Risk: medium (resizing,
   `js_realloc` paths, typed arrays).
4. **Remove the hashed lookup of the initial shape (≈1k).** Cache the empty shape on the prototype object, or per constructor or
   site (JSC: StructureCache plus the allocation profile), instead of `find_hashed_shape_proto` on every creation. Cost: low.
   Risk: low.
5. **Pre-size and pre-shape objects that gain properties after creation (≈1-1.5k, part of the 1.7k "property set").** Use the
   static count of properties added at the site (constructor, or literal followed by `o.x = …`) plus capacity slop, so
   `add_property` neither reallocates nor walks `find_hashed_shape_prop`. Cost: low to medium.
6. **Static allocation sinking (variable gain, large on iterator-heavy code).**
   - Escape analysis after inlining in `lower.rs`. Sink non-escaping literals, `{value, done}` iterator results, rest and
     arguments arrays, and closures given to inlined callbacks.
   - Materialize on escape paths; no deopt is needed.
   - Also elide write barriers on stores into objects allocated with no intervening call that could GC (JSC epoch rule), saving
     ~3 instructions per store.
   Cost: high. Risk: medium (correctness of the escape rules for untyped operations).
7. **GC tuning and scanning hygiene (instructions uncertain; memory-positive).**
   - (a) Pre-filter conservative scan candidates with a TinyBloomFilter over chunk addresses before `js_gc_find`.
   - (b) Measure collections per request and fixed costs (`js_gc_sweep_atoms`, roots) before raising `JS_GC_YOUNG_LIMIT` (4 MB)
     toward JSC's ≥32 MB Eden. That trades memory, which runs against our goal of using less memory than Bun.
   - (c) Do not copy JSC's per-slow-path `sanitizeStackForVM` (the source of Bun's 2.9k). Instead, zero
     `[deepest_sp_seen, sp)` once per event-loop turn or in `js_gc_new_run`, which runs about once per 64 KB run and costs almost
     nothing.
   - (d) Long-term: precise stack maps for compiled frames (Cranelift user stack maps or LLVM statepoints), with conservative
     scanning only for C frames. This removes retention by stale spill slots. Cost: high.
8. **Slimmer object header (memory, ~25% on small objects; indirect GC gain).** Use a 32-bit compressed `shape`, drop
   `ref_count` for objects and `prop` for inline-props objects (derive it from a flag), and move `weak_index` to a side table bit.
   That brings the overhead to 16 bytes, as in JSC. Cost: high (JS_LAYOUT_* in codegen). Risk: medium.
