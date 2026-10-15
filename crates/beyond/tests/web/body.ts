// Blob, File and FormData, as bodies too (the expected output is Bun's).
console.log(new Blob(["ab", new Uint8Array([99])]));
console.log(new Blob(["x"], { type: "Text/Plain" }));
console.log(new File(["abc"], "a.txt", { type: "text/plain", lastModified: 5 }));
console.log([new Blob([])]);
const fd = new FormData(); fd.append("a", "1"); fd.append("f", new Blob(["zz"]), "z.bin");
console.log(fd);
console.log(new Response(new Blob(["q"], { type: "image/png" })).headers.get("content-type"));
console.log(new Response(fd).headers.get("content-type")?.slice(0, 30));
console.log(new Response(new URLSearchParams("a=1")).headers.get("content-type"));
console.log(await new Response(new Blob(["hey"])).text(), (await new Response("x").blob()).type);
{
const fd2 = new FormData();
fd2.append("name", "Kei");
fd2.append("note", "line1\nline2 \"q\"");
fd2.append("file", new File(["hello world"], "hi.txt", { type: "text/plain" }));
fd2.append("bin", new Blob([new Uint8Array([0, 1, 2, 255])]), "b.bin");
const res = new Response(fd2);
const back = await res.formData();
for (const [k, v] of back) console.log(k, typeof v === "string" ? JSON.stringify(v) : `${v.name} ${v.type} ${v.size} ${JSON.stringify(await v.text())}`);
console.log([...(await new Response(new URLSearchParams("a=1&b=%20&c")).formData())].map((e) => e.join("=")).join("&"));
const req = new Request("http://x/", { method: "POST", body: fd2 });
console.log(req.headers.get("content-type")?.startsWith("multipart/form-data; boundary="), (await req.formData()).get("name"));
const b = await new Response(new Blob(["abc"], { type: "text/x" })).blob();
console.log(b.type, b.size, await b.text(), await b.slice(1, 2).text(), (await b.arrayBuffer()).byteLength);
try { await new Response("plain").formData(); } catch (e: any) { console.log(e.name); }
console.log(JSON.stringify(fd2.getAll("name")), fd2.has("bin"), (fd2.get("bin") as File).name);
fd2.set("name", "Alice"); fd2.delete("note"); console.log([...fd2.keys()].join());
}

// Headers as Bun shows them (known names, set-cookie, then the others), and
// requests and responses with used bodies.
const h = new Headers({ b: "1", A: "2", "set-cookie": "x", c: "3", "Content-Type": "text/x" });
h.append("b", "4");
h.append("Set-Cookie", "y");
h.append("accept", "*/*");
console.log(h);
console.log(h.toJSON());
console.log(JSON.stringify(h));
h.delete("b");
h.set("a", "9");
h.append("b", "5");
console.log(h);
console.log(new Headers());
console.log(new Headers([["x-one", "1"]]));
console.log(new Response(null));
console.log(new Response("abc"));
const r = new Response("abc"); await r.text(); console.log(r);
console.log(new Response(null, { headers: { z: "1", a: "2" }, status: 201, statusText: "Made" }));
console.log(new Request("http://x/"));
console.log(new Request("http://x/", { method: "POST", body: "hey" }));
const q = new Request("http://x/", { method: "POST", body: "hey" }); await q.text(); console.log(q);
console.log(new Request("http://x/", { headers: { a: "1" } }));
console.log([new Response("x")]);
console.log({ r: new Response("x") });
const k = new Headers(); k.append("Cookie", "a=1"); k.append("cookie", "b=2"); k.append("x", "1"); k.append("x", "2");
console.log(k.get("cookie"), k.get("x"), [...k], k);
console.log(new Headers({ "10": "a", z: "b", "2": "c" }).toJSON());
