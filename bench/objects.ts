// {} vs Object.create(null): creation, keys added, dictionaries with dynamic keys, reads (`beyond run bench/objects.ts`; `bun bench/objects.ts`).
const N = 2_000_000;
const keys: string[] = [];
for (let i = 0; i < 64; i++) keys.push("key" + i);

function emptyLit(): number {
  let s = 0;
  for (let i = 0; i < N; i++) { const o: any = {}; s += o === null ? 0 : 1; }
  return s;
}
function emptyNull(): number {
  let s = 0;
  for (let i = 0; i < N; i++) { const o: any = Object.create(null); s += o === null ? 0 : 1; }
  return s;
}
function fixedLit(): number {
  let s = 0;
  for (let i = 0; i < N; i++) { const o: any = {}; o.a = i; o.b = 2; o.c = 3; s += o.a + o.c; }
  return s;
}
function fixedNull(): number {
  let s = 0;
  for (let i = 0; i < N; i++) { const o: any = Object.create(null); o.a = i; o.b = 2; o.c = 3; s += o.a + o.c; }
  return s;
}
function dictLit(): number {
  let s = 0;
  for (let r = 0; r < N / 64; r++) {
    const d: any = {};
    for (let i = 0; i < 64; i++) d[keys[i]] = i;
    for (let i = 0; i < 64; i++) s += d[keys[i]];
    if ("missing" in d) s++;
  }
  return s;
}
function dictNull(): number {
  let s = 0;
  for (let r = 0; r < N / 64; r++) {
    const d: any = Object.create(null);
    for (let i = 0; i < 64; i++) d[keys[i]] = i;
    for (let i = 0; i < 64; i++) s += d[keys[i]];
    if ("missing" in d) s++;
  }
  return s;
}
const lit: any = { a: 1, b: 2, c: 3 };
const nul: any = Object.create(null); nul.a = 1; nul.b = 2; nul.c = 3;
function readLit(): number { let s = 0; for (let i = 0; i < N; i++) s += lit.a + lit.c + (lit.zz === undefined ? 1 : 0); return s; }
function readNull(): number { let s = 0; for (let i = 0; i < N; i++) s += nul.a + nul.c + (nul.zz === undefined ? 1 : 0); return s; }

function time(label: string, ops: number, f: () => number): void {
  f();
  let best = Infinity;
  for (let r = 0; r < 5; r++) {
    const t0 = performance.now();
    f();
    best = Math.min(best, ((performance.now() - t0) * 1e6) / ops);
  }
  console.log(label.padEnd(44) + best.toFixed(2).padStart(8) + " ns");
}
time("new empty object: {}", N, emptyLit);
time("new empty object: Object.create(null)", N, emptyNull);
time("new + 3 props + 2 reads: {}", N, fixedLit);
time("new + 3 props + 2 reads: Object.create(null)", N, fixedNull);
time("dictionary, 64 dynamic keys (per key): {}", N, dictLit);
time("dictionary, 64 dynamic keys (per key): null", N, dictNull);
time("read 2 props + 1 missing: {}", N, readLit);
time("read 2 props + 1 missing: Object.create(null)", N, readNull);
