//! The web APIs: programs whose output is Bun's (tests/web/*.out, made with
//! `bun x.ts > x.out`), and the web platform tests' URL data (tests/wpt,
//! from github.com/web-platform-tests/wpt, url/resources; BSD 3-Clause).

mod common;

use std::process::Command;

/// Runs tests/web/`name`.ts: its standard output, its standard error and
/// whether it succeeded.
fn run(name: &str) -> (String, String, bool) {
    let dir = common::tempdir(name);
    let exe = dir.join(name);
    common::build(&common::test_file(&format!("web/{name}.ts")), &exe);
    let out = Command::new(&exe).output().unwrap();
    let _ = std::fs::remove_dir_all(&dir);
    (String::from_utf8_lossy(&out.stdout).into(), String::from_utf8_lossy(&out.stderr).into(), out.status.success())
}

fn expected(name: &str) -> String {
    std::fs::read_to_string(common::test_file(&format!("web/{name}.out"))).unwrap()
}

#[test]
fn globals() {
    // TextEncoder/TextDecoder, crypto, structuredClone, events, abort.
    let (out, err, ok) = run("globals");
    assert_eq!(out, expected("globals"));
    // An error a listener threw is reported, and the program then exits
    // with 1, as Bun's.
    assert!(err.contains("Error: listener"), "{err}");
    assert!(!ok);
}

#[test]
fn console() {
    // console.log's formats: Bun's, for each kind of value.
    let (out, err, ok) = run("console");
    assert_eq!(out, expected("console"));
    assert!(ok, "{err}");
}

#[test]
fn url() {
    let (out, err, ok) = run("url");
    assert_eq!(out, expected("url"));
    assert!(ok, "{err}");
}

#[test]
fn url_wpt() {
    // A program with the data in it (Beyond has no file APIs yet).
    let data = |f: &str| {
        let text = std::fs::read_to_string(common::test_file(&format!("wpt/{f}"))).unwrap();
        // As a JavaScript string literal (JSON's escapes are JavaScript's).
        let mut lit = String::from("\"");
        for c in text.chars() {
            match c {
                '"' => lit.push_str("\\\""),
                '\\' => lit.push_str("\\\\"),
                '\n' => lit.push_str("\\n"),
                c => lit.push(c),
            }
        }
        lit.push('"');
        lit
    };
    let program = format!(
        "const urltestdata = JSON.parse({});\nconst setters = JSON.parse({});\nconst toascii = JSON.parse({});\n{}",
        data("urltestdata.json"),
        data("setters_tests.json"),
        data("toascii.json"),
        std::fs::read_to_string(common::test_file("wpt/run.ts")).unwrap()
    );
    let dir = common::tempdir("wpt");
    let app = dir.join("wpt.ts");
    std::fs::write(&app, program).unwrap();
    let exe = dir.join("wpt");
    common::build(&app, &exe);
    let out = Command::new(&exe).output().unwrap();
    let _ = std::fs::remove_dir_all(&dir);
    let out = String::from_utf8_lossy(&out.stdout);
    for line in ["urltestdata: 896/896", "setters: 278/278", "toascii: 87/87"] {
        assert!(out.contains(line), "expected {line}:\n{out}");
    }
}
