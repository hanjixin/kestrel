import { strict as assert } from 'node:assert';
import { Worker, isMainThread, parentPort, MessageChannel, markAsUntransferable, isMarkedAsUntransferable } from 'node:worker_threads';
function payload() {
  const buffer = new ArrayBuffer(16);
  new Uint8Array(buffer)[4] = 42;
  const value = { shared: new SharedArrayBuffer(8), buffer, view: new Uint8Array(buffer, 4, 3), date: new Date(1234), map: new Map(), big: 123n };
  value.self = value;
  value.map.set(value, value.date);
  return value;
}
function check(value) {
  assert.equal(value.self, value);
  assert.equal(value.view.buffer, value.buffer);
  assert.equal(value.view.byteOffset, 4);
  assert.equal(value.view[0], 42);
  assert.equal(value.map.get(value), value.date);
  assert.equal(value.date.getTime(), 1234);
  assert.equal(value.big, 123n);
}
if (!isMainThread) {
  parentPort.on('message', value => { check(value); new Uint8Array(value.shared)[0] = 99; parentPort.postMessage(value, [value.buffer]); process.exit(0); });
} else {
  const {port1, port2} = new MessageChannel();
  const value = payload();
  const received = new Promise(resolve => port2.once('message', resolve));
  port1.postMessage(value, [value.buffer]);
  assert.equal(value.buffer.byteLength, 0);
  check(await received);
  const invalid = new ArrayBuffer(2);
  assert.throws(() => port1.postMessage(() => {}, [invalid]), {name: 'DataCloneError'});
  assert.equal(invalid.byteLength, 2);
  assert.throws(() => port1.postMessage({}, [invalid, invalid]), {name: 'DataCloneError'});
  assert.equal(invalid.byteLength, 2);
  markAsUntransferable(invalid);
  assert.equal(isMarkedAsUntransferable(invalid), true);
  assert.throws(() => port1.postMessage({}, [invalid]), {name: 'DataCloneError'});
  port1.close(); port2.close();
  const worker = new Worker(new URL(import.meta.url));
  const reply = new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); });
  const exited = new Promise(resolve => worker.once('exit', resolve));
  const other = payload();
  worker.postMessage(other, [other.buffer]);
  assert.equal(other.buffer.byteLength, 0);
  check(await reply);
  assert.equal(new Uint8Array(other.shared)[0], 99);
  assert.equal(await exited, 0);
  const unused = new ArrayBuffer(8);
  worker.postMessage(unused, [unused]);
  assert.equal(unused.byteLength, 8);
  console.log('worker clone ok');
}
