# E. Making AOT-compiled untyped JavaScript fast

How JSC's DFG/FTL speed up untyped code, which of those wins an AOT compiler can get, prior art, and a
ranked proposal for Luminous.

Paths: `JSC/` = `/tmp/claude-0/-home-user/fb0dc63b-644d-5569-a7d0-46953e9b705b/scratchpad/study/webkit/Source/JavaScriptCore/`,
`LUM/` = `/home/user/beyond/vendor/luminous/`.

---

## 0. Summary

* For framework code (property-heavy, call-heavy, allocation-heavy, little arithmetic), DFG/FTL get most
  of their win from three things that depend on each other:
  1. Inlining, chosen from call-target profiles (including polymorphic switches and getter inlining).
  2. Replacing ICs with straight-line `CheckStructure` + `GetByOffset`. Prototype lookups become
     constants under watchpoints.
  3. Removing checks once they are explicit: CFA over structure sets that survive calls because of
     transition watchpoints, CSE, and check hoisting.

  Value-type speculation (int32, double, string) matters less here than in benchmarks, but it removes
  the tag checks and boxing on every value that flows between operations.
* OSR exit is what makes speculation cheap. After a failed check the code leaves and never merges
  back, so everything downstream is typed. An AOT compiler can get almost all of this without runtime
  codegen by doing **"static OSR"**: exits jump into a generic copy of the same function, compiled
  ahead of time from the same MIR, at the matching program point. Three things in Luminous make this
  much easier than in JSC:
  - Conservative stack scanning means no stack maps.
  - Native code is the only tier, so no interpreter frames need rebuilding.
  - Exit and target live in one LLVM/Cranelift function.

  What AOT really cannot do is *recompile* after exits. Profiles must come from a training run, and the
  runtime can only switch to generic code.
* Luminous already has most of the machinery a JIT would use, but it is driven by **TypeScript
  annotations**:
  - `predict_calls` (guarded inlining), `ir.rs:2824`.
  - `specialize_fields` (`ShapeGet`/`ShapeSet` against runtime-learned shapes), `ir.rs:3056`.
  - `virtualize_instances` (scalar replacement with materialization), `ir.rs:3866`.
  - `spec.rs` speculative numeric regions (entry guard plus a full copy).

  In node_modules JS those hints are missing, so this machinery is idle. **The cheapest big lever is to
  feed these passes with profile-derived hints**: shapes and callees recorded by the existing `LumIC`s
  and call sites during a build-time training run.
* Prior art agrees:
  - Untyped AOT without speculation buys little. Static Hermes untyped native code runs at about
    interpreter speed.
  - Baseline-level AOT (ICs compiled in) gives 1.5–5x over an interpreter (weval/cfallin, Sparkplug).
    Luminous is already at this level.
  - The rest of the gap to optimizing JITs comes from feedback-driven specialization and inlining.
    SpiderMonkey's Warp showed that **IC state alone is enough feedback**: it dropped global type
    inference and transpiled CacheIR into MIR, gaining 10–20%.

Ranked proposals (details in §4):

| # | Proposal | Expected gain (Hono JS side, 69k instr/req) | Difficulty | Main risk |
|---|---|---|---|---|
| P1 | Training-run profiles fed into the existing passes: guarded monomorphic/polymorphic property access with constant slots, guarded inlining of callees and getters, specialized `instanceof` | 15–25k instr/req (≈20–35%) | medium | Shapes must have an identity that holds across runs; code growth |
| P2 | Two versions of hot functions with "static OSR" exits into a generic copy; profile-seeded prediction propagation (unboxed int/double/bool), check CSE with epoch re-checks after calls | Half or more of the 13.5k compiled-code instructions (Elysia 9.6k vs JSC 1.7k), plus enabling P1 to go further | high | Correct exit states; up to 2x code for hot functions |
| P3 | Whole-program allocation-site shapes: final shape known at allocation, inline allocation, escape analysis for temporaries | 5–10k (object creation 8.4k, add_property 1.7k, part of GC 9.6k) | medium | Low (shapes stay checked) |
| P4 | Build-time cross-module devirtualization (ESM bindings as constants, closed-world call graph) plus cheap local type inference | 2–5k directly; enables P1 and P2 without profiles | low–medium | CJS `exports` mutation (guard it) |

Caveat on measurement: Poirier/Rohou/Serrano (2025) removed up to two memory accesses per IC hit in Hopc
and found **no speedup** on modern CPUs. Callgrind instruction counts overstate gains from IC
micro-tweaks. Aim at removing *work* (C calls, generic lookups, allocations, boxing) and confirm with
cycles (`perf stat`), not only instructions.

---

## 1. What DFG/FTL exploit, ranked for framework code

Phase order: `JSC/dfg/DFGPlan.cpp:237-258`. Parsing with profile-driven inlining and IC conversion
happens first. Then PredictionInjection, PredictionPropagation, Fixup, InvalidationPointInjection and
TypeCheckHoisting, then BackwardsPropagation, StrengthReduction, CFA, ConstantFolding and LocalCSE
(`:270-277`). The FTL SSA pipeline (`:366-454`) adds PutStackSinking, ArgumentsElimination, GlobalCSE,
ObjectAllocationSinking, LICM, IntegerRangeOptimization and OSRAvailabilityAnalysis.

### 1.1 Inlining from call-link profiles (largest payoff for framework code)

* **Profile source.** `CallLinkInfo` / `PolymorphicCallStubRoutine` keep call *edges with counts*.
  `CallLinkStatus::computeFromCallLinkInfo` (`JSC/bytecode/CallLinkStatus.cpp:140-236`) sorts edges by
  count. It keeps at most `maxPolymorphicCallVariantsForInlining` = 5 callees with count ≥
  `frequentCallThreshold` = 2, and requires known/unknown ≥ `minimumCallToKnownRate` = 0.51
  (`JSC/runtime/OptionsList.h:277-279`). Closures are "despecified" to their executable: the code is
  the identity, not the function object (`:226-231`, `isClosureCall`).
* **Monomorphic case.** `handleInlining` (`JSC/dfg/DFGByteCodeParser.cpp:2612-2665`) inlines with a
  callee check (`emitFunctionChecks`, `:1873`). If inlining is refused (budget), it still emits a
  **DirectCall** to the known executable (`:2638-2662`).
* **Polymorphic case (FTL only).** A `Switch` on the callee or executable has one inlined body per
  variant (`:2666-2810`). The **fallthrough is a generic `Call` when `couldTakeSlowPath`, not an OSR
  exit** (`:2813-2834`). This is a plain diamond, usable as-is by an AOT compiler.
* **Budgets.** Bytecode cost is 80 in DFG and 170 in FTL (`OptionsList.h:316,319`; `getInliningBalance`
  `DFGByteCodeParser.cpp:2597-2608`). Depth is 5, recursion 2, and caller size at most 10000
  (`OptionsList.h:328-333`).
* **Getters and setters are inlined through the same path.** `handleGetById` turns a getter variant
  into `handleCall(..., InlineCallFrame::GetterCall, ...)` (`DFGByteCodeParser.cpp:7552-7595`).
  Framework code reads getters constantly (Hono `c.req`, `c.res`, …).

**AOT.** Fully obtainable with training profiles, guarding on code identity with a generic call as
fallback. Whole-program visibility often gets the monomorphic case **statically** (§4 P4). No OSR
needed: JSC itself uses a fallback call for the polymorphic case.

### 1.2 ICs become explicit checks and loads, with prototype loads folded to constants

* `handleGetById` (`DFGByteCodeParser.cpp:7370-7600`) reads `GetByStatus`, which comes from the
  baseline IC stubs. It produces:
  - one variant: `CheckStructure` + `GetByOffset` (`load(...)`, `:7505-7512`);
  - several variants (FTL, at most `maxPolymorphicAccessInliningListSize` = 8, `OptionsList.h:271`):
    `MultiGetByOffset`, lowered as a switch on the structure ID whose miss is an OSR exit unless CFA
    proved coverage (`JSC/ftl/FTLLowerDFGToB3.cpp:12790-12880`);
  - megamorphic: `GetByIdMegamorphic` (`:7402-7406`).
* **Prototype hits cost zero code.** `planLoad` (`DFGByteCodeParser.cpp:7060-7127`) first tries to
  promote the condition "property present on prototype P" to "property equals value V" under a
  watchpoint, which gives a **constant** (`:7099-7101`). Failing that, it watches the structure and
  loads from the prototype as a constant base. Failing that, it emits a `CheckStructure` on the
  prototype. A method read from a prototype therefore becomes a constant function, then a
  DirectCall, then inlined.

**AOT.** Profiles give the shape(s) per site. The **slot offset becomes a compile-time constant**, but
QuickJS shapes are runtime pointers, so the shape compare needs a learned identity. Luminous already
has the pattern in `lum_record_shapes`: a global table filled by the first object of that shape
(`LUM/runtime/luminous_rt.h:23-34`, `specialize_fields`). Prototype constants: the
`js_proto_epoch` + `LumIC.value` scheme (`luminous_rt.h:121-128`) is the AOT stand-in for JSC's
equivalence watchpoints. Its *invalidation* differs, see 1.5.

### 1.3 Check elimination: CFA, structure watchpoints, CSE, hoisting

* **CFA / abstract interpretation** (`DFGAbstractInterpreterInlines.h`, 6353 lines) tracks type and
  structure sets per node. A `CheckStructure` whose input is already proven is removed by
  ConstantFolding.
* **Why checks survive calls.** `StructureAbstractValue::clobber`
  (`JSC/dfg/DFGStructureAbstractValue.cpp:49-76`, comments in `.h:116-130`): after an effectful node
  the set is "clobbered", but **if every structure in it is watchable, JSC sets a transition
  watchpoint and keeps the set**. If an object transitions later, the code is jettisoned and frames
  exit at the next `InvalidationPoint` (`DFGInvalidationPointInjectionPhase.cpp:39-70`). This is the
  one optimization that most needs real invalidation.
* **CSE.** `LocalCSEPhase` and `GlobalCSEPhase` (`JSC/dfg/DFGCSEPhase.cpp:314,679`) are driven by
  `clobberize` (`DFGClobberize.h`, 2858 lines), a precise read/write heap model per node. Once a
  property access is a `GetByOffset`, it can be CSE'd and LICM'd across nodes that don't write that
  heap location.
* **TypeCheckHoisting** (`JSC/dfg/DFGTypeCheckHoistingPhase.cpp:83-140, 246-330, 524-533`) moves
  `CheckStructure`/`CheckArray` from uses to the variable's definition (e.g. a `SetArgument` at
  function entry) when all checks on that variable agree on one structure. It amounts to a
  function-entry shape check, the natural AOT "two-version at entry" guard.

**AOT.** CFA and CSE are static and fully obtainable *once checks are explicit IR nodes with constant
shapes* (P1 and P2). The watchpoint-based "survives calls" property is not available. The substitute is
to re-check the shape after calls (load + compare; QuickJS objects change shape pointer when they
transition) or to check `js_proto_epoch` after calls for prototype assumptions. Both are cheap and fall
back to generic code.

### 1.4 Value profiling and prediction propagation

* **Profiles.** `ValueProfile` buckets (`JSC/bytecode/ValueProfile.h:45-140`) store the last value
  seen. `computeUpdatedPrediction` (`:113-128`) folds them into a 64-bit `SpeculatedType` lattice
  (`JSC/bytecode/SpeculatedType.h:45-120`) with fine classes: FinalObject, Array, Function,
  StringIdent vs StringVar, BoolInt32, Int32, Int52, AnyIntAsDouble, DoubleReal, Other, …
* **Profiles are needed only at "heap" nodes.** Loads, calls, arguments, closure and global vars and
  `GetByVal` take `getHeapPrediction()` (`JSC/dfg/DFGPredictionPropagationPhase.cpp:1030-1100`). All
  other nodes get types by forward/backward fixpoint propagation (`:49-108`), e.g. `ValueAdd`
  (`:257-293`) uses operand predictions plus the arith profile's "did overflow/double" bits through
  `addSpeculationMode`.
* **No profile means an exit.** `getPrediction` emits `ForceOSRExit` when a site never ran
  (`DFGByteCodeParser.cpp:1319-1330`). The function is compiled assuming that code is unreachable.
* Fixup then picks edge use kinds (Int32Use, DoubleRepUse, StringIdentUse, CellUse, ObjectUse…). The
  FTL emits `speculate(...)` checks that become OSR exits (`FTLLowerDFGToB3.cpp:25300-25343`,
  `appendOSRExit` `:27669`, `blessSpeculation` `:27712`).

**AOT.** A training run can record the same lattice per heap site: per `LumIC` result, call result and
parameter. Propagation is static. Unboxed values are what *need* exits that never merge: if a
speculated-int32 add overflows and the slow result merges back, the join is untyped again. This is
precisely what P2's static OSR provides.

### 1.5 OSR exit, and what each benefit needs it for

`ExitKind` (`JSC/bytecode/ExitKind.h:32-68`) lists the speculation failures: BadType, BadCache,
BadConstantValue, BadExecutable, Overflow, NegativeZero, OutOfBounds, HoistingFailed, … Exits rebuild
baseline frames, including inlined frames (`reifyInlinedCallFrames`, `DFGOSRExitCompilerCommon.h:40`),
from `ValueRecovery`s (`DFGOSRExit.cpp:187-330`). After `osrExitCountForReoptimization` = 100 exits the
code is jettisoned and recompiled with exit-site knowledge (`OptionsList.h:395`). The parser consults
`hasExitSite(..., BadCache)` at many sites (`DFGByteCodeParser.cpp:3222…`).

| Benefit | Statically (whole program) | With AOT training profile | Needs real OSR / deopt? |
|---|---|---|---|
| Monomorphic inlining | Yes when the callee is resolvable (ESM imports, `this.m()` in classes, literals) | Yes (guard on code identity) | No (fallback call) |
| Polymorphic call inlining | Partly (CHA over classes) | Yes | No (JSC itself uses a fallback call) |
| Getter/setter inlining | Partly (class getters) | Yes | No |
| Own-property IC → constant slot | Yes for allocation-site shapes (P3) | Yes | No for a diamond; P2 static OSR for downstream typing |
| Prototype method → constant | Partly | Yes | **Invalidation**: an epoch check after calls replaces watchpoints |
| Structure facts surviving calls | No | No | **Yes in JSC (transition watchpoints)**. AOT: re-check after calls (cheap) |
| CSE / LICM of property loads | Yes once explicit | Yes | No |
| Int32/double/bool unboxing on heap values | Rarely | Yes | Needs non-merging exits (static OSR suffices) |
| `ForceOSRExit` on never-run code | n/a | Profile marks cold code | AOT: compile it generic and cold; no exit needed |
| Allocation sinking (escape analysis) | Yes for non-escaping objects | Profile helps choose | JSC materializes on exit; AOT materializes at escape points (already done in `virtualize_instances`) |
| Recompile after bad speculation | No | Next build only | **Yes (only a JIT)**. AOT: sticky per-site/function "go generic" flags plus exit counters fed to the next build |

---

## 2. Prior art (with numbers)

* **Static Hermes (Meta).** Requires sound types (Flow/TS) for speed. Untyped code is compiled to native
  code calling generic runtime helpers. In the community benchmark (`KusStar/benchmark-static-hermes`,
  M1 Pro), untyped native code is about as fast as the bytecode interpreter and sometimes slower:
  | | calc | md5 | nbody |
  |---|---|---|---|
  | interpreter | 2085 ms | 2027 ms | 841 ms |
  | untyped native | 2334 ms | 2504 ms | 555 ms |
  | typed native | 4 ms | — | 53 ms |
  | JSC | — | 179 ms | 35 ms |

  Mikov's own factorial micro-benchmark: interpreter 2086 ms, untyped native 2388 ms. Lesson: AOT
  without speculation or types does not pay. Luminous untyped code is already past this (ICs, int fast
  paths, guarded inlining).
* **Hermes bytecode AOT** precompiles to bytecode only (startup win, no peak win).
* **Hopc (Serrano, DLS 2018; ICFP 2021).** AOT JS→Scheme→C:
  - *Hint typing*: types guessed from uses.
  - *Function duplication*: a generic version plus a specialized version chosen by argument tests at
    entry (Hopc's "two-version" design).
  - ICs, unboxed integers.

  ICFP'21: standard suites favour the JITs; on a diverse "new" suite the AOT compiler "reaches
  competitive speeds and consumes significantly less memory". *Sealed classes* (ECOOP 2022): +19% on
  average, +56% at best, from fixed class layouts. Poirier/Rohou/Serrano (Programming 2025) removed up
  to two memory accesses per IC hit via dynamic binary modification: **no measurable speedup**.
* **Static Basic Block Versioning** (Melançon/Feeley/Serrano, ECOOP 2024; AOT, Scheme): version limit
  2 removes 54%/62% of dynamic type tests and runs about 10% faster, with little impact on code size or
  compile time. JIT predecessor LBBV (Chevalier-Boisvert/Feeley, ECOOP 2015/2016, Higgs JS VM): 94.3%
  of type tests removed.
* **SpiderMonkey Warp** (Firefox 83). Replaced global hybrid Type Inference (Hackett & Guo, PLDI 2012:
  "up to 50%" at the time) with **transpiling CacheIR IC stubs into MIR**: Google Docs load about 20%
  faster, Speedometer 10–12%; some Octane/Kraken regressions. Lesson: IC state is the feedback that
  matters, and global type inference costs more than it gains. That favours P1 over P4's
  "flow-based type inference".
* **V8 Sparkplug** (non-optimizing baseline compiler, one pass from bytecode with IC calls): JetStream
  +45% and Speedometer +41% over Ignition; 5–15% real world. **Maglev** (fast SSA optimizing JIT on
  feedback, CheckMap + LoadField, "known node info" to drop repeated checks, representation selection
  for phis, deopt): compiles about 10x slower than Sparkplug and 10x faster than TurboFan; JetStream
  +8.2%, Speedometer +6%, energy −10% on Speedometer. **jitless V8**: Speedometer 2.0 about 40% slower
  (half from no optimizing compiler, half regexp interpreter), Web Tooling 80% slower, a YouTube TV
  session only 6% slower. Interpreter or baseline code is often "good enough" off the hot loops.
* **weval / JS→Wasm AOT (Fallin, 2024; PLDI 2025).** SpiderMonkey's interpreter is partially evaluated
  into per-function code, with a *pre-collected corpus of IC stub bodies* compiled ahead of time.
  3–5x over the generic interpreter (Richards 4.39x, RegExp 1.70x); interpreter-only weval 1.58x on
  Octane. This is baseline-tier AOT, the level Luminous is at.
* **GraalVM.** native-image PGO builds an instrumented image, runs a workload and rebuilds; it is
  closed-world Java, with guarded devirtualization and generic fallback, without deopt. For guest JS,
  Truffle's **Auxiliary Engine Caching** persists ASTs, profiles *and optimized speculative machine
  code* after a training run, but keeps runtime deopt. Its docs note that code shared across contexts
  "does not allow for speculation on the identity of runtime values". Same lesson for us: speculate on
  *code identity* and *learned shapes*, not on object pointers from a training run.
* **HHVM Jump-Start** (CGO 2021). Profiles from seeder servers feed the optimizing JIT on fresh
  servers: 54.9% less warmup capacity loss and **+5.4% steady state**. Profiles from a training
  population can beat in-process profiles.
* **Porffor.** 100% AOT JS→C via its own IR. Its README says it is slower than JIT engines by default
  and catches up only with typed input. No published numbers.
* **Dart AOT, Java native-image.** Closed-world type-flow analysis gives devirtualization and unboxing
  without deopt. This works for *sound* or closed languages; for JS the open dynamic object model
  limits it (TAJS/SAFE-style analyses do not scale precisely to framework code). Treat static
  inference as a *complement* that finds the easy monomorphic cases (P4), not the main engine.

---

## 3. Luminous today (what the code does)

* **Untyped binary ops** (`LUM/crates/luminous-codegen/src/lower.rs:6293-6416`, `int_fast_path`
  `:6246`). Every op emits all of:
  - an int32 test (xor/or of tags), overflow check, re-box;
  - a float/float path;
  - a mixed-number path;
  - a cold `JS_AddValues` / `JS_BinaryOperator` call.

  The result joins as (boxed JSValue, shadow f64, known flag). No profile, so the next operation
  re-tests tags. `instanceof` goes through generic `JS_BinaryOperator` (`lower.rs:6450`), about 180
  instructions each per CONTEXT.md.
* **Property get** (`prop_get_inner`, `lower.rs:7404-7629`):
  - loads `ic->shape` and compares (shape is *data*, not a constant);
  - loads `ic->slot` and the slot;
  - for prototype kinds: an epoch compare (`js_proto_epoch` vs `ic->epoch`), a refresh helper, and
    getter calls through `lum_call_getter` unless predicted;
  - polymorphic sites get inline probing of `LumIC.poly`;
  - miss: `lum_ic_get_proto`.

  The result is an untyped JSValue joined from 5 or more paths. Since shape and slot are runtime data,
  the compiler cannot CSE checks between two reads of the same object or know the result's type.
* **Calls** (`call_linked`, `lower.rs:5935-6006`) do, in order: tag test, class-id test, load fast
  entry, stack-limit check, **argv spilled to a stack array**, indirect call, then a "declined" check.
  `call_or_inline` (`:4207-4244`) inlines `Predicted` bodies behind `pred_guard` (`:4155`: native-entry
  identity plus parameter-type checks) with a fallback call. Predictions come only from `predict_calls`
  (`LUM/crates/luminous-front/src/ir.rs:2824`), which knows `this` of class methods, locals holding
  object literals, and annotation hints (`expr_hint` / `infer_hints`, `ir.rs:2594-2634`).
* **Existing AOT speculation**, all keyed on annotation-derived `Hint`s (`ir.rs:264-273`); pipeline at
  `LUM/crates/luminous-front/src/check.rs:402-413`:
  - `specialize_fields` (`ir.rs:3056`): `ShapeGet`/`ShapeSet` at fixed slots against
    `lum_record_shapes`, learned at runtime.
  - `inline_calls` (`ir.rs:2467`).
  - `virtualize_instances` (`ir.rs:3866`): scalar replacement with "materialization, as
    deoptimization does".
  - `speculate_numbers` (`spec.rs:1-27`): region copy behind an entry guard. Valid because "nothing in
    the copy can run code".

  **In untyped node_modules code these mostly do nothing for lack of hints.** That is the core of the
  3x gap.

---

## 4. Proposals (ranked)

### P1. Profile-guided specialization: "Warp in the build step" (do first)

**What.**
1. **Instrumented build** (`beyond build --profile-gen`): the same code, plus each `LumIC` and each
   call site dumps its state at exit or periodically, keyed by site id:
   - property sites: shape *descriptors* and hit counts;
   - call sites: callee code identity (native function index or builtin id) and counts;
   - binary ops and heap sites: a small `SpeculatedType`-like bitmask (int32 / double / string / bool /
     undefined-null / object-class).
2. **Shape identity across runs.** A shape pointer means nothing in the next process. Key shapes by
   **descriptor**: prototype identity (class, or the allocation site of the literal/constructor), the
   property-key sequence and flags. At runtime, a table slot per descriptor is filled by the first
   object created with that descriptor (as `lum_record_learn` does). The guard is then
   `obj->shape == table[k]` with a compile-time slot.
3. **Rebuild with profile** (`--profile-use`): convert the profile into the existing IR hints, so the
   existing passes do the work:
   - monomorphic property sites become `ShapeGet`/`ShapeSet` with a constant slot (and a
     `MultiGetByOffset`-like switch for 2–4 shapes);
   - prototype methods and getters seen as constant (epoch-guarded) become `Predicted` with the callee
     body, so getters stop going through `lum_call_getter`;
   - monomorphic and polymorphic call sites become `Predicted` (inline under budget, else a **direct
     call** to `lum_fast_<i>` *with arguments in registers*, skipping the argv spill and the
     re-checks);
   - `instanceof C` with a profiled `C` becomes a constant prototype walk guarded by the epoch;
   - `str.match(re)` with a pristine RegExp gets a direct path like the existing pins.
4. **Fallback = what is emitted today** (IC + generic). A wrong or stale profile costs only the guard.

**Expected gain.** Targets the CONTEXT rows "property get 7.5k", "calls into C builtins 4.9k",
"instanceof 2.2k", a good part of "compiled native code 13.5k" (call sequences, IC path selection) and
part of "regexp 2.0k". **15–25k of ~69k instr/req for Hono.** This assumes, as JSC's numbers suggest,
that most framework sites are monomorphic. Measure that first: dump `LumIC` states after a Hono run and
count mono/poly/mega sites (one day of work, sizes the whole project).

**Difficulty.** Medium. The IR nodes, guards and inliner exist. New work: profile dump/load, descriptor
keys, mapping profile site ids to IR sites stably across builds (hash of module path + span), and a
register-argument direct-call convention.

**Risks.**
- Correctness: low, everything is guarded with the existing generic path as fallback.
- Profile staleness: affects performance only.
- Code size: grows with inlining. Cap per function and only inline sites above a hotness threshold.
- Compile time: modest (training run + second build).
- Spec: inlined getters must keep `this` and exception semantics; a prototype-constant assumption must
  be re-validated after any call inside the inlined region (epoch check), see P2.

### P2. Two-version hot functions with "static OSR" and profile-seeded type propagation

**What.** For the hottest N functions (by training-run instruction share, e.g. covering 90% of
compiled-code time), emit inside the same native function:

* a **fast version** compiled under speculation:
  - heap-site predictions from the profile, propagated as in `DFGPredictionPropagationPhase` (only
    loads, call results and parameters need profiles);
  - shape checks as explicit nodes, CSE'd and hoisted (TypeCheckHoisting at the entry for parameters);
  - unboxed int32/double/bool locals, StringIdent compares;
* a **generic version**: today's code.

Each failed check in the fast version branches to an **exit block** that:
1. boxes live unboxed values;
2. materializes virtual objects (reusing `virtualize_instances`' materialization);
3. jumps to the **corresponding block of the generic version**.

The generic version never jumps back, so fast-path types are never merged away. This is OSR exit
compiled ahead of time, without its hard parts:
- no interpreter frames;
- no stack maps (conservative scanning);
- exit and target in one LLVM/Cranelift function, so live values pass as block arguments;
- inlined callees exit into the generic copy of the inlined region within the caller, so no frame
  reification.

Exits are allowed only at "exitOK" points (before an effect, as DFG's `origin.exitOK`). After effectful
calls, re-validate shape facts by re-checking the shape pointer, and prototype facts with one
`js_proto_epoch` compare: the AOT `InvalidationPoint`. A per-function exit counter can flip a sticky
"generic-only" flag at entry (the AOT analogue of jettison) and is reported to the next build.

A cheaper first step: **entry-dispatched two-version** (Hopc style; JSC TypeCheckHoisting at
`SetArgument`). Check parameter shapes and types once at entry and run a fully specialized body.
Inside, any failed guard still falls back locally (a diamond). Good for small leaf helpers and
callbacks.

**Expected gain.** Attacks the "compiled code is 5.7x JSC's JIT code" item: tag-check chains, the 3–4
path joins per op, spills from wide joins. Plausibly halves compiled-code instructions on hot paths.
SBBV (version limit 2) removed 54–62% of type tests for about 10% time, and LBBV removed 94%. Also makes
P1's constant slots CSE-able across a function.

**Difficulty.** High: versioning at MIR level, mapping between versions, exit-state construction,
interaction with async functions and generators (whose state machines `lower.rs` already builds;
exclude them at first, as `spec.rs` does), and testing (an exit fuzzer like JSC's `DFGOSRExitFuzz`:
force random exits and compare results).

**Risks.**
- Correctness of exit states (side effects must commit exactly once): mitigate with exitOK discipline
  and fuzzing.
- Code size: up to 2x on hot functions only.
- LLVM compile time.

### P3. Whole-program allocation-site shapes, inline allocation, escape analysis

**What.**
- From every constructor, class field initializer and object literal in the bundle (node_modules
  included), compute the property-key sequence an allocation site's objects get by the end of
  construction. The training profile covers properties added *after* construction (CONTEXT: 8
  properties/request added after creation via `add_property`).
- Create the final shape once (lazily, per site) and allocate objects directly with it and enough
  slots. Initialize slots inline instead of `JS_NewObjectProtoClass` (~250 instr) followed by
  transitions. V8 does this with slack tracking, JSC with inferred inline capacity.
- Object literals already go through `lum_new_object` with an IC. Extend this to `new C()` of
  interpreted or compiled classes and to the request-scoped objects frameworks create.
- Extend `virtualize_instances` (`ir.rs:3866`) to profile-identified non-escaping temporaries
  (options bags, `{done, value}`, destructured returns), using P1's inlining to expose them.

**Expected gain.** Object creation 8.4k → about 2k; property set 1.7k → about 0.3k; less GC/allocation
(9.6k) when objects are sunk. **About 5–10k instr/req.**

**Difficulty.** Medium. **Risk.** Low: shapes are still checked at use, and a "predicted" final shape
only pre-sizes the object. The spec issue is property *order*: objects must still enumerate in
insertion order. Pre-creating a shape is only valid if the keys are added in that order, so allocate
with the *construction-time* shape and pre-reserve slots, rather than adding keys early.

### P4. Build-time devirtualization and lightweight static inference (enabler)

**What.** With the whole bundle visible:
- resolve ESM imports and exports that are never reassigned to their definitions (ESM bindings are
  immutable to importers; namespace objects are frozen);
- class-hierarchy analysis over top-level classes;
- `const` function bindings;
- return-type summaries for small functions.

Monomorphic calls become direct calls with no guard where provable, and `predict_calls` gets hints
without annotations. Keep the inference *local and cheap* (Warp's lesson; TAJS/SAFE-precision
whole-program analysis does not scale to framework code). CommonJS `module.exports` objects are
mutable, so guard them (identity check plus fallback).

**Expected gain.** 2–5k directly (call overhead). Its main value is giving P1 and P2 coverage on code
that the training run did not reach. **Difficulty.** Low–medium. **Risk.** Low, if every
non-provable case keeps a guard.

### Recommended order

1. **Measure:** dump `LumIC` and call-site states after a Hono/Elysia run (mono/poly/mega ratio, top
   sites by count) and measure cycles alongside callgrind.
2. **P1** with descriptor-keyed shapes and direct register-argument calls.
3. **P3** (independent of P1, and P1's inlining helps it).
4. **P4**, opportunistic.
5. **P2**, starting with entry-dispatch versions of hot leaf functions, then static-OSR exits once the
   exit-state machinery and a fuzzer exist.

---

## Sources

- JSC source (WebKit, local clone): file:line references above.
- Luminous source: `LUM/crates/luminous-codegen/src/lower.rs`, `LUM/crates/luminous-front/src/{ir,check,spec}.rs`, `LUM/runtime/luminous_rt.h`.
- V8 Maglev: https://v8.dev/blog/maglev (read via github.com/v8/v8.dev `src/blog/maglev.md`); holiday-season-2023 recap for JetStream +8.2% / Speedometer +6%: https://v8.dev/blog/holiday-season-2023
- V8 Sparkplug: https://v8.dev/blog/sparkplug ; V8 jitless: https://v8.dev/blog/jitless
- Static Hermes benchmark: https://github.com/KusStar/benchmark-static-hermes ; Mikov, "How to speed up a micro-benchmark 300x": https://tmikov.blogspot.com/2023/09/how-to-speed-up-micro-benchmark-300x.html ; Static Hermes talks: https://speakerdeck.com/tmikov2023/static-hermes-react-native-eu-2023-announcement , https://speakerdeck.com/tmikov2023/compiling-a-real-world-cli-tool-to-native-with-static-hermes
- Serrano, JavaScript AOT compilation (DLS 2018): https://dl.acm.org/doi/10.1145/3276945.3276950 ; Of JavaScript AOT Compilation Performance (ICFP 2021): https://dl.acm.org/doi/10.1145/3473575 ; JavaScript Sealed Classes (ECOOP 2022): https://drops.dagstuhl.de/entities/document/10.4230/LIPIcs.ECOOP.2022.24
- Poirier, Rohou, Serrano, An Attempt to Catch Up with JIT Compilers: The False Lead of Optimizing Inline Caches (2025): https://arxiv.org/abs/2502.20547
- Melançon, Feeley, Serrano, Static Basic Block Versioning (ECOOP 2024): https://drops.dagstuhl.de/entities/document/10.4230/LIPIcs.ECOOP.2024.28
- Chevalier-Boisvert, Feeley, Interprocedural Type Specialization of JavaScript Programs Without Type Analysis (ECOOP 2016): https://arxiv.org/abs/1511.02956
- Mozilla Warp (Firefox 83): https://hacks.mozilla.org/?p=46699 ; https://www.phoronix.com/news/Warp-Is-Ready-For-Firefox-83
- Hackett, Guo, Fast and precise hybrid type inference for JavaScript (PLDI 2012): https://wiki.mozilla.org/TypeInference
- Fallin, Compilation of JavaScript to Wasm, Part 2: AOT vs JIT: https://cfallin.org/blog/2024/08/27/aot-js/ ; weval PLDI 2025: https://cfallin.org/pubs/pldi2025_weval.pdf ; PBL: https://cfallin.org/blog/2023/10/11/spidermonkey-pbl/
- GraalVM native-image PGO: https://www.graalvm.org/21.3/reference-manual/native-image/PGO/ ; Truffle Auxiliary Engine Caching: https://www.graalvm.org/dev/graalvm-as-a-platform/language-implementation-framework/AuxiliaryEngineCachingEnterprise/
- HHVM Jump-Start (CGO 2021): https://engineering.fb.com/2021/03/03/developer-tools/hhvm-jump-start/
- Porffor: https://github.com/CanadaHonk/porffor

Note: direct fetches of most non-GitHub hosts were blocked in this session. Numbers for Warp, SBBV,
Sealed Classes, weval, HHVM and Hackett & Guo come from search-engine summaries of those pages and
abstracts, not from reading the full papers. Maglev, Sparkplug, jitless and the Static Hermes benchmark
table were read from their GitHub sources.
