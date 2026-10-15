const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join(" ");
const cps = (s: string) => [...s].map((c) => c.codePointAt(0)!.toString(16)).join(" ");

// TextEncoder
const enc = new TextEncoder();
console.log(enc.encoding, hex(enc.encode("a" + String.fromCharCode(0xd800) + "b€😀")), enc.encode().length, String(enc));
const dest = new Uint8Array(5);
console.log(JSON.stringify(enc.encodeInto("ab😀c", dest)), hex(dest));
console.log(JSON.stringify(enc.encodeInto("é€", new Uint8Array(4))));

// TextDecoder
const dec = new TextDecoder();
console.log(dec.encoding, dec.fatal, dec.ignoreBOM);
for (const a of [[0x61, 0xff, 0x62], [0xf0, 0x9f, 0x98], [0xed, 0xa0, 0x80, 0x61], [0xe2, 0x82, 0x41], [0xef, 0xbb, 0xbf, 0x41], []]) {
  console.log(cps(dec.decode(new Uint8Array(a))));
}
console.log(cps(new TextDecoder("utf-8", { ignoreBOM: true }).decode(new Uint8Array([0xef, 0xbb, 0xbf, 0x41]))));
try {
  new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array([0xff]));
} catch (e: any) {
  console.log(e.name);
}
const s = new TextDecoder();
const bytes = enc.encode("﻿hé😀!");
let out = "";
for (const b of bytes) out += s.decode(new Uint8Array([b]), { stream: true });
out += s.decode();
console.log(cps(out));
console.log(cps(s.decode(new Uint8Array([0xf0, 0x9f]), { stream: true }) + "|" + s.decode()));
console.log(new TextDecoder(" Latin1 ").encoding, cps(new TextDecoder("latin1").decode(new Uint8Array([0x41, 0x80, 0x9f, 0xe9]))));
console.log(new TextDecoder("utf-16").encoding, cps(new TextDecoder("utf-16le").decode(new Uint8Array([0xff, 0xfe, 0x41, 0, 0x3d, 0xd8, 0x00, 0xde, 0x00, 0xd8]))));
console.log(cps(new TextDecoder().decode(new DataView(new Uint8Array([0x68, 0x69]).buffer))), cps(new TextDecoder().decode(new Uint16Array([0x6968]))));
try {
  new TextDecoder("nope");
} catch (e: any) {
  console.log(e.name);
}

// crypto
const r = crypto.getRandomValues(new Uint8Array(16));
console.log(r.length, r.some((x) => x !== 0), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(crypto.randomUUID()));
try {
  crypto.getRandomValues(new Float64Array(2) as any);
} catch (e: any) {
  console.log(e.name);
}
try {
  crypto.getRandomValues(new Uint8Array(65536));
} catch (e: any) {
  console.log(e.name);
}

// structuredClone
const o: any = { a: 1, d: new Date(0), m: new Map([[1, { x: 2 }]]), s: new Set([1]), r: /x/gi, u: new Uint8Array([1, 2]), n: null };
o.self = o;
const c = structuredClone(o);
console.log(c !== o, c.self === c, c.d.getTime(), c.m.get(1).x, c.s.has(1), String(c.r), JSON.stringify([...c.u]), c.n);
const err = structuredClone(new RangeError("bad"));
console.log(err instanceof RangeError, err.message);
try {
  structuredClone(() => 1);
} catch (e: any) {
  console.log(e.name);
}
const buf = new ArrayBuffer(4);
const moved = structuredClone(buf, { transfer: [buf] });
console.log(buf.byteLength, moved.byteLength);
class P { x = 1; get y() { return 2; } }
console.log(JSON.stringify(structuredClone(new P())));

// Events
const t = new EventTarget();
const seen: string[] = [];
t.addEventListener("x", (e) => seen.push("a" + e.eventPhase), { once: true });
t.addEventListener("x", { handleEvent: (e: Event) => seen.push("b" + (e.target === t)) });
t.addEventListener("x", (e) => { seen.push("c"); e.preventDefault(); }, { capture: true });
const ev = new Event("x", { cancelable: true });
console.log(t.dispatchEvent(ev), ev.defaultPrevented, ev.eventPhase, ev.target === t);
t.dispatchEvent(new Event("x"));
console.log(seen.join(","));
const ce = new CustomEvent("y", { detail: { k: 1 } });
console.log(ce.detail.k, ce instanceof Event, Event.AT_TARGET, ce.AT_TARGET);
const t2 = new EventTarget();
t2.addEventListener("z", () => { throw new Error("listener"); });
t2.addEventListener("z", () => console.log("after the error"));
t2.dispatchEvent(new Event("z"));
class Emitter extends EventTarget {}
const em = new Emitter();
em.addEventListener("q", (e) => console.log("subclass", e.type));
em.dispatchEvent(new Event("q"));

// Abort
const ac = new AbortController();
const order: string[] = [];
ac.signal.onabort = () => order.push("onabort");
ac.signal.addEventListener("abort", () => order.push("listener"));
const t3 = new EventTarget();
t3.addEventListener("w", () => order.push("w"), { signal: ac.signal });
ac.abort();
t3.dispatchEvent(new Event("w"));
console.log(ac.signal.aborted, ac.signal.reason.name, order.join(","));
try {
  ac.signal.throwIfAborted();
} catch (e: any) {
  console.log("thrown", e.name);
}
console.log(AbortSignal.abort("why").reason);
const a1 = new AbortController();
const any = AbortSignal.any([a1.signal, new AbortController().signal]);
a1.abort("first");
console.log(any.aborted, any.reason);
try {
  new (AbortSignal as any)();
} catch (e: any) {
  console.log(e.name);
}
const ts = AbortSignal.timeout(5);
ts.addEventListener("abort", () => console.log("timeout", ts.reason.name));
setTimeout(() => console.log("done"), 20);
