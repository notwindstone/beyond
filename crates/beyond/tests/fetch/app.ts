// fetch() against tests/fetch.rs's server (its port put in for __PORT__):
// what each case gives, URLs without the server's address. The output is
// Bun's (app.out).
const B = "http://127.0.0.1:__PORT__";
const S = "https://127.0.0.1:__TLS_PORT__";
const SELF = "https://127.0.0.1:__SELF_PORT__";
const ca = __CA__;
const HB = B.replace("http:", "https:");
const strip = (s: string | null) => (s === null ? s : s.replace(S, "S").replace(SELF, "SELF").replace(HB, "HB").replace(B, "B"));
const show = async (label: string, f: () => any) => {
  try {
    console.log(label, await f());
  } catch (e: any) {
    console.log(label, "threw", e?.constructor?.name, JSON.stringify(strip(e?.message ?? null)), e?.code, e?.name, e?.errno, strip(e?.path ?? null), e?.syscall, e?.hostname);
  }
};

await show("plain", async () => (await fetch(B + "/")).text());
await show("response", async () => {
  const r = await fetch(B + "/teapot");
  return [r.status, r.statusText, r.ok, r.type, strip(r.url), r.redirected, r.bodyUsed, r.headers.get("x-multi"), r.headers.getSetCookie()];
});
await show("request headers", async () => (await fetch(B + "/headers", { headers: { "X-Custom": "yes" } })).text());
await show("own headers", async () => {
  const headers = { accept: "text/plain", "accept-encoding": "identity", "user-agent": "mine", connection: "keep-alive" };
  return (await fetch(B + "/headers", { headers })).text();
});
await show("redirect", async () => {
  const r = await fetch(B + "/redir");
  return [r.status, strip(r.url), r.redirected, await r.text()];
});
await show("manual", async () => {
  const r = await fetch(B + "/redir", { redirect: "manual" });
  return [r.status, r.headers.get("location"), r.redirected];
});
await show("error", async () => fetch(B + "/redir", { redirect: "error" }));
await show("loop", async () => fetch(B + "/loop"));
await show("gzip", async () => {
  const t = await (await fetch(B + "/gzip")).text();
  return [t.length, t.slice(0, 11)];
});
await show("deflate", async () => (await fetch(B + "/deflate")).text());
await show("br", async () => {
  const t = await (await fetch(B + "/br")).text();
  return [t.length, t.slice(0, 13)];
});
await show("chunked", async () => {
  const t = await (await fetch(B + "/chunked")).text();
  return [t.length, t.slice(0, 6)];
});
await show("close", async () => (await fetch(B + "/close")).text());
await show("big", async () => (await (await fetch(B + "/big")).arrayBuffer()).byteLength);
await show("204", async () => {
  const r = await fetch(B + "/empty");
  return [r.status, r.body === null, await r.text()];
});
await show("head", async () => {
  const r = await fetch(B + "/", { method: "HEAD" });
  return [r.status, r.headers.get("content-length"), r.body === null, await r.text()];
});
await show("zero", async () => {
  const r = await fetch(B + "/zero");
  return [r.status, r.body === null, await r.text()];
});
await show("zstd", async () => {
  const t = await (await fetch(B + "/zstd")).text();
  return [t.length, t.slice(0, 11)];
});
await show("post", async () => (await fetch(B + "/echo", { method: "POST", body: "data!" })).text());
await show("post bytes", async () => (await fetch(B + "/echo", { method: "POST", body: new Uint8Array([104, 105]) })).text());
await show("post params", async () => (await fetch(B + "/form", { method: "POST", body: new URLSearchParams({ a: "1", b: "x y" }) })).text());
await show("post json", async () => (await fetch(B + "/form", { method: "POST", body: JSON.stringify({ a: 1 }) })).text());
await show("post blob", async () => (await fetch(B + "/form", { method: "POST", body: new Blob(["blob"], { type: "text/x-blob" }) })).text());
await show("post stream", async () => {
  const body = new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode("str"));
      c.enqueue(new TextEncoder().encode("eam"));
      c.close();
    },
  });
  return (await fetch(B + "/echo", { method: "POST", body })).text();
});
await show("put", async () => (await fetch(B + "/echo", { method: "PUT", body: "put" })).text());
await show("request object", async () => (await fetch(new Request(B + "/echo", { method: "POST", body: "req" }))).text());
await show("url object", async () => (await fetch(new URL("/final?u=1", B))).text());
await show("303", async () => {
  const r = await fetch(B + "/303", { method: "POST", body: "x" });
  return [r.status, strip(r.url), await r.text()];
});
await show("stream read", async () => {
  const r = await fetch(B + "/chunked");
  let n = 0;
  for await (const c of r.body!) n += c.length;
  return n;
});
await show("json", async () => (await fetch(B + "/json")).json());
await show("used", async () => {
  const r = await fetch(B + "/");
  await r.text();
  return [r.bodyUsed, await r.text().catch((e) => e.code)];
});
await show("clone", async () => {
  const r = await fetch(B + "/chunked");
  const c = r.clone();
  return [(await r.text()).length, (await c.text()).length];
});
await show("abort mid-body", async () => {
  const c = new AbortController();
  const r = await fetch(B + "/slow", { signal: c.signal });
  setTimeout(() => c.abort(), 50);
  return r.text();
});
await show("abort before head", async () => {
  const c = new AbortController();
  setTimeout(() => c.abort(), 50);
  return fetch(B + "/late", { signal: c.signal });
});
await show("cancel body", async () => {
  const r = await fetch(B + "/big");
  await r.body!.cancel();
  return "canceled";
});
await show("parallel", async () => (await Promise.all([1, 2, 3, 4, 5].map(() => fetch(B + "/").then((r) => r.text())))).join("|"));
await show("server closed", async () => [await (await fetch(B + "/bye")).text(), await (await fetch(B + "/")).text()]);

// TLS.
await show("https", async () => (await fetch(S + "/", { tls: { ca } })).text());
await show("https localhost", async () => (await fetch(`https://localhost:__TLS_PORT__/final`, { tls: { ca } })).text());
await show("https redirect", async () => {
  const r = await fetch(S + "/redir", { tls: { ca } });
  return [r.status, strip(r.url), r.redirected, await r.text()];
});
await show("https gzip", async () => (await (await fetch(S + "/gzip", { tls: { ca } })).text()).length);
await show("https chunked", async () => (await (await fetch(S + "/chunked", { tls: { ca } })).text()).length);
await show("https big", async () => (await (await fetch(S + "/big", { tls: { ca } })).arrayBuffer()).byteLength);
await show("https post", async () => (await fetch(S + "/echo", { method: "POST", body: "over tls", tls: { ca } })).text());
await show("https parallel", async () => (await Promise.all([1, 2, 3].map(() => fetch(S + "/", { tls: { ca: [ca] } }).then((r) => r.text())))).join("|"));
await show("https unchecked", async () => (await fetch(S + "/", { tls: { rejectUnauthorized: false } })).text());
await show("https unknown ca", () => fetch(S + "/"));
await show("https self-signed", () => fetch(SELF + "/"));
await show("https self-signed unchecked", async () => (await fetch(SELF + "/", { tls: { rejectUnauthorized: false } })).text());
await show("https wrong name", () => fetch(S + "/", { tls: { ca, serverName: "example.com" } }));
await show("https to http", () => fetch(HB + "/"));

// Errors.
await show("refused", () => fetch("http://127.0.0.1:1/"));
await show("reset", () => fetch(B + "/reset"));
await show("garbage", () => fetch(B + "/garbage"));
await show("dns", () => fetch("http://nonexistent.invalid/"));
await show("bad url", () => fetch("not a url"));
await show("ftp", () => fetch("ftp://x/"));
await show("aborted", () => fetch(B + "/", { signal: AbortSignal.abort() }));
await show("abort reason", () => fetch(B + "/", { signal: AbortSignal.abort(new Error("mine")) }));
await show("get body", () => fetch(B + "/", { method: "GET", body: "x" }));
