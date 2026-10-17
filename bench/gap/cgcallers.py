#!/usr/bin/env python3
"""Callers of a function (inclusive cost of the calls) in a callgrind file.
Usage: cgcallers.py FILE FUNCTION_SUBSTRING"""
import re, sys, collections
path, target = sys.argv[1], sys.argv[2]
names = {}
def resolve(s):
    m = re.match(r'\((\d+)\)(?: (.*))?', s)
    if not m: return s
    if m.group(2) is not None: names[m.group(1)] = m.group(2)
    return names.get(m.group(1), '?')
callers = collections.Counter(); counts = collections.Counter()
cur = None; callee = None; pending = None
for line in open(path, errors='replace'):
    line = line.rstrip('\n')
    if line.startswith('fn='): cur = resolve(line[3:]); continue
    if line.startswith('cfn='): callee = resolve(line[4:]); continue
    if line.startswith('calls='): pending = (callee, int(line[6:].split()[0])); continue
    if pending and line and (line[0].isdigit() or line[0] in '+-*'):
        c, n = pending; pending = None
        if target in (c or ''):
            parts = line.split()
            callers[cur] += int(parts[1]) if len(parts) > 1 else 0
            counts[cur] += n
for fn, c in callers.most_common(15):
    print(f"{c:14,d}  {counts[fn]:9d} calls  {fn}")
