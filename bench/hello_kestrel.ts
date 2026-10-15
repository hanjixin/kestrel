const w = process.env.WORKERS ?? "1";
const workers = w === "auto" ? "auto" : Number(w);
Kestrel.serve({ port: Number(process.env.PORT ?? 3000), workers, silent: true, fetch(req: Request) {
  return new Response("Hello, World!");
} });
