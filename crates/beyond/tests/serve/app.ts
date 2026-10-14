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
