#!/usr/bin/env python3
"""Calls between functions matching CALLER_REGEX and CALLEE_REGEX, with
counts and inclusive costs per request (callgrind file).
Usage: cgcallees.py FILE REQUESTS CALLER_REGEX CALLEE_REGEX [N]"""
import re, sys, collections
path, reqs = sys.argv[1], int(sys.argv[2])
cre, ere = re.compile(sys.argv[3]), re.compile(sys.argv[4])
top = int(sys.argv[5]) if len(sys.argv) > 5 else 40
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
        if cur and c and cre.search(cur) and ere.search(c):
            parts = line.split()
            k = (re.sub(r"'\d+$", '', cur), re.sub(r"'\d+$", '', c))
            inc[k] += int(parts[1]) if len(parts) > 1 else 0; cnt[k] += n
for (a, b), c in inc.most_common(top):
    print(f"{c/reqs:9,.0f}  {cnt[(a,b)]/reqs:6.1f}/req  {c/max(cnt[(a,b)],1):6.0f}/call  {a[:60]} -> {b[:60]}")
