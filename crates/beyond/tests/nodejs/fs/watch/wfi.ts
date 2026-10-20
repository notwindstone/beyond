import fsp from "node:fs/promises";
const dest = (process.env.TMPDIR ?? "/tmp") + "/beyond-fs-wfi.txt";
(async () => {
  for (const v of [42, 42n, {}, Symbol("42"), true, undefined, null, NaN] as any[]) {
    try { await fsp.writeFile(dest, v); console.log(String(v), "ok"); } catch (e: any) { console.log(String(v), e.name, e.code, e.message); }
  }
  const fh = await fsp.open(dest, "w");
  for (const v of [42, {}, null] as any[]) {
    try { await fh.writeFile(v); console.log("fh", String(v), "ok"); } catch (e: any) { console.log("fh", String(v), e.name, e.code, e.message); }
  }
  await fh.close();
})();
