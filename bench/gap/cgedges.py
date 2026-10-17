#!/usr/bin/env python3
"""Inclusive cost of calls that cross from one set of functions into the rest,
grouped by callee: e.g. what native code spends in engine calls.
Usage: cgedges.py FILE REQUESTS CALLER_REGEX [CALLEE_EXCLUDE_REGEX] [N]"""
import re, sys, collections
path, reqs, cre = sys.argv[1], int(sys.argv[2]), re.compile(sys.argv[3])
xre = re.compile(sys.argv[4]) if len(sys.argv) > 4 and sys.argv[4] else cre
top = int(sys.argv[5]) if len(sys.argv) > 5 else 50
names = {}
def resolve(s):
    m = re.match(r'\((\d+)\)(?: (.*))?', s)
    if not m: return s
    if m.group(2) is not None: names[m.group(1)] = m.group(2)
    return names.get(m.group(1), '?')
inc = collections.Counter(); cnt = collections.Counter()
cur = callee = None; pending = None
for line in open(path, errors='replace'):
    line = line.rstrip('\n')
    if line.startswith('fn='): cur = resolve(line[3:]); continue
    if line.startswith('cfn='): callee = resolve(line[4:]); continue
    if line.startswith('calls='): pending = (callee, int(line[6:].split()[0])); continue
    if pending and line and (line[0].isdigit() or line[0] in '+-*'):
        c, n = pending; pending = None
        if cur and cre.match(cur) and c and not xre.match(c):
            parts = line.split()
            base = re.sub(r"'\d+$", '', c)
            inc[base] += int(parts[1]) if len(parts) > 1 else 0; cnt[base] += n
tot = sum(inc.values())
print(f"{tot/reqs:10,.0f} instr/request in calls out of {sys.argv[3]}")
for fn, c in inc.most_common(top):
    print(f"{c/reqs:10,.0f}  {cnt[fn]/reqs:7.1f}/req  {c/max(cnt[fn],1):7.0f}/call  {fn[:150]}")
