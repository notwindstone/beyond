// An Elysia app with the routes of bench/hono/app.ts and a hook that sets a
// header on every response, served by Elysia's Bun adapter (on Beyond,
// `Bun` is `Beyond`). Built ahead of time with Elysia's AOT plugin (see
// build.ts): no handler is made with `new Function` at run time.
import { Elysia } from "elysia";

const app = new Elysia()
  .onRequest(({ set }) => {
    set.headers["x-powered-by"] = "Elysia";
  })
  .get("/", () => "Hello Elysia!")
  .get("/json", () => ({ message: "Hello", ok: true, n: 42, list: [1, 2, 3] }))
  .get("/users/:id", ({ params: { id } }) => ({ id, name: "user" + id }))
  .get("/search", ({ query }) => ({ q: query.q }))
  .post("/echo", ({ body }) => ({ received: body }))
  .get("/error", () => {
    throw new Error("boom");
  })
  .listen(3000);

export default app;
