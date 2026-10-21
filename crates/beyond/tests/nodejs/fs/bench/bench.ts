import fs from "node:fs";

const dir = (process.env.TMPDIR ?? "/tmp") + "/beyond-fs/bench";
fs.mkdirSync(dir + "/many", { recursive: true });
fs.writeFileSync(dir + "/small.txt", "hello world, this is a small file\n".repeat(4));
const big = Buffer.alloc(1 << 20, 97);
fs.writeFileSync(dir + "/big.bin", big);
for (let i = 0; i < 100; i++) fs.writeFileSync(dir + "/many/f" + i, "x");

// The best of 5 runs of n/5 calls (the machine is noisy).
function bench(name: string, n: number, f: () => void) {
  for (let i = 0; i < Math.min(n, 100); i++) f();
  let best = Infinity;
  const m = Math.max(1, Math.floor(n / 5));
  for (let r = 0; r < 5; r++) {
    const t0 = performance.now();
    for (let i = 0; i < m; i++) f();
    best = Math.min(best, performance.now() - t0);
  }
  console.log(name.padEnd(36) + (best * 1e6 / m).toFixed(0).padStart(9) + " ns/op");
}

const small = dir + "/small.txt", bigp = dir + "/big.bin";
let sink: any;
bench("readFileSync small utf8", 100000, () => { sink = fs.readFileSync(small, "utf8"); });
bench("readFileSync small buffer", 100000, () => { sink = fs.readFileSync(small); });
bench("readFileSync 1MB utf8", 500, () => { sink = fs.readFileSync(bigp, "utf8"); });
bench("readFileSync 1MB buffer", 500, () => { sink = fs.readFileSync(bigp); });
bench("statSync", 200000, () => { sink = fs.statSync(small); });
bench("statSync + isFile", 200000, () => { sink = fs.statSync(small).isFile(); });
bench("lstatSync throwIfNoEntry:false miss", 200000, () => { sink = fs.lstatSync(dir + "/nope", { throwIfNoEntry: false }); });
bench("existsSync hit", 200000, () => { sink = fs.existsSync(small); });
bench("existsSync miss", 200000, () => { sink = fs.existsSync(dir + "/nope"); });
bench("writeFileSync small string", 20000, () => { fs.writeFileSync(dir + "/out.txt", "hello world\n"); });
bench("writeFileSync 1MB buffer", 1000, () => { fs.writeFileSync(dir + "/out.bin", big); });
bench("readdirSync 100", 20000, () => { sink = fs.readdirSync(dir + "/many"); });
bench("readdirSync 100 withFileTypes", 20000, () => { sink = fs.readdirSync(dir + "/many", { withFileTypes: true }); });
const buf = Buffer.alloc(4096);
bench("open/read/close", 50000, () => { const fd = fs.openSync(small, "r"); fs.readSync(fd, buf, 0, 4096, 0); fs.closeSync(fd); });
const wfd = fs.openSync(dir + "/w.txt", "w");
bench("writeSync string", 200000, () => { fs.writeSync(wfd, "abc", 0); });
bench("writeSync buffer", 200000, () => { fs.writeSync(wfd, buf, 0, 16, 0); });
fs.closeSync(wfd);
if (sink === 12345) console.log("x");
