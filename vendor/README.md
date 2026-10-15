# Vendored code

Copied unmodified from [Bun](https://github.com/oven-sh/bun) at commit
`e40a58ad875f91bb95fb05fbd87bd17c6a93566b`:

| here | in Bun | license |
|------|--------|---------|
| `bun-usockets/` | `packages/bun-usockets/` (Bun's fork of uSockets) | Apache 2.0 (`bun-usockets/LICENSE`) |
| `bun-uws/` | `packages/bun-uws/` (Bun's fork of uWebSockets) | Apache 2.0 (`bun-uws/LICENSE`) |
| `uws-capi/libuwsockets.cpp`, `uws-capi/_libusockets.h` | `src/uws_sys/` (Bun's C interface to uWebSockets) | MIT (Bun) |

What Bun's runtime provides to this code (socket event dispatch, locks,
name resolution, the `Date` header, ...) Beyond provides in
`crates/beyond-rt/native/bun_hooks.c`; what it includes from WebKit, mimalloc,
libdeflate and ls-hpack, in `crates/beyond-rt/shim/`. TLS (BoringSSL), HTTP/2
and HTTP/3 are not built yet (`crates/beyond-rt/native/stubs.c`).

From elsewhere, unmodified:

| here | from | license |
|------|------|---------|
| `picohttpparser/` | [h2o/picohttpparser](https://github.com/h2o/picohttpparser) at `465a7ff09fbd3432fe56c673451f5460154d1f07`: `picohttpparser.c`, `picohttpparser.h` | MIT (in the files) |
| `zstd/` | [facebook/zstd](https://github.com/facebook/zstd) v1.5.7 (`f8745da6ff1ad1e7bab384bd1f9d742439278e99`): `zstddeclib.c` (made by `build/single_file_libs/create_single_file_decoder.sh`), `lib/zstd.h`, `lib/zstd_errors.h` | BSD (`zstd/LICENSE`) |

`fetch()`'s client (`crates/beyond-rt/native/client.c`) uses both:
picohttpparser for responses' heads and chunked bodies, zstd for `zstd`
bodies.
