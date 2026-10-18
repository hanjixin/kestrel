import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import { strict as assert } from "node:assert";

const server = http.createServer((req, res) => {
  setTimeout(() => res.end("delayed response"), 20);
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
try {
  for (const pipelined of [false, true]) {
    const socket = net.connect(server.address().port, "127.0.0.1");
    const timer = setTimeout(() => socket.destroy(new Error("response timeout")), 5000);
    try {
      await once(socket, "connect");
      let response = "";
      socket.on("data", data => { response += data.toString(); });
      const ended = once(socket, "end");
      socket.write((pipelined ? "GET / HTTP/1.1\r\nHost: localhost\r\n\r\n" : "") +
        "GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");
      await ended;
      assert.ok(response.startsWith("HTTP/1.1 200"), "connection closed before async response headers");
      assert.equal(response.split("delayed response").length - 1, pipelined ? 2 : 1,
        "missing async response body");
    } finally {
      clearTimeout(timer);
      socket.destroy();
    }
  }
  console.log("async response before connection close: passed");
} finally {
  server.close();
}
