import fs from "node:fs";
const d = (process.env.TMPDIR ?? "/tmp") + "/beyond-fs/wa-" + process.argv[2];
fs.rmSync(d, { recursive: true, force: true });
fs.mkdirSync(d, { recursive: true });
const ac = new AbortController();
const w1 = fs.watch(d, { signal: ac.signal }, (t, f) => console.log("w1", t, f));
w1.on("error", (e: any) => console.log("w1 error", e.name, e.message));
w1.on("close", () => console.log("w1 close"));
const pre = AbortSignal.abort();
const w2 = fs.watch(d, { signal: pre }, (t, f) => console.log("w2", t, f));
w2.on("error", (e: any) => console.log("w2 error", e.name));
w2.on("close", () => console.log("w2 close"));
const w3 = fs.watch(d, (t, f) => { console.log("w3", t, f); w3.close(); console.log("w3 closed in listener"); });
w3.on("close", () => console.log("w3 close"));
console.log("sync end");
setTimeout(() => {
  ac.abort();
  console.log("aborted");
  fs.writeFileSync(d + "/x", "1");
  setTimeout(() => {
    const w4 = fs.watch(d, () => {});
    w4.unref();
    console.log("unref'd; exiting");
  }, 50);
}, 30);
