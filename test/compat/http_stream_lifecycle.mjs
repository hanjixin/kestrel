import http from 'node:http';
import net from 'node:net';
import { strict as assert } from 'node:assert';
let closed;
const responseClosed = new Promise(resolve => closed = resolve);
const server = http.createServer((req, res) => {
  res.on('error', () => {});
  res.flushHeaders();
  if (req.method === 'POST') {
    const consume = () => { let text = ''; req.on('data', c => text += c); req.on('end', () => res.end(text)); };
    if (req.url === '/immediate') consume(); else setTimeout(consume, 10);
  } else if (req.method === 'HEAD') { res.write(Buffer.alloc(128 * 1024)); res.end(); }
  else { res.once('close', closed); res.write('first'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
async function request(method, body = '', path = '/') {
  return new Promise((resolve, reject) => {
    const req = http.request({host:'127.0.0.1', port, method, path, headers:{'content-length':Buffer.byteLength(body)}}, res => {
      let text = ''; res.on('data', c => text += c); res.on('end', () => resolve(text));
    });
    req.on('error', reject); req.end(body);
  });
}
assert.equal(await request('POST', 'body-after-headers'), 'body-after-headers');
assert.equal(await request('POST', 'immediate-body', '/immediate'), 'immediate-body');
assert.equal(await request('HEAD'), '');
const socket = net.connect(port, '127.0.0.1');
socket.on('connect', () => socket.write('GET / HTTP/1.1\r\nHost: localhost\r\n\r\n'));
socket.on('data', c => { if (c.toString().includes('first')) socket.destroy(); });
await responseClosed;
await new Promise(resolve => server.close(resolve));
console.log('stream lifecycle ok');
