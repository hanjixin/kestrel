import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
const self = fileURLToPath(import.meta.url);
if (process.argv[2] === "child") {
  process.on("message", (m) => { if (m.cmd === "ping") process.send({ pong: m.n * 2, argv: process.argv.length }); if (m.cmd === "bye") process.exit(5); });
  process.send({ ready: true });
} else {
  const child = fork(self, ["child"], { silent: true });
  const [ready] = await once(child, "message");
  child.send({ cmd: "ping", n: 21 });
  const [pong] = await once(child, "message");
  child.send({ cmd: "bye" });
  const [code] = await once(child, "exit");
  console.log(JSON.stringify([ready, pong, code]));
}
