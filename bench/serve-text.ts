// Beyond.serve answering every request with a short text (Bun: Bun.serve).
Beyond.serve({ port: 3000, fetch: () => new Response("Hello World!") });
