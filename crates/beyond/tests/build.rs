//! Beyond.build (Bun.build) and the Node.js modules it uses: programs whose
//! output is Bun's (tests/build.out and tests/node/node.out, made with
//! `bun x.ts`).

mod common;

use std::process::Command;

/// Runs tests/`path`.ts in directory `dir` (of tests/) with `args`: its
/// standard output, its standard error and whether it succeeded.
fn run(path: &str, dir: &str, args: &[&str]) -> (String, String, bool) {
    let name = path.replace('/', "-");
    let tmp = common::tempdir(&name);
    let exe = tmp.join(&name);
    common::build(&common::test_file(&format!("{path}.ts")), &exe);
    let out = Command::new(&exe)
        .args(args.iter().map(|a| a.replace("<tmp>", tmp.to_str().unwrap())))
        .current_dir(common::test_file(dir))
        .output()
        .unwrap();
    let _ = std::fs::remove_dir_all(&tmp);
    (String::from_utf8_lossy(&out.stdout).into(), String::from_utf8_lossy(&out.stderr).into(), out.status.success())
}

fn expected(path: &str) -> String {
    std::fs::read_to_string(common::test_file(&format!("{path}.out"))).unwrap()
}

#[test]
fn build() {
    // Plugins (onStart, onResolve and onLoad in a namespace, onEnd), the
    // json and text loaders, `define`, tree shaking (`sideEffects`), the
    // bundle run, and errors thrown or in `logs`.
    let (out, err, ok) = run("build/build", "build", &["<tmp>/out"]);
    assert_eq!(out, expected("build"), "{err}");
    assert!(ok, "{err}");
}

#[test]
fn node() {
    // node:path, node:url, node:fs (and its promises), node:buffer,
    // node:events, node:os, process, node:worker_threads, node:module's
    // require (CommonJS and JSON), import.meta, import() of a TypeScript
    // module at run time, and Bun.file and Bun.write.
    let (out, err, ok) = run("node/node", "node", &["<tmp>"]);
    assert_eq!(out, expected("node/node"), "{err}");
    assert!(ok, "{err}");
}
