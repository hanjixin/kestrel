import { Worker, isMainThread, parentPort } from 'node:worker_threads';
if (isMainThread) {
  const count = Number(process.env.COUNT || 200), size = Number(process.env.SIZE || 1048576);
  const worker = new Worker(new URL(import.meta.url));
  let n = 0;
  const start = performance.now();
  worker.on('message', buffer => {
    if (!(buffer instanceof ArrayBuffer) || buffer.byteLength !== size)
      throw new Error('Worker did not preserve the transferred payload');
    if (++n < count) worker.postMessage(buffer, [buffer]);
    else { console.log(JSON.stringify({roundtrips:count, bytes:size, milliseconds:Math.round(performance.now()-start)})); worker.postMessage(null); }
  });
  const buffer = new ArrayBuffer(size);
  worker.postMessage(buffer, [buffer]);
  await new Promise(resolve => worker.once('exit', resolve));
} else {
  parentPort.on('message', value => { if (value === null) return process.exit(0); parentPort.postMessage(value, [value]); });
}
