// The asynchronous calls, as callbacks and as promises, with many in
// flight: ns per call, the best of five runs of `batches` rounds of `inFlight`
// calls started at once (each round awaited before the next).
import fs from "node:fs";
import fsp from "node:fs/promises";

const dir = (process.env.TMPDIR ?? "/tmp") + "/beyond-fs/bench-async";
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir + "/many", { recursive: true });
fs.writeFileSync(dir + "/small.txt", "hello world, this is a small file\n".repeat(4));
for (let i = 0; i < 100; i++) fs.writeFileSync(dir + "/many/f" + i, "x");
const small = dir + "/small.txt";

async function bench(name: string, inFlight: number, batches: number, start: (i: number) => Promise<unknown>) {
  // (Warm up.)
  await Promise.all(Array.from({ length: inFlight }, (_, i) => start(i)));
  let best = Infinity;
  for (let r = 0; r < 5; r++) {
    const t0 = performance.now();
    for (let b = 0; b < batches; b++) {
      const ps = new Array(inFlight);
      for (let i = 0; i < inFlight; i++) ps[i] = start(i);
      await Promise.all(ps);
    }
    best = Math.min(best, performance.now() - t0);
  }
  console.log(name.padEnd(40) + ((best * 1e6) / (inFlight * batches)).toFixed(0).padStart(9) + " ns/op");
}

/** A callback call as a promise (what the round awaits). */
function cb(f: (done: (err: unknown, v?: unknown) => void) => void): Promise<unknown> {
  return new Promise((resolve, reject) => f((err, v) => (err ? reject(err) : resolve(v))));
}

let sink: any;
await bench("readFile small utf8 (callback)", 64, 200, () => cb(d => fs.readFile(small, "utf8", d)));
await bench("readFile small utf8 (promise)", 64, 200, () => fsp.readFile(small, "utf8"));
await bench("writeFile small (callback)", 64, 100, i => cb(d => fs.writeFile(`${dir}/w${i}.txt`, "hello world\n", d)));
await bench("writeFile small (promise)", 64, 100, i => fsp.writeFile(`${dir}/w${i}.txt`, "hello world\n"));
await bench("stat (callback)", 64, 400, () => cb(d => fs.stat(small, d)));
await bench("stat (promise)", 64, 400, () => fsp.stat(small));
await bench("readdir 100 (callback)", 16, 200, () => cb(d => fs.readdir(dir + "/many", d)));
await bench("readdir 100 (promise)", 16, 200, () => fsp.readdir(dir + "/many"));
await bench("readdir 100 withFileTypes (promise)", 16, 200, () => fsp.readdir(dir + "/many", { withFileTypes: true }));

// FileHandle: reads and writes of 4 KB at positions, many in flight.
{
  const fh = await fsp.open(dir + "/fh.bin", "w+");
  const data = Buffer.alloc(1 << 20, 97);
  await fh.write(data, 0, data.length, 0);
  const bufs = Array.from({ length: 64 }, () => Buffer.alloc(4096));
  await bench("FileHandle.read 4KB", 64, 200, i => fh.read(bufs[i], 0, 4096, (i * 4096) % (1 << 20)));
  await bench("FileHandle.write 4KB", 64, 100, i => fh.write(bufs[i], 0, 4096, (i * 4096) % (1 << 20)));
  await fh.close();
}
if (sink === 12345) console.log("x");
