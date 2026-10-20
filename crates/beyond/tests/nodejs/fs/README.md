# node:fs against Bun

- `compare/` (sync, errors, async, classes) and `watch/` (fs.watch event
  streams, aborts, FileHandle writes): programs whose output must be the
  same under Bun and Beyond. `./run.sh compare/sync.ts` (add `native` for a
  natively compiled build); `compare/h.ts` is their shared harness.
- `bench/bench.ts`: ns per call of the common synchronous calls, best of
  five, run under `bun` and a native `beyond build`; `bench/big.ts N MODE`:
  reading 1 MB N times (`utf8`, `latin1` or a buffer).
- `mjs2cjs.py SRC DST`: Node's `.mjs` tests as CommonJS, for the runner,
  which does not load `.mjs` yet; `runconv.py RUNNER DIR [FILTER...]` runs
  such a converted copy of Bun's `test/js/node/test`.
