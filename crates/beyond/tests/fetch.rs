//! `fetch()`: builds tests/fetch/app.ts for a server of the test's own (on
//! a port of its choosing, put in for `__PORT__`), the same over TLS with a
//! certificate of a CA the test makes (`__TLS_PORT__`, the CA's PEM put in
//! for `__CA__`) and with a self-signed one (`__SELF_PORT__`), and checks
//! its output against Bun's (tests/fetch/app.out, made with `cargo test
//! --test fetch -- --ignored`, which runs the program with `bun` instead).

mod common;

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Shutdown, TcpListener};
use std::sync::Arc;

use openssl::asn1::Asn1Time;
use openssl::bn::{BigNum, MsbOption};
use openssl::hash::MessageDigest;
use openssl::pkey::{PKey, Private};
use openssl::rsa::Rsa;
use openssl::ssl::{SslAcceptor, SslMethod};
use openssl::x509::extension::{BasicConstraints, SubjectAlternativeName};
use openssl::x509::{X509, X509NameBuilder};
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
fn read_req<S: Read>(r: &mut BufReader<S>) -> Option<Req> {
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

fn send<S: Write>(s: &mut S, status: &str, headers: &[(&str, &str)], body: &[u8]) {
    let mut out = format!("HTTP/1.1 {status}\r\n");
    for (n, v) in headers {
        out.push_str(&format!("{n}: {v}\r\n"));
    }
    out.push_str(&format!("Content-Length: {}\r\n\r\n", body.len()));
    let _ = s.write_all(out.as_bytes());
    let _ = s.write_all(body);
}

/// Answers the requests on one connection; false once it is to be closed.
fn answer<S: Write>(s: &mut S, req: &Req) -> bool {
    let p = req.path.as_str();
    match (req.method.as_str(), p) {
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
        // Closed without an answer.
        (_, "/reset") => return false,
        (_, "/garbage") => {
            let _ = s.write_all(b"NOT HTTP AT ALL\r\n\r\n");
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

/// Answers a connection's requests until it is to be closed.
fn serve<S: Read + Write>(s: S) {
    let mut r = BufReader::new(s);
    while let Some(req) = read_req(&mut r) {
        if !answer(r.get_mut(), &req) {
            break;
        }
    }
}

/// A server on a port of its own, each connection on a thread; over TLS
/// with `tls`.
fn server(tls: Option<Arc<SslAcceptor>>) -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    thread::spawn(move || {
        for s in listener.incoming() {
            let Ok(s) = s else { continue };
            let tls = tls.clone();
            thread::spawn(move || {
                let tcp = s.try_clone().unwrap();
                match tls {
                    Some(acceptor) => {
                        if let Ok(s) = acceptor.accept(s) {
                            serve(s);
                        }
                    }
                    None => serve(s),
                }
                let _ = tcp.shutdown(Shutdown::Both);
            });
        }
    });
    port
}

fn key() -> PKey<Private> {
    PKey::from_rsa(Rsa::generate(2048).unwrap()).unwrap()
}

/// A certificate for `cn`, valid for localhost and 127.0.0.1, signed by
/// `issuer` (itself if None; a CA's if `ca`).
fn certificate(cn: &str, key: &PKey<Private>, issuer: Option<(&X509, &PKey<Private>)>, ca: bool) -> X509 {
    let mut name = X509NameBuilder::new().unwrap();
    name.append_entry_by_text("CN", cn).unwrap();
    let name = name.build();
    let mut b = X509::builder().unwrap();
    b.set_version(2).unwrap();
    let mut serial = BigNum::new().unwrap();
    serial.rand(64, MsbOption::MAYBE_ZERO, false).unwrap();
    b.set_serial_number(&serial.to_asn1_integer().unwrap()).unwrap();
    b.set_subject_name(&name).unwrap();
    b.set_issuer_name(issuer.map_or(&name, |(c, _)| c.subject_name())).unwrap();
    b.set_pubkey(key).unwrap();
    b.set_not_before(&Asn1Time::days_from_now(0).unwrap()).unwrap();
    b.set_not_after(&Asn1Time::days_from_now(30).unwrap()).unwrap();
    if ca {
        b.append_extension(BasicConstraints::new().critical().ca().build().unwrap()).unwrap();
    } else {
        let san = SubjectAlternativeName::new().dns("localhost").ip("127.0.0.1").build(&b.x509v3_context(issuer.map(|(c, _)| &**c), None)).unwrap();
        b.append_extension(san).unwrap();
    }
    b.sign(issuer.map_or(key, |(_, k)| k), MessageDigest::sha256()).unwrap();
    b.build()
}

fn acceptor(cert: &X509, key: &PKey<Private>) -> Arc<SslAcceptor> {
    let mut a = SslAcceptor::mozilla_intermediate_v5(SslMethod::tls()).unwrap();
    a.set_certificate(cert).unwrap();
    a.set_private_key(key).unwrap();
    Arc::new(a.build())
}

/// The servers: plain, over TLS with a certificate of a CA (whose PEM is
/// returned), and over TLS with a self-signed certificate.
fn servers() -> (u16, u16, u16, String) {
    let ca_key = key();
    let ca = certificate("Beyond Test CA", &ca_key, None, true);
    let leaf_key = key();
    let leaf = certificate("localhost", &leaf_key, Some((&ca, &ca_key)), false);
    let self_key = key();
    let selfsigned = certificate("localhost", &self_key, None, false);
    let plain = server(None);
    let tls = server(Some(acceptor(&leaf, &leaf_key)));
    let selfp = server(Some(acceptor(&selfsigned, &self_key)));
    (plain, tls, selfp, String::from_utf8(ca.to_pem().unwrap()).unwrap())
}

/// tests/fetch/app.ts in a directory of its own, for the servers.
fn program(dir: &std::path::Path) -> std::path::PathBuf {
    let (port, tls, selfp, ca) = servers();
    let text = std::fs::read_to_string(common::test_file("fetch/app.ts")).unwrap();
    let ca = format!("{ca:?}");
    let text = text
        .replace("__PORT__", &port.to_string())
        .replace("__TLS_PORT__", &tls.to_string())
        .replace("__SELF_PORT__", &selfp.to_string())
        .replace("__CA__", &ca);
    let app = dir.join("app.ts");
    std::fs::write(&app, text).unwrap();
    app
}

#[test]
fn fetch() {
    let dir = common::tempdir("fetch");
    let exe = dir.join("app");
    common::build(&program(&dir), &exe);
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
    let dir = common::tempdir("fetch-bun");
    let out = Command::new("bun").arg(program(&dir)).output().unwrap();
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::write(common::test_file("fetch/app.out"), &out.stdout).unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
}
