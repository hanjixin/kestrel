import http from 'node:http';
import { strict as assert } from 'node:assert';
const server = http.createServer((req, res) => { req.read(); res.end('ok'); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
try {
  for (let i = 0; i < 3; i++) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}`, {method:'POST', body:'payload'});
    assert.equal(await response.text(), 'ok');
  }
  console.log('early request body read completes and exits');
} finally { await new Promise(resolve => server.close(resolve)); }
