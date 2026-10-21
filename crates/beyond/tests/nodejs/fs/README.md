# node:fs against Bun

- `compare/` (sync, errors, async, classes, streams, rw) and `watch/`
  (fs.watch event streams, aborts, FileHandle writes): programs whose
  output must be the same under Bun and Beyond. `./run.sh compare/sync.ts`
  (add `native` for a natively compiled build); `compare/h.ts` is their
  shared harness.
- `bench/`: run under `bun` and a native `beyond build`, each case the
  best of five runs. `bench.ts`: ns per call of the common synchronous
  calls; `async.ts`: the callback and promise forms, many calls in
  flight; `tree.ts`: streams of 1 to 100 MB, recursive `readdir`, and
  `cp` and `rm` of a tree of 2,000 files; `big.ts N MODE`: reading 1 MB N
  times (`utf8`, `latin1` or a buffer).
- Node's own tests: `run.py` (one directory up) with the runner built by
  `beyond build`, which imports `.mjs` tests itself. `mjs2cjs.py SRC DST`
  converts them to CommonJS (from before it did); `runconv.py RUNNER DIR
  [FILTER...]` runs such a converted copy of Bun's `test/js/node/test`.
