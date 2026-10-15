import net from "node:net";
import tls from "node:tls";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
const sock = path.join(os.tmpdir(), "kestrel-" + process.pid + ".sock");
const srv = net.createServer((s) => { s.on("data", (d) => s.end("u:" + d)); });
srv.listen(sock); await once(srv, "listening");
const c = net.connect(sock); await once(c, "connect"); c.write("hi");
let got = ""; c.on("data", (d) => (got += d)); await once(c, "close");
srv.close(); await once(srv, "close");
// tls server
const dir = path.dirname(fileURLToPath(import.meta.url));
const ts = tls.createServer({ key: fs.readFileSync(path.join(dir, "key.pem")), cert: fs.readFileSync(path.join(dir, "cert.pem")) }, (s) => { s.on("data", (d) => s.end("t:" + d)); });
ts.listen(0, "127.0.0.1"); await once(ts, "listening");
const tc = tls.connect({ port: ts.address().port, host: "127.0.0.1", rejectUnauthorized: false }); await once(tc, "secureConnect"); tc.write("yo");
let tgot = ""; tc.on("data", (d) => (tgot += d)); await once(tc, "close");
ts.close();
// fs.watch
const dirw = fs.mkdtempSync(path.join(os.tmpdir(), "kw-"));
const w = fs.watch(dirw);
const evp = once(w, "change");
setTimeout(() => fs.writeFileSync(path.join(dirw, "a.txt"), "x"), 50);
const [type, file] = await evp;
w.close(); fs.rmSync(dirw, { recursive: true });
console.log(JSON.stringify([got, tgot, typeof type, typeof file]));
process.exit(0);
