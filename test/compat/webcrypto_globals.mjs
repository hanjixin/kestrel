import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
for (const name of ['Crypto', 'CryptoKey', 'SubtleCrypto']) {
  assert.equal(typeof globalThis[name], 'function', name);
  assert.throws(() => new globalThis[name](), {code:'ERR_ILLEGAL_CONSTRUCTOR'});
}
assert.equal(globalThis.crypto, webcrypto);
assert.ok(crypto instanceof Crypto);
assert.ok(crypto.subtle instanceof SubtleCrypto);
assert.equal(crypto.constructor, Crypto);
assert.equal(crypto.subtle.constructor, SubtleCrypto);
const key = await crypto.subtle.importKey('raw', new Uint8Array(16), {name:'AES-GCM'}, true, ['encrypt','decrypt']);
assert.ok(key instanceof CryptoKey);
assert.equal(key.constructor, CryptoKey);
assert.equal(Object.prototype.toString.call(key), '[object CryptoKey]');
const encrypted = await crypto.subtle.encrypt({name:'AES-GCM',iv:new Uint8Array(12)},key,new Uint8Array([1,2,3]));
assert.deepEqual(new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:new Uint8Array(12)},key,encrypted)),new Uint8Array([1,2,3]));
console.log('webcrypto globals ok');
