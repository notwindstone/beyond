// A server for tests/serve.rs (`routes`): Bun.serve (`Bun` is `Beyond`) with
// `routes`, as Bun 1.4.3 answers them; `/reload` swaps them, `/stop` stops.
const server = Bun.serve({
  port: 0,
  routes: {
    "/static": new Response("static body", { headers: { "x-s": "1" } }),
    "/users/:id": (req: any) => Response.json({ params: req.params }),
    "/users/me": () => new Response("me"),
    "/files/*": (req: any) => new Response("files " + JSON.stringify(req.params)),
    "/methods": { GET: () => new Response("get"), POST: new Response("post static") },
    "/a/:x/b/:y": (req: any) => Response.json(req.params),
    "/enc/:name": (req: any) => Response.json(req.params),
    "/throws": () => {
      throw new Error("route boom");
    },
    "/async": async () => new Response("async"),
  },
  fetch(req) {
    const path = req.url.slice(req.url.indexOf("/", 8));
    if (path === "/reload") {
      server.reload({ routes: { "/reloaded": new Response("new") }, fetch: () => new Response("new fetch") });
      return new Response("reloaded");
    }
    if (path === "/pending") return new Response(String(server.pendingRequests));
    if (path === "/stop") {
      server.stop();
      return new Response("bye");
    }
    return new Response("fetch " + path + " " + req.method + " " + (req as any).params);
  },
  error(e) {
    return new Response("error: " + (e as Error).message, { status: 500 });
  },
});
console.log(server.port);
