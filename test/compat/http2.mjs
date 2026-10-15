// node:http2 — secure server (stream + compat API) and h2c, client via http2.connect.
// Needs NODE_TLS_REJECT_UNAUTHORIZED=0 (self-signed cert) under node.
import http2 from "node:http2";
import fs from "node:fs";
import { once } from "node:events";
const out = [];
const dir = new URL("./", import.meta.url);
const srv = http2.createSecureServer({ key: fs.readFileSync(new URL("key.pem", dir)), cert: fs.readFileSync(new URL("cert.pem", dir)) });
srv.on("stream", (stream, headers) => {
  if (headers[":path"] !== "/s") return;
  stream.respond({ ":status": 201, "x-a": "b", "content-type": "text/plain" });
  stream.end("stream:" + headers[":method"] + ":" + headers[":scheme"]);
});
srv.on("request", (req, res) => {
  if (req.url === "/s") return;
  let body = "";
  req.setEncoding("utf8");
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ v: req.httpVersion, m: req.method, u: req.url, a: typeof req.headers[":authority"], p: req.headers[":path"], body }));
  });
});
srv.listen(0, "127.0.0.1");
await once(srv, "listening");
const port = srv.address().port;
const client = http2.connect(`https://127.0.0.1:${port}`, { rejectUnauthorized: false });
await once(client, "connect");
const call = (session, path, method = "GET", body) => new Promise((resolve, reject) => {
  const r = session.request({ ":path": path, ":method": method, "x-req": "1" });
  let data = "", hdrs;
  r.on("response", (h) => (hdrs = h));
  r.setEncoding("utf8");
  r.on("data", (c) => (data += c));
  r.on("end", () => resolve({ status: hdrs[":status"], ct: hdrs["content-type"], xa: hdrs["x-a"], data }));
  r.on("error", reject);
  if (body) r.end(body); else r.end();
});
out.push(await call(client, "/s"));
out.push(await call(client, "/r?x=1", "POST", "hello"));
client.close();
await once(client, "close");
srv.close();

const h2c = http2.createServer((req, res) => res.end("h2c " + req.httpVersion + " " + req.headers[":scheme"] + " " + req.method));
h2c.listen(0, "127.0.0.1");
await once(h2c, "listening");
const c2 = http2.connect(`http://127.0.0.1:${h2c.address().port}`);
out.push(await call(c2, "/plain"));
c2.close();
h2c.close();

out.push(typeof http2.constants.HTTP2_HEADER_PATH, http2.constants.NGHTTP2_CANCEL, http2.getDefaultSettings().maxFrameSize, http2.getUnpackedSettings(http2.getPackedSettings({ maxFrameSize: 20000, enablePush: false })));
let err; try { client.request({ ":path": "/" }); } catch (e) { err = e.code; }
out.push(err);
console.log(JSON.stringify(out));
process.exit(0);
