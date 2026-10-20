import fs from "node:fs";
const base = (process.env.TMPDIR ?? "/tmp") + "/beyond-fs/we-" + process.argv[2];
fs.rmSync(base, { recursive: true, force: true });
fs.mkdirSync(base + "/d/sub", { recursive: true });
fs.mkdirSync(base + "/r/a/b", { recursive: true });
fs.writeFileSync(base + "/f.txt", "x");
fs.writeFileSync(base + "/r/a/b/deep.txt", "x");
const log: string[] = [];
const fmt = (v: any) => v === null ? "null" : v === undefined ? "undef" : Buffer.isBuffer(v) ? "buf:" + v.toString() : typeof v === "string" ? v : v instanceof Error ? `${(v as any).code}:${v.message}` : String(v);
function W(name: string, path: string, opts: any) {
  const w = fs.watch(path, opts, (t, f) => log.push(`${name} listener ${t} ${fmt(f)}`));
  w.on("change", (t, f) => log.push(`${name} change ${t} ${fmt(f)}`));
  w.on("error", (e) => log.push(`${name} error ${fmt(e)}`));
  w.on("close", () => log.push(`${name} close`));
  return w;
}
const wd = W("dir", base + "/d", {});
const wf = W("file", base + "/f.txt", {});
const wr = W("rec", base + "/r", { recursive: true });
const wb = W("buf", base + "/d", { encoding: "buffer" });
const wh = W("hex", base + "/d", "hex");
const steps: [string, () => void][] = [
  ["create", () => fs.writeFileSync(base + "/d/a.txt", "1")],
  ["modify", () => fs.appendFileSync(base + "/d/a.txt", "2")],
  ["rename", () => fs.renameSync(base + "/d/a.txt", base + "/d/b.txt")],
  ["chmod", () => fs.chmodSync(base + "/d/b.txt", 0o600)],
  ["unlink", () => fs.unlinkSync(base + "/d/b.txt")],
  ["mkdir", () => fs.mkdirSync(base + "/d/new")],
  ["sub write", () => fs.writeFileSync(base + "/d/sub/x.txt", "1")],
  ["file modify", () => fs.writeFileSync(base + "/f.txt", "yy")],
  ["file chmod", () => fs.chmodSync(base + "/f.txt", 0o600)],
  ["rec deep", () => fs.writeFileSync(base + "/r/a/b/deep.txt", "2")],
  ["rec new tree", () => { fs.mkdirSync(base + "/r/n1/n2", { recursive: true }); }],
  ["rec new file", () => fs.writeFileSync(base + "/r/n1/n2/z.txt", "1")],
  ["rec rm", () => fs.rmSync(base + "/r/a", { recursive: true })],
  ["close hex", () => { wh.close(); fs.writeFileSync(base + "/d/c.txt", "1"); }],
  ["file unlink", () => fs.unlinkSync(base + "/f.txt")],
  ["dir rm", () => fs.rmSync(base + "/d", { recursive: true })],
];
let i = 0;
function next() {
  if (log.length) { console.log(log.sort().join("\n")); log.length = 0; }
  if (i === steps.length) {
    wd.close(); wf.close(); wr.close(); wb.close();
    setTimeout(() => { console.log(log.sort().join("\n")); }, 50);
    return;
  }
  const [n, f] = steps[i++];
  console.log("--", n);
  f();
  setTimeout(next, 80);
}
setTimeout(next, 50);
