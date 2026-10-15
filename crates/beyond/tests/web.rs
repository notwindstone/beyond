//! The web APIs: programs whose output is Bun's (tests/web/*.out, made with
//! `bun x.ts > x.out`), and web platform tests (tests/wpt, from
//! github.com/web-platform-tests/wpt; BSD 3-Clause): the URL data
//! (url/resources), and the tests of streams (streams, encoding/streams)
//! run with a small stand-in for their harness (tests/wpt/testharness.js).

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
fn body() {
    // Blob, File, FormData, and Request and Response with them.
    let (out, err, ok) = run("body");
    assert_eq!(out, expected("body"));
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

/// The tests' files (relative to tests/wpt) under `dir`, sorted.
fn wpt_files(dir: &str, out: &mut Vec<String>) {
    for e in std::fs::read_dir(common::test_file(&format!("wpt/{dir}"))).unwrap() {
        let e = e.unwrap();
        let name = format!("{dir}/{}", e.file_name().to_string_lossy());
        if e.file_type().unwrap().is_dir() {
            wpt_files(&name, out);
        } else if name.ends_with(".any.js") {
            out.push(name);
        }
    }
}

#[test]
fn streams_wpt() {
    // All the tests in one program (one build): the harness, the resources
    // the tests name (`// META: script=`) once, and each test file in a
    // block of its own (the encoding tests' resources, which declare plain
    // functions, in it too).
    let read = |p: &str| std::fs::read_to_string(common::test_file(&format!("wpt/{p}"))).unwrap();
    let mut files = Vec::new();
    wpt_files("streams", &mut files);
    wpt_files("encoding/streams", &mut files);
    files.sort();
    let mut shared = vec![read("testharness.js")];
    let mut seen = std::collections::HashSet::new();
    let mut blocks = Vec::new();
    for f in &files {
        let src = read(f);
        let mut local = Vec::new();
        for line in src.lines() {
            let Some(script) = line.strip_prefix("// META: script=") else { continue };
            match script.trim() {
                "/common/gc.js" => {}
                "/common/sab.js" => {
                    if seen.insert("sab".to_string()) {
                        shared.push("self.createBuffer = (type, length, opts) => new self[type](length, opts);".into());
                    }
                }
                s => {
                    let dir = std::path::Path::new(f).parent().unwrap();
                    let path = dir.join(s);
                    // (Normalized: `..` against the directory.)
                    let mut parts: Vec<String> = Vec::new();
                    for c in path.components() {
                        match c.as_os_str().to_string_lossy().as_ref() {
                            ".." => {
                                parts.pop();
                            }
                            "." => {}
                            p => parts.push(p.to_string()),
                        }
                    }
                    let p = parts.join("/");
                    if p.starts_with("encoding/") {
                        local.push(read(&p));
                    } else if seen.insert(p.clone()) {
                        shared.push(read(&p));
                    }
                }
            }
        }
        local.push(src);
        blocks.push(format!("__file = {f:?};\n{{\n{}\n}}\n", local.join("\n")));
    }
    let program = format!("{}\n{}\n__run();\n", shared.join("\n"), blocks.join("\n"));
    let dir = common::tempdir("streams-wpt");
    let app = dir.join("streams.ts");
    std::fs::write(&app, program).unwrap();
    let exe = dir.join("streams");
    common::build(&app, &exe);
    let out = Command::new(&exe).output().unwrap();
    let _ = std::fs::remove_dir_all(&dir);
    let out = String::from_utf8_lossy(&out.stdout);
    let known: std::collections::HashSet<String> = read("streams.expected")
        .lines()
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .map(String::from)
        .collect();
    let mut failed = Vec::new();
    let mut total = 0;
    for line in out.lines() {
        let (status, rest) = line.split_once(' ').unwrap_or((line, ""));
        if !matches!(status, "PASS" | "FAIL" | "TIMEOUT") {
            continue;
        }
        total += 1;
        let name = if status == "FAIL" { rest.split_once(": ").map_or(rest, |(n, _)| n) } else { rest };
        // (A FAIL's name is up to its message: the test names have ": " in
        // them too, so the known ones are matched by prefix.)
        if status != "PASS" && !known.iter().any(|k| rest.starts_with(k.as_str())) {
            failed.push(format!("{status} {name}"));
        }
    }
    assert!(total > 1200, "only {total} tests ran:\n{out}");
    assert!(failed.is_empty(), "{} failed:\n{}", failed.len(), failed.join("\n"));
}

#[test]
fn streams() {
    // How streams print, Bun's methods of theirs, and bodies of streams.
    let (out, err, ok) = run("streams");
    assert_eq!(out, expected("streams"));
    assert!(ok, "{err}");
}
