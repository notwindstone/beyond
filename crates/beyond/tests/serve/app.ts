// A server for tests/serve.rs: it prints its port, answers, and exits after
// `/stop`.
const server = Beyond.serve({
  port: 0,
  async fetch(req: Request) {
    const path = req.url.slice(req.url.indexOf("/", 8));
    if (path === "/json") return Response.json({ method: req.method, ua: req.headers.get("user-agent") });
    if (path === "/later") {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return new Response("later", { status: 202, headers: { "X-Kind": "async" } });
    }
    if (path.startsWith("/headers")) return new Response(JSON.stringify({ url: req.url, headers: [...req.headers] }));
    if (path === "/stream") {
      // Chunks as they come (chunked), the content type given.
      const stream = new ReadableStream({
        async start(c) {
          c.enqueue(new TextEncoder().encode("a"));
          await new Promise((resolve) => setTimeout(resolve, 5));
          c.enqueue("bc");
          c.close();
        },
      });
      return new Response(stream, { headers: { "content-type": "text/x-stream" } });
    }
    if (path === "/big") {
      // 4 MB in 64 KB chunks: written as the connection drains.
      let n = 0;
      const stream = new ReadableStream({
        pull(c) {
          if (n === 64) return c.close();
          c.enqueue(new Uint8Array(65536).fill(97 + (n++ % 26)));
        },
      });
      return new Response(stream);
    }
    if (path === "/broken") {
      const stream = new ReadableStream({
        async pull(c) {
          c.enqueue(new TextEncoder().encode("part"));
          await new Promise((resolve) => setTimeout(resolve, 5));
          c.error(new Error("stream broke"));
        },
      });
      return new Response(stream);
    }
    if (path === "/generator") {
      return new Response(
        (async function* () {
          yield "x";
          yield new Uint8Array([121]);
        })(),
      );
    }
    if (path === "/pipe") return new Response(req.body);
    // Streams that hold their whole body: sent whole, with their length (a
    // body's stream, as middleware re-making a response has it; a Blob's;
    // one its source filled and closed), as Bun's.
    if (path === "/rewrap") {
      const r = new Response("abc", { headers: { "x-from": "first" } });
      return new Response(r.body, r);
    }
    if (path === "/blob-stream") return new Response(new Blob(["blob"], { type: "text/x-blob" }).stream());
    if (path === "/whole") {
      return new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode("w"));
            c.enqueue("ho");
            c.close();
          },
        }),
      );
    }
    // The framing headers the program gives are not sent (the body's are);
    // a body's default content type, as Bun's.
    if (path === "/framing") return new Response("hi", { headers: { "content-length": "7", "transfer-encoding": "chunked", "x-a": "1" } });
    if (path === "/bytes") return new Response(new Uint8Array([104, 105]));
    if (path === "/empty") return new Response("");
    if (path === "/count") {
      let n = 0;
      for await (const chunk of req.body!) {
        n += chunk.length;
        // (A slow reader.)
        if (n % (1 << 20) < chunk.length) await new Promise((resolve) => setTimeout(resolve, 1));
      }
      return new Response(String(n));
    }
    if (req.method === "POST") return new Response(`echo: ${await req.text()}`, { status: 201 });
    if (path === "/throw") throw new Error("boom");
    if (path === "/stop") {
      server.stop();
      return new Response("stopping");
    }
    return new Response("hello");
  },
});
console.log(server.port);
