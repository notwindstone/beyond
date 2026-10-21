// Streams and the rest of what reads and writes in pieces: createReadStream
// and createWriteStream with their options, FileHandle's readLines,
// readableWebStream and streams, openAsBlob, Dir, glob and cp's options.
import fs from "node:fs";
import fsp from "node:fs/promises";
import { ta, t, fresh, fmt, errStr } from "./h.ts";
const W = fresh();

const text = Array.from({ length: 200 }, (_, i) => `line ${i} ` + "x".repeat(i % 37)).join("\n") + "\n";
fs.writeFileSync(W + "/text", text);
const bin = Buffer.alloc(300000);
for (let i = 0; i < bin.length; i++) bin[i] = (i * 7) & 255;
fs.writeFileSync(W + "/bin", bin);

/** A stream's events and data, once it closes (or ends, with `untilEnd`). */
function collect(s: any, untilEnd = false): Promise<any> {
  return new Promise((res, rej) => {
    const chunks: any[] = [];
    const events: string[] = [];
    const done = () => res({ events, n: chunks.length, sizes: chunks.map((c: any) => c.length).slice(0, 6), joined: typeof chunks[0] === "string" ? chunks.join("").length : Buffer.concat(chunks).length, bytesRead: s.bytesRead });
    s.on("open", () => events.push("open"));
    s.on("ready", () => events.push("ready"));
    s.on("data", (c: any) => chunks.push(c));
    s.on("close", () => {
      events.push("close");
      done();
    });
    s.on("end", () => {
      events.push("end");
      if (untilEnd) setTimeout(done, 5);
    });
    s.on("error", (e: any) => {
      events.push("error " + errStr(e));
    });
  });
}

// createReadStream
await ta("rs default", () => collect(fs.createReadStream(W + "/bin")));
await ta("rs highWaterMark", () => collect(fs.createReadStream(W + "/bin", { highWaterMark: 1000, start: 10, end: 5009 })));
await ta("rs encoding", () => collect(fs.createReadStream(W + "/text", { encoding: "utf8", highWaterMark: 100 })));
await ta("rs string encoding arg", () => collect(fs.createReadStream(W + "/text", "hex")));
await ta("rs start past end", () => collect(fs.createReadStream(W + "/text", { start: 1e6 })));
await ta("rs end only", () => collect(fs.createReadStream(W + "/text", { end: 0 })));
await ta("rs fd", () => {
  const fd = fs.openSync(W + "/text", "r");
  return collect(fs.createReadStream("ignored", { fd, start: 5, end: 9 }));
});
await ta("rs fd autoClose false", async () => {
  const fd = fs.openSync(W + "/text", "r");
  const r = await collect(fs.createReadStream("", { fd, autoClose: false, end: 3 }), true);
  const st = fs.fstatSync(fd).size;
  fs.closeSync(fd);
  return [r, st];
});
await ta("rs missing", () => collect(fs.createReadStream(W + "/nope")));
await ta("rs directory", () => collect(fs.createReadStream(W)));
t("rs bad start", () => fs.createReadStream(W + "/text", { start: -1 }));
t("rs start > end", () => fs.createReadStream(W + "/text", { start: 5, end: 2 }));
t("rs bad encoding", () => fs.createReadStream(W + "/text", { encoding: "nope" as any }));
t("rs props", () => {
  const s = fs.createReadStream(W + "/text", { start: 2 });
  const r = [s.path, s.start, s.end, s.flags, s.mode, s.pending, s.readableHighWaterMark, s.bytesRead];
  s.destroy();
  return r;
});
await ta("rs destroy before open", () => new Promise((res) => {
  const s = fs.createReadStream(W + "/text");
  const ev: string[] = [];
  s.on("open", () => ev.push("open"));
  s.on("close", () => { ev.push("close"); res(ev); });
  s.destroy();
}));
await ta("rs pause/resume", () => new Promise((res) => {
  const s = fs.createReadStream(W + "/bin", { highWaterMark: 65536 });
  let n = 0;
  s.on("data", (c) => {
    n += c.length;
    s.pause();
    setTimeout(() => s.resume(), 1);
  });
  s.on("end", () => res(n));
}));
await ta("rs async iterator", async () => {
  let n = 0, k = 0;
  for await (const c of fs.createReadStream(W + "/bin", { highWaterMark: 50000 })) {
    n += c.length;
    k++;
  }
  return [n, k];
});
await ta("rs pipe", () => new Promise((res, rej) => {
  const out = fs.createWriteStream(W + "/piped");
  fs.createReadStream(W + "/bin").pipe(out).on("finish", () => res(fs.readFileSync(W + "/piped").equals(bin))).on("error", rej);
}));

// createWriteStream
function finish(w: any): Promise<any> {
  return new Promise((res) => {
    const ev: string[] = [];
    w.on("open", () => ev.push("open"));
    w.on("ready", () => ev.push("ready"));
    w.on("finish", () => ev.push("finish"));
    w.on("error", (e: any) => ev.push("error " + errStr(e)));
    w.on("close", () => {
      ev.push("close");
      res({ ev, bytesWritten: w.bytesWritten });
    });
  });
}
await ta("ws writes", async () => {
  const w = fs.createWriteStream(W + "/w1");
  const done = finish(w);
  const r = [w.write("abc"), w.write(Buffer.from("def")), w.write(new Uint8Array([103, 104]))];
  w.end("!");
  return [r, await done, fs.readFileSync(W + "/w1", "utf8")];
});
await ta("ws flags a", async () => {
  fs.writeFileSync(W + "/w2", "start-");
  const w = fs.createWriteStream(W + "/w2", { flags: "a" });
  const done = finish(w);
  w.end("appended");
  return [await done, fs.readFileSync(W + "/w2", "utf8")];
});
await ta("ws start", async () => {
  fs.writeFileSync(W + "/w3", "0123456789");
  const w = fs.createWriteStream(W + "/w3", { flags: "r+", start: 3 });
  const done = finish(w);
  w.end("abc");
  return [await done, fs.readFileSync(W + "/w3", "utf8")];
});
await ta("ws encoding", async () => {
  const w = fs.createWriteStream(W + "/w4", { encoding: "hex" } as any);
  const done = finish(w);
  w.write("68656c6c6f");
  w.end();
  return [await done, fs.readFileSync(W + "/w4", "utf8")];
});
await ta("ws highWaterMark drain", async () => {
  const w = fs.createWriteStream(W + "/w5", { highWaterMark: 10 });
  const done = finish(w);
  const r: any[] = [w.writableHighWaterMark, w.write("12345"), w.write("67890abc"), w.writableLength];
  await new Promise((res) => w.once("drain", res));
  r.push("drained", w.writableLength);
  w.end();
  return [r, await done, fs.readFileSync(W + "/w5", "utf8")];
});
await ta("ws cork/writev", async () => {
  const w = fs.createWriteStream(W + "/w6");
  const done = finish(w);
  w.cork();
  w.write("a");
  w.write("b");
  w.write("c");
  process.nextTick(() => w.uncork());
  w.end("d");
  return [await done, fs.readFileSync(W + "/w6", "utf8")];
});
await ta("ws fd", async () => {
  const fd = fs.openSync(W + "/w7", "w");
  const w = fs.createWriteStream("", { fd });
  const done = finish(w);
  w.end("via fd");
  return [await done, fs.readFileSync(W + "/w7", "utf8")];
});
await ta("ws missing dir", () => finish(fs.createWriteStream(W + "/nodir/x")));
await ta("ws write after end", async () => {
  const w = fs.createWriteStream(W + "/w8");
  const done = finish(w);
  w.end("x");
  const e = await new Promise((res) => w.write("y", (err) => res(err)));
  return [errStr(e), await done];
});
await ta("ws destroy", async () => {
  const w = fs.createWriteStream(W + "/w9");
  const done = finish(w);
  w.write("partial");
  w.destroy();
  return [await done, w.destroyed];
});
await ta("ws flush", async () => {
  const w = fs.createWriteStream(W + "/w10", { flush: true } as any);
  const done = finish(w);
  w.end("flushed");
  return [await done, fs.readFileSync(W + "/w10", "utf8")];
});
t("ws props", () => {
  const w = fs.createWriteStream(W + "/w11", { start: 0, mode: 0o600 });
  const r = [w.path, w.start, w.flags, w.mode, w.pending, w.bytesWritten];
  w.destroy();
  return r;
});
t("ws bad start", () => fs.createWriteStream(W + "/w12", { start: -5 }));

// FileHandle
await ta("fh readLines", async () => {
  const fh = await fsp.open(W + "/text");
  const out: string[] = [];
  for await (const l of fh.readLines()) out.push(l);
  return [out.length, out[0], out[199], fh.fd === -1];
});
await ta("fh readLines crlf start", async () => {
  fs.writeFileSync(W + "/crlf", "a\r\nb\r\n\r\nc");
  const fh = await fsp.open(W + "/crlf");
  const out: string[] = [];
  for await (const l of fh.readLines({ start: 1 })) out.push(l);
  return out;
});
await ta("fh createReadStream", async () => {
  const fh = await fsp.open(W + "/bin");
  const r = await collect(fh.createReadStream({ start: 100, end: 199 }));
  return [r, fh.fd === -1];
});
await ta("fh createWriteStream", async () => {
  const fh = await fsp.open(W + "/fhw", "w");
  const w = fh.createWriteStream();
  const done = finish(w);
  w.write("one ");
  w.end("two");
  return [await done, fs.readFileSync(W + "/fhw", "utf8")];
});
await ta("fh readableWebStream", async () => {
  const fh = await fsp.open(W + "/bin");
  const rs = fh.readableWebStream();
  const reader = rs.getReader();
  let n = 0, k = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    k++;
    if (k === 1) n += 0 * (value instanceof Uint8Array ? 1 : 0);
  }
  await fh.close();
  return [n, k > 0];
});
await ta("fh readableWebStream bytes", async () => {
  const fh = await fsp.open(W + "/text");
  const rs = fh.readableWebStream({ type: "bytes" } as any);
  const chunks: Uint8Array[] = [];
  for await (const c of rs as any) chunks.push(c);
  await fh.close();
  return Buffer.concat(chunks).toString().slice(0, 20);
});
await ta("fh readableWebStream twice", async () => {
  const fh = await fsp.open(W + "/text");
  fh.readableWebStream();
  try {
    fh.readableWebStream();
  } catch (e) {
    await fh.close();
    return errStr(e);
  }
  await fh.close();
  return "no error";
});
await ta("fh read/write variants", async () => {
  const fh = await fsp.open(W + "/rw", "w+");
  const r: any[] = [];
  r.push(await fh.write("hello world"));
  r.push(await fh.write(Buffer.from("XY"), 0, 2, 3));
  r.push(await fh.read(Buffer.alloc(5), 0, 5, 0));
  r.push(await fh.read({ buffer: Buffer.alloc(4), position: 6 }));
  r.push(await fh.read());
  r.push(await fh.readv([Buffer.alloc(3), Buffer.alloc(3)], 0));
  r.push(await fh.writev([Buffer.from("A"), Buffer.from("B")], 0));
  r.push(await fh.readFile("utf8"));
  r.push((await fh.stat()).size);
  await fh.truncate(4);
  r.push(await fh.readFile({ encoding: "utf8" }));
  await fh.close();
  r.push(await fh.close().catch((e: any) => errStr(e)));
  return r;
});
await ta("fh closed ops", async () => {
  const fh = await fsp.open(W + "/text");
  await fh.close();
  const r: any[] = [];
  for (const f of [() => fh.read(Buffer.alloc(1)), () => fh.stat(), () => fh.readFile(), () => fh.write("x")]) {
    r.push(await (f as any)().then(() => "ok", (e: any) => errStr(e)));
  }
  return r;
});
await ta("fh asyncDispose", async () => {
  const fh = await fsp.open(W + "/text");
  await fh[Symbol.asyncDispose]();
  return fh.fd;
});

// openAsBlob
await ta("openAsBlob", async () => {
  const b = await fs.openAsBlob(W + "/text");
  return [b.size, b.type, (await b.text()).slice(0, 10), (await b.slice(5, 9).text())];
});
await ta("openAsBlob type", async () => {
  const b = await fs.openAsBlob(W + "/bin", { type: "application/x-test" });
  return [b.size, b.type, Buffer.from(await b.arrayBuffer()).subarray(0, 4)];
});
await ta("openAsBlob missing", () => fs.openAsBlob(W + "/nope"));
await ta("openAsBlob bad", () => fs.openAsBlob(123 as any));

// Dir
fs.mkdirSync(W + "/d/sub", { recursive: true });
for (const f of ["a", "b", "c"]) fs.writeFileSync(W + "/d/" + f, f);
await ta("Dir read", async () => {
  const d = await fsp.opendir(W + "/d");
  const names: string[] = [];
  let e;
  while ((e = await d.read())) names.push(e.name + (e.isDirectory() ? "/" : ""));
  await d.close();
  return [d.path, names.sort()];
});
await ta("Dir readSync / iterator", async () => {
  const d = fs.opendirSync(W + "/d");
  const first = d.readSync();
  const rest: string[] = [];
  for await (const e of d) rest.push(e.name);
  return [typeof first?.name, rest.length + 1];
});
await ta("Dir callbacks", () => new Promise((res) => {
  fs.opendir(W + "/d", (err, d) => {
    if (err) return res(errStr(err));
    d.read((err2, e) => {
      d.close((err3) => res([err2, typeof e?.name, err3]));
    });
  });
}));
await ta("Dir closed", async () => {
  const d = fs.opendirSync(W + "/d");
  d.closeSync();
  const r: any[] = [];
  try { d.readSync(); } catch (e) { r.push(errStr(e)); }
  r.push(await d.close().catch((e: any) => errStr(e)));
  return r;
});
await ta("Dir recursive", async () => {
  fs.writeFileSync(W + "/d/sub/deep", "x");
  const d = await fsp.opendir(W + "/d", { recursive: true });
  const names: string[] = [];
  for await (const e of d) names.push(e.parentPath.slice(W.length) + "/" + e.name);
  return names.sort();
});
await ta("Dir bufferSize", async () => {
  const d = await fsp.opendir(W + "/d", { bufferSize: 1 });
  let n = 0;
  for await (const _ of d) n++;
  return n;
});
t("Dir bad bufferSize", () => fs.opendirSync(W + "/d", { bufferSize: 0 }));
await ta("Dir explicit resource management", async () => {
  let d: any;
  {
    await using dir = await fsp.opendir(W + "/d");
    d = dir;
  }
  return await d.close().catch((e: any) => errStr(e));
});

// glob
fs.mkdirSync(W + "/g/x/y", { recursive: true });
for (const f of ["a.ts", "b.js", "x/c.ts", "x/y/d.ts", ".hidden.ts"]) fs.writeFileSync(W + "/g/" + f, "");
t("globSync", () => fs.globSync("**/*.ts", { cwd: W + "/g" }).sort());
t("globSync array", () => fs.globSync(["*.ts", "*.js"], { cwd: W + "/g" }).sort());
t("globSync exclude", () => fs.globSync("**/*.ts", { cwd: W + "/g", exclude: (p: string) => p.includes("y") }).sort());
t("globSync exclude array", () => fs.globSync("**/*.ts", { cwd: W + "/g", exclude: ["x/**"] } as any).sort());
t("globSync withFileTypes", () => fs.globSync("x/*", { cwd: W + "/g", withFileTypes: true }).map((d: any) => [d.name, d.isDirectory()]).sort());
await ta("glob cb", () => new Promise((res) => fs.glob("*.{ts,js}", { cwd: W + "/g" }, (err, m) => res([err, m.sort()]))));
await ta("fsp.glob", async () => {
  const out: string[] = [];
  for await (const m of fsp.glob("**", { cwd: W + "/g" })) out.push(m);
  return out.sort();
});
t("globSync bad", () => fs.globSync(123 as any));

// cp options
fs.mkdirSync(W + "/src/inner", { recursive: true });
fs.writeFileSync(W + "/src/one.txt", "1");
fs.writeFileSync(W + "/src/two.log", "2");
fs.writeFileSync(W + "/src/inner/three.txt", "3");
fs.symlinkSync("one.txt", W + "/src/link");
function tree(dir: string): string[] {
  return (fs.readdirSync(dir, { recursive: true }) as string[]).sort();
}
t("cpSync filter", () => {
  fs.cpSync(W + "/src", W + "/c1", { recursive: true, filter: (s: string) => !s.endsWith(".log") });
  return tree(W + "/c1");
});
t("cpSync dir without recursive", () => fs.cpSync(W + "/src", W + "/c2"));
t("cpSync exists errorOnExist", () => {
  fs.cpSync(W + "/src/one.txt", W + "/c3.txt");
  return fs.cpSync(W + "/src/one.txt", W + "/c3.txt", { force: false, errorOnExist: true });
});
t("cpSync force false", () => {
  fs.writeFileSync(W + "/c4.txt", "keep");
  fs.cpSync(W + "/src/one.txt", W + "/c4.txt", { force: false });
  return fs.readFileSync(W + "/c4.txt", "utf8");
});
t("cpSync dereference", () => {
  fs.cpSync(W + "/src", W + "/c5", { recursive: true, dereference: true });
  return [fs.lstatSync(W + "/c5/link").isSymbolicLink(), fs.readFileSync(W + "/c5/link", "utf8")];
});
t("cpSync verbatimSymlinks", () => {
  fs.cpSync(W + "/src", W + "/c6", { recursive: true, verbatimSymlinks: true });
  return fs.readlinkSync(W + "/c6/link");
});
t("cpSync into itself", () => fs.cpSync(W + "/src", W + "/src/inner/x", { recursive: true }));
t("cpSync preserveTimestamps", () => {
  fs.utimesSync(W + "/src/one.txt", 1000, 2000);
  fs.cpSync(W + "/src/one.txt", W + "/c7.txt", { preserveTimestamps: true });
  return fs.statSync(W + "/c7.txt").mtimeMs;
});
await ta("fsp.cp filter async", async () => {
  await fsp.cp(W + "/src", W + "/c8", { recursive: true, filter: async (s: string) => !s.endsWith(".txt") || s.includes("inner") });
  return tree(W + "/c8");
});
await ta("cp cb", () => new Promise((res) => fs.cp(W + "/src", W + "/c9", { recursive: true }, (err) => res([err, tree(W + "/c9")]))));
await ta("fsp.cp missing", () => fsp.cp(W + "/nope", W + "/c10"));
t("cpSync bad mode", () => fs.cpSync(W + "/src/one.txt", W + "/c11", { mode: -1 } as any));
console.log("done", fmt(null));
