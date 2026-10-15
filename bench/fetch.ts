// fetch() throughput against the server on port 3000 (another process):
// N fetches with C of them in flight, each response read with text(). The
// count in flight is put in for __C__ (bench/run.sh).
const url = "http://127.0.0.1:3000/";
const N = 300000;
const C = __C__;

async function worker(n: number): Promise<number> {
  let bytes = 0;
  for (let i = 0; i < n; i++) {
    const r = await fetch(url);
    bytes += (await r.text()).length;
  }
  return bytes;
}

for (let round = 0; round < 3; round++) {
  const t0 = performance.now();
  const ps: Promise<number>[] = [];
  for (let c = 0; c < C; c++) ps.push(worker(N / C));
  await Promise.all(ps);
  const ms = performance.now() - t0;
  console.log(`${Math.round(N / (ms / 1000))} fetches/s`);
}
