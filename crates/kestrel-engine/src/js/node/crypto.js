// node:crypto — hashes, HMAC, random; webcrypto subset.
import { ops, nodeError, toUint8 } from "ext:kestrel/internal.js";
import { Buffer } from "ext:kestrel/node/buffer.js";

const ALGOS = ["md5", "sha1", "sha224", "sha256", "sha384", "sha512"];
const norm = (a) => String(a).toLowerCase().replace("-", "");

class Hash {
  #algo; #chunks = []; #done = false;
  constructor(algo) { this.#algo = norm(algo); if (!ALGOS.includes(this.#algo)) throw nodeError("ERR_OSSL_EVP_UNSUPPORTED", "Digest method not supported"); }
  update(data, enc) { if (this.#done) throw nodeError("ERR_CRYPTO_HASH_FINALIZED", "Digest already called"); this.#chunks.push(typeof data === "string" ? Buffer.from(data, enc) : toUint8(data)); return this; }
  digest(enc) { if (this.#done) throw nodeError("ERR_CRYPTO_HASH_FINALIZED", "Digest already called"); this.#done = true; const out = Buffer.from(ops.op_k_hash(this.#algo, Buffer.concat(this.#chunks))); return enc ? out.toString(enc) : out; }
  copy() { const h = new Hash(this.#algo); h.#chunks = this.#chunks.slice(); return h; }
}
class Hmac {
  #algo; #key; #chunks = []; #done = false;
  constructor(algo, key) { this.#algo = norm(algo); this.#key = typeof key === "string" ? Buffer.from(key) : toUint8(key); if (!ALGOS.includes(this.#algo)) throw nodeError("ERR_OSSL_EVP_UNSUPPORTED", "Invalid digest: " + algo); }
  update(data, enc) { this.#chunks.push(typeof data === "string" ? Buffer.from(data, enc) : toUint8(data)); return this; }
  digest(enc) { if (this.#done) throw nodeError("ERR_CRYPTO_HASH_FINALIZED", "Digest already called"); this.#done = true; const out = Buffer.from(ops.op_k_hmac(this.#algo, this.#key, Buffer.concat(this.#chunks))); return enc ? out.toString(enc) : out; }
}

export function createHash(algo) { return new Hash(algo); }
export function createHmac(algo, key) { return new Hmac(algo, key); }
export function hash(algo, data, enc = "hex") { return createHash(algo).update(data).digest(enc); }
export function getHashes() { return ALGOS.slice(); }
export function getCiphers() { return []; }
export function getCurves() { return []; }
export function randomBytes(n, cb) { const b = Buffer.from(ops.op_k_random_bytes(n >>> 0)); if (cb) { queueMicrotask(() => cb(null, b)); return; } return b; }
export function randomFillSync(buf, offset = 0, size) { const u = toUint8(buf); size = size ?? u.length - offset; u.set(ops.op_k_random_bytes(size), offset); return buf; }
export function randomFill(buf, ...args) { const cb = args.pop(); randomFillSync(buf, ...args); queueMicrotask(() => cb(null, buf)); }
export function randomUUID() { return ops.op_k_random_uuid(); }
export function randomInt(min, max, cb) { if (max === undefined || typeof max === "function") { cb = max; max = min; min = 0; } const range = max - min; const b = ops.op_k_random_bytes(6); let v = 0; for (let i = 0; i < 6; i++) v = v * 256 + b[i]; const r = min + (v % range); if (cb) { queueMicrotask(() => cb(null, r)); return; } return r; }
export function getRandomValues(arr) { if (!ArrayBuffer.isView(arr)) throw new TypeError("expected a TypedArray"); new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength).set(ops.op_k_random_bytes(arr.byteLength)); return arr; }
export function timingSafeEqual(a, b) { a = toUint8(a); b = toUint8(b); if (a.length !== b.length) throw nodeError("ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH", "Input buffers must have the same byte length", RangeError); let r = 0; for (let i = 0; i < a.length; i++) r |= a[i] ^ b[i]; return r === 0; }
export function pbkdf2Sync() { throw nodeError("ERR_METHOD_NOT_IMPLEMENTED", "crypto.pbkdf2 is not implemented yet"); }
export function pbkdf2(...args) { const cb = args.pop(); queueMicrotask(() => cb(new Error("crypto.pbkdf2 is not implemented yet"))); }
export function scryptSync() { throw nodeError("ERR_METHOD_NOT_IMPLEMENTED", "crypto.scrypt is not implemented yet"); }
export function createCipheriv() { throw nodeError("ERR_METHOD_NOT_IMPLEMENTED", "crypto.createCipheriv is not implemented yet"); }
export function createDecipheriv() { throw nodeError("ERR_METHOD_NOT_IMPLEMENTED", "crypto.createDecipheriv is not implemented yet"); }
export function createSign() { throw nodeError("ERR_METHOD_NOT_IMPLEMENTED", "crypto.createSign is not implemented yet"); }
export function createVerify() { throw nodeError("ERR_METHOD_NOT_IMPLEMENTED", "crypto.createVerify is not implemented yet"); }
export function generateKeyPairSync() { throw nodeError("ERR_METHOD_NOT_IMPLEMENTED", "crypto.generateKeyPair is not implemented yet"); }
export const constants = {};

const subtle = {
  async digest(algo, data) { const name = typeof algo === "string" ? algo : algo.name; return Buffer.from(ops.op_k_hash(norm(name), toUint8(data))).buffer; },
  async importKey() { throw nodeError("ERR_METHOD_NOT_IMPLEMENTED", "subtle.importKey is not implemented yet"); },
  async sign() { throw nodeError("ERR_METHOD_NOT_IMPLEMENTED", "subtle.sign is not implemented yet"); },
  async verify() { throw nodeError("ERR_METHOD_NOT_IMPLEMENTED", "subtle.verify is not implemented yet"); },
  async encrypt() { throw nodeError("ERR_METHOD_NOT_IMPLEMENTED", "subtle.encrypt is not implemented yet"); },
  async decrypt() { throw nodeError("ERR_METHOD_NOT_IMPLEMENTED", "subtle.decrypt is not implemented yet"); },
  async generateKey() { throw nodeError("ERR_METHOD_NOT_IMPLEMENTED", "subtle.generateKey is not implemented yet"); },
};
export const webcrypto = { subtle, getRandomValues, randomUUID, get [Symbol.toStringTag]() { return "Crypto"; } };
export { subtle };

const crypto = { createHash, createHmac, hash, getHashes, getCiphers, getCurves, randomBytes, randomFillSync, randomFill, randomUUID, randomInt, getRandomValues, timingSafeEqual, pbkdf2Sync, pbkdf2, scryptSync, createCipheriv, createDecipheriv, createSign, createVerify, generateKeyPairSync, constants, webcrypto, subtle, Hash, Hmac };
export default crypto;
