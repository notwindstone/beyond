import fsp from "node:fs/promises";
import fs from "node:fs";
const dest = (process.env.TMPDIR ?? "/tmp") + "/beyond-fs-wfa.txt";
const buffer = Buffer.from("abc".repeat(1000));
(async () => {
  for (const [n, f] of [
    ["writeFile", (signal: any) => fsp.writeFile(dest, buffer, { signal })],
    ["readFile", (signal: any) => fsp.readFile(dest, { signal })],
    ["appendFile", (signal: any) => fsp.appendFile(dest, buffer, { signal })],
    ["writeFile str", (signal: any) => fsp.writeFile(dest, "abc", { signal })],
    ["fh.readFile", async (signal: any) => { const fh = await fsp.open(dest); try { return await fh.readFile({ signal }); } finally { await fh.close(); } }],
    ["fh.writeFile", async (signal: any) => { const fh = await fsp.open(dest, "w"); try { return await fh.writeFile(buffer, { signal }); } finally { await fh.close(); } }],
  ] as [string, (s: any) => Promise<any>][]) {
    const c = new AbortController();
    process.nextTick(() => c.abort());
    try { const r = await f(c.signal); console.log(n, "resolved", typeof r); } catch (e: any) { console.log(n, "rejected", e.name, e.code, e.message, e.cause?.name); }
  }
  for (const n of ["cb readFile", "cb writeFile"]) {
    const c = new AbortController();
    await new Promise<void>((res) => {
      const cb = (e: any) => { console.log(n, e ? `${e.name} ${e.code}` : "ok"); res(); };
      if (n === "cb readFile") fs.readFile(dest, { signal: c.signal }, cb); else fs.writeFile(dest, "x", { signal: c.signal }, cb);
      process.nextTick(() => c.abort());
    });
  }
})();
