Kestrel.serve({ port: Number(process.env.PORT ?? 3312), workers: 1, silent: true, async fetch(req: Request) {
  if (req.method === "POST") { const j = await req.json(); return Response.json({ got: j, ct: req.headers.get("content-type") }, { status: 202, headers: { "x-k": "1" } }); }
  if (new URL(req.url, "http://x").pathname === "/bytes") return new Response(new Uint8Array([104, 105]), { headers: { "content-type": "application/octet-stream" } });
  return new Response("hi " + req.url);
} });
const port = Number(process.env.PORT ?? 3312);
const a = await fetch(`http://127.0.0.1:${port}/x?y=1`);
const b = await fetch(`http://127.0.0.1:${port}/j`, { method: "POST", body: JSON.stringify({ n: 1 }), headers: { "content-type": "application/json" } });
const c = await fetch(`http://127.0.0.1:${port}/bytes`);
console.log(a.status, await a.text(), "|", b.status, b.headers.get("x-k"), await b.json(), "|", c.headers.get("content-type"), new Uint8Array(await c.arrayBuffer()).join(","));
process.exit(0);
