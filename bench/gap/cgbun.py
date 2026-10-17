#!/usr/bin/env python3
"""Per-category exclusive instruction counts for a callgrind file of Bun's
profile build. Usage: cgbun.py FILE [requests] [-v CATEGORY]"""
import re, sys, collections
path = sys.argv[1]
reqs = int(sys.argv[2]) if len(sys.argv) > 2 and sys.argv[2].isdigit() else 1
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
        if len(parts) > 1 and cur_fn: cost[cur_fn] += int(parts[1])
total = sum(cost.values())
def category(fn, ob):
    ob = ob or ''
    if fn.startswith('0x') or ob.endswith('???'): return 'JIT-compiled JS'
    if fn.startswith('__memset'): return 'memset'
    if 'libc.so' in ob or 'ld-linux' in ob or 'libgcc' in ob or 'libstdc++' in ob or 'libm.so' in ob: return 'libc'
    if re.match(r'(JSC::(DFG|B3|FTL|Wasm|Yarr::YarrJIT|JIT|Baseline|LinkBuffer|CCallHelpers|MacroAssembler|Air)|WTF::(SSACalculator|Dominators|NaturalLoops|appendNodeOrder|BackwardsDominators|SingleRootGraph|IndexSet|IndexMap|BitVector|ScopedLambda))', fn) or 'JSC::DFG' in fn or 'JSC::B3' in fn or 'JSC::FTL' in fn or 'JITPlan' in fn or 'JITWorklist' in fn or fn.startswith('JSC::JIT'): return 'JIT compiler'
    if re.match(r'(mi_|_mi_|malloc|free$|calloc|realloc|bmalloc|pas_|libpas|WTF::fastMalloc|WTF::fastFree|bmalloc_)', fn): return 'malloc'
    if re.search(r'(JSC::Heap::|JSC::MarkedBlock|JSC::Collector|ConservativeRoots|SlotVisitor|MarkedSpace|JSC::GC|sanitizeStack|IsoSubspace|BlockDirectory|LocalAllocator|JSC::Subspace|JSC::CompleteSubspace|JSC::PreciseAllocation|MarkingConstraint|JSC::GCActivity|JSC::FreeList|EdenGC|JSC::HeapCell|JSC::WeakSet|JSC::WeakBlock|JSC::Allocator|JSC::JSRunLoopTimer|JSC::IncrementalSweeper|JSC::GCDeferral)', fn): return 'GC and allocation'
    if re.match(r'(uWS::|us_|bsd_|Bun__|Bun::|WebCore::|<?bun_|Zig::|zig|_ZN|core::|alloc::|std::|simdutf|<std|<core|<alloc|<&)', fn) or 'bun_runtime' in fn or 'bun_core' in fn: return 'Bun runtime (uWS, WebCore, Rust)'
    if re.match(r'(JSC::|WTF::|operation|llint_|vmEntry|op_|slow_path|ipint|js_|ctiMasm|.*Thunk|jsc_)', fn) or 'JSC::' in fn or 'WTF::' in fn: return 'JSC runtime (C++, LLInt)'
    return 'other'
cats = collections.Counter(); bycat = collections.defaultdict(collections.Counter)
for fn, c in cost.items():
    k = category(fn, fobj.get(fn)); cats[k] += c; bycat[k][fn] += c
for k, c in cats.most_common(): print(f"{c/reqs:12,.0f}  {100*c/total:5.1f}%  {k}")
print(f"{total/reqs:12,.0f}  total per request")
if show:
    for fn, c in bycat[show].most_common(60): print(f"{c/reqs:10,.0f}  {fn[:170]}")
