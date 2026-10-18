import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { strict as assert } from "node:assert";

if (process.argv[2] === "child") {
  process.on("message", () => {});
  process.on("disconnect", () => process.exit(0));
  process.send("ready");
} else {
  const child = fork(fileURLToPath(import.meta.url), ["child"], { silent: true });
  const exited = once(child, "exit");
  const timer = setTimeout(() => child.kill(), 5000);
  try {
    await once(child, "message");
    // Exceed the socket buffer so shutdown overlaps outstanding writes.
    for (let i = 0; i < 16; i++) child.send({ data: "x".repeat(262144) });
    child.disconnect();
    const [code, signal] = await exited;
    assert.equal(signal, null, "IPC disconnect must reach the child without a timeout");
    assert.equal(code, 0);
    console.log("fork disconnect with pending writes: passed");
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
}
