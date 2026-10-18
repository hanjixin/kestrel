import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kestrel-async-'));
try {
  // A FIFO read can only complete if this isolate runs the timer that writes it.
  for (const callback of [false, true]) {
    const fifo = path.join(dir, callback ? 'callback' : 'promise');
    execFileSync('mkfifo', [fifo]);
    let fired = false;
    const timer = setTimeout(() => { fired = true; fs.writeFileSync(fifo, 'hello'); }, 25);
    const data = callback
      ? await new Promise((resolve, reject) => fs.readFile(fifo, 'utf8', (e, v) => e ? reject(e) : resolve(v)))
      : await fs.promises.readFile(fifo, 'utf8');
    clearTimeout(timer);
    assert.equal(fired, true);
    assert.equal(data, 'hello');
  }
  const file = path.join(dir, 'data');
  await fs.promises.writeFile(file, Buffer.alloc(1024 * 1024, 7));
  const stream = fs.createReadStream(file, { highWaterMark: 4096, start: 10, end: 10009 });
  await new Promise(resolve => stream.once('readable', resolve));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(stream.readableLength <= 8192);
  assert.ok(stream.bytesRead <= 8192);
  let size = 0;
  for await (const chunk of stream) { size += chunk.length; assert.equal(chunk[0], 7); }
  assert.equal(size, 10000);
  console.log('async filesystem ok');
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
