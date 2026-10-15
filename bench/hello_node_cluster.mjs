import cluster from "node:cluster";
import http from "node:http";
import os from "node:os";
const port = Number(process.env.PORT ?? 3000);
if (cluster.isPrimary) {
  for (let i = 0; i < os.availableParallelism(); i++) cluster.fork();
} else {
  http.createServer((req, res) => { res.setHeader("content-type", "text/plain;charset=UTF-8"); res.end("Hello, World!"); }).listen(port);
}
