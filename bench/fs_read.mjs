import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kestrel-fs-bench-'));
const file = path.join(dir, 'data');
try {
  fs.writeFileSync(file, Buffer.alloc(32 * 1024 * 1024, 42));
  await fs.promises.readFile(file);
  let ticks = 0;
  const timer = setInterval(() => ticks++, 1);
  const start = performance.now();
  let bytes = 0;
  for (let i = 0; i < 16; i++) bytes += (await fs.promises.readFile(file)).length;
  const milliseconds = performance.now() - start;
  clearInterval(timer);
  console.log(JSON.stringify({bytes, milliseconds:Math.round(milliseconds), ticks}));
} finally { fs.rmSync(dir, {recursive:true,force:true}); }
