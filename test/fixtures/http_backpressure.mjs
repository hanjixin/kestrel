import http from 'node:http';
const total = 64 * 1024 * 1024;
const chunk = Buffer.alloc(65536, 42);
const server = http.createServer((req, res) => {
  let produced = 0;
  setTimeout(() => console.log('produced ' + produced), 100);
  function pump() {
    while (produced < total) { produced += chunk.length; if (!res.write(chunk)) { res.once('drain', pump); return; } }
    res.end(); server.close();
  }
  pump();
});
server.listen(0, '127.0.0.1', () => console.log('port ' + server.address().port));
