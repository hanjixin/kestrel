import cluster from "node:cluster";
import http from "node:http";
import { once } from "node:events";
const port = Number(process.env.PORT ?? 3491);
if (cluster.isPrimary) {
  const workers = [cluster.fork(), cluster.fork()];
  const firstMessages = workers.map((w) => once(w, "message"));
  let online = 0;
  for (const p of firstMessages) { const [m] = await p; if (m.listening) online++; }
  const seen = new Set();
  for (let i = 0; i < 20; i++) { const r = await fetch(`http://127.0.0.1:${port}/`); seen.add(await r.text()); }
  for (const w of workers) w.kill();
  const codes = await Promise.all(workers.map((w) => new Promise((res) => w.on("exit", (c, s) => res(s || c)))));
  console.log(JSON.stringify({ online, answered: seen.size >= 1, allFromWorkers: [...seen].every((s) => s.startsWith("w")), codes }));
} else {
  const srv = http.createServer((req, res) => res.end("w" + cluster.worker.id));
  srv.listen(port, "127.0.0.1", () => process.send({ listening: true }));
}
