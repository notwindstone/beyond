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
