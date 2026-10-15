// node:zlib — gzip/deflate/raw via flate2. Sync, callback, and stream forms (streams buffer whole input).
import { ops, toUint8, nodeError } from "ext:kestrel/internal.js";
import { Buffer } from "ext:kestrel/node/buffer.js";
import { Transform } from "ext:kestrel/node/stream.js";

const run = (mode, data, opts) => Buffer.from(ops.op_k_zlib(mode, typeof data === "string" ? Buffer.from(data) : toUint8(data), opts && typeof opts.level === "number" ? opts.level : -1));
const cbForm = (mode) => (data, opts, cb) => { if (typeof opts === "function") { cb = opts; opts = {}; } let r, err = null; try { r = run(mode, data, opts); } catch (e) { err = e; } queueMicrotask(() => (err ? cb(err) : cb(null, r))); };

export const gzipSync = (d, o) => run("gzip", d, o);
export const gunzipSync = (d, o) => run("gunzip", d, o);
export const deflateSync = (d, o) => run("deflate", d, o);
export const inflateSync = (d, o) => run("inflate", d, o);
export const deflateRawSync = (d, o) => run("deflateRaw", d, o);
export const inflateRawSync = (d, o) => run("inflateRaw", d, o);
export const unzipSync = (d, o) => run("unzip", d, o);
export const gzip = cbForm("gzip");
export const gunzip = cbForm("gunzip");
export const deflate = cbForm("deflate");
export const inflate = cbForm("inflate");
export const deflateRaw = cbForm("deflateRaw");
export const inflateRaw = cbForm("inflateRaw");
export const unzip = cbForm("unzip");
const brQuality = (o) => (o && o.params && o.params[constants.BROTLI_PARAM_QUALITY] !== undefined ? o.params[constants.BROTLI_PARAM_QUALITY] : 11);
export const brotliCompressSync = (d, o) => Buffer.from(ops.op_brotli(typeof d === "string" ? Buffer.from(d) : toUint8(d), true, brQuality(o)));
export const brotliDecompressSync = (d) => Buffer.from(ops.op_brotli(typeof d === "string" ? Buffer.from(d) : toUint8(d), false, 0));
export const brotliCompress = (d, o, cb) => { if (typeof o === "function") { cb = o; o = {}; } let r, err = null; try { r = brotliCompressSync(d, o); } catch (e) { err = e; } queueMicrotask(() => (err ? cb(err) : cb(null, r))); };
export const brotliDecompress = (d, o, cb) => { if (typeof o === "function") { cb = o; o = {}; } let r, err = null; try { r = brotliDecompressSync(d); } catch (e) { err = e; } queueMicrotask(() => (err ? cb(err) : cb(null, r))); };

class ZlibStream extends Transform {
  #chunks = []; #mode; #opts;
  constructor(mode, opts = {}) { super(); this.#mode = mode; this.#opts = opts; this.bytesWritten = 0; }
  _transform(chunk, enc, cb) { const b = typeof chunk === "string" ? Buffer.from(chunk, enc) : chunk; this.bytesWritten += b.length; this.#chunks.push(b); cb(); }
  _flush(cb) { try { cb(null, run(this.#mode, Buffer.concat(this.#chunks), this.#opts)); } catch (e) { cb(e); } }
  flush(cb) { if (cb) queueMicrotask(cb); }
  close(cb) { this.destroy(); if (cb) queueMicrotask(cb); }
  params() {}
  reset() { this.#chunks = []; }
}
export class Gzip extends ZlibStream { constructor(o) { super("gzip", o); } }
export class Gunzip extends ZlibStream { constructor(o) { super("gunzip", o); } }
export class Deflate extends ZlibStream { constructor(o) { super("deflate", o); } }
export class Inflate extends ZlibStream { constructor(o) { super("inflate", o); } }
export class DeflateRaw extends ZlibStream { constructor(o) { super("deflateRaw", o); } }
export class InflateRaw extends ZlibStream { constructor(o) { super("inflateRaw", o); } }
export class Unzip extends ZlibStream { constructor(o) { super("unzip", o); } }
class BrotliStream extends Transform {
  #chunks = []; #compress; #opts;
  constructor(compress, opts = {}) { super(); this.#compress = compress; this.#opts = opts; }
  _transform(chunk, enc, cb) { this.#chunks.push(typeof chunk === "string" ? Buffer.from(chunk, enc) : chunk); cb(); }
  _flush(cb) { try { cb(null, this.#compress ? brotliCompressSync(Buffer.concat(this.#chunks), this.#opts) : brotliDecompressSync(Buffer.concat(this.#chunks))); } catch (e) { cb(e); } }
  flush(cb) { if (cb) queueMicrotask(cb); } close(cb) { this.destroy(); if (cb) queueMicrotask(cb); }
}
export class BrotliCompress extends BrotliStream { constructor(o) { super(true, o); } }
export class BrotliDecompress extends BrotliStream { constructor(o) { super(false, o); } }
export const createBrotliCompress = (o) => new BrotliCompress(o);
export const createBrotliDecompress = (o) => new BrotliDecompress(o);
export const createGzip = (o) => new Gzip(o);
export const createGunzip = (o) => new Gunzip(o);
export const createDeflate = (o) => new Deflate(o);
export const createInflate = (o) => new Inflate(o);
export const createDeflateRaw = (o) => new DeflateRaw(o);
export const createInflateRaw = (o) => new InflateRaw(o);
export const createUnzip = (o) => new Unzip(o);
export const constants = { Z_NO_FLUSH: 0, Z_PARTIAL_FLUSH: 1, Z_SYNC_FLUSH: 2, Z_FULL_FLUSH: 3, Z_FINISH: 4, Z_OK: 0, Z_STREAM_END: 1, Z_NO_COMPRESSION: 0, Z_BEST_SPEED: 1, Z_BEST_COMPRESSION: 9, Z_DEFAULT_COMPRESSION: -1, Z_DEFAULT_STRATEGY: 0, Z_DEFAULT_WINDOWBITS: 15, Z_DEFAULT_MEMLEVEL: 8, BROTLI_OPERATION_PROCESS: 0, BROTLI_OPERATION_FINISH: 2, BROTLI_PARAM_QUALITY: 1, BROTLI_PARAM_MODE: 0 };
export function crc32(data, value = 0) { let c = ~value >>> 0; const u = typeof data === "string" ? Buffer.from(data) : toUint8(data); for (let i = 0; i < u.length; i++) { c ^= u[i]; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1; } return (~c) >>> 0; }
export default { BrotliCompress, BrotliDecompress, createBrotliCompress, createBrotliDecompress, gzipSync, gunzipSync, deflateSync, inflateSync, deflateRawSync, inflateRawSync, unzipSync, gzip, gunzip, deflate, inflate, deflateRaw, inflateRaw, unzip, brotliCompressSync, brotliDecompressSync, brotliCompress, brotliDecompress, Gzip, Gunzip, Deflate, Inflate, DeflateRaw, InflateRaw, Unzip, createGzip, createGunzip, createDeflate, createInflate, createDeflateRaw, createInflateRaw, createUnzip, constants, crc32 };
