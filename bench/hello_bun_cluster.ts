// Bun's documented way to use all cores: one process per core sharing the port via SO_REUSEPORT (Linux).
import { spawn } from "bun";
const port = Number(process.env.PORT ?? 3000);
if (process.env.BUN_WORKER) {
  Bun.serve({ port, reusePort: true, fetch() { return new Response("Hello, World!"); } });
} else {
  const n = Number(process.env.WORKERS) || navigator.hardwareConcurrency;
  for (let i = 0; i < n; i++) spawn({ cmd: [process.execPath, import.meta.path], env: { ...process.env, BUN_WORKER: "1" }, stdout: "inherit", stderr: "inherit" });
}
