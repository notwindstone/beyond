#!/usr/bin/env python3
"""Exclusive instruction counts per function from a callgrind file (any
dump, name compression resolved), with the object file. Prints the top N
and, with --classify, totals per category. Usage: cgexcl.py FILE [N] [--classify]"""
import re, sys, collections
path = sys.argv[1]
top = int(sys.argv[2]) if len(sys.argv) > 2 and sys.argv[2].isdigit() else 40
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
    if re.match(r'lum_(fn|fast)_\d+', fn): return 'native code'
    if fn == 'JS_CallInternal' or fn.startswith('JS_CallInternal'): return 'interpreter'
    if 'libc.so' in ob or 'ld-linux' in ob or 'libgcc' in ob or 'libstdc++' in ob or 'libm.so' in ob: return 'libc and system libraries'
    if re.match(r'(js_gc_|mark_children|gc_|js_arena_free|js_free_|free_|js_.*_finalizer|js_gc)', fn): return 'collector and freeing'
    if re.match(r'(us_|_ZN3uWS|_ZN4uWS|uWS|phr_|_ZN6beyond|beyond_|_ZN[0-9]*beyond|simdutf|_ZN7simdutf|bsd_|ssl|BIO_|EVP_)', fn) or 'beyond' in fn: return 'Beyond native runtime (uWS, HTTP, Rust/C)'
    if re.match(r'lum_', fn): return 'Luminous runtime (C)'
    return 'engine (QuickJS C)'
if '--classify' in sys.argv:
    cats = collections.Counter()
    for fn, c in cost.items(): cats[category(fn, fobj.get(fn))] += c
    for k, c in cats.most_common(): print(f"{c:14,d}  {100*c/total:5.1f}%  {k}")
    print(f"{total:14,d}  total")
for fn, c in cost.most_common(top):
    print(f"{c:14,d}  {100*c/total:5.1f}%  {fn}  [{(fobj.get(fn) or '').split('/')[-1]}]")
