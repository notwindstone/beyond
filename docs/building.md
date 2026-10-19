# Building

```sh
scripts/setup.sh          # Luminous (a submodule) and its engine
cargo build --release
target/release/beyond run app.ts
```

`beyond build app.ts -o app` writes the executable, its native code
compiled by LLVM (clang's optimizer: a minute or two for a program with
Beyond's library, its code faster) when clang is there, else by Cranelift;
`beyond run` compiles with Cranelift (seconds); `--backend` picks either.
`--no-native` interprets the whole program, compiling only to bytecode:
what suits a build script, whose time is spent in the bundler (Elysia's,
with its packages: 3 s to compile, against minutes natively).
`cargo build` also builds `libbeyond_build.so` (`crates/beyond-build`, the
bundler and the TypeScript transpiler behind `Beyond.build` and `import()`
at run time), which programs load from next to `beyond` when they need it.
Needs clang (Bun's networking code uses its extensions), zlib, brotli's
decoder (libbrotlidec) and OpenSSL 3 (libssl, libcrypto).
