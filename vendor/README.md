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
