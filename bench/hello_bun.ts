Bun.serve({ port: Number(process.env.PORT ?? 3000), fetch(req) { return new Response("Hello, World!"); } });
