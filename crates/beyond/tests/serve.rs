//! `Beyond.serve`: builds tests/serve/app.ts, runs it, and checks its
//! answers to requests made over TCP.

mod common;

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
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

/// A chunked body's content (None if it does not end with the last chunk).
fn dechunk(mut body: &str) -> Option<String> {
    let mut out = String::new();
    loop {
        let (size, rest) = body.split_once("\r\n")?;
        let n = usize::from_str_radix(size.trim(), 16).ok()?;
        if n == 0 {
            return (rest == "\r\n").then_some(out);
        }
        out.push_str(rest.get(..n)?);
        body = rest.get(n..)?.strip_prefix("\r\n")?;
    }
}

fn get(port: u16, path: &str) -> (Vec<String>, String) {
    request(port, &format!("GET {path} HTTP/1.1\r\nHost: localhost\r\nUser-Agent: beyond-test\r\nConnection: close\r\n\r\n"))
}

#[test]
fn serve() {
    let dir = common::tempdir("serve");
    let exe = dir.join("app");
    common::build(&common::test_file("serve/app.ts"), &exe);

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

    // Bodies that are streams: chunked.
    let (head, body) = get(port, "/stream");
    assert_eq!(head[0], "HTTP/1.1 200 OK");
    assert!(head.contains(&"transfer-encoding: chunked".into()), "{head:?}");
    assert!(head.contains(&"content-type: text/x-stream".into()), "{head:?}");
    assert_eq!(dechunk(&body).as_deref(), Some("abc"), "{body:?}");

    let (_, body) = get(port, "/big");
    let big = dechunk(&body).expect("a complete body");
    assert_eq!(big.len(), 64 * 65536);
    assert!(big.starts_with('a') && big.ends_with('l'), "{}", &big[big.len() - 10..]);

    let (_, body) = get(port, "/generator");
    assert_eq!(dechunk(&body).as_deref(), Some("xy"));

    // A stream that fails midway: the connection is closed without the
    // last chunk.
    let (head, body) = get(port, "/broken");
    assert_eq!(head[0], "HTTP/1.1 200 OK");
    assert!(body.starts_with("4\r\npart\r\n") && dechunk(&body).is_none(), "{body:?}");

    // The request's body, as the response's.
    let (_, body) =
        request(port, "POST /pipe HTTP/1.1\r\nHost: localhost\r\nContent-Length: 5\r\nConnection: close\r\n\r\nhello");
    assert_eq!(dechunk(&body).as_deref(), Some("hello"), "{body:?}");

    // A body that arrives slowly: the handler is called on the head, and its
    // body is read as it comes (here, sent back as it is read).
    {
        let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        s.write_all(b"POST /pipe HTTP/1.1\r\nHost: localhost\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n3\r\none\r\n")
            .unwrap();
        // (The first part comes back before the rest is sent.)
        let mut got = Vec::new();
        let mut buf = [0; 4096];
        while !String::from_utf8_lossy(&got).contains("\r\n\r\n3\r\none\r\n") {
            let n = s.read(&mut buf).unwrap();
            assert!(n > 0, "closed: {:?}", String::from_utf8_lossy(&got));
            got.extend_from_slice(&buf[..n]);
        }
        s.write_all(b"3\r\ntwo\r\n0\r\n\r\n").unwrap();
        s.read_to_end(&mut got).unwrap();
        let out = String::from_utf8_lossy(&got);
        let (_, body) = out.split_once("\r\n\r\n").unwrap();
        assert_eq!(dechunk(body).as_deref(), Some("onetwo"), "{body:?}");
    }

    // A large body read as a stream (the connection paused while it waits).
    let big = "x".repeat(4 << 20);
    let (_, body) = request(
        port,
        &format!("POST /count HTTP/1.1\r\nHost: localhost\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{big}", big.len()),
    );
    assert_eq!(body, format!("{}", big.len()));

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
    assert!(stderr.contains("Error: stream broke"), "{stderr}");
    let _ = std::fs::remove_dir_all(&dir);
}
