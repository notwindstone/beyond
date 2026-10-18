// A server for tests/serve.rs (`reuse_port`): sharing a port, as Bun 1.4.3
// does (`reusePort`; `development: false`, or NODE_UNIQUE_ID set, making it
// the default); then a server on the port PORT names, answering its id,
// which tests/serve.rs runs twice.

const fetch = (name: string) => () => new Response(name);
const a = Bun.serve({ port: 0, reusePort: true, fetch: fetch("a") });
const b = Bun.serve({ port: a.port, reusePort: true, fetch: fetch("b") });
console.log("shared", a.port === b.port);
for (const opts of [{}, { reusePort: false }, { development: true }, { development: {} }]) {
  try {
    const c = Bun.serve({ port: a.port, ...opts, fetch: fetch("c") });
    console.log("bound", JSON.stringify(opts));
    c.stop(true);
  } catch (e) {
    console.log((e as Error).constructor.name + ": " + (e as Error).message.replace(String(a.port), "PORT"));
  }
}
const d = Bun.serve({ port: 0, development: false, fetch: fetch("d") });
const e = Bun.serve({ port: d.port, development: false, fetch: fetch("e") });
console.log("production shares", d.port === e.port);
const f = Bun.serve({ port: 0, fetch: fetch("f") });
try {
  Bun.serve({ port: f.port, reusePort: true, fetch: fetch("g") }).stop(true);
  console.log("joined a port shared by default");
} catch (err) {
  console.log("exclusive kept: " + (err as Error).message.replace(String(f.port), "PORT"));
}
// A stopped server's port is free again.
b.stop(true);
const h = Bun.serve({ port: b.port, reusePort: true, fetch: fetch("h") });
console.log("rejoined", h.port === a.port);
for (const s of [a, d, e, f, h]) s.stop(true);

const id = String(Math.random()).slice(2, 10);
Bun.serve({ reusePort: true, fetch: () => new Response(id) });
console.log("serving", id);
