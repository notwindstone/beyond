import subprocess, os, sys, json, concurrent.futures
runner, d = sys.argv[1], sys.argv[2]
tests = sorted(f for f in os.listdir(os.path.join(d, "parallel")) if f.endswith(".js") and (len(sys.argv) < 4 or any(x in f for x in sys.argv[3:])))
def one(i_t):
    i, t = i_t
    env = {**os.environ, "NODE_TEST_DIR": d, "TEST_THREAD_ID": str(i % 3 + 1)}
    try:
        p = subprocess.run([runner, os.path.join(d, "parallel", t)], cwd=d, env=env, stdin=subprocess.DEVNULL, capture_output=True, timeout=30)
        err = p.stderr.decode(errors="replace").strip()
        first = next((l for l in err.splitlines() if l.strip()), "")
        return t, ("pass" if p.returncode == 0 else "fail"), first[:200]
    except subprocess.TimeoutExpired:
        return t, "timeout", ""
with concurrent.futures.ThreadPoolExecutor(3) as ex:
    res = list(ex.map(one, enumerate(tests)))
for t, s, e in res:
    if s != "pass": print(s, t, "|", e)
print("pass", sum(1 for r in res if r[1] == "pass"), "/", len(res))
