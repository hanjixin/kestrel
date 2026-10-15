import http from "node:http";
import { once } from "node:events";
const srv = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    res.statusCode = 201;
    res.setHeader("X-Echo", req.headers["x-test"] || "");
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ method: req.method, url: req.url, body, ua: typeof req.headers["user-agent"] }));
  });
});
srv.listen(0 || Number(process.env.PORT ?? 3311));
await once(srv, "listening");
const port = srv.address().port;
const r = await fetch(`http://127.0.0.1:${port}/echo?x=1`, { method: "POST", headers: { "x-test": "abc", "content-type": "text/plain" }, body: "payload" });
console.log(r.status, r.headers.get("x-echo"), r.headers.get("content-type"), await r.json());
// http.get client
const txt = await new Promise((resolve, reject) => {
  http.get({ host: "127.0.0.1", port, path: "/plain" }, (res) => { let s = ""; res.setEncoding("utf8"); res.on("data", (c) => (s += c)); res.on("end", () => resolve(res.statusCode + " " + s)); }).on("error", reject);
});
console.log(txt);
srv.close();
process.exit(0);
