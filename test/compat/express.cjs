// Express 4 end to end: routing, params, query, middleware, JSON body parsing and responses.
// A representative real Node web service; output identical under node and kestrel.
const express = require("express");
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.tag = "mw"; next(); });
app.get("/", (req, res) => res.send("hello:" + req.tag));
app.get("/user/:id", (req, res) => res.json({ id: req.params.id, q: req.query }));
app.post("/echo", (req, res) => res.status(201).json({ got: req.body, tag: req.tag }));
app.get("/boom", (_req, _res) => { throw new Error("handler error"); });
const srv = app.listen(0, "127.0.0.1", async () => {
  const port = srv.address().port;
  const g = async (p, opts) => { const r = await fetch("http://127.0.0.1:" + port + p, opts); return [r.status, (r.headers.get("content-type") || "").split(";")[0], await r.text()]; };
  const out = [];
  out.push(await g("/"));
  out.push(await g("/user/42?x=1&y=2"));
  out.push(await g("/echo", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ a: 1, b: [2, 3] }) }));
  out.push((await g("/boom"))[0]); // 500 from the default error handler
  out.push((await g("/missing"))[0]); // 404
  console.log(JSON.stringify(out));
  srv.close(); process.exit(0);
});
