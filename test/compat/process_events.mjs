import assert from 'node:assert/strict';
import process from 'node:process';
const event = Symbol('process-events');
const seen = [];
function regular(value) { assert.equal(this, process); seen.push(`regular:${value}`); }
function first(value) { assert.equal(this, process); seen.push(`first:${value}`); process.emit(event, 'nested'); }
assert.equal(typeof process.prependOnceListener, 'function');
assert.equal(typeof process.rawListeners, 'function');
assert.equal(process.on(event, regular), process);
assert.equal(process.prependOnceListener(event, first), process);
assert.deepEqual(process.listeners(event), [first, regular]);
const raw = process.rawListeners(event);
assert.equal(raw[0].listener, first);
raw.pop();
assert.equal(process.listenerCount(event), 2);
process.emit(event, 'outer');
assert.deepEqual(seen, ['first:outer', 'regular:nested', 'regular:outer']);
assert.deepEqual(process.listeners(event), [regular]);
process.once(event, first);
process.removeListener(event, first);
assert.deepEqual(process.listeners(event), [regular]);
process.on(event, regular);
assert.equal(process.listenerCount(event, regular), 2);
process.removeListener(event, regular);
assert.equal(process.listenerCount(event, regular), 1);
for (const method of ['on','once','prependListener','prependOnceListener','removeListener']) {
  assert.throws(() => process[method](event, null), {code:'ERR_INVALID_ARG_TYPE'});
}
process.removeAllListeners(event);
assert.equal(process.eventNames().includes(event), false);
console.log('process events ok');
