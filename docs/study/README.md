# Study notes

Research notes behind [../direction.md](../direction.md), written in
October 2026 from the sources of WebKit (`75bd0aee`, 2026-10-17:
`Source/JavaScriptCore` and `Source/WTF`) and Bun (`017b2439a7`,
2026-10-16), and the callgrind profiles of section 1 of that document.
References to files are to those revisions; numbers marked as estimates
were not measured.

- [A-object-model.md](A-object-model.md): structures, inline caches
  (including the data-only "handler" caches), the megamorphic cache,
  watchpoints, `instanceof`, getters.
- [B-allocation-gc.md](B-allocation-gc.md): allocation fast paths, the
  Riptide collector, conservative scanning and stack clearing, allocation
  sinking, memory per object.
- [C-builtins.md](C-builtins.md): RegExp, strings, promises and
  `await`, arrays and species, JSON and key caches, the per-feature
  watchpoint sets of the global object.
- [D-bun.md](D-bun.md): Bun's layers (now Rust), its class generator, the
  `Bun.serve` request path, event loop, performance history and
  methodology, its JavaScriptCore fork, memory.
- [E-aot-untyped.md](E-aot-untyped.md): what DFG/FTL exploit in untyped
  code, what an ahead-of-time compiler can get, prior art with numbers,
  proposals.
