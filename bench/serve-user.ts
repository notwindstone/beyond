// Beyond.serve answering every request with a user made for it, as JSON
// (Bun: Bun.serve). With `aot type` it is an object of a fixed layout,
// written from its fields; bench/run.sh also runs it with a plain `type`.
aot type Point = { x: number; y: number };
aot type User = { id: int; name: string; email: string; age: int; score: number; active: boolean; home: Point };

let n = 0;

function user(i: int): User {
  return { id: i, name: "user" + i, email: "user" + i + "@example.com", age: 20 + (i % 50), score: i * 1.5, active: i % 2 === 0, home: { x: i, y: i / 2 } };
}

Beyond.serve({
  port: 3000,
  fetch: () => Response.json(user(n++ & 1023)),
});
