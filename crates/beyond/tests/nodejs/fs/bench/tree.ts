// Streams and trees: createReadStream and createWriteStream throughput (MB/s
// of 1 MB to 100 MB files), recursive readdir, and cp and rm of a directory
// tree; the best of five runs each (µs per run, and MB/s for streams).
import fs from "node:fs";
import fsp from "node:fs/promises";

const dir = (process.env.TMPDIR ?? "/tmp") + "/beyond-fs/bench-tree";
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });

async function best(runs: number, f: () => Promise<unknown> | unknown): Promise<number> {
  await f();
  let b = Infinity;
  for (let r = 0; r < runs; r++) {
    const t0 = performance.now();
    await f();
    b = Math.min(b, performance.now() - t0);
  }
  return b;
}

function line(name: string, ms: number, mb?: number) {
  const us = (ms * 1000).toFixed(0).padStart(10) + " us";
  console.log(name.padEnd(40) + us + (mb !== undefined ? ((mb / (ms / 1000)).toFixed(0).padStart(8) + " MB/s") : ""));
}

// Streams.
for (const mb of [1, 10, 100]) {
  const file = `${dir}/s${mb}.bin`;
  fs.writeFileSync(file, Buffer.alloc(mb << 20, 120));
  const read = () =>
    new Promise<number>((resolve, reject) => {
      let n = 0;
      fs.createReadStream(file)
        .on("data", (c: Buffer) => (n += c.length))
        .on("end", () => resolve(n))
        .on("error", reject);
    });
  line(`createReadStream ${mb} MB`, await best(5, read), mb);
  const chunk = Buffer.alloc(64 * 1024, 121);
  const write = () =>
    new Promise<void>((resolve, reject) => {
      const ws = fs.createWriteStream(`${dir}/w${mb}.bin`);
      let left = (mb << 20) / chunk.length;
      const pump = () => {
        while (left > 0) {
          left--;
          if (!ws.write(chunk)) return void ws.once("drain", pump);
        }
        ws.end();
      };
      ws.on("finish", resolve).on("error", reject);
      pump();
    });
  line(`createWriteStream ${mb} MB`, await best(5, write), mb);
}

// A tree: 10 directories of 10 of 20 files (2,000 files).
const tree = `${dir}/tree`;
for (let a = 0; a < 10; a++)
  for (let b = 0; b < 10; b++) {
    const d = `${tree}/a${a}/b${b}`;
    fs.mkdirSync(d, { recursive: true });
    for (let f = 0; f < 20; f++) fs.writeFileSync(`${d}/f${f}.txt`, "some text " + f);
  }
line("readdirSync recursive (2,110 entries)", await best(5, () => fs.readdirSync(tree, { recursive: true })));
line("readdir recursive (promise)", await best(5, () => fsp.readdir(tree, { recursive: true })));
line("readdirSync recursive withFileTypes", await best(5, () => fs.readdirSync(tree, { recursive: true, withFileTypes: true })));
let n = 0;
line("cpSync + rmSync tree", await best(5, () => {
  const d = `${dir}/copy${n++}`;
  fs.cpSync(tree, d, { recursive: true });
  fs.rmSync(d, { recursive: true });
}));
line("cp + rm tree (promise)", await best(5, async () => {
  const d = `${dir}/copy${n++}`;
  await fsp.cp(tree, d, { recursive: true });
  await fsp.rm(d, { recursive: true });
}));
fs.rmSync(dir, { recursive: true, force: true });
