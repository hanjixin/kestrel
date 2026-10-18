import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import fs from "node:fs";
import net from "node:net";
import { once } from "node:events";
import { strict as assert } from "node:assert";

// Exercise both the header-only fast path and POST's hyper handover.
for (const [protocol, method] of [["http", "GET"], ["http", "POST"], ["https", "GET"], ["https", "POST"]]) {
  let callback = false;
  const secure = protocol === "https";
  const options = secure ? {
    key: fs.readFileSync(new URL("./key.pem", import.meta.url)),
    cert: fs.readFileSync(new URL("./cert.pem", import.meta.url)),
  } : {};
  const server = (secure ? https : http).createServer(options, (req, res) => {
    req.resume();
    server.close(() => { callback = true; });
    assert.equal(callback, false, "close callback must wait for the response");
    setTimeout(() => {
      assert.equal(callback, false, "active response was closed early");
      res.end("finished before close");
    }, 20);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const closed = once(server, "close");
  const socket = secure ? tls.connect({ port: server.address().port, host: "127.0.0.1", rejectUnauthorized: false }) :
    net.connect(server.address().port, "127.0.0.1");
  await once(socket, secure ? "secureConnect" : "connect");
  let body = "";
  socket.on("data", b => { body += b.toString(); });
  const ended = once(socket, "end");
  socket.write(`${method} / HTTP/1.1\r\nHost: localhost\r\n` +
    (method === "POST" ? "Content-Length: 1\r\n\r\nx" : "\r\n"));
  await ended;
  await closed;
  assert.ok(body.includes("finished before close"));
  assert.equal(callback, true);
  socket.destroy();
  console.log(protocol + " " + method + " active response drained");
}
