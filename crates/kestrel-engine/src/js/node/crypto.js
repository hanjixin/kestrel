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
export function getCiphers() { return Object.keys(CIPHERS); }
export function getCurves() { return []; }
export function randomBytes(n, cb) { const b = Buffer.from(ops.op_k_random_bytes(n >>> 0)); if (cb) { queueMicrotask(() => cb(null, b)); return; } return b; }
export function randomFillSync(buf, offset = 0, size) { const u = toUint8(buf); size = size ?? u.length - offset; u.set(ops.op_k_random_bytes(size), offset); return buf; }
export function randomFill(buf, ...args) { const cb = args.pop(); randomFillSync(buf, ...args); queueMicrotask(() => cb(null, buf)); }
export function randomUUID() { return ops.op_k_random_uuid(); }
export function randomInt(min, max, cb) { if (max === undefined || typeof max === "function") { cb = max; max = min; min = 0; } const range = max - min; const b = ops.op_k_random_bytes(6); let v = 0; for (let i = 0; i < 6; i++) v = v * 256 + b[i]; const r = min + (v % range); if (cb) { queueMicrotask(() => cb(null, r)); return; } return r; }
export function getRandomValues(arr) { if (!ArrayBuffer.isView(arr)) throw new TypeError("expected a TypedArray"); new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength).set(ops.op_k_random_bytes(arr.byteLength)); return arr; }
export function timingSafeEqual(a, b) { a = toUint8(a); b = toUint8(b); if (a.length !== b.length) throw nodeError("ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH", "Input buffers must have the same byte length", RangeError); let r = 0; for (let i = 0; i < a.length; i++) r |= a[i] ^ b[i]; return r === 0; }
const bytesOf = (x, enc) => (typeof x === "string" ? Buffer.from(x, enc) : toUint8(x));
export function pbkdf2Sync(password, salt, iterations, keylen, digest = "sha1") { return Buffer.from(ops.op_pbkdf2(bytesOf(password), bytesOf(salt), iterations >>> 0, keylen >>> 0, String(digest))); }
export function pbkdf2(password, salt, iterations, keylen, digest, cb) { if (typeof digest === "function") { cb = digest; digest = "sha1"; } let r, err = null; try { r = pbkdf2Sync(password, salt, iterations, keylen, digest); } catch (e) { err = e; } queueMicrotask(() => (err ? cb(err) : cb(null, r))); }
export function scryptSync(password, salt, keylen, opts = {}) { const N = opts.N ?? opts.cost ?? 16384, r = opts.r ?? opts.blockSize ?? 8, p = opts.p ?? opts.parallelization ?? 1; return Buffer.from(ops.op_scrypt(bytesOf(password), bytesOf(salt), N, r, p, keylen >>> 0)); }
export function scrypt(password, salt, keylen, opts, cb) { if (typeof opts === "function") { cb = opts; opts = {}; } let r, err = null; try { r = scryptSync(password, salt, keylen, opts); } catch (e) { err = e; } queueMicrotask(() => (err ? cb(err) : cb(null, r))); }
export function hkdfSync(digest, ikm, salt, info, keylen) { const out = ops.op_hkdf(String(digest), bytesOf(ikm), bytesOf(salt), bytesOf(info), keylen >>> 0); return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength); }
export function hkdf(digest, ikm, salt, info, keylen, cb) { let r, err = null; try { r = hkdfSync(digest, ikm, salt, info, keylen); } catch (e) { err = e; } queueMicrotask(() => (err ? cb(err) : cb(null, r))); }

const CIPHERS = { "aes-128-gcm": [16, 12, true], "aes-256-gcm": [32, 12, true], "chacha20-poly1305": [32, 12, true], "aes-128-cbc": [16, 16, false], "aes-256-cbc": [32, 16, false], "aes-128-ctr": [16, 16, false], "aes-256-ctr": [32, 16, false] };
class CipherBase {
  #algo; #key; #iv; #chunks = []; #aad = []; #encrypt; #tag = null; #authTag = null; #done = false; #aead;
  constructor(algo, key, iv, encrypt, opts = {}) {
    this.#algo = String(algo).toLowerCase();
    const spec = CIPHERS[this.#algo];
    if (!spec) throw nodeError("ERR_CRYPTO_UNKNOWN_CIPHER", "Unknown cipher");
    this.#key = bytesOf(key); this.#iv = iv == null ? new Uint8Array(0) : bytesOf(iv); this.#encrypt = encrypt; this.#aead = spec[2];
    if (this.#key.length !== spec[0]) throw nodeError("ERR_CRYPTO_INVALID_KEYLEN", "Invalid key length", RangeError);
    if (this.#iv.length < spec[1]) throw nodeError("ERR_CRYPTO_INVALID_IV", "Invalid initialization vector", TypeError);
  }
  setAAD(buf) { this.#aad.push(bytesOf(buf)); return this; }
  setAutoPadding() { return this; }
  update(data, inputEnc, outputEnc) {
    // Buffered: block ciphers need the full input for padding, AEADs for the tag.
    this.#chunks.push(bytesOf(data, inputEnc));
    const empty = Buffer.alloc(0);
    return outputEnc && outputEnc !== "buffer" ? "" : empty;
  }
  final(outputEnc) {
    if (this.#done) throw nodeError("ERR_CRYPTO_INVALID_STATE", "Unsupported state or unable to authenticate data");
    this.#done = true;
    let input = Buffer.concat(this.#chunks);
    if (this.#aead && !this.#encrypt) { if (!this.#authTag) throw nodeError("ERR_CRYPTO_INVALID_STATE", "Unsupported state or unable to authenticate data"); input = Buffer.concat([input, this.#authTag]); }
    let out = Buffer.from(ops.op_cipher(this.#algo, this.#encrypt, this.#key, this.#iv, input, Buffer.concat(this.#aad)));
    if (this.#aead && this.#encrypt) { this.#tag = out.subarray(out.length - 16); out = out.subarray(0, out.length - 16); }
    return outputEnc && outputEnc !== "buffer" ? out.toString(outputEnc) : out;
  }
  getAuthTag() { if (!this.#tag) throw nodeError("ERR_CRYPTO_INVALID_STATE", "Invalid state for operation getAuthTag"); return Buffer.from(this.#tag); }
  setAuthTag(tag) { this.#authTag = bytesOf(tag); return this; }
}
export class Cipheriv extends CipherBase { constructor(a, k, iv, o) { super(a, k, iv, true, o); } }
export class Decipheriv extends CipherBase { constructor(a, k, iv, o) { super(a, k, iv, false, o); } }
export function createCipheriv(algo, key, iv, opts) { return new Cipheriv(algo, key, iv, opts); }
export function createDecipheriv(algo, key, iv, opts) { return new Decipheriv(algo, key, iv, opts); }
// ---- asymmetric: KeyObject, generateKeyPair, sign/verify (RSA PKCS#1 v1.5 / PSS, ECDSA P-256) ----
const pemOf = (k) => (k instanceof KeyObject ? k._pem : typeof k === "string" ? k : k && k.key !== undefined ? pemOf(k.key) : Buffer.from(k).toString());
export class KeyObject {
  constructor(type, pem, info) { this.type = type; this._pem = pem; this.asymmetricKeyType = info.kind; this.asymmetricKeyDetails = info.kind === "rsa" ? { modulusLength: info.bits } : { namedCurve: "prime256v1" }; }
  export(opts = {}) { if (opts.format === "der") throw nodeError("ERR_METHOD_NOT_IMPLEMENTED", "DER export is not supported yet"); return this._pem; }
  equals(o) { return o instanceof KeyObject && o._pem === this._pem; }
  get symmetricKeySize() { return undefined; }
}
export function createPrivateKey(key) { const pem = pemOf(key); const info = ops.op_key_info(pem); if (!info.is_private) throw nodeError("ERR_CRYPTO_INVALID_KEY_OBJECT_TYPE", "not a private key", TypeError); return new KeyObject("private", pem, info); }
export function createPublicKey(key) { const pem = pemOf(key); const info = ops.op_key_info(pem); return new KeyObject("public", pem, info); }
function encodeKey(pem, enc) { return !enc ? null : enc.format === "pem" || enc.format === undefined ? pem : (() => { throw nodeError("ERR_METHOD_NOT_IMPLEMENTED", "only PEM key encoding is supported yet"); })(); }
export function generateKeyPairSync(type, options = {}) {
  type = String(type).toLowerCase();
  const kind = type === "rsa" || type === "rsa-pss" ? "rsa" : type === "ec" ? "ec" : null;
  if (!kind) throw nodeError("ERR_INVALID_ARG_VALUE", "generateKeyPair: only 'rsa' and 'ec' (P-256) are supported yet");
  if (kind === "ec" && options.namedCurve && !/^(prime256v1|P-256|secp256r1)$/i.test(options.namedCurve)) throw nodeError("ERR_INVALID_ARG_VALUE", "only P-256 is supported yet");
  const kp = ops.op_keygen(kind, kind === "rsa" ? (options.modulusLength ?? 2048) : 0);
  const pubInfo = ops.op_key_info(kp.public_pem), privInfo = ops.op_key_info(kp.private_pem);
  const publicKey = options.publicKeyEncoding ? encodeKey(kp.public_pem, options.publicKeyEncoding) : new KeyObject("public", kp.public_pem, pubInfo);
  const privateKey = options.privateKeyEncoding ? encodeKey(kp.private_pem, options.privateKeyEncoding) : new KeyObject("private", kp.private_pem, privInfo);
  return { publicKey, privateKey };
}
export function generateKeyPair(type, options, cb) { if (typeof options === "function") { cb = options; options = {}; } let r, err = null; try { r = generateKeyPairSync(type, options); } catch (e) { err = e; } queueMicrotask(() => (err ? cb(err) : cb(null, r.publicKey, r.privateKey))); }
generateKeyPair[Symbol.for("nodejs.util.promisify.custom")] = (type, options) => new Promise((res, rej) => generateKeyPair(type, options, (e, publicKey, privateKey) => (e ? rej(e) : res({ publicKey, privateKey }))));
function schemeFor(key, algorithm) {
  const pem = pemOf(key); const info = ops.op_key_info(pem);
  const padding = key && typeof key === "object" && !(key instanceof KeyObject) ? key.padding : undefined;
  const scheme = info.kind === "ec" ? "ecdsa" : padding === constants.RSA_PKCS1_PSS_PADDING ? "rsa-pss" : "rsa-pkcs1";
  let digest = String(algorithm ?? (info.kind === "ec" ? "sha256" : "sha256")).toLowerCase().replace(/^rsa-/, "").replace("-", "");
  return { pem, scheme, digest };
}
class SignBase {
  #algo; #chunks = [];
  constructor(algo) { this.#algo = algo; }
  update(data, enc) { this.#chunks.push(bytesOf(data, enc)); return this; }
  _data() { return Buffer.concat(this.#chunks); }
  _algo() { return this.#algo; }
}
export class Sign extends SignBase {
  sign(key, enc) { const { pem, scheme, digest } = schemeFor(key, this._algo()); const sig = Buffer.from(ops.op_sign(scheme, digest, pem, this._data())); return enc ? sig.toString(enc) : sig; }
}
export class Verify extends SignBase {
  verify(key, signature, enc) { const { pem, scheme, digest } = schemeFor(key, this._algo()); return ops.op_verify(scheme, digest, pem, this._data(), typeof signature === "string" ? Buffer.from(signature, enc || "hex") : toUint8(signature)); }
}
export function createSign(algo) { return new Sign(algo); }
export function createVerify(algo) { return new Verify(algo); }
export function sign(algorithm, data, key, cb) { const r = new Sign(algorithm).update(data).sign(key); if (cb) { queueMicrotask(() => cb(null, r)); return; } return r; }
export function verify(algorithm, data, key, signature, cb) { const r = new Verify(algorithm).update(data).verify(key, signature); if (cb) { queueMicrotask(() => cb(null, r)); return; } return r; }
export function generateKeySync(type, { length }) { return { type: "secret", export: () => randomBytes(length / 8), symmetricKeySize: length / 8 }; }
export function createSecretKey(key, enc) { const k = bytesOf(key, enc); return { type: "secret", symmetricKeySize: k.length, export: () => Buffer.from(k), _raw: k }; }
export function getCipherInfo(name) { const s = CIPHERS[String(name).toLowerCase()]; return s ? { name: String(name).toLowerCase(), keyLength: s[0], ivLength: s[1], mode: s[2] ? "gcm" : name.includes("cbc") ? "cbc" : "ctr" } : undefined; }
export const constants = { RSA_PKCS1_PADDING: 1, RSA_NO_PADDING: 3, RSA_PKCS1_OAEP_PADDING: 4, RSA_PKCS1_PSS_PADDING: 6, RSA_PSS_SALTLEN_DIGEST: -1, RSA_PSS_SALTLEN_MAX_SIGN: -2, RSA_PSS_SALTLEN_AUTO: -2 };

const algName = (a) => (typeof a === "string" ? a : a.name).toUpperCase();
const hashName = (h) => String(typeof h === "string" ? h : h.name).toLowerCase().replace("-", "");
class CryptoKey { constructor(type, algorithm, extractable, usages, raw) { this.type = type; this.algorithm = algorithm; this.extractable = extractable; this.usages = usages; this._raw = raw; } get [Symbol.toStringTag]() { return "CryptoKey"; } }
const subtle = {
  async digest(algo, data) { return Buffer.from(ops.op_k_hash(hashName(algo), toUint8(data))).buffer; },
  async importKey(format, keyData, algorithm, extractable, usages) {
    if (format !== "raw") throw nodeError("ERR_METHOD_NOT_IMPLEMENTED", "subtle.importKey: only 'raw' keys are supported yet");
    const alg = typeof algorithm === "string" ? { name: algorithm } : { ...algorithm };
    if (alg.hash) alg.hash = { name: typeof alg.hash === "string" ? alg.hash : alg.hash.name };
    const raw = toUint8(keyData);
    if (alg.name.toUpperCase().startsWith("AES")) alg.length = raw.length * 8;
    return new CryptoKey("secret", alg, extractable, usages, new Uint8Array(raw));
  },
  async exportKey(format, key) { if (format !== "raw") throw nodeError("ERR_METHOD_NOT_IMPLEMENTED", "subtle.exportKey: only 'raw' is supported yet"); return key._raw.slice().buffer; },
  async generateKey(algorithm, extractable, usages) { const alg = typeof algorithm === "string" ? { name: algorithm } : { ...algorithm }; const len = alg.length ? alg.length / 8 : 32; return new CryptoKey("secret", alg, extractable, usages, ops.op_k_random_bytes(len)); },
  async sign(algorithm, key, data) { if (algName(algorithm) !== "HMAC") throw nodeError("ERR_METHOD_NOT_IMPLEMENTED", "subtle.sign: only HMAC is supported yet"); return Buffer.from(ops.op_k_hmac(hashName(key.algorithm.hash), key._raw, toUint8(data))).buffer; },
  async verify(algorithm, key, signature, data) { const mac = Buffer.from(ops.op_k_hmac(hashName(key.algorithm.hash), key._raw, toUint8(data))); const sig = Buffer.from(toUint8(signature)); return mac.length === sig.length && timingSafeEqual(mac, sig); },
  async encrypt(algorithm, key, data) {
    const name = algName(algorithm);
    if (name === "AES-GCM") { const out = ops.op_cipher(key._raw.length === 16 ? "aes-128-gcm" : "aes-256-gcm", true, key._raw, toUint8(algorithm.iv), toUint8(data), algorithm.additionalData ? toUint8(algorithm.additionalData) : new Uint8Array(0)); return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength); }
    if (name === "AES-CBC") { const out = ops.op_cipher(key._raw.length === 16 ? "aes-128-cbc" : "aes-256-cbc", true, key._raw, toUint8(algorithm.iv), toUint8(data), new Uint8Array(0)); return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength); }
    if (name === "AES-CTR") { const out = ops.op_cipher(key._raw.length === 16 ? "aes-128-ctr" : "aes-256-ctr", true, key._raw, toUint8(algorithm.counter), toUint8(data), new Uint8Array(0)); return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength); }
    throw nodeError("ERR_METHOD_NOT_IMPLEMENTED", "subtle.encrypt: " + name + " is not supported yet");
  },
  async decrypt(algorithm, key, data) {
    const name = algName(algorithm);
    const run = (a, iv) => { const out = ops.op_cipher(a, false, key._raw, toUint8(iv), toUint8(data), algorithm.additionalData ? toUint8(algorithm.additionalData) : new Uint8Array(0)); return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength); };
    if (name === "AES-GCM") return run(key._raw.length === 16 ? "aes-128-gcm" : "aes-256-gcm", algorithm.iv);
    if (name === "AES-CBC") return run(key._raw.length === 16 ? "aes-128-cbc" : "aes-256-cbc", algorithm.iv);
    if (name === "AES-CTR") return run(key._raw.length === 16 ? "aes-128-ctr" : "aes-256-ctr", algorithm.counter);
    throw nodeError("ERR_METHOD_NOT_IMPLEMENTED", "subtle.decrypt: " + name + " is not supported yet");
  },
  async deriveBits(algorithm, key, length) {
    const name = algName(algorithm);
    if (name === "PBKDF2") { const out = ops.op_pbkdf2(key._raw, toUint8(algorithm.salt), algorithm.iterations >>> 0, length / 8, hashName(algorithm.hash)); return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength); }
    if (name === "HKDF") { const out = ops.op_hkdf(hashName(algorithm.hash), key._raw, toUint8(algorithm.salt), toUint8(algorithm.info), length / 8); return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength); }
    throw nodeError("ERR_METHOD_NOT_IMPLEMENTED", "subtle.deriveBits: " + name + " is not supported yet");
  },
  async deriveKey(algorithm, baseKey, derivedAlg, extractable, usages) { const len = derivedAlg.length ?? 256; const bits = await subtle.deriveBits(algorithm, baseKey, len); return subtle.importKey("raw", bits, derivedAlg, extractable, usages); },
  async wrapKey() { throw nodeError("ERR_METHOD_NOT_IMPLEMENTED", "subtle.wrapKey is not supported yet"); },
  async unwrapKey() { throw nodeError("ERR_METHOD_NOT_IMPLEMENTED", "subtle.unwrapKey is not supported yet"); },
};
export { CryptoKey };
export const webcrypto = { subtle, getRandomValues, randomUUID, get [Symbol.toStringTag]() { return "Crypto"; } };
export { subtle };

const crypto = { createHash, createHmac, hash, getHashes, getCiphers, getCurves, randomBytes, randomFillSync, randomFill, randomUUID, randomInt, getRandomValues, timingSafeEqual, pbkdf2Sync, pbkdf2, scryptSync, scrypt, hkdfSync, hkdf, createCipheriv, createDecipheriv, Cipheriv, Decipheriv, createSign, createVerify, Sign, Verify, sign, verify, generateKeyPairSync, generateKeyPair, generateKeySync, createSecretKey, createPrivateKey, createPublicKey, KeyObject, getCipherInfo, constants, webcrypto, subtle, CryptoKey, Hash, Hmac };
export default crypto;
