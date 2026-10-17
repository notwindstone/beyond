# Gap map

Instructions per request of a server under callgrind, grouped by feature,
as in section 1 of [docs/direction.md](../../docs/direction.md).

    # Beyond (LLVM, without AVX-512, which valgrind cannot run)
    beyond build --backend llvm --march x86-64-v3 bench/hono/app.ts -o /tmp/hono
    WARM=30000 bench/gap/cgserve.sh /tmp/cg.hono 10000 /users/42 /tmp/hono
    bench/gap/cgfeat.py /tmp/cg.hono.1 10000

    # Bun: its symbolized build (bun-linux-x64-profile.zip of the release)
    sed 's/Beyond\.serve/Bun.serve/' bench/hono/app.ts > bench/hono/app.bun.ts
    BUN_OPTIONS= WARM=30000 bench/gap/cgserve.sh /tmp/cg.bun 10000 /users/42 \
        bun-profile bench/hono/app.bun.ts
    bench/gap/cgbun.py /tmp/cg.bun.1 10000

`cgserve.sh OUT N PATH cmd...` starts the server under callgrind, sends
`WARM` requests (default 2,000; Bun needs ~30,000 before its JIT stops
compiling), zeroes the counters, sends N requests to PATH with oha and
dumps (`OUT.1`).

- `cgfeat.py FILE REQUESTS [-v FEATURE]`: Beyond, per feature; `-v`
  lists a feature's functions.
- `cgbun.py FILE REQUESTS [-v CATEGORY]`: Bun, per category.
- `cgexcl.py FILE [N] [--classify]`: exclusive cost per function.
- `cgcallers.py FILE FUNCTION`: callers of a function, inclusive.
- `cgedges.py FILE REQUESTS CALLER_REGEX`: what calls out of a set of
  functions (e.g. compiled code, `'lum_(fn|fast)_\d+'`) cost, by callee.
