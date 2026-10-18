// `await r.json()` where an `aot type` is expected (Luminous converts the
// result; Beyond parses the body to the type directly): Bun has no
// `aot type`, so the expected output is what the conversion makes.
type int = number;
aot type Item = { id: int; label: string; price: number; tags: { t: string }[]; note?: string; owner: Owner | null };
aot type Owner = { name: string };

const json = JSON.stringify({
  id: 1,
  label: "café ☃",
  price: 9.5,
  tags: [{ t: "x", skip: true }],
  owner: { name: "Ann", age: 3 },
  extra: { deep: [1, 2, 3] },
});

async function show(label: string, f: () => Promise<Item>): Promise<void> {
  try {
    const it = await f();
    console.log(label, JSON.stringify(it), it.id + 1, it.tags[0].t, it.owner === null ? "-" : it.owner.name);
  } catch (e) {
    console.log(label, (e as Error).constructor.name + ": " + (e as Error).message);
  }
}

async function main(): Promise<void> {
  await show("string", async () => {
    const r: Item = await new Response(json).json();
    return r;
  });
  await show("bytes", async () => {
    const r: Item = await new Response(new TextEncoder().encode(json)).json();
    return r;
  });
  await show("stream", async () => {
    const s = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(json.slice(0, 10)));
        c.enqueue(new TextEncoder().encode(json.slice(10)));
        c.close();
      },
    });
    const r: Item = await new Response(s).json();
    return r;
  });
  await show("request", async () => {
    const r: Item = await new Request("http://localhost/", { method: "POST", body: json }).json();
    return r;
  });
  await show("bad type", async () => {
    const r: Item = await new Response(new TextEncoder().encode(`{"id":"1"}`)).json();
    return r;
  });
  await show("bad json", async () => {
    const r: Item = await new Response(new TextEncoder().encode(`{"id":`)).json();
    return r;
  });
  await show("invalid utf-8", async () => {
    const b = new TextEncoder().encode(json.replace("Ann", "Aÿn"));
    b[b.indexOf(0xc3)] = 0xff;
    const r: Item = await new Response(b).json();
    return r;
  });
  const used = new Response(json);
  await used.text();
  await show("used", async () => {
    const r: Item = await used.json();
    return r;
  });
  // Without an `aot type`: the plain value, every field kept.
  const plain = await new Response(json).json();
  console.log("plain", JSON.stringify(plain) === json);
}
main();
