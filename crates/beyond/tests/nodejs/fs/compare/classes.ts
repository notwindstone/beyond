import fs from "node:fs";
import { t, fresh, fmt } from "./h.ts";
const W = fresh();
fs.writeFileSync(W + "/f", "x");
const desc = (o: any) => Object.getOwnPropertyNames(o).map((k) => { const d = Object.getOwnPropertyDescriptor(o, k)!; return k + (d.get ? ":get" : "") + (d.set ? ":set" : "") + (d.enumerable ? ":e" : "") + (d.writable ? ":w" : "") + (d.configurable ? ":c" : ""); }).join(",");
const st = fs.statSync(W + "/f");
t("stats own", () => desc(st));
t("stats proto", () => desc(Object.getPrototypeOf(st)));
t("stats tag", () => [Object.prototype.toString.call(st), String(st)]);
t("stats instanceof", () => [st instanceof fs.Stats, st.constructor === fs.Stats, fs.Stats.name, fs.Stats.length, typeof fs.Stats]);
t("stats mtime", () => { const s = fs.statSync(W + "/f"); const d = s.mtime; return [d instanceof Date, d.getTime() === Math.floor(s.mtimeMs) || d.getTime() === Math.round(s.mtimeMs), Object.keys(s).includes("mtime"), s.mtime === d]; });
t("stats set atime", () => { const s = fs.statSync(W + "/f"); (s as any).atime = 5; return [s.atime, Object.keys(s).slice(-1)]; });
t("new Stats", () => { const s = new fs.Stats(1, 0o100644, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14); return [Object.keys(s).map((k) => k + "=" + (s as any)[k]).join(" "), s.isFile(), s.isDirectory(), s.atime.getTime(), s.birthtime.getTime()]; });
t("Stats call", () => { const s = (fs.Stats as any)(1, 0o40000); return [s.dev, s.mode, s.isDirectory(), s instanceof fs.Stats]; });
t("Stats subclass", () => { class S extends (fs.Stats as any) {} const s = new S(1, 0o100000); return [s instanceof S, s.isFile(), Object.keys(s).length]; });
t("Stats proto methods on proto", () => [(fs.Stats.prototype as any).isFile(), fs.Stats.prototype.mtime instanceof Date]);
t("stats isFile this", () => [st.isFile.call({ mode: 0o100000 }), st.isFile.call(1 as any), st.isFile.call({})]);
const bs = fs.statSync(W + "/f", { bigint: true });
t("bigstats own", () => desc(bs));
t("bigstats proto", () => desc(Object.getPrototypeOf(bs)));
t("bigstats tag", () => [Object.prototype.toString.call(bs), bs.constructor.name, bs instanceof fs.Stats]);
t("bigstats types", () => Object.keys(bs).map((k) => typeof (bs as any)[k]).join(","));
t("bigstats dates", () => [bs.mtime instanceof Date, bs.mtime.getTime() === Number(bs.mtimeMs), bs.mtimeNs / 1000000n === bs.mtimeMs]);
t("bigstats methods", () => [bs.isFile(), bs.isDirectory()]);
const dir = fs.readdirSync(W, { withFileTypes: true })[0];
t("dirent own", () => desc(dir));
t("dirent proto", () => desc(Object.getPrototypeOf(dir)));
t("dirent misc", () => [Object.prototype.toString.call(dir), dir instanceof fs.Dirent, dir.constructor === fs.Dirent, fs.Dirent.name, fs.Dirent.length, Object.getOwnPropertySymbols(dir).length, JSON.stringify(dir), Object.keys({ ...dir }).join()]);
t("new Dirent", () => { const d = new fs.Dirent("n", 2, "/p" as any); return [d.name, d.path, d.parentPath, d.isDirectory(), d.isFile(), Object.keys(d).join()]; });
t("new Dirent types", () => [1, 2, 3, 4, 5, 6, 7, 0, 99, "1"].map((ty) => { const d = new fs.Dirent("n", ty as any, "/" as any); return [d.isFile(), d.isDirectory(), d.isSymbolicLink(), d.isFIFO(), d.isSocket(), d.isCharacterDevice(), d.isBlockDevice()].map(Number).join(""); }));
t("Dirent subclass", () => { class D extends (fs.Dirent as any) { x() { return 1; } } const d: any = new D("a", 1, "/"); return [d instanceof D, d.isFile(), d.x(), d.name]; });
t("Dirent methods on other", () => [fs.Dirent.prototype.isFile.call({}), fs.Dirent.prototype.isFile.call(5 as any)]);
const sfs = fs.statfsSync(W);
t("statfs own", () => desc(sfs));
t("statfs proto", () => [desc(Object.getPrototypeOf(sfs)), Object.prototype.toString.call(sfs), Object.prototype.toString.call(fs.statfsSync(W, { bigint: true }))]);
t("statfs types", () => Object.keys(fs.statfsSync(W, { bigint: true })).map((k) => typeof (fs.statfsSync(W, { bigint: true }) as any)[k]).join(","));
// watchFile
await new Promise<void>((resolve) => {
  const p = W + "/watched";
  fs.writeFileSync(p, "1");
  let n = 0;
  const listener = (curr: any, prev: any) => {
    n++;
    console.log("watchFile change", n, curr.size, prev.size, curr instanceof fs.Stats);
    if (n === 1) fs.writeFileSync(p, "333");
    else { fs.unwatchFile(p, listener); resolve(); }
  };
  const w = fs.watchFile(p, { interval: 20 }, listener);
  console.log("watcher", typeof w.ref, typeof w.unref, typeof (w as any).start);
  setTimeout(() => fs.writeFileSync(p, "22"), 60);
});
await new Promise<void>((resolve) => {
  const p = W + "/missing";
  fs.watchFile(p, { interval: 20, bigint: true }, (curr: any, prev: any) => {
    console.log("watchFile missing", curr.size, prev.size, curr.mtimeMs, typeof curr.mtimeNs);
    fs.unwatchFile(p);
    resolve();
  });
});
t("watch", () => fs.watch(W));
console.log("done", fmt(null));
process.exit(0);
