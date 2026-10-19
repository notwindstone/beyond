// The Node.js modules and Bun APIs build scripts use. Run in this directory
// with a scratch directory as its argument; the expected output is Bun's.
import { Buffer } from "node:buffer";
import { EventEmitter, once } from "node:events";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { createRequire, isBuiltin } from "node:module";
import * as os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isMainThread } from "node:worker_threads";

const work = process.argv[2];
const shown = (s: string) => s.replaceAll(work, "<work>").replaceAll(process.cwd(), ".");

// path
console.log(path.join("/a/b", "../c", "./d.ts"), path.resolve("/x", "y", "..", "z"), path.relative("/a/b/c", "/a/d"));
console.log(path.dirname("/a/b/c.ts"), path.basename("/a/b/c.ts", ".ts"), path.extname("x.tar.gz"), path.sep, path.delimiter);
console.log(JSON.stringify(path.parse("/home/u/file.txt")), path.format({ dir: "/x", base: "y.js" }), path.isAbsolute("./a"));
console.log(path.normalize("/a//b/../c/."), path.posix === path, typeof path.win32?.join);

// url
const url = pathToFileURL("/tmp/a b.txt");
console.log(url.href, fileURLToPath("file:///tmp/a%20b.txt"), fileURLToPath(url) === "/tmp/a b.txt");

// fs
fs.mkdirSync(path.join(work, "dir/sub"), { recursive: true });
fs.writeFileSync(path.join(work, "dir/a.txt"), "alpha");
fs.writeFileSync(path.join(work, "dir/sub/b.bin"), new Uint8Array([1, 2, 3]));
fs.appendFileSync(path.join(work, "dir/a.txt"), "+beta");
console.log(fs.readFileSync(path.join(work, "dir/a.txt"), "utf8"), [...fs.readFileSync(path.join(work, "dir/sub/b.bin"))]);
console.log(fs.existsSync(path.join(work, "dir")), fs.existsSync(path.join(work, "nope")), fs.readdirSync(path.join(work, "dir")).sort());
const dirents = fs.readdirSync(path.join(work, "dir"), { withFileTypes: true }).sort((x, y) => x.name.localeCompare(y.name));
console.log(dirents.map((d) => `${d.name}:${d.isDirectory() ? "dir" : d.isFile() ? "file" : "?"}`).join(" "));
const st = fs.statSync(path.join(work, "dir/a.txt"));
console.log(st.size, st.isFile(), st.isDirectory(), typeof st.mtimeMs, st.mtime instanceof Date);
try {
  fs.readFileSync(path.join(work, "missing.txt"));
} catch (e: any) {
  console.log(e.code, e.syscall, e.errno, shown(e.path), shown(e.message));
}
fs.renameSync(path.join(work, "dir/a.txt"), path.join(work, "dir/c.txt"));
fs.copyFileSync(path.join(work, "dir/c.txt"), path.join(work, "dir/d.txt"));
fs.unlinkSync(path.join(work, "dir/c.txt"));
console.log(fs.readdirSync(path.join(work, "dir")).sort(), shown(fs.realpathSync(path.join(work, "dir/../dir/d.txt"))));
await fsp.writeFile(path.join(work, "p.json"), JSON.stringify({ ok: true }));
console.log(JSON.parse(await fsp.readFile(path.join(work, "p.json"), "utf8")), (await fsp.stat(path.join(work, "p.json"))).size);
await fsp.rm(path.join(work, "dir"), { recursive: true, force: true });
console.log(fs.existsSync(path.join(work, "dir")), typeof fs.promises.readFile);

// buffer
const buf = Buffer.from("héllo wörld");
console.log(buf.length, buf.toString("hex"), buf.toString("base64"), Buffer.from("aGk=", "base64").toString());
console.log(Buffer.concat([Buffer.from("a"), Buffer.from("b")]).toString(), Buffer.byteLength("héllo"), buf.subarray(0, 5).toString());
console.log(Buffer.isBuffer(buf), buf.equals(Buffer.from("héllo wörld")), Buffer.alloc(3, 1).join(","), buf instanceof Uint8Array);

// events
const em = new EventEmitter();
const got: string[] = [];
em.on("x", (a: number) => got.push("on " + a));
em.once("x", (a: number) => got.push("once " + a));
em.emit("x", 1);
em.emit("x", 2);
console.log(got.join(", "), em.listenerCount("x"), em.eventNames());
setTimeout(() => em.emit("later", 42), 1);
console.log("once", await once(em, "later"));

// os, process, worker_threads, module
console.log(JSON.stringify(os.EOL), os.platform() === process.platform, typeof os.cpus().length, typeof os.tmpdir(), os.endianness());
console.log(typeof process.env.PATH, process.argv.length, typeof process.pid, typeof process.hrtime.bigint(), process.cwd() === path.resolve("."));
console.log(isMainThread, isBuiltin("fs"), isBuiltin("node:path"), isBuiltin("nope"), typeof process.getBuiltinModule("node:path").join);
const require = createRequire(import.meta.url);
const cjs = require("./cjs.cjs");
console.log(cjs.joined, JSON.stringify(cjs.data), cjs.self, require("node:path") === path || typeof require("node:path").join);

// import.meta, and import() of a computed specifier (made JavaScript then)
console.log(shown(import.meta.dir), import.meta.file, shown(import.meta.path), shown(import.meta.resolve("./dynamic.ts")));
const name = ["dynamic", "ts"].join(".");
const dyn = await import("./" + name);
console.log(dyn.greeting, dyn.default(21));

// Bun.file and Bun.write
const target = path.join(work, "out/w.txt");
console.log(await Bun.write(target, "written"), await Bun.file(target).text(), Bun.file(target).size, Bun.file(target).type);
console.log(await Bun.file(path.join(work, "nope")).exists(), await Bun.file(target).exists(), (await Bun.file("data.json").json()).n);
