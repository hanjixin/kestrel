import http from 'node:http';
import net from 'node:net';
import { strict as assert } from 'node:assert';
let release;
const server = http.createServer((req, res) => {
  if (req.url === '/next') return res.end('next');
  res.setHeader('content-type', 'text/event-stream');
  res.flushHeaders();
  res.write('data: first\n\n');
  release = () => res.end('data: last\n\n');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const socket = net.connect(server.address().port, '127.0.0.1');
let output = '', released = false;
await new Promise((resolve, reject) => {
  socket.on('error', reject);
  socket.on('connect', () => socket.write('GET / HTTP/1.1\r\nHost: localhost\r\n\r\n'));
  socket.on('data', chunk => {
    output += chunk.toString();
    if (!released && output.includes('data: first')) {
      released = true;
      assert.ok(output.includes('text/event-stream'));
      release();
      socket.write('GET /next HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
    }
  });
  socket.on('end', resolve);
});
assert.ok(output.includes('data: last'));
assert.ok(output.endsWith('next'));
assert.equal(output.split('HTTP/1.1 200').length, 3);
await new Promise(resolve => server.close(resolve));
console.log('streaming before end and keepalive ok');
