// Beyond.serve answering every request with a list of 50 users as JSON
// (Bun: Bun.serve). With `aot type` they are objects of a fixed layout,
// written from their fields; bench/run.sh also runs it with a plain `type`.
aot type Point = { x: number; y: number };
aot type User = { id: int; name: string; email: string; age: int; score: number; active: boolean; home: Point };

const users: User[] = [];
for (let i = 0; i < 50; i++) {
  users.push({ id: i, name: "user" + i, email: "user" + i + "@example.com", age: 20 + (i % 50), score: i * 1.5, active: i % 2 === 0, home: { x: i, y: i / 2 } });
}

Beyond.serve({
  port: 3000,
  fetch: () => Response.json(users),
});
