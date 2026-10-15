// node:string_decoder — handles multi-byte sequences split across chunks.
import { Buffer } from "ext:kestrel/node/buffer.js";
export class StringDecoder {
  #enc; #pending = null;
  constructor(encoding = "utf8") { this.#enc = String(encoding).toLowerCase().replace("-", ""); if (this.#enc === "utf8" || this.#enc === "utf16le" || this.#enc === "ucs2") {} this.encoding = this.#enc === "ucs2" ? "utf16le" : this.#enc; }
  get lastNeed() { return this.#pending ? 1 : 0; }
  get lastTotal() { return this.#pending ? this.#pending.length : 0; }
  write(buf) {
    if (typeof buf === "string") return buf;
    let b = buf instanceof Buffer ? buf : Buffer.from(buf);
    if (this.#pending) { b = Buffer.concat([this.#pending, b]); this.#pending = null; }
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
      if (i >= 0 && need > b.length - i) { this.#pending = Buffer.from(b.subarray(i)); b = b.subarray(0, i); }
      return b.toString("utf8");
    }
    if (this.encoding === "utf16le" && b.length % 2) { this.#pending = Buffer.from(b.subarray(b.length - 1)); b = b.subarray(0, b.length - 1); }
    if (this.encoding === "base64" && b.length % 3) { const keep = b.length % 3; this.#pending = Buffer.from(b.subarray(b.length - keep)); b = b.subarray(0, b.length - keep); }
    return b.toString(this.encoding);
  }
  end(buf) { let s = buf ? this.write(buf) : ""; if (this.#pending) { s += this.#pending.toString(this.encoding); this.#pending = null; } return s; }
  text(buf, i) { return this.write(buf.subarray(i)); }
}
export default { StringDecoder };
