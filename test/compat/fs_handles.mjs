import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kestrel-handles-'));
try {
  const file = path.join(dir, 'test');
  const handle = await fs.promises.open(file, 'w+');
  await handle.write('one'); await handle.write('two');
  await handle.close();
  assert.equal(fs.readFileSync(file, 'utf8'), 'onetwo');
  await new Promise((resolve, reject) => fs.writeFile(1, 'stdio ok\n', e => e ? reject(e) : resolve()));
  console.log('file handles ok');
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
