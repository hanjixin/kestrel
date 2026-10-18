import http from "node:http";
import http2 from "node:http2";
import https from "node:https";
import fs from "node:fs";
import net from "node:net";
import { once } from "node:events";
import { strict as assert } from "node:assert";

const tlsOptions = {
  key: fs.readFileSync(new URL("./key.pem", import.meta.url)),
  cert: fs.readFileSync(new URL("./cert.pem", import.meta.url)),
};
for (const protocol of process.argv[2] ? [process.argv[2]] : ["http", "h2", "https", "shared"]) {
  const server = protocol === "https" ? https.createServer(tlsOptions) :
    protocol === "shared" ? http2.createSecureServer({ ...tlsOptions, allowHTTP1: true }) :
    (protocol === "h2" ? http2 : http).createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  const closed = once(server, "close");
  server.close();
  assert.equal(server.listening, false);
  await closed;
  assert.equal(server.address(), null);
  // Closing must release the real listener, not just update JS properties.
  const probe = net.createServer();
  probe.listen(port, "127.0.0.1");
  await once(probe, "listening");
  const probeClosed = once(probe, "close");
  probe.close();
  await probeClosed;
  console.log(protocol + " server closed and port released");
}
// No process.exit(): a pending accept op must not keep the runtime alive.
