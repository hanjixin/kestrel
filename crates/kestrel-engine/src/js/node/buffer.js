// node:buffer — Buffer as a Uint8Array subclass. Encodings: utf8, hex, base64, base64url, latin1/binary, ascii, utf16le/ucs2.
import { ops, utf8Decode, utf8Encode, nodeError } from "ext:kestrel/internal.js";

const kMaxLength = 2 ** 32 - 1;
const kStringMaxLength = 2 ** 29 - 24;

function normEnc(enc) {
  if (enc === undefined || enc === null) return "utf8";
  const e = String(enc).toLowerCase();
  switch (e) {
    case "utf8": case "utf-8": return "utf8";
    case "hex": return "hex";
    case "base64": return "base64";
    case "base64url": return "base64url";
    case "latin1": case "binary": return "latin1";
    case "ascii": return "ascii";
    case "utf16le": case "utf-16le": case "ucs2": case "ucs-2": return "utf16le";
    default: throw nodeError("ERR_UNKNOWN_ENCODING", "Unknown encoding: " + enc, TypeError);
  }
}

function encodeString(s, enc) {
  switch (normEnc(enc)) {
    case "utf8": return utf8Encode(s);
    case "hex": return ops.op_k_hex_decode(s);
    case "base64": case "base64url": return ops.op_k_base64_decode(s);
    case "latin1": case "ascii": return ops.op_k_latin1_encode(s);
    case "utf16le": { const u = new Uint8Array(s.length * 2); for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); u[i * 2] = c & 255; u[i * 2 + 1] = c >> 8; } return u; }
  }
}

function decodeBytes(u8, enc) {
  switch (normEnc(enc)) {
    case "utf8": return utf8Decode(u8);
    case "hex": return ops.op_k_hex_encode(u8);
    case "base64": return ops.op_k_base64_encode(u8, false);
    case "base64url": return ops.op_k_base64_encode(u8, true);
    case "latin1": return ops.op_k_latin1_decode(u8);
    case "ascii": { let s = ""; for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i] & 127); return s; }
    case "utf16le": { let s = ""; for (let i = 0; i + 1 < u8.length; i += 2) s += String.fromCharCode(u8[i] | (u8[i + 1] << 8)); return s; }
  }
}

export class Buffer extends Uint8Array {
  static poolSize = 8192;

  static from(value, encodingOrOffset, length) {
    if (typeof value === "string") return fromBytes(encodeString(value, encodingOrOffset));
    if (value instanceof ArrayBuffer || value instanceof SharedArrayBuffer) {
      const off = encodingOrOffset >>> 0;
      const len = length === undefined ? value.byteLength - off : length >>> 0;
      return new Buffer(value, off, len);
    }
    if (ArrayBuffer.isView(value)) return fromBytes(new Uint8Array(value.buffer, value.byteOffset, value.byteLength), true);
    if (Array.isArray(value)) { const b = Buffer.allocUnsafe(value.length); for (let i = 0; i < value.length; i++) b[i] = value[i] & 255; return b; }
    if (value && typeof value === "object") {
      if (value.type === "Buffer" && Array.isArray(value.data)) return Buffer.from(value.data);
      if (typeof value.length === "number") return Buffer.from(Array.from(value));
      if (typeof value.valueOf === "function" && value.valueOf() !== value) return Buffer.from(value.valueOf(), encodingOrOffset, length);
      if (typeof value[Symbol.toPrimitive] === "function") return Buffer.from(value[Symbol.toPrimitive]("string"), encodingOrOffset, length);
    }
    throw nodeError("ERR_INVALID_ARG_TYPE", "The first argument must be of type string or an instance of Buffer, ArrayBuffer, or Array or an Array-like Object. Received " + typeof value, TypeError);
  }
  static alloc(size, fill, encoding) {
    checkSize(size);
    const b = new Buffer(size);
    if (fill !== undefined && fill !== 0) b.fill(fill, 0, size, encoding);
    return b;
  }
  static allocUnsafe(size) { checkSize(size); return new Buffer(size); }
  static allocUnsafeSlow(size) { checkSize(size); return new Buffer(size); }
  static isBuffer(b) { return b instanceof Buffer; }
  static isEncoding(e) { try { normEnc(e); return true; } catch { return false; } }
  static byteLength(v, enc) {
    if (typeof v === "string") { const e = normEnc(enc); if (e === "utf8") return utf8Encode(v).length; if (e === "hex") return v.length >>> 1; if (e === "base64" || e === "base64url") return ops.op_k_base64_decode(v).length; if (e === "utf16le") return v.length * 2; return v.length; }
    if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer) return v.byteLength;
    throw nodeError("ERR_INVALID_ARG_TYPE", 'The "string" argument must be of type string or an instance of Buffer or ArrayBuffer', TypeError);
  }
  static concat(list, totalLength) {
    if (!Array.isArray(list)) throw nodeError("ERR_INVALID_ARG_TYPE", 'The "list" argument must be an instance of Array', TypeError);
    if (list.length === 0) return Buffer.alloc(0);
    if (totalLength === undefined) { totalLength = 0; for (const b of list) totalLength += b.length; }
    const out = Buffer.allocUnsafe(totalLength);
    let pos = 0;
    for (const b of list) { const src = b instanceof Uint8Array ? b : Buffer.from(b); const n = Math.min(src.length, totalLength - pos); out.set(n === src.length ? src : src.subarray(0, n), pos); pos += n; if (pos >= totalLength) break; }
    if (pos < totalLength) out.fill(0, pos);
    return out;
  }
  static compare(a, b) {
    if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array)) throw nodeError("ERR_INVALID_ARG_TYPE", 'The "buf1" argument must be an instance of Buffer or Uint8Array', TypeError);
    return compareBytes(a, b);
  }

  get parent() { return this.buffer; }
  get offset() { return this.byteOffset; }

  toString(enc, start, end) {
    if (arguments.length === 0) return utf8Decode(this);
    start = start === undefined ? 0 : Math.max(0, start | 0);
    end = end === undefined ? this.length : Math.min(this.length, end | 0);
    if (end <= start) return "";
    return decodeBytes(start === 0 && end === this.length ? this : this.subarray(start, end), enc);
  }
  toLocaleString(enc, start, end) { return this.toString(enc, start, end); }
  toJSON() { return { type: "Buffer", data: Array.from(this) }; }
  equals(other) { if (!(other instanceof Uint8Array)) throw nodeError("ERR_INVALID_ARG_TYPE", 'The "otherBuffer" argument must be an instance of Buffer or Uint8Array', TypeError); return compareBytes(this, other) === 0; }
  compare(target, tStart = 0, tEnd = target.length, sStart = 0, sEnd = this.length) { return compareBytes(this.subarray(sStart, sEnd), target.subarray(tStart, tEnd)); }
  copy(target, targetStart = 0, sourceStart = 0, sourceEnd = this.length) {
    const n = Math.max(0, Math.min(sourceEnd - sourceStart, target.length - targetStart, this.length - sourceStart));
    if (n > 0) target.set(this.subarray(sourceStart, sourceStart + n), targetStart);
    return n;
  }
  slice(start, end) { return this.subarray(start, end); }
  subarray(start, end) { const u = Uint8Array.prototype.subarray.call(this, start, end); return new Buffer(u.buffer, u.byteOffset, u.byteLength); }
  write(string, offset = 0, length, encoding) {
    if (typeof offset === "string") { encoding = offset; offset = 0; length = undefined; }
    else if (typeof length === "string") { encoding = length; length = undefined; }
    const bytes = encodeString(string, encoding);
    const n = Math.min(bytes.length, length === undefined ? this.length - offset : length, this.length - offset);
    this.set(n === bytes.length ? bytes : bytes.subarray(0, n), offset);
    return n;
  }
  fill(value, offset = 0, end = this.length, encoding) {
    if (typeof offset === "string") { encoding = offset; offset = 0; end = this.length; }
    else if (typeof end === "string") { encoding = end; end = this.length; }
    if (typeof value === "number") { Uint8Array.prototype.fill.call(this, value & 255, offset, end); return this; }
    const bytes = typeof value === "string" ? encodeString(value, encoding) : Buffer.from(value);
    if (bytes.length === 0) { Uint8Array.prototype.fill.call(this, 0, offset, end); return this; }
    for (let i = offset, j = 0; i < end; i++, j = (j + 1) % bytes.length) this[i] = bytes[j];
    return this;
  }
  indexOf(value, byteOffset = 0, encoding) { return indexOfImpl(this, value, byteOffset, encoding, true); }
  lastIndexOf(value, byteOffset = this.length - 1, encoding) { return indexOfImpl(this, value, byteOffset, encoding, false); }
  includes(value, byteOffset, encoding) { return this.indexOf(value, byteOffset, encoding) !== -1; }
  reverse() { Uint8Array.prototype.reverse.call(this); return this; }
  swap16() { for (let i = 0; i + 1 < this.length; i += 2) { const t = this[i]; this[i] = this[i + 1]; this[i + 1] = t; } return this; }
  swap32() { for (let i = 0; i + 3 < this.length; i += 4) { let t = this[i]; this[i] = this[i + 3]; this[i + 3] = t; t = this[i + 1]; this[i + 1] = this[i + 2]; this[i + 2] = t; } return this; }

  // ---- numeric accessors ----
  readUInt8(o = 0) { chk(this, o, 1); return this[o]; }
  readInt8(o = 0) { chk(this, o, 1); const v = this[o]; return v & 0x80 ? v - 0x100 : v; }
  readUInt16LE(o = 0) { chk(this, o, 2); return this[o] | (this[o + 1] << 8); }
  readUInt16BE(o = 0) { chk(this, o, 2); return (this[o] << 8) | this[o + 1]; }
  readInt16LE(o = 0) { const v = this.readUInt16LE(o); return v & 0x8000 ? v - 0x10000 : v; }
  readInt16BE(o = 0) { const v = this.readUInt16BE(o); return v & 0x8000 ? v - 0x10000 : v; }
  readUInt32LE(o = 0) { chk(this, o, 4); return (this[o] | (this[o + 1] << 8) | (this[o + 2] << 16)) + this[o + 3] * 0x1000000; }
  readUInt32BE(o = 0) { chk(this, o, 4); return this[o] * 0x1000000 + ((this[o + 1] << 16) | (this[o + 2] << 8) | this[o + 3]); }
  readInt32LE(o = 0) { chk(this, o, 4); return this[o] | (this[o + 1] << 8) | (this[o + 2] << 16) | (this[o + 3] << 24); }
  readInt32BE(o = 0) { chk(this, o, 4); return (this[o] << 24) | (this[o + 1] << 16) | (this[o + 2] << 8) | this[o + 3]; }
  readBigUInt64LE(o = 0) { chk(this, o, 8); return BigInt(this.readUInt32LE(o)) | (BigInt(this.readUInt32LE(o + 4)) << 32n); }
  readBigUInt64BE(o = 0) { chk(this, o, 8); return (BigInt(this.readUInt32BE(o)) << 32n) | BigInt(this.readUInt32BE(o + 4)); }
  readBigInt64LE(o = 0) { return BigInt.asIntN(64, this.readBigUInt64LE(o)); }
  readBigInt64BE(o = 0) { return BigInt.asIntN(64, this.readBigUInt64BE(o)); }
  readFloatLE(o = 0) { chk(this, o, 4); return dv(this).getFloat32(o, true); }
  readFloatBE(o = 0) { chk(this, o, 4); return dv(this).getFloat32(o, false); }
  readDoubleLE(o = 0) { chk(this, o, 8); return dv(this).getFloat64(o, true); }
  readDoubleBE(o = 0) { chk(this, o, 8); return dv(this).getFloat64(o, false); }
  readUIntLE(o, n) { chk(this, o, n); let v = 0, m = 1; for (let i = 0; i < n; i++) { v += this[o + i] * m; m *= 256; } return v; }
  readUIntBE(o, n) { chk(this, o, n); let v = 0; for (let i = 0; i < n; i++) v = v * 256 + this[o + i]; return v; }
  readIntLE(o, n) { const v = this.readUIntLE(o, n); const lim = 2 ** (8 * n - 1); return v >= lim ? v - 2 * lim : v; }
  readIntBE(o, n) { const v = this.readUIntBE(o, n); const lim = 2 ** (8 * n - 1); return v >= lim ? v - 2 * lim : v; }
  writeUInt8(v, o = 0) { chk(this, o, 1); this[o] = v; return o + 1; }
  writeInt8(v, o = 0) { chk(this, o, 1); this[o] = v & 255; return o + 1; }
  writeUInt16LE(v, o = 0) { chk(this, o, 2); this[o] = v; this[o + 1] = v >>> 8; return o + 2; }
  writeUInt16BE(v, o = 0) { chk(this, o, 2); this[o] = v >>> 8; this[o + 1] = v; return o + 2; }
  writeInt16LE(v, o = 0) { return this.writeUInt16LE(v & 0xffff, o); }
  writeInt16BE(v, o = 0) { return this.writeUInt16BE(v & 0xffff, o); }
  writeUInt32LE(v, o = 0) { chk(this, o, 4); this[o] = v; this[o + 1] = v >>> 8; this[o + 2] = v >>> 16; this[o + 3] = v >>> 24; return o + 4; }
  writeUInt32BE(v, o = 0) { chk(this, o, 4); this[o] = v >>> 24; this[o + 1] = v >>> 16; this[o + 2] = v >>> 8; this[o + 3] = v; return o + 4; }
  writeInt32LE(v, o = 0) { return this.writeUInt32LE(v >>> 0, o); }
  writeInt32BE(v, o = 0) { return this.writeUInt32BE(v >>> 0, o); }
  writeBigUInt64LE(v, o = 0) { chk(this, o, 8); this.writeUInt32LE(Number(v & 0xffffffffn), o); this.writeUInt32LE(Number((v >> 32n) & 0xffffffffn), o + 4); return o + 8; }
  writeBigUInt64BE(v, o = 0) { chk(this, o, 8); this.writeUInt32BE(Number((v >> 32n) & 0xffffffffn), o); this.writeUInt32BE(Number(v & 0xffffffffn), o + 4); return o + 8; }
  writeBigInt64LE(v, o = 0) { return this.writeBigUInt64LE(BigInt.asUintN(64, v), o); }
  writeBigInt64BE(v, o = 0) { return this.writeBigUInt64BE(BigInt.asUintN(64, v), o); }
  writeFloatLE(v, o = 0) { chk(this, o, 4); dv(this).setFloat32(o, v, true); return o + 4; }
  writeFloatBE(v, o = 0) { chk(this, o, 4); dv(this).setFloat32(o, v, false); return o + 4; }
  writeDoubleLE(v, o = 0) { chk(this, o, 8); dv(this).setFloat64(o, v, true); return o + 8; }
  writeDoubleBE(v, o = 0) { chk(this, o, 8); dv(this).setFloat64(o, v, false); return o + 8; }
  writeUIntLE(v, o, n) { chk(this, o, n); for (let i = 0; i < n; i++) { this[o + i] = v & 255; v = Math.floor(v / 256); } return o + n; }
  writeUIntBE(v, o, n) { chk(this, o, n); for (let i = n - 1; i >= 0; i--) { this[o + i] = v & 255; v = Math.floor(v / 256); } return o + n; }
  writeIntLE(v, o, n) { return this.writeUIntLE(v < 0 ? v + 2 ** (8 * n) : v, o, n); }
  writeIntBE(v, o, n) { return this.writeUIntBE(v < 0 ? v + 2 ** (8 * n) : v, o, n); }
}
// Aliases
for (const [a, b] of [["readUint8", "readUInt8"], ["readUint16LE", "readUInt16LE"], ["readUint16BE", "readUInt16BE"], ["readUint32LE", "readUInt32LE"], ["readUint32BE", "readUInt32BE"], ["readBigUint64LE", "readBigUInt64LE"], ["readBigUint64BE", "readBigUInt64BE"], ["readUintLE", "readUIntLE"], ["readUintBE", "readUIntBE"], ["writeUint8", "writeUInt8"], ["writeUint16LE", "writeUInt16LE"], ["writeUint16BE", "writeUInt16BE"], ["writeUint32LE", "writeUInt32LE"], ["writeUint32BE", "writeUInt32BE"], ["writeBigUint64LE", "writeBigUInt64LE"], ["writeBigUint64BE", "writeBigUInt64BE"], ["writeUintLE", "writeUIntLE"], ["writeUintBE", "writeUIntBE"]]) {
  Buffer.prototype[a] = Buffer.prototype[b];
}

function dv(b) { return new DataView(b.buffer, b.byteOffset, b.byteLength); }
function chk(b, o, n) { if (!(o >= 0 && o + n <= b.length)) { throw nodeError("ERR_OUT_OF_RANGE", 'The value of "offset" is out of range. It must be >= 0 and <= ' + (b.length - n) + ". Received " + o, RangeError); } }
function checkSize(size) { if (typeof size !== "number") throw nodeError("ERR_INVALID_ARG_TYPE", 'The "size" argument must be of type number. Received ' + typeof size, TypeError); if (size < 0 || size > kMaxLength) throw nodeError("ERR_OUT_OF_RANGE", 'The value of "size" is out of range. It must be >= 0 && <= ' + kMaxLength + ". Received " + size, RangeError); }
function fromBytes(u8, copy = false) { if (!copy && u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength) return new Buffer(u8.buffer); const b = new Buffer(u8.length); b.set(u8); return b; }
function compareBytes(a, b) { const n = Math.min(a.length, b.length); for (let i = 0; i < n; i++) { if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1; } return a.length === b.length ? 0 : a.length < b.length ? -1 : 1; }
function indexOfImpl(buf, value, byteOffset, encoding, forward) {
  if (typeof byteOffset === "string") { encoding = byteOffset; byteOffset = forward ? 0 : buf.length - 1; }
  byteOffset = +byteOffset; if (Number.isNaN(byteOffset)) byteOffset = forward ? 0 : buf.length - 1;
  if (byteOffset < 0) byteOffset += buf.length;
  if (typeof value === "number") { value &= 255; if (forward) { for (let i = Math.max(0, byteOffset); i < buf.length; i++) if (buf[i] === value) return i; } else { for (let i = Math.min(byteOffset, buf.length - 1); i >= 0; i--) if (buf[i] === value) return i; } return -1; }
  const needle = typeof value === "string" ? encodeString(value, encoding) : value;
  if (needle.length === 0) return forward ? Math.min(byteOffset, buf.length) : Math.min(byteOffset, buf.length);
  const test = (i) => { for (let j = 0; j < needle.length; j++) if (buf[i + j] !== needle[j]) return false; return true; };
  if (forward) { for (let i = Math.max(0, byteOffset); i <= buf.length - needle.length; i++) if (test(i)) return i; }
  else { for (let i = Math.min(byteOffset, buf.length - needle.length); i >= 0; i--) if (test(i)) return i; }
  return -1;
}

export const SlowBuffer = Buffer;
export const constants = { MAX_LENGTH: kMaxLength, MAX_STRING_LENGTH: kStringMaxLength };
export const INSPECT_MAX_BYTES = 50;
export const kMaxLength_ = kMaxLength;
export { kMaxLength, kStringMaxLength };
export function transcode(source, from, to) { return Buffer.from(Buffer.from(source).toString(from), to); }
export function isUtf8(u8) { try { new TextDecoder("utf-8", { fatal: true }).decode(u8); return true; } catch { return false; } }
export function isAscii(u8) { for (const b of u8) if (b > 127) return false; return true; }
export function atob(s) { return ops.op_k_latin1_decode(ops.op_k_base64_decode(String(s))); }
export function btoa(s) { return ops.op_k_base64_encode(ops.op_k_latin1_encode(String(s)), false); }
export class Blob {
  #parts;
  constructor(parts = [], opts = {}) { this.#parts = parts.map((p) => typeof p === "string" ? utf8Encode(p) : p instanceof Blob ? p.#bytes() : new Uint8Array(ArrayBuffer.isView(p) ? p.buffer.slice(p.byteOffset, p.byteOffset + p.byteLength) : p)); this.type = opts.type || ""; }
  #bytes() { const n = this.#parts.reduce((a, p) => a + p.length, 0); const out = new Uint8Array(n); let o = 0; for (const p of this.#parts) { out.set(p, o); o += p.length; } return out; }
  get size() { return this.#parts.reduce((a, p) => a + p.length, 0); }
  async arrayBuffer() { return this.#bytes().buffer; }
  async bytes() { return this.#bytes(); }
  async text() { return utf8Decode(this.#bytes()); }
  slice(start = 0, end = this.size, type = "") { return new Blob([this.#bytes().slice(start, end)], { type }); }
  stream() { const bytes = this.#bytes(); return new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }); }
  get [Symbol.toStringTag]() { return "Blob"; }
}
export class File extends Blob { constructor(parts, name, opts = {}) { super(parts, opts); this.name = String(name); this.lastModified = opts.lastModified ?? Date.now(); } get [Symbol.toStringTag]() { return "File"; } }

const buffer = { Buffer, SlowBuffer, constants, INSPECT_MAX_BYTES, kMaxLength, kStringMaxLength, transcode, isUtf8, isAscii, atob, btoa, Blob, File };
export default buffer;
