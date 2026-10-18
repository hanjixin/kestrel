import http from 'node:http';
import { once } from 'node:events';
import assert from 'node:assert/strict';
const cases = [
  ['ascii', undefined], ['你好🙂é', undefined], ['孤立\ud800代理', 'utf8'],
  ['你好🙂', 'UTF-8'], ['caf\xe9', 'latin1'], ['610062ff', 'hex'],
  ['aGVsbG8=', 'base64'], ['你好🙂', 'utf16le'], ['', undefined],
];
for (const streamed of [false, true]) {
 for (const [body, encoding] of cases) {
  let callback = false;
  const server = http.createServer((req, res) => {
   res.setHeader('x-case', 'string');
   if (streamed) res.write('prefix:');
   res.end(body, encoding, () => { callback = true; });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const data = await new Promise((resolve, reject) => {
   http.get(`http://127.0.0.1:${server.address().port}/`, { agent: false, headers: { connection: 'close' } }, res => {
    assert.equal(res.headers['x-case'], 'string');
    const chunks = []; res.on('data', c => chunks.push(c));
    res.on('end', () => resolve(Buffer.concat(chunks))); res.on('error', reject);
   }).on('error', reject);
  });
  assert.deepEqual(data, Buffer.concat([Buffer.from(streamed ? 'prefix:' : ''), Buffer.from(body, encoding)]));
  await new Promise(resolve => server.close(resolve));
  assert.equal(callback, true);
 }
}
console.log('string responses: encodings, unicode, streaming and end callbacks passed');
// Verify a streamed Unicode payload larger than the writable byte threshold.
const streamServer = http.createServer((req, res) => {
 const text = '界'.repeat(Math.floor(res.writableHighWaterMark / 3) + 1);
 res.setHeader('content-length', Buffer.byteLength(text));
 res.write(text);
 res.end();
});
streamServer.listen(0, '127.0.0.1'); await once(streamServer, 'listening');
await new Promise((resolve, reject) => {
 http.get(`http://127.0.0.1:${streamServer.address().port}/`, { agent: false, headers: { connection: 'close' } }, res => {
  let bytes = 0; res.on('data', chunk => { bytes += chunk.length; });
  res.on('end', () => { assert.equal(bytes, Number(res.headers['content-length'])); resolve(); });
  res.on('error', reject);
 }).on('error', reject);
});
await new Promise(resolve => streamServer.close(resolve));
console.log('streamed Unicode payload is complete');
const recoveryServer = http.createServer((req, res) => {
 assert.throws(() => res.end('12345678', 'invalid-encoding'), { code: 'ERR_UNKNOWN_ENCODING' });
 res.end('fallback');
});
recoveryServer.listen(0, '127.0.0.1'); await once(recoveryServer, 'listening');
await new Promise((resolve, reject) => {
 http.get(`http://127.0.0.1:${recoveryServer.address().port}/`, { agent: false, headers: { connection: 'close' } }, res => {
  let body = ''; res.on('data', chunk => { body += chunk.toString(); });
  res.on('end', () => { assert.equal(body, 'fallback'); resolve(); }); res.on('error', reject);
 }).on('error', reject);
});
await new Promise(resolve => recoveryServer.close(resolve));
console.log('invalid encoding leaves response usable');
