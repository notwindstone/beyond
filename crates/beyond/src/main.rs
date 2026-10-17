//! `beyond build` / `beyond run`: a program compiled by Luminous with
//! Beyond's runtime: its modules (lib/, `beyond:*`), its globals (the
//! prelude lib/globals.ts), and its native core (beyond-rt: the event loop,
//! timers, the HTTP server), linked in.

use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{Context, Result, bail};
use clap::{Parser, Subcommand};
use luminous_cli::{Backend, BuildOpts, EmbedOpts};

#[derive(Parser)]
#[command(name = "beyond", about = "A JavaScript and TypeScript runtime built on Luminous")]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Compile a program to a native executable.
    Build {
        input: PathBuf,
        #[arg(short, long)]
        output: Option<PathBuf>,
        #[command(flatten)]
        opts: BuildOpts,
    },
    /// Compile and run a program.
    Run {
        input: PathBuf,
        #[command(flatten)]
        opts: BuildOpts,
        /// Arguments passed to the program.
        #[arg(last = true)]
        args: Vec<String>,
    },
}

/// Beyond's source tree (its lib/ modules).
fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

/// lib/globals.ts's globals: each module of lib/ and those it exports.
const GLOBALS: &[(&str, &[&str])] = &[
    ("console", &["console"]),
    ("timers", &["setTimeout", "setInterval", "clearTimeout", "clearInterval"]),
    ("encoding", &["TextEncoder", "TextDecoder", "TextEncoderStream", "TextDecoderStream"]),
    ("events", &["Event", "CustomEvent", "EventTarget", "AbortController", "AbortSignal", "reportError"]),
    ("crypto", &["Crypto", "crypto"]),
    ("clone", &["structuredClone"]),
    ("url", &["URL", "URLSearchParams"]),
    ("blob", &["Blob", "File"]),
    ("formdata", &["FormData"]),
    ("fetch", &["Headers", "Request", "Response"]),
    ("client", &["fetch"]),
    (
        "streams",
        &[
            "ReadableStream",
            "ReadableStreamDefaultReader",
            "ReadableStreamDefaultController",
            "ReadableStreamBYOBReader",
            "ReadableStreamBYOBRequest",
            "ReadableByteStreamController",
            "WritableStream",
            "WritableStreamDefaultWriter",
            "WritableStreamDefaultController",
            "TransformStream",
            "TransformStreamDefaultController",
            "ByteLengthQueuingStrategy",
            "CountQueuingStrategy",
        ],
    ),
];

/// What Beyond adds to a program.
fn embed(opts: &mut BuildOpts) -> Result<()> {
    let lib = root().join("lib");
    // The native core, built next to this executable (the same target
    // directory).
    let exe = std::env::current_exe()?;
    let rt = exe.parent().unwrap().join("libbeyond_rt.a");
    if !rt.exists() {
        bail!("{} not found (build the workspace: cargo build)", rt.display());
    }
    let e: &mut EmbedOpts = &mut opts.embed;
    e.preludes.insert(0, lib.join("globals.ts"));
    e.module_dirs.push(("beyond:".into(), lib));
    e.c_modules.push(("beyond:native".into(), "js_init_module_beyond".into()));
    e.init_fn = Some("beyond_init".into());
    e.loop_fn = Some("beyond_loop".into());
    e.link.push(rt.display().to_string());
    // The globals the prelude defines from lib/'s modules: the program's
    // references to them are those modules' bindings (`new Response()` a
    // native constructor call).
    for (spec, names) in GLOBALS {
        for name in *names {
            e.globals.push((name.to_string(), format!("beyond:{spec}")));
        }
    }
    // (What the Rust standard library, uWebSockets, zlib, Brotli and OpenSSL
    // need.)
    for l in ["-lstdc++", "-lz", "-lbrotlidec", "-lssl", "-lcrypto", "-lgcc_s", "-lutil", "-lrt", "-lpthread", "-lm", "-ldl"] {
        e.link.push(l.into());
    }
    Ok(())
}

/// `beyond build`'s backend when none is chosen (`--backend`,
/// $LUMINOUS_BACKEND): LLVM, whose code runs faster, if its clang is there,
/// else Cranelift. (`beyond run` keeps Cranelift's, which compiles faster.)
fn prefer_llvm(opts: &mut BuildOpts) {
    if opts.backend.is_some() || std::env::var("LUMINOUS_BACKEND").is_ok_and(|b| !b.is_empty()) {
        return;
    }
    let clang = opts.clang.clone().or_else(|| std::env::var_os("LUMINOUS_CLANG").map(PathBuf::from));
    let clang = clang.unwrap_or_else(|| "clang".into());
    if Command::new(&clang).arg("--version").output().is_ok_and(|o| o.status.success()) {
        opts.backend = Some(Backend::Llvm);
    }
}

fn main() {
    if let Err(e) = real_main() {
        let msg = format!("{e:#}");
        if msg.contains('\n') {
            eprintln!("{msg}")
        } else {
            eprintln!("beyond: {msg}")
        }
        std::process::exit(1);
    }
}

fn real_main() -> Result<()> {
    let fopts = luminous_front::Options { int_wrapping: true };
    match Cli::parse().cmd {
        Cmd::Build { input, output, mut opts } => {
            embed(&mut opts)?;
            prefer_llvm(&mut opts);
            let output = output.unwrap_or_else(|| input.with_extension(""));
            luminous_cli::build(&input, &output, &opts, &fopts)
        }
        Cmd::Run { input, mut opts, args } => {
            embed(&mut opts)?;
            let dir = luminous_cli::tempdir()?;
            let exe = dir.join("a.out");
            let r = luminous_cli::build(&input, &exe, &opts, &fopts).and_then(|()| {
                let status = Command::new(&exe).args(&args).status().context("running the program")?;
                Ok(status.code().unwrap_or(1))
            });
            let _ = std::fs::remove_dir_all(&dir);
            std::process::exit(r?);
        }
    }
}
