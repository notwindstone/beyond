// Streams as Bun has them: how they print, Bun's extra methods, and bodies
// made of streams and async iterables.
const show = async (label: string, f: () => any) => {
  try {
    console.log(label, await f());
  } catch (e: any) {
    console.log(label, "threw", e?.constructor?.name, e?.message, e?.code);
  }
};
const bytes = (s: string) => new TextEncoder().encode(s);

// Printing.
const s = new ReadableStream();
console.log(s);
console.log({ a: s, b: [s] });
console.log(new ReadableStream({ type: "bytes" }));
const errored = new ReadableStream({
  start(c) {
    c.error(new Error("x"));
  },
});
await new Promise((r) => setTimeout(r, 1));
console.log(errored);
const locked = new ReadableStream();
locked.getReader();
console.log(locked);
console.log(new WritableStream(), new TransformStream());
console.log(new ReadableStream().getReader(), new WritableStream().getWriter());
console.log(new TextEncoderStream(), new TextDecoderStream());
console.log(new CountQueuingStrategy({ highWaterMark: 3 }), new ByteLengthQueuingStrategy({ highWaterMark: 3 }));
let dc: any;
new ReadableStream({
  start(c) {
    dc = c;
  },
});
console.log(dc);
let bc: any;
const byteStream = new ReadableStream({
  type: "bytes",
  start(c) {
    bc = c;
  },
});
console.log(bc);
const byob = byteStream.getReader({ mode: "byob" });
console.log(byob);
byob.read(new Uint8Array(4));
await Promise.resolve();
console.log(bc.byobRequest);
let wc: any;
new WritableStream({
  start(c) {
    wc = c;
  },
});
console.log(wc);
let tc: any;
new TransformStream({
  start(c) {
    tc = c;
  },
});
console.log(tc);
console.log({ x: { y: new TransformStream() } });
console.log(String(s), Object.prototype.toString.call(s));

// Bun's methods: a stream read whole.
console.log(Object.getOwnPropertyNames(ReadableStream.prototype));
const of = (...chunks: any[]) =>
  new ReadableStream({
    start(c) {
      for (const x of chunks) c.enqueue(x);
      c.close();
    },
  });
console.log(await of("hi").text());
console.log(await of(new Uint8Array([1, 2])).bytes());
console.log(await of('{"a":1}').json());
console.log(await of("hi").blob());
console.log(await new Blob(["xy"]).stream().text());

// Bodies.
await show("empty str body", () => new Response("").body);
await show("no body", () => new Response().body);
await show("null body", () => new Response(null).body);
const r1 = new Response("hello");
await show("body", () => r1.body);
await show("same", () => r1.body === r1.body);
await show("bodyUsed after body", () => r1.bodyUsed);
await show("text after body", () => r1.text());
await show("bodyUsed after text", () => r1.bodyUsed);
await show("body after text", () => r1.body);
const r3 = new Response("hello");
const rd = r3.body!.getReader();
await show("bodyUsed locked", () => r3.bodyUsed);
await show("text locked", () => r3.text());
await show("read", () => rd.read());
await show("bodyUsed after read", () => r3.bodyUsed);
const r4 = new Response(of(bytes("ab"), bytes("cd")));
await show("stream headers", () => [...r4.headers]);
await show("stream text", () => r4.text());
await show("stream text again", () => r4.text());
await show("locked stream", () => {
  const s2 = new ReadableStream();
  s2.getReader();
  return new Response(s2);
});
await show("string chunks", () => new Response(of("str")).text());
await show("number chunks", () => new Response(of(5)).text());
await show("asyncgen", () =>
  new Response(
    (async function* () {
      yield "a";
      yield new Uint8Array([98]);
    })(),
  ).text(),
);
await show("asyncgen fn", () =>
  new Response(async function* () {
    yield "a";
  } as any).text(),
);
await show("req stream", () => new Request("http://x/", { method: "POST", body: of(new Uint8Array([104, 105])) }).text());
await show("req body", () => new Request("http://x/", { method: "POST", body: "hi" }).body);
await show("req nobody", () => new Request("http://x/").body);
await show("clone stream", async () => {
  const r = new Response(of(new Uint8Array([104, 105])));
  const c = r.clone();
  return [await r.text(), await c.text()];
});
await show("blob stream text", () => new Response(new Blob(["xy"]).stream()).text());
await show("disturbed", async () => {
  const s3 = new ReadableStream({
    pull(c) {
      c.enqueue(new Uint8Array([1]));
    },
  });
  const r = s3.getReader();
  await r.read();
  r.releaseLock();
  return new Response(s3);
});
await show("pipeThrough", () =>
  new Response(of("héllo ", "wörld").pipeThrough(new TextEncoderStream()).pipeThrough(new TextDecoderStream()).pipeThrough(new TextEncoderStream())).text(),
);
