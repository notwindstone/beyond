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
