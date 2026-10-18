import http from 'node:http';
import net from 'node:net';
import { strict as assert } from 'node:assert';
const server = http.createServer((req, res) => {
  const body = JSON.stringify({ method: req.method, url: req.url, cookie: req.headers.cookie, repeated: req.headers['x-repeat'], host: req.headers.host, constructor: req.headers.constructor, own: Object.hasOwn(req.headers, 'constructor') });
  res.setHeader('Content-Length', Buffer.byteLength(body));
  res.end(body);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
try {
  for (const [method, target] of [['GET', '/a/../b?x=%2f'], ['OPTIONS', '*'], ['GET', 'http://example.test/a/../b?q=1']]) {
    const reply = await new Promise((resolve, reject) => {
      const socket = net.connect(server.address().port, '127.0.0.1', () => socket.write(`${method} ${target} HTTP/1.1\r\nHost: example.test\r\nConstructor: header-value\r\nCookie: a=1\r\nCookie: b=2\r\nX-Repeat: one\r\nX-Repeat: two\r\nConnection: close\r\n\r\n`));
      let data = ''; socket.on('data', chunk => data += chunk); socket.on('end', () => resolve(data)); socket.on('error', reject);
    });
    const body = JSON.parse(reply.slice(reply.indexOf('\r\n\r\n') + 4));
    assert.deepEqual(body, {method, url: target, cookie: 'a=1; b=2', repeated: 'one, two', host: 'example.test', constructor: 'header-value', own: true});
  }
  console.log('raw request targets and repeated headers ok');
} finally { await new Promise(resolve => server.close(resolve)); }
