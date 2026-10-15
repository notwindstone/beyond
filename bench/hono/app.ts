// A Hono app with simple routes and a middleware, served by Beyond.serve
// (Bun: Bun.serve); bench/run.sh hono installs Hono (bun install) here.
import { Hono } from "hono";

const app = new Hono();

app.use("*", async (c, next) => {
  await next();
  c.header("X-Powered-By", "Hono");
});

app.get("/", (c) => c.text("Hello Hono!"));

app.get("/json", (c) => c.json({ message: "Hello", ok: true, n: 42, list: [1, 2, 3] }));

app.get("/html", (c) => c.html("<h1>Hello</h1>"));

app.get("/users/:id", (c) => {
  const id = c.req.param("id");
  return c.json({ id, name: "user" + id });
});

app.get("/posts/:postId/comments/:commentId", (c) => c.json(c.req.param()));

app.get("/search", (c) => {
  const q = c.req.query("q");
  const tags = c.req.queries("tag");
  return c.json({ q, tags });
});

app.post("/echo", async (c) => {
  const body = await c.req.json();
  return c.json({ received: body }, 201);
});

app.get("/headers", (c) => c.text("ua: " + c.req.header("User-Agent")));

app.get("/redirect", (c) => c.redirect("/"));

app.get("/error", () => {
  throw new Error("boom");
});

const api = new Hono();
api.get("/items", (c) => c.json([{ id: 1 }, { id: 2 }]));
api.get("/items/:id{[0-9]+}", (c) => c.json({ id: Number(c.req.param("id")) }));
app.route("/api", api);

app.notFound((c) => c.text("Not here: " + c.req.path, 404));
app.onError((err, c) => c.text("Error: " + err.message, 500));

Beyond.serve({ port: 3000, fetch: app.fetch });
