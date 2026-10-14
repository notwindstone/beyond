//! `Beyond.serve`: builds tests/serve/app.ts, runs it, and checks its
//! answers to requests made over TCP.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::Duration;

/// The response to `raw` (a request, with `Connection: close`): its head
/// (lines, the header names in lower case) and its body.
fn request(port: u16, raw: &str) -> (Vec<String>, String) {
    let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
    s.write_all(raw.as_bytes()).unwrap();
    let mut out = String::new();
    s.read_to_string(&mut out).unwrap();
    let (head, body) = out.split_once("\r\n\r\n").expect("a complete response");
    let head = head
        .lines()
        .map(|l| match l.split_once(": ") {
            Some((n, v)) => format!("{}: {v}", n.to_lowercase()),
            None => l.to_string(),
        })
        .collect();
    (head, body.to_string())
}

fn get(port: u16, path: &str) -> (Vec<String>, String) {
    request(port, &format!("GET {path} HTTP/1.1\r\nHost: localhost\r\nUser-Agent: beyond-test\r\nConnection: close\r\n\r\n"))
}

#[test]
fn serve() {
    let dir = std::env::temp_dir().join(format!("beyond-serve-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    // The native core (a static library, which `cargo test` does not build),
    // next to `beyond`.
    let mut cargo = Command::new(env!("CARGO"));
    cargo.args(["build", "-p", "beyond-rt"]);
    if !cfg!(debug_assertions) {
        cargo.arg("--release");
    }
    assert!(cargo.status().unwrap().success(), "building beyond-rt failed");
    let exe = dir.join("app");
    let app = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/serve/app.ts");
    let st = Command::new(env!("CARGO_BIN_EXE_beyond")).arg("build").arg(&app).arg("-o").arg(&exe).status().unwrap();
    assert!(st.success(), "beyond build failed");

    let mut child = Command::new(&exe).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
    let mut line = String::new();
    BufReader::new(child.stdout.take().unwrap()).read_line(&mut line).unwrap();
    let port: u16 = line.trim().parse().expect("the port");

    let (head, body) = get(port, "/");
    assert_eq!(head[0], "HTTP/1.1 200 OK");
    assert!(head.contains(&"content-type: text/plain;charset=utf-8".into()), "{head:?}");
    assert!(head.contains(&"content-length: 5".into()), "{head:?}");
    assert!(head.iter().any(|h| h.starts_with("date: ")), "{head:?}");
    assert_eq!(body, "hello");

    let (head, body) = get(port, "/json");
    assert!(head.contains(&"content-type: application/json;charset=utf-8".into()), "{head:?}");
    assert_eq!(body, r#"{"method":"GET","ua":"beyond-test"}"#);

    let (head, body) = get(port, "/later");
    assert_eq!(head[0], "HTTP/1.1 202 Accepted");
    assert!(head.contains(&"x-kind: async".into()), "{head:?}");
    assert_eq!(body, "later");

    let (_, body) = request(
        port,
        "GET /headers?q=1 HTTP/1.1\r\nHost: example.test\r\nX-Mixed-Case:  Va lue \r\nConnection: close\r\n\r\n",
    );
    assert_eq!(
        body,
        r#"{"url":"http://example.test/headers?q=1","headers":[["connection","close"],["host","example.test"],["x-mixed-case","Va lue"]]}"#
    );

    let (head, body) =
        request(port, "POST /echo HTTP/1.1\r\nHost: localhost\r\nContent-Length: 3\r\nConnection: close\r\n\r\nabc");
    assert_eq!(head[0], "HTTP/1.1 201 Created");
    assert_eq!(body, "echo: abc");

    let (head, body) = get(port, "/throw");
    assert_eq!(head[0], "HTTP/1.1 500 Internal Server Error");
    assert_eq!(body, "Internal Server Error");

    // Keep-alive: two requests on one connection.
    let (_, body) = request(
        port,
        "GET / HTTP/1.1\r\nHost: localhost\r\n\r\nGET /json HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
    );
    assert!(body.starts_with("hello") && body.ends_with(r#"{"method":"GET","ua":null}"#), "{body:?}");

    let (_, body) = get(port, "/stop");
    assert_eq!(body, "stopping");
    // With the server stopped, the program has nothing left to wait for.
    let out = child.wait_with_output().unwrap();
    assert!(out.status.success(), "{:?}", out.status);
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(stderr.contains("Error: boom"), "{stderr}");
    let _ = std::fs::remove_dir_all(&dir);
}
