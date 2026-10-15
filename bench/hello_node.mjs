import http from "node:http";
http.createServer((req, res) => { res.setHeader("content-type", "text/plain;charset=UTF-8"); res.end("Hello, World!"); }).listen(Number(process.env.PORT ?? 3000));
