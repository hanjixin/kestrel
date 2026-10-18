import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
if (process.argv[2] === 'child') {
  process.prependOnceListener('message', function (message) {
    assert.equal(this, process);
    assert.equal(process.listenerCount('message'), 0);
    process.send({value: message.value + 1}, () => process.disconnect());
  });
} else {
  const child = fork(fileURLToPath(import.meta.url), ['child'], {silent: true});
  const exited = once(child, 'exit');
  const reply = once(child, 'message');
  child.send({value: 41});
  assert.deepEqual((await reply)[0], {value:42});
  assert.equal((await exited)[0], 0);
  console.log('process prepend once IPC ok');
}
