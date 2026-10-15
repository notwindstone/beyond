//! Compiles what the static library holds besides Rust: Bun's uSockets,
//! uWebSockets and its C interface, picohttpparser and zstd's decoder
//! (vendor/), Beyond's hooks for them, and the QuickJS bindings (native/),
//! against Luminous's engine headers.

use std::path::{Path, PathBuf};

fn main() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let vendor = root.join("vendor");
    let quickjs = std::env::var_os("BEYOND_QUICKJS_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| vendor.join("luminous/build/quickjs-src"));
    assert!(
        quickjs.join("quickjs.h").exists(),
        "QuickJS-NG headers not found in {} (run vendor/luminous/scripts/build-quickjs.sh, or set BEYOND_QUICKJS_DIR)",
        quickjs.display()
    );
    let shim = Path::new("shim");
    let usockets = vendor.join("bun-usockets/src");

    // (Bun builds this code with clang: it uses clang's nullability qualifiers.)
    let mut c = cc::Build::new();
    c.compiler("clang")
        .opt_level(2)
        .warnings(false)
        .define("LIBUS_USE_EPOLL", None)
        .define("LIBUS_USE_OPENSSL", None)
        .include(shim)
        .include(&usockets)
        .include(vendor.join("picohttpparser"))
        .include(vendor.join("zstd"))
        .include(&quickjs);
    c.file(vendor.join("picohttpparser/picohttpparser.c"));
    c.file(vendor.join("zstd/zstddeclib.c"));
    for f in ["bsd.c", "context.c", "loop.c", "socket.c", "udp.c", "eventing/epoll_kqueue.c"] {
        c.file(usockets.join(f));
    }
    for f in ["native/bun_hooks.c", "native/stubs.c", "native/module.c", "native/server.c", "native/web.c", "native/client.c"] {
        c.file(f);
    }
    c.compile("beyond_c");

    cc::Build::new()
        .cpp(true)
        .compiler("clang++")
        .std("c++20")
        .opt_level(2)
        .warnings(false)
        .define("LIBUS_USE_EPOLL", None)
        .define("LIBUS_USE_OPENSSL", None)
        .include(shim)
        .include(&vendor)
        .include(&usockets)
        .include(vendor.join("uws-capi"))
        .file("native/uws_capi.cpp")
        .compile("beyond_uws");

    for d in ["native", "shim"] {
        println!("cargo:rerun-if-changed={d}");
    }
    println!("cargo:rerun-if-changed={}", vendor.join("bun-usockets").display());
    println!("cargo:rerun-if-changed={}", vendor.join("bun-uws").display());
    println!("cargo:rerun-if-changed={}", vendor.join("uws-capi").display());
    println!("cargo:rerun-if-changed={}", vendor.join("picohttpparser").display());
    println!("cargo:rerun-if-changed={}", vendor.join("zstd").display());
    println!("cargo:rerun-if-env-changed=BEYOND_QUICKJS_DIR");
}
