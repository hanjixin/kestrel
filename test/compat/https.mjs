import https from "node:https";
import fs from "node:fs";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import path from "node:path";
const dir = path.dirname(fileURLToPath(import.meta.url));
const key = fs.readFileSync(path.join(dir, "key.pem")), cert = fs.readFileSync(path.join(dir, "cert.pem"));
const srv = https.createServer({ key, cert }, (req, res) => { res.setHeader("content-type", "text/plain"); res.end("secure " + req.url); });
srv.listen(Number(process.env.PORT ?? 3443), "127.0.0.1");
await once(srv, "listening");
// Node needs NODE_TLS_REJECT_UNAUTHORIZED=0 for the self-signed cert; kestrel's fetch reads the same env.
const r = await fetch(`https://127.0.0.1:${srv.address().port}/x`);
console.log(r.status, await r.text());
srv.close();
process.exit(0);
