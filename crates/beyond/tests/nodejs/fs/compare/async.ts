import fs from "node:fs";
import fsp from "node:fs/promises";
import { ta, tcb, fresh, fmt } from "./h.ts";
const W = fresh();

// ordering against microtasks, nextTick, timers
{
  const log: string[] = [];
  fs.stat(W, () => log.push("cb-stat"));
  fsp.stat(W).then(() => log.push("promise-stat"));
  fs.readFile(W + "/nope", () => log.push("cb-readFile-err"));
  Promise.resolve().then(() => log.push("promise"));
  setTimeout(() => log.push("timeout"), 0);
  queueMicrotask(() => log.push("microtask"));
  log.push("sync");
  await new Promise((r) => setTimeout(r, 30));
  // (Bun's completions come in the order its thread pool finishes them,
  // before or after a timer of 1 ms as they finish: only that they come
  // after the synchronous code and the microtasks is certain.)
  const fsEvents = log.filter((x) => x.startsWith("cb-") || x === "promise-stat");
  const rest = log.filter((x) => !fsEvents.includes(x));
  console.log("order:", rest.join(" "), "| fs:", fsEvents.sort().join(" "), "| first fs at least", log.findIndex((x) => fsEvents.includes(x)) >= 3);
}
{
  // a callback's microtasks run before the next completion
  const log: string[] = [];
  fs.stat(W, () => { log.push("cb1"); Promise.resolve().then(() => log.push("cb1-micro")); });
  fs.stat(W, () => log.push("cb2"));
  await new Promise((r) => setTimeout(r, 30));
  // (In whichever order the two complete.)
  console.log("order2:", [...log].sort().join(" "), "| micro right after its callback:", log.indexOf("cb1-micro") === log.indexOf("cb1") + 1);
}
{
  // callback arguments
  await tcb("access cb", (cb) => fs.access(W, cb));
  await tcb("access cb err", (cb) => fs.access(W + "/nope", cb));
  await tcb("exists cb", (cb) => fs.exists(W, cb));
  await tcb("exists cb no", (cb) => fs.exists(W + "/nope", cb));
  await tcb("writeFile cb", (cb) => fs.writeFile(W + "/a", "data", cb));
  await tcb("writeFile cb opts", (cb) => fs.writeFile(W + "/b", "6869", "hex", cb));
  await tcb("appendFile cb", (cb) => fs.appendFile(W + "/a", "+more", cb));
  await tcb("readFile cb", (cb) => fs.readFile(W + "/a", "utf8", cb));
  await tcb("readFile cb buf", (cb) => fs.readFile(W + "/b", cb));
  await tcb("readFile cb err", (cb) => fs.readFile(W + "/nope", cb));
  await tcb("readFile cb dir", (cb) => fs.readFile(W, cb));
  await tcb("stat cb", (cb) => fs.stat(W + "/a", (e, s) => cb(e, s.size, s.isFile())));
  await tcb("stat cb bigint", (cb) => fs.stat(W + "/a", { bigint: true }, (e, s) => cb(e, s.size)));
  await tcb("stat cb err", (cb) => fs.stat(W + "/nope", cb));
  await tcb("lstat cb", (cb) => fs.lstat(W + "/a", (e, s) => cb(e, s.isFile())));
  await tcb("statfs cb", (cb) => fs.statfs(W, (e, s) => cb(e, typeof s.bsize)));
  await tcb("mkdir cb", (cb) => fs.mkdir(W + "/d", cb));
  await tcb("mkdir cb rec", (cb) => fs.mkdir(W + "/d/e/f", { recursive: true }, cb));
  await tcb("mkdir cb err", (cb) => fs.mkdir(W + "/d", cb));
  await tcb("mkdtemp cb", (cb) => fs.mkdtemp(W + "/t-", (e, p) => cb(e, p.length - (W + "/t-").length)));
  await tcb("readdir cb", (cb) => fs.readdir(W + "/d", cb));
  await tcb("readdir cb types", (cb) => fs.readdir(W + "/d", { withFileTypes: true }, (e, l) => cb(e, l.map((d: any) => d.name + d.isDirectory()))));
  await tcb("readdir cb rec", (cb) => fs.readdir(W + "/d", { recursive: true }, (e, l) => cb(e, l.sort())));
  await tcb("readdir cb err", (cb) => fs.readdir(W + "/nope", cb));
  await tcb("symlink cb", (cb) => fs.symlink("a", W + "/ln", cb));
  await tcb("symlink cb type", (cb) => fs.symlink("a", W + "/ln2", "file", cb));
  await tcb("readlink cb", (cb) => fs.readlink(W + "/ln", cb));
  await tcb("readlink cb buf", (cb) => fs.readlink(W + "/ln", "buffer", cb));
  await tcb("realpath cb", (cb) => fs.realpath(W + "/ln", cb));
  await tcb("realpath.native cb", (cb) => fs.realpath.native(W + "/ln", cb));
  await tcb("realpath cb err", (cb) => fs.realpath(W + "/nope", cb));
  await tcb("link cb", (cb) => fs.link(W + "/a", W + "/hard", cb));
  await tcb("rename cb", (cb) => fs.rename(W + "/hard", W + "/hard2", cb));
  await tcb("rename cb err", (cb) => fs.rename(W + "/nope", W + "/x", cb));
  await tcb("unlink cb", (cb) => fs.unlink(W + "/hard2", cb));
  await tcb("chmod cb", (cb) => fs.chmod(W + "/a", 0o600, cb));
  await tcb("chown cb", (cb) => fs.chown(W + "/a", -1, -1, cb));
  await tcb("lchown cb", (cb) => fs.lchown(W + "/ln", -1, -1, cb));
  await tcb("utimes cb", (cb) => fs.utimes(W + "/a", 1, 2, cb));
  await tcb("lutimes cb", (cb) => fs.lutimes(W + "/ln", 1, 2, cb));
  await tcb("truncate cb", (cb) => fs.truncate(W + "/a", 2, cb));
  await tcb("truncate cb nolen", (cb) => fs.truncate(W + "/b", cb));
  await tcb("copyFile cb", (cb) => fs.copyFile(W + "/a", W + "/c", cb));
  await tcb("copyFile cb excl", (cb) => fs.copyFile(W + "/a", W + "/c", fs.constants.COPYFILE_EXCL, cb));
  await tcb("rm cb", (cb) => fs.rm(W + "/c", cb));
  await tcb("rm cb dir", (cb) => fs.rm(W + "/d", cb));
  await tcb("rm cb rec", (cb) => fs.rm(W + "/d", { recursive: true }, cb));
  await tcb("rmdir cb err", (cb) => fs.rmdir(W + "/nope", cb));
  await tcb("cp cb", (cb) => fs.cp(W + "/a", W + "/cp", cb));
  let fd = 0;
  await tcb("open cb", (cb) => fs.open(W + "/f", "w+", (e, f) => { fd = f; cb(e, typeof f); }));
  await tcb("open cb noflags", (cb) => fs.open(W + "/a", (e, f) => { fs.closeSync(f); cb(e, typeof f); }));
  await tcb("open cb err", (cb) => fs.open(W + "/nope", "r", cb));
  await tcb("write cb", (cb) => fs.write(fd, Buffer.from("hello world"), (e, n, b) => cb(e, n, b)));
  await tcb("write cb off", (cb) => fs.write(fd, Buffer.from("XYZ"), 1, 2, 0, cb));
  await tcb("write cb str", (cb) => fs.write(fd, "str", cb));
  await tcb("write cb str pos", (cb) => fs.write(fd, "Q", 4, cb));
  await tcb("write cb str enc", (cb) => fs.write(fd, "41", 5, "hex", cb));
  await tcb("write cb opts", (cb) => fs.write(fd, Buffer.from("abc"), { offset: 1, length: 2, position: 7 }, cb));
  await tcb("read cb", (cb) => fs.read(fd, Buffer.alloc(5), 0, 5, 0, (e, n, b) => cb(e, n, b)));
  await tcb("read cb opts", (cb) => fs.read(fd, { buffer: Buffer.alloc(4), position: 2 }, (e, n, b) => cb(e, n, b)));
  await tcb("read cb buf opts", (cb) => fs.read(fd, Buffer.alloc(4), { position: 1, length: 2 }, (e, n, b) => cb(e, n, b)));
  await tcb("read cb only", (cb) => fs.read(fd, (e, n, b) => cb(e, n, b.length)));
  await tcb("readv cb", (cb) => fs.readv(fd, [Buffer.alloc(2), Buffer.alloc(3)], 0, cb));
  await tcb("writev cb", (cb) => fs.writev(fd, [Buffer.from("1"), Buffer.from("2")], 0, cb));
  await tcb("fstat cb", (cb) => fs.fstat(fd, (e, s) => cb(e, s.size)));
  await tcb("fsync cb", (cb) => fs.fsync(fd, cb));
  await tcb("fdatasync cb", (cb) => fs.fdatasync(fd, cb));
  await tcb("ftruncate cb", (cb) => fs.ftruncate(fd, 4, cb));
  await tcb("fchmod cb", (cb) => fs.fchmod(fd, 0o644, cb));
  await tcb("fchown cb", (cb) => fs.fchown(fd, -1, -1, cb));
  await tcb("futimes cb", (cb) => fs.futimes(fd, 3, 4, cb));
  await tcb("readFile fd cb", (cb) => fs.readFile(fd, "utf8", cb));
  await tcb("close cb", (cb) => fs.close(fd, cb));
  await tcb("close cb err", (cb) => fs.close(fd, cb));
  await tcb("fstat cb err", (cb) => fs.fstat(fd, cb));
  await tcb("opendir cb", (cb) => fs.opendir(W, (e, d) => { const n = []; let x; while ((x = d.readSync())) n.push(x.name); d.closeSync(); cb(e, n.filter((x: string) => !x.startsWith("t-")).sort()); }));
  await tcb("opendir cb err", (cb) => fs.opendir(W + "/a", cb));
}
// promises
await ta("p access", () => fsp.access(W + "/a"));
await ta("p access err", () => fsp.access(W + "/nope"));
await ta("p exists", () => (fsp as any).exists?.(W));
await ta("p readFile", () => fsp.readFile(W + "/a", "utf8"));
await ta("p readFile err", () => fsp.readFile(W + "/nope"));
await ta("p writeFile", () => fsp.writeFile(W + "/pw", "abc"));
await ta("p writeFile iter", () => fsp.writeFile(W + "/pw2", ["a", "b", "c"]).then(() => fs.readFileSync(W + "/pw2", "utf8")));
await ta("p appendFile", () => fsp.appendFile(W + "/pw", "def").then(() => fs.readFileSync(W + "/pw", "utf8")));
await ta("p stat", () => fsp.stat(W + "/pw").then((s) => s.size));
await ta("p lstat", () => fsp.lstat(W + "/ln").then((s) => s.isSymbolicLink()));
await ta("p stat err", () => fsp.stat(W + "/nope"));
await ta("p statfs", () => fsp.statfs(W).then((s) => typeof s.type));
await ta("p mkdir", () => fsp.mkdir(W + "/pd/x", { recursive: true }));
await ta("p mkdtemp", () => fsp.mkdtemp(W + "/pt-").then((p) => p.length - (W + "/pt-").length));
await ta("p readdir", () => fsp.readdir(W + "/pd"));
await ta("p readdir types", () => fsp.readdir(W + "/pd", { withFileTypes: true }).then((l) => l.map((d) => d.name + d.isDirectory())));
await ta("p readdir rec", () => fsp.readdir(W + "/pd", { recursive: true }));
await ta("p readlink", () => fsp.readlink(W + "/ln"));
await ta("p realpath", () => fsp.realpath(W + "/ln"));
await ta("p symlink", () => fsp.symlink("pw", W + "/pln"));
await ta("p link", () => fsp.link(W + "/pw", W + "/plink"));
await ta("p rename", () => fsp.rename(W + "/plink", W + "/plink2"));
await ta("p unlink", () => fsp.unlink(W + "/plink2"));
await ta("p chmod", () => fsp.chmod(W + "/pw", 0o644));
await ta("p chown", () => fsp.chown(W + "/pw", -1, -1));
await ta("p lchown", () => fsp.lchown(W + "/pln", -1, -1));
await ta("p utimes", () => fsp.utimes(W + "/pw", 1, 2));
await ta("p lutimes", () => fsp.lutimes(W + "/pln", 1, 2));
await ta("p truncate", () => fsp.truncate(W + "/pw", 1));
await ta("p copyFile", () => fsp.copyFile(W + "/pw", W + "/pc"));
await ta("p cp", () => fsp.cp(W + "/pd", W + "/pd2", { recursive: true }).then(() => fs.readdirSync(W + "/pd2")));
await ta("p rm", () => fsp.rm(W + "/pd2", { recursive: true }));
await ta("p rm err", () => fsp.rm(W + "/pd2"));
await ta("p rmdir", () => fsp.rmdir(W + "/pd/x"));
await ta("p opendir", async () => { const d = await fsp.opendir(W + "/pd"); const n = []; for await (const e of d) n.push(e.name); return n; });
await ta("p filehandle", async () => {
  const fh = await fsp.open(W + "/fh", "w+");
  const r: any[] = [typeof fh.fd];
  r.push((await fh.write(Buffer.from("filehandle!"))).bytesWritten);
  r.push((await fh.write("str", 0)).bytesWritten);
  r.push((await fh.read(Buffer.alloc(4), 0, 4, 0)).bytesRead);
  r.push((await fh.read({ buffer: Buffer.alloc(3), position: 1 })).buffer.toString());
  r.push((await fh.stat()).size);
  await fh.truncate(5);
  r.push(await fh.readFile("utf8"));
  await fh.writeFile("whole");
  r.push((await fh.readv([Buffer.alloc(2), Buffer.alloc(2)], 0)).bytesRead);
  r.push((await fh.writev([Buffer.from("A"), Buffer.from("B")], 0)).bytesWritten);
  await fh.chmod(0o640);
  await fh.utimes(1, 2);
  await fh.sync();
  await fh.datasync();
  await fh.appendFile("++");
  await fh.close();
  r.push(fs.readFileSync(W + "/fh", "utf8"));
  return r;
});
await ta("p filehandle readLines/stream", async () => {
  fs.writeFileSync(W + "/lines", "one\ntwo\nthree\n");
  const fh = await fsp.open(W + "/lines");
  const out = [];
  for await (const l of fh.readLines()) out.push(l);
  return out;
});
await ta("p open err", () => fsp.open(W + "/nope"));
await ta("p validation", () => fsp.stat(123 as any));
await ta("p readFile aborted", () => { const c = new AbortController(); c.abort(); return fsp.readFile(W + "/pw", { signal: c.signal }); });
await tcb("readFile cb aborted", (cb) => { const c = new AbortController(); c.abort(); fs.readFile(W + "/pw", { signal: c.signal }, cb); });
// streams
await ta("createReadStream", () => new Promise((res, rej) => { const chunks: any[] = []; fs.createReadStream(W + "/lines", { encoding: "utf8" }).on("data", (c) => chunks.push(c)).on("end", () => res(chunks.join(""))).on("error", rej); }));
await ta("createReadStream range", () => new Promise((res, rej) => { const chunks: any[] = []; fs.createReadStream(W + "/lines", { start: 4, end: 6 }).on("data", (c) => chunks.push(c)).on("end", () => res(Buffer.concat(chunks).toString())).on("error", rej); }));
await ta("createWriteStream", () => new Promise((res, rej) => { const w = fs.createWriteStream(W + "/ws"); w.write("abc"); w.end("def", () => res(fs.readFileSync(W + "/ws", "utf8"))); w.on("error", rej); }));
await ta("createReadStream err", () => new Promise((res) => { fs.createReadStream(W + "/nope").on("error", (e) => res(e)); }));
console.log("done", fmt(null));
