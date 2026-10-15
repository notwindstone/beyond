// new URL(s).href for a few kinds of URL: nanoseconds each (Beyond and Bun alike).
const cases = [
  "http://127.0.0.1:3000/",
  "https://example.com/a/b/c?x=1&y=2#frag",
  "https://user:pass@sub.example.com:8080/p/a/t/h?query=string#hash",
  "http://example.com/a/./b/../c",
  "HTTP://EXAMPLE.COM/%7Efoo",
];
for (const s of cases) {
  let sink = 0;
  const N = 200000;
  for (let i = 0; i < 2000; i++) sink += new URL(s).href.length;
  const t0 = performance.now();
  for (let i = 0; i < N; i++) sink += new URL(s).href.length;
  const ns = ((performance.now() - t0) * 1e6) / N;
  console.log(`${ns.toFixed(0).padStart(6)} ns  ${s}  (${sink})`);
}
