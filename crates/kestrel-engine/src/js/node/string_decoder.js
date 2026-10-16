// node:string_decoder — handles multi-byte sequences split across chunks.
// A function constructor (not an ES class) so legacy subclasses can call
// `StringDecoder.call(this, enc)` through `util.inherits` (iconv-lite does this).
import { Buffer } from "ext:kestrel/node/buffer.js";

const kEnc = Symbol("string_decoder.enc");
const kPending = Symbol("string_decoder.pending");

export function StringDecoder(encoding = "utf8") {
  const enc = String(encoding).toLowerCase().replace("-", "");
  this[kEnc] = enc;
  this[kPending] = null;
  this.encoding = enc === "ucs2" ? "utf16le" : enc;
}
Object.defineProperties(StringDecoder.prototype, {
  lastNeed: { get() { return this[kPending] ? 1 : 0; }, configurable: true },
  lastTotal: { get() { return this[kPending] ? this[kPending].length : 0; }, configurable: true },
});
StringDecoder.prototype.write = function write(buf) {
  if (typeof buf === "string") return buf;
  let b = buf instanceof Buffer ? buf : Buffer.from(buf);
  if (this[kPending]) { b = Buffer.concat([this[kPending], b]); this[kPending] = null; }
  if (this.encoding === "utf8") {
    // Find the start of a possibly-incomplete trailing sequence.
    let i = b.length - 1, need = 0;
    for (let k = 0; k < 4 && i >= 0; k++, i--) {
      const c = b[i];
      if ((c & 0xc0) === 0x80) continue;           // continuation byte
      if ((c & 0xe0) === 0xc0) need = 2; else if ((c & 0xf0) === 0xe0) need = 3; else if ((c & 0xf8) === 0xf0) need = 4; else need = 1;
      break;
    }
    // Bytes from the lead byte at i to the end: incomplete when fewer than `need`.
    if (i >= 0 && need > b.length - i) { this[kPending] = Buffer.from(b.subarray(i)); b = b.subarray(0, i); }
    return b.toString("utf8");
  }
  if (this.encoding === "utf16le" && b.length % 2) { this[kPending] = Buffer.from(b.subarray(b.length - 1)); b = b.subarray(0, b.length - 1); }
  if (this.encoding === "base64" && b.length % 3) { const keep = b.length % 3; this[kPending] = Buffer.from(b.subarray(b.length - keep)); b = b.subarray(0, b.length - keep); }
  return b.toString(this.encoding);
};
StringDecoder.prototype.end = function end(buf) {
  let s = buf ? this.write(buf) : "";
  if (this[kPending]) { s += this[kPending].toString(this.encoding); this[kPending] = null; }
  return s;
};
StringDecoder.prototype.text = function text(buf, i) { return this.write(buf.subarray(i)); };

export default { StringDecoder };
