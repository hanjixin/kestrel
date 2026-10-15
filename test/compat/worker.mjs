import { Worker, isMainThread, parentPort, workerData, threadId } from "node:worker_threads";
import { fileURLToPath } from "node:url";
if (isMainThread) {
  const w = new Worker(fileURLToPath(import.meta.url), { workerData: { n: 20, buf: new Uint8Array([1, 2, 3]) } });
  const got = [];
  w.on("message", (m) => { got.push(m); if (m.done) w.postMessage({ cmd: "exit", code: 7 }); });
  const code = await new Promise((res) => w.on("exit", res));
  console.log(JSON.stringify({ got, code, mainThreadId: threadId }));
} else {
  const fib = (n) => (n < 2 ? n : fib(n - 1) + fib(n - 2));
  parentPort.postMessage({ fib: fib(workerData.n), sum: workerData.buf.reduce((a, b) => a + b, 0), tid: threadId > 0, done: true });
  parentPort.on("message", (m) => { if (m.cmd === "exit") process.exit(m.code); });
}
