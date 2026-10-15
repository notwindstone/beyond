//! `fetch()`: builds tests/fetch/app.ts for a server of the test's own (on
//! a port of its choosing, put in for `__PORT__`) and checks its output
//! against Bun's (tests/fetch/app.out, made with `cargo test --test fetch
//! -- --ignored`, which runs the program with `bun` instead).

mod common;

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::process::Command;
use std::thread;
use std::time::Duration;

const GZIP: [u8; 41] = [
    31, 139, 8, 0, 0, 0, 0, 0, 2, 255, 203, 72, 205, 201, 201, 87, 72, 175, 202, 44, 80, 200, 24, 101, 142, 50, 71, 153, 163, 76,
    114, 153, 0, 76, 86, 215, 15, 76, 4, 0, 0,
];
const DEFLATE: [u8; 21] = [120, 156, 203, 72, 205, 201, 201, 87, 72, 73, 77, 203, 73, 44, 73, 5, 0, 35, 12, 5, 10];
const BR: [u8; 30] = [
    27, 137, 2, 248, 29, 169, 83, 159, 187, 112, 45, 86, 134, 38, 39, 65, 216, 232, 146, 45, 237, 45, 10, 140, 6, 190, 145, 25,
    191, 0,
];

const ZSTD: [u8; 28] = [
    40, 181, 47, 253, 96, 76, 3, 149, 0, 0, 88, 104, 101, 108, 108, 111, 32, 122, 115, 116, 100, 32, 1, 0, 62, 248, 47, 94,
];

/// A request: its method, target, headers (names in lower case) and body.
struct Req {
    method: String,
    path: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl Req {
    fn header(&self, name: &str) -> &str {
        self.headers.iter().find(|(n, _)| n == name).map_or("", |(_, v)| v)
    }
}

/// The next request on `r` (None once the client closes the connection).
fn read_req(r: &mut BufReader<TcpStream>) -> Option<Req> {
    let mut line = String::new();
    if r.read_line(&mut line).ok()? == 0 {
        return None;
    }
    let mut parts = line.split_whitespace();
    let method = parts.next()?.to_string();
    let path = parts.next()?.to_string();
    let mut headers = Vec::new();
    loop {
        let mut h = String::new();
        r.read_line(&mut h).ok()?;
        let h = h.trim_end();
        if h.is_empty() {
            break;
        }
        let (n, v) = h.split_once(':')?;
        headers.push((n.to_lowercase(), v.trim().to_string()));
    }
    let mut req = Req { method, path, headers, body: Vec::new() };
    if req.header("transfer-encoding") == "chunked" {
        loop {
            let mut size = String::new();
            r.read_line(&mut size).ok()?;
            let n = usize::from_str_radix(size.trim(), 16).ok()?;
            let mut chunk = vec![0; n + 2];
            r.read_exact(&mut chunk).ok()?;
            if n == 0 {
                break;
            }
            req.body.extend_from_slice(&chunk[..n]);
        }
    } else if let Ok(n) = req.header("content-length").parse::<usize>() {
        req.body = vec![0; n];
        r.read_exact(&mut req.body).ok()?;
    }
    Some(req)
}

fn send(s: &mut TcpStream, status: &str, headers: &[(&str, &str)], body: &[u8]) {
    let mut out = format!("HTTP/1.1 {status}\r\n");
    for (n, v) in headers {
        out.push_str(&format!("{n}: {v}\r\n"));
    }
    out.push_str(&format!("Content-Length: {}\r\n\r\n", body.len()));
    let _ = s.write_all(out.as_bytes());
    let _ = s.write_all(body);
}

/// Answers the requests on one connection; false once it is to be closed.
fn answer(s: &mut TcpStream, req: &Req) -> bool {
    let p = req.path.as_str();
    match (req.method.as_str(), p) {
        ("HEAD", _) => {
            let _ = s.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 1234\r\n\r\n");
        }
        ("POST", "/303") => send(s, "303 See Other", &[("Location", "/final")], b""),
        ("POST", "/form") => {
            let body = format!("{} {}", req.header("content-type"), String::from_utf8_lossy(&req.body));
            send(s, "200 OK", &[], body.as_bytes());
        }
        ("POST" | "PUT", _) => {
            let body = format!("{} {}", req.method, String::from_utf8_lossy(&req.body));
            send(s, "200 OK", &[], body.as_bytes());
        }
        (_, "/teapot") => send(
            s,
            "418 Short And Stout",
            &[("X-Multi", "a"), ("X-Multi", "b"), ("Set-Cookie", "a=1"), ("Set-Cookie", "b=2")],
            b"tea",
        ),
        (_, "/headers") => {
            // The headers in the order sent; the user agent and host as
            // whether they are there, as they differ.
            let mut out = String::new();
            for (n, v) in &req.headers {
                let v = match n.as_str() {
                    "user-agent" if v != "mine" => "*",
                    "host" => "*",
                    _ => v,
                };
                out.push_str(&format!("{n}={v};"));
            }
            send(s, "200 OK", &[], out.as_bytes());
        }
        (_, "/redir") => send(s, "302 Found", &[("Location", "/final?x=1")], b""),
        (_, "/loop") => send(s, "301 Moved Permanently", &[("Location", "/loop")], b""),
        (_, "/gzip") => send(s, "200 OK", &[("Content-Encoding", "gzip")], &GZIP),
        (_, "/deflate") => send(s, "200 OK", &[("Content-Encoding", "deflate")], &DEFLATE),
        (_, "/br") => send(s, "200 OK", &[("Content-Encoding", "br")], &BR),
        (_, "/zstd") => send(s, "200 OK", &[("Content-Encoding", "zstd")], &ZSTD),
        (_, "/zero") => send(s, "200 OK", &[], b""),
        (_, "/json") => send(s, "200 OK", &[("Content-Type", "application/json")], br#"{"a":[1,2],"b":"c"}"#),
        (_, "/chunked") => {
            let _ = s.write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n");
            for part in [b"ab".to_vec(), b"cde".to_vec(), vec![b'f'; 70000]] {
                let _ = s.write_all(format!("{:x}\r\n", part.len()).as_bytes());
                let _ = s.write_all(&part);
                let _ = s.write_all(b"\r\n");
                thread::sleep(Duration::from_millis(10));
            }
            let _ = s.write_all(b"0\r\n\r\n");
        }
        (_, "/close") => {
            let _ = s.write_all(b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\nuntil close");
            return false;
        }
        (_, "/bye") => {
            // Kept alive, as far as the client knows; closed here.
            send(s, "200 OK", &[], b"bye");
            return false;
        }
        (_, "/big") => send(s, "200 OK", &[], &vec![b'x'; 8 << 20]),
        (_, "/slow") => {
            let _ = s.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\nxxxxxxxxxx");
            thread::sleep(Duration::from_millis(500));
            let _ = s.write_all(&[b'y'; 90]);
        }
        (_, "/late") => {
            thread::sleep(Duration::from_millis(500));
            send(s, "200 OK", &[], b"late");
        }
        (_, "/empty") => {
            let _ = s.write_all(b"HTTP/1.1 204 No Content\r\n\r\n");
        }
        _ if p.starts_with("/final") => send(s, "200 OK", &[], format!("final {p}").as_bytes()),
        _ => send(s, "200 OK", &[], format!("hello {}", req.header("connection")).as_bytes()),
    }
    true
}

/// A server on a port of its own, each connection on a thread.
fn server() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    thread::spawn(move || {
        for s in listener.incoming() {
            let Ok(mut s) = s else { continue };
            thread::spawn(move || {
                let mut r = BufReader::new(s.try_clone().unwrap());
                while let Some(req) = read_req(&mut r) {
                    if !answer(&mut s, &req) {
                        break;
                    }
                }
                let _ = s.shutdown(Shutdown::Both);
            });
        }
    });
    port
}

/// tests/fetch/app.ts in a directory of its own, for the server on `port`.
fn program(port: u16, dir: &std::path::Path) -> std::path::PathBuf {
    let text = std::fs::read_to_string(common::test_file("fetch/app.ts")).unwrap();
    let app = dir.join("app.ts");
    std::fs::write(&app, text.replace("__PORT__", &port.to_string())).unwrap();
    app
}

#[test]
fn fetch() {
    let port = server();
    let dir = common::tempdir("fetch");
    let exe = dir.join("app");
    common::build(&program(port, &dir), &exe);
    let out = Command::new(&exe).output().unwrap();
    let _ = std::fs::remove_dir_all(&dir);
    let expected = std::fs::read_to_string(common::test_file("fetch/app.out")).unwrap();
    assert_eq!(String::from_utf8_lossy(&out.stdout), expected);
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
}

/// Bun's output, for tests/fetch/app.out.
#[test]
#[ignore]
fn fetch_bun() {
    let port = server();
    let dir = common::tempdir("fetch-bun");
    let out = Command::new("bun").arg(program(port, &dir)).output().unwrap();
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::write(common::test_file("fetch/app.out"), &out.stdout).unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
}
