import assert from 'node:assert/strict';
import * as streams from 'node:stream/web';
for (const name of ['ReadableStreamBYOBReader','ReadableStreamBYOBRequest','ReadableByteStreamController','TransformStreamDefaultController']) {
  assert.equal(typeof globalThis[name], 'function', name);
  assert.equal(streams[name], globalThis[name]);
}
assert.throws(() => new ReadableStream().getReader({mode:'byob'}), TypeError);
// Queued bytes: transfer caller ownership, preserve excess bytes and typed-array kind.
let controller;
const stream = new ReadableStream({type:'bytes', start(c) {controller=c; c.enqueue(new Uint8Array([1,2,3,4,5])); c.close();}});
assert.ok(controller instanceof ReadableByteStreamController);
const reader = stream.getReader({mode:'byob'});
assert.ok(reader instanceof ReadableStreamBYOBReader);
assert.throws(() => stream.getReader(), TypeError);
const buffer = new ArrayBuffer(6);
const result = await reader.read(new Uint8Array(buffer, 2, 3));
assert.equal(buffer.byteLength, 0);
assert.deepEqual([...result.value], [1,2,3]);
assert.equal(result.value.byteOffset, 2);
assert.equal(result.done, false);
const second = await reader.read(new Uint8Array(4));
assert.deepEqual([...second.value], [4,5]);
const end = await reader.read(new Uint8Array(4));
assert.equal(end.done, true); assert.equal(end.value.byteLength,0);
await reader.closed; reader.releaseLock(); assert.equal(stream.locked,false);
// Direct BYOB source + minimum element count, across multiple pulls.
let next = 1;
const direct = new ReadableStream({type:'bytes',pull(c) {
  const req=c.byobRequest; assert.ok(req instanceof ReadableStreamBYOBRequest);
  req.view[0]=next++; req.respond(1);
  assert.equal(req.view,null);
  assert.throws(()=>req.respond(1),TypeError);
  if(next===5)c.close();
}}).getReader({mode:'byob'});
const filled = await direct.read(new Uint16Array(2),{min:2});
assert.ok(filled.value instanceof Uint16Array);
assert.deepEqual([...new Uint8Array(filled.value.buffer,filled.value.byteOffset,filled.value.byteLength)],[1,2,3,4]);
assert.equal((await direct.read(new Uint8Array(1))).done,true);
direct.releaseLock();
// A source can fill a replacement view; closing an empty pending read needs respond(0).
let pulls=0;
const replacement = new ReadableStream({type:'bytes',pull(c) {
  const req=c.byobRequest;
  if(pulls++===0){req.view[0]=42;req.respondWithNewView(req.view.subarray(0,1));}
  else {c.close();req.respond(0);}
}}).getReader({mode:'byob'});
assert.deepEqual([...(await replacement.read(new Uint8Array(4))).value],[42]);
assert.equal((await replacement.read(new Uint8Array(4))).done,true);
replacement.releaseLock();
// Cancellation resolves pending reads and propagates the reason.
let reason;
const cancelStream = new ReadableStream({type:'bytes',cancel(r){reason=r;}});
const cancelReader=cancelStream.getReader({mode:'byob'});
const pending=cancelReader.read(new Uint8Array(8));
await cancelReader.cancel('stop');assert.equal(reason,'stop');
assert.deepEqual(await pending,{value:undefined,done:true});cancelReader.releaseLock();
// Release rejects pending reads and relinquishes the lock.
const releasedStream=new ReadableStream({type:'bytes'});
const released=releasedStream.getReader({mode:'byob'});
const rejected=assert.rejects(released.read(new Uint8Array(1)),TypeError);
released.releaseLock();await rejected;assert.equal(releasedStream.locked,false);
// Source errors reach read() and closed without hanging.
const broken=new ReadableStream({type:'bytes',pull(c){c.error(new Error('source'));}}).getReader({mode:'byob'});
await assert.rejects(broken.read(new Uint8Array(1)),/source/);
await assert.rejects(broken.closed,/source/);broken.releaseLock();
// Tee preserves byte-stream capability and gives independent chunks.
const branches=new ReadableStream({type:'bytes',start(c){c.enqueue(new Uint8Array([7,8]));c.close();}}).tee();
const a=branches[0].getReader({mode:'byob'}),b=branches[1].getReader({mode:'byob'});
const [av,bv]=await Promise.all([a.read(new Uint8Array(2)),b.read(new Uint8Array(2))]);
av.value[0]=99;assert.deepEqual([...bv.value],[7,8]);
await Promise.all([a.cancel(),b.cancel()]);a.releaseLock();b.releaseLock();
console.log('BYOB ownership, partial reads, min, lifecycle and tee ok');
