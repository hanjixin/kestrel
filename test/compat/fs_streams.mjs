import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inherits } from "node:util";
import { once } from "node:events";
import { Readable, Writable } from "node:stream";

// graceful-fs uses these legacy constructors when webpack reads/writes its cache.
function LegacyRead(file, options) { fs.ReadStream.call(this, file, options); }
function LegacyWrite(file, options) { fs.WriteStream.call(this, file, options); }
inherits(LegacyRead, fs.ReadStream);
inherits(LegacyWrite, fs.WriteStream);
class DerivedRead extends fs.ReadStream {}
class DerivedWrite extends fs.WriteStream {}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kestrel-fs-streams-"));
try {
  const modes = [
    [(p, o) => new fs.WriteStream(p, o), (p, o) => new fs.ReadStream(p, o)],
    [(p, o) => fs.WriteStream(p, o), (p, o) => fs.ReadStream(p, o)],
    [(p, o) => new LegacyWrite(p, o), (p, o) => new LegacyRead(p, o)],
    [(p, o) => new DerivedWrite(p, o), (p, o) => new DerivedRead(p, o)],
    [fs.createWriteStream, fs.createReadStream],
  ];
  for (const [index, [write, read]] of modes.entries()) {
    const file = path.join(dir, String(index));
    const writer = write(file, { highWaterMark: 2 });
    assert.ok(writer instanceof fs.WriteStream && writer instanceof Writable);
    assert.equal(writer.writableHighWaterMark, 2);
    const finished = once(writer, "finish");
    writer.write("hello");
    writer.end(" world");
    await finished;
    assert.equal(writer.bytesWritten, 11);
    assert.equal(fs.readFileSync(file, "utf8"), "hello world");

    const reader = read(file, { start: 1, end: 7, encoding: "utf8", highWaterMark: 2 });
    assert.ok(reader instanceof fs.ReadStream && reader instanceof Readable);
    let result = "";
    reader.on("data", chunk => { result += chunk; });
    await once(reader, "end");
    assert.equal(result, "ello wo");
    assert.equal(reader.bytesRead, 7);
  }
  console.log("fs stream constructors: 5 modes passed");
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
