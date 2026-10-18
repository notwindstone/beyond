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
Needs clang (Bun's networking code uses its extensions), zlib, brotli's
decoder (libbrotlidec) and OpenSSL 3 (libssl, libcrypto).
