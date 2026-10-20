import * as fs from "node:fs";
const dir = (process.env.TMPDIR ?? "/tmp") + "/beyond-fs/bench";
const bigp = dir + "/big.bin";
let sink: any;
const n = +(process.argv[2] ?? 300);
const mode = process.argv[3] ?? "utf8";
const t0 = performance.now();
for (let i = 0; i < n; i++) sink = mode === "utf8" ? fs.readFileSync(bigp, "utf8") : mode === "latin1" ? fs.readFileSync(bigp, "latin1") : fs.readFileSync(bigp);
console.log(mode, ((performance.now() - t0) * 1000 / n).toFixed(1), "us/op", sink.length);
