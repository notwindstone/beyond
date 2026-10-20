#!/usr/bin/env python3
"""Runs Node.js's tests (Bun's copy: test/js/node/test/parallel in Bun's
repository) with the runner (runner.ts, built with `beyond build`), each in
its own process, and reports which pass: exit status 0 within the time
limit, as Bun's runner counts them (a test that skips itself passes).

    run.py RUNNER [--bun DIR] [--jobs N] [--timeout S] [--out FILE] [FILTER...]

FILTER: substrings of test names (test-path-, test-events-); all by default.
The results (one JSON object per test: name, status, seconds, first line of
the error) go to --out (default: nodejs-results.jsonl in the current
directory); a summary per module goes to stdout.
"""

import argparse
import concurrent.futures
import json
import os
import re
import subprocess
import sys
import threading
import time

# (Each worker its own TEST_THREAD_ID: tests running at once get their own
# temporary directory, .tmp.N, instead of wiping each other's.)
_ids = threading.local()
_next_id = iter(range(1 << 30))
_id_lock = threading.Lock()


def thread_id():
    if not hasattr(_ids, "n"):
        with _id_lock:
            _ids.n = next(_next_id)
    return _ids.n


# The flags of a test's `// Flags:` line that Bun's runner passes on the
# command line (scripts/runner.node.ts, resolutionGatingFlags): Node's
# common module handles the others, in the test's process or a child.
GATING_FLAGS = {"--expose-internals", "--experimental-quic", "--experimental-stream-iter", "--no-warnings"}


def test_flags(test):
    try:
        with open(test, encoding="utf-8", errors="replace") as f:
            m = re.search(r"^// Flags:[^\S\r\n]+(--[^\r\n]*)$", f.read(), re.M)
    except OSError:
        return []
    return [f for f in m.group(1).split() if f.split("=")[0] in GATING_FLAGS] if m else []


def run_one(runner, test, cwd, timeout):
    start = time.time()
    try:
        p = subprocess.run(
            [runner, *test_flags(test), test],
            cwd=cwd,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout,
            env={**os.environ, "NODE_TEST_DIR": cwd, "TEST_THREAD_ID": str(thread_id())},
        )
        status = "pass" if p.returncode == 0 else "fail"
        err = p.stderr.decode(errors="replace").strip()
        first = next((l for l in err.splitlines() if l.strip()), "")
        if status == "fail" and not first:
            first = f"exit {p.returncode}"
        if status == "pass" and "# Skipped" in p.stdout.decode(errors="replace"):
            status = "skip"
    except subprocess.TimeoutExpired:
        status, first = "timeout", ""
    return {"name": os.path.basename(test), "status": status, "seconds": round(time.time() - start, 2), "error": first[:300]}


def module_of(name):
    m = re.match(r"test-([a-z0-9]+)", name)
    return m.group(1) if m else name


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("runner")
    ap.add_argument("--bun", default=os.environ.get("BUN_DIR", "/home/user/bun"))
    ap.add_argument("--jobs", type=int, default=os.cpu_count() or 4)
    ap.add_argument("--timeout", type=float, default=30)
    ap.add_argument("--out", default="nodejs-results.jsonl")
    ap.add_argument("filters", nargs="*")
    a = ap.parse_args()

    root = os.path.join(a.bun, "test/js/node/test")
    parallel = os.path.join(root, "parallel")
    tests = sorted(
        f for f in os.listdir(parallel) if f.startswith("test-") and (f.endswith(".js") or f.endswith(".mjs") or f.endswith(".cjs"))
    )
    if a.filters:
        tests = [t for t in tests if any(f in t for f in a.filters)]
    runner = os.path.abspath(a.runner)

    results = []
    with concurrent.futures.ThreadPoolExecutor(a.jobs) as pool:
        futures = [pool.submit(run_one, runner, os.path.join(parallel, t), root, a.timeout) for t in tests]
        for i, f in enumerate(concurrent.futures.as_completed(futures), 1):
            results.append(f.result())
            if i % 200 == 0:
                print(f"{i}/{len(tests)}", file=sys.stderr)
    results.sort(key=lambda r: r["name"])
    with open(a.out, "w") as out:
        for r in results:
            out.write(json.dumps(r) + "\n")

    by = {}
    for r in results:
        s = by.setdefault(module_of(r["name"]), {"pass": 0, "skip": 0, "fail": 0, "timeout": 0})
        s[r["status"]] += 1
    total = {k: sum(s[k] for s in by.values()) for k in ("pass", "skip", "fail", "timeout")}
    for m, s in sorted(by.items(), key=lambda kv: -sum(kv[1].values())):
        n = sum(s.values())
        print(f"{m:24} {s['pass']:5} pass {s['skip']:4} skip {s['fail']:5} fail {s['timeout']:4} timeout  / {n}")
    n = len(results)
    print(f"{'total':24} {total['pass']:5} pass {total['skip']:4} skip {total['fail']:5} fail {total['timeout']:4} timeout  / {n}")


if __name__ == "__main__":
    main()
