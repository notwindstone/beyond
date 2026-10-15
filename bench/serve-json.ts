// Beyond.serve answering every request with a small JSON object (Bun:
// Bun.serve).
Beyond.serve({
  port: 3000,
  fetch: () => Response.json({ message: "Hello World!", id: 42, tags: ["a", "b"], ok: true }),
});
