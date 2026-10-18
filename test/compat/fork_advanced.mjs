import { fork } from 'node:child_process';
import { strict as assert } from 'node:assert';
import { fileURLToPath } from 'node:url';
function check(value) {
  assert.equal(value.self, value);
  assert.equal(value.map.get('date').getTime(), 1234);
  assert.equal(value.big, 123n);
  assert.ok(Buffer.isBuffer(value.buf));
  assert.equal(value.buf.length, 256 * 1024);
  assert.equal(value.buf[0], 42);
  assert.ok(value.typed instanceof Int32Array);
  assert.equal(value.typed[0], 1234);
}
if (process.argv[2] === 'child') {
  process.on('message', value => { check(value); process.send(value, () => process.disconnect()); });
} else {
  const options = { serialization: 'advanced', stdio: ['ignore', 'inherit', 'inherit', 'ipc'] };
  if (process.env.CHILD_RUNTIME) options.execPath = process.env.CHILD_RUNTIME;
  const child = fork(fileURLToPath(import.meta.url), ['child'], options);
  const message = new Promise((resolve, reject) => { child.once('message', resolve); child.once('error', reject); });
  const exited = new Promise(resolve => child.once('exit', resolve));
  const value = { map: new Map([['date', new Date(1234)]]), big: 123n, buf: Buffer.alloc(256 * 1024, 42), typed: new Int32Array([1234]) };
  value.self = value;
  child.send(value);
  check(await message);
  assert.equal(await exited, 0);
  console.log('advanced IPC ok');
}
