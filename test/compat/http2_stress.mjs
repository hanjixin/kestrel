// HTTP/2 under load: many concurrent streams, request and response bodies far larger than the
// 64 KiB flow-control window (so WINDOW_UPDATE and poll_capacity are exercised in both
// directions), verified by length and FNV-1a checksum. Output is identical under node and
// kestrel. h2c so no cert is needed.
import http2 from "node:http2";
import { once } from "node:events";

function fnv1a(buf) {
  let h = 0x811c9dc5;
  for (let i = 0; i < buf.length; i++) { h ^= buf[i]; h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
function makeBody(seed, len) {
  const b = Buffer.allocUnsafe(len);
  let x = seed >>> 0;
  for (let i = 0; i < len; i++) { x = (Math.imul(x, 1103515245) + 12345) >>> 0; b[i] = x & 0xff; }
  return b;
}

const server = http2.createServer();
server.on("stream", (stream, headers) => {
  // Echo: read the whole request body, reply with a body of the requested size whose bytes
  // depend on the checksum of what was received (so a corrupted upload changes the download).
  const want = Number(headers["x-want"] || 0);
  const chunks = [];
  stream.on("data", (c) => chunks.push(c));
  stream.on("end", () => {
    const got = Buffer.concat(chunks);
    const sum = fnv1a(got);
    stream.respond({ ":status": 200, "x-recv-len": String(got.length), "x-recv-sum": String(sum) });
    stream.end(makeBody(sum, want));
  });
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const port = server.address().port;

const client = http2.connect(`http://127.0.0.1:${port}`);
await once(client, "connect");

const CONCURRENCY = 40;
const sizes = [0, 1, 1024, 65535, 65536, 200000, 1000000];
function doReq(i) {
  const reqLen = sizes[i % sizes.length];
  const respLen = sizes[(i + 3) % sizes.length];
  const body = makeBody(i + 1, reqLen);
  return new Promise((resolve, reject) => {
    const r = client.request({ ":method": "POST", ":path": "/echo", "x-want": String(respLen) });
    const chunks = [];
    let recvLen, recvSum;
    r.on("response", (h) => { recvLen = Number(h["x-recv-len"]); recvSum = Number(h["x-recv-sum"]); });
    r.on("data", (c) => chunks.push(c));
    r.on("end", () => {
      const got = Buffer.concat(chunks);
      resolve({ i, reqLen, uploadedSum: recvLen === reqLen && recvSum === fnv1a(body), respLen: got.length === respLen, respSum: fnv1a(got) === fnv1a(makeBody(fnv1a(body), respLen)) });
    });
    r.on("error", reject);
    r.end(body);
  });
}

const results = await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => doReq(i)));
const uploadsOk = results.every((r) => r.uploadedSum);
const respLensOk = results.every((r) => r.respLen);
const respSumsOk = results.every((r) => r.respSum);
console.log(JSON.stringify({ count: results.length, uploadsOk, respLensOk, respSumsOk, totalUp: results.reduce((a, r) => a + r.reqLen, 0) }));
client.close();
await once(client, "close");
server.close();
