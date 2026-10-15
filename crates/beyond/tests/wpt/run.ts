// The checks of the WPT url tests (urltestdata, setters_tests, toascii),
// run on the data the test puts before this (see tests/web.rs).
const PROPS = ["href", "origin", "protocol", "username", "password", "host", "hostname", "port", "pathname", "search", "hash"];
const fails: string[] = [];
const esc = (s: unknown) => JSON.stringify(s);
let pass = 0, total = 0;
for (const t of urltestdata) {
  if (typeof t !== "object") continue;
  total++;
  let u: any = null;
  try {
    u = t.base === null || t.base === undefined ? new URL(t.input) : new URL(t.input, t.base);
  } catch {}
  if (t.failure) {
    if (u === null) pass++;
    else fails.push(`parse ${esc(t.input)} base ${esc(t.base)}: expected failure, got ${esc(u.href)}`);
    continue;
  }
  if (u === null) {
    fails.push(`parse ${esc(t.input)} base ${esc(t.base)}: failed, expected ${esc(t.href)}`);
    continue;
  }
  const bad = PROPS.filter((k) => k in t && u[k] !== t[k]).map((k) => `${k} ${esc(u[k])} != ${esc(t[k])}`);
  if (bad.length === 0) pass++;
  else fails.push(`parse ${esc(t.input)} base ${esc(t.base)}: ${bad.join("; ")}`);
}
console.log(`urltestdata: ${pass}/${total}`);
let spass = 0, stotal = 0;
for (const prop of Object.keys(setters)) {
  if (prop === "comment") continue;
  for (const t of setters[prop]) {
    stotal++;
    let u: any;
    try {
      u = new URL(t.href);
      u[prop] = t.new_value;
    } catch (e) {
      fails.push(`set ${prop} ${esc(t.href)} = ${esc(t.new_value)}: threw ${e}`);
      continue;
    }
    const bad = Object.keys(t.expected).filter((k) => u[k] !== t.expected[k]).map((k) => `${k} ${esc(u[k])} != ${esc(t.expected[k])}`);
    if (bad.length === 0) spass++;
    else fails.push(`set ${prop} ${esc(t.href)} = ${esc(t.new_value)}: ${bad.join("; ")}`);
  }
}
console.log(`setters: ${spass}/${stotal}`);
let apass = 0, atotal = 0;
for (const t of toascii) {
  if (typeof t !== "object") continue;
  atotal++;
  let host: string | null = null;
  try {
    host = new URL(`https://${t.input}/x`).host;
  } catch {}
  if (host === t.output) apass++;
  else fails.push(`toascii ${esc(t.input)}: ${esc(host)} != ${esc(t.output)}`);
}
console.log(`toascii: ${apass}/${atotal}`);
for (const f of fails) console.log("FAIL", f);
