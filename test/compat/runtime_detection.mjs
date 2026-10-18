import assert from 'node:assert/strict';
assert.equal(typeof globalThis.Deno, 'undefined');
const args=globalThis.Deno ? globalThis.Deno.args : process.argv;
assert.ok(Array.isArray(args));assert.equal(typeof args.indexOf('unused'), 'number');
console.log('node runtime detection ok');
