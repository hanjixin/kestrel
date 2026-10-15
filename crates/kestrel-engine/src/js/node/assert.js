// node:assert
import { inspect } from "ext:kestrel/internal.js";
import { deepEqual } from "ext:kestrel/node/util.js";

export class AssertionError extends Error {
  constructor(options = {}) {
    const { message, actual, expected, operator } = options;
    super(message !== undefined ? String(message) : generateMessage(actual, expected, operator));
    this.name = "AssertionError";
    this.code = "ERR_ASSERTION";
    this.actual = actual;
    this.expected = expected;
    this.operator = operator;
    this.generatedMessage = message === undefined;
  }
}
function generateMessage(actual, expected, operator) {
  switch (operator) {
    case "==": return "Expected values to be loosely equal:\n\n" + inspect(actual) + " == " + inspect(expected);
    case "strictEqual": return "Expected values to be strictly equal:\n\n" + inspect(actual) + " !== " + inspect(expected);
    case "notStrictEqual": return 'Expected "actual" to be strictly unequal to: ' + inspect(expected);
    case "deepEqual": return "Expected values to be loosely deep-equal:\n\n" + inspect(actual) + "\n\nshould loosely deep-equal\n\n" + inspect(expected);
    case "deepStrictEqual": return "Expected values to be strictly deep-equal:\n" + inspect(actual) + "\n\nshould equal\n\n" + inspect(expected);
    case "notDeepStrictEqual": return 'Expected "actual" not to be strictly deep-equal to: ' + inspect(expected);
    case "notDeepEqual": return 'Expected "actual" not to be loosely deep-equal to: ' + inspect(expected);
    case "!=": return 'Expected "actual" to be loosely unequal to: ' + inspect(expected);
    case "fail": return "Failed";
    default: return inspect(actual) + " " + operator + " " + inspect(expected);
  }
}
function fail_(actual, expected, message, operator, stackStartFn) {
  if (message instanceof Error) throw message;
  throw new AssertionError({ message, actual, expected, operator, stackStartFn });
}

export function ok(value, message) { if (arguments.length === 0) fail_(undefined, true, "No value argument passed to `assert.ok()`", "==", ok); if (!value) fail_(value, true, message ?? "The expression evaluated to a falsy value:\n\n  assert.ok(" + inspect(value) + ")\n", "==", ok); }
export function fail(message = "Failed") { if (message instanceof Error) throw message; const e = new AssertionError({ message, operator: "fail" }); throw e; }
export function equal(a, b, m) { if (!(a == b || (a !== a && b !== b))) fail_(a, b, m, "==", equal); }
export function notEqual(a, b, m) { if (a == b || (a !== a && b !== b)) fail_(a, b, m, "!=", notEqual); }
export function strictEqual(a, b, m) { if (!Object.is(a, b)) fail_(a, b, m, "strictEqual", strictEqual); }
export function notStrictEqual(a, b, m) { if (Object.is(a, b)) fail_(a, b, m, "notStrictEqual", notStrictEqual); }
export function deepEqual_(a, b, m) { if (!deepEqual(a, b, false, new Map())) fail_(a, b, m, "deepEqual", deepEqual_); }
export function notDeepEqual(a, b, m) { if (deepEqual(a, b, false, new Map())) fail_(a, b, m, "notDeepEqual", notDeepEqual); }
export function deepStrictEqual(a, b, m) { if (!deepEqual(a, b, true, new Map())) fail_(a, b, m, "deepStrictEqual", deepStrictEqual); }
export function notDeepStrictEqual(a, b, m) { if (deepEqual(a, b, true, new Map())) fail_(a, b, m, "notDeepStrictEqual", notDeepStrictEqual); }
export function ifError(err) { if (err !== null && err !== undefined) { const e = new AssertionError({ message: "ifError got unwanted exception: " + (err instanceof Error ? err.message : inspect(err)), actual: err, expected: null, operator: "ifError" }); throw e; } }
export function match(s, re, m) { if (typeof s !== "string" || !re.test(s)) fail_(s, re, m ?? "The input did not match the regular expression " + inspect(re) + ". Input:\n\n" + inspect(s) + "\n", "match", match); }
export function doesNotMatch(s, re, m) { if (typeof s === "string" && re.test(s)) fail_(s, re, m ?? "The input was expected to not match the regular expression " + inspect(re) + ". Input:\n\n" + inspect(s) + "\n", "doesNotMatch", doesNotMatch); }

function matchesExpected(err, expected, message, fn) {
  if (expected === undefined) return;
  if (typeof expected === "function") {
    if (expected.prototype !== undefined && err instanceof expected) return;
    if (Error.isPrototypeOf(expected)) throw err;
    const r = expected.call({}, err);
    if (r !== true) fail_(err, expected, message ?? "The " + (fn === rejects ? "rejection" : "error") + " validation function is expected to return \"true\". Received " + inspect(r), fn.name, fn);
    return;
  }
  if (expected instanceof RegExp) { if (!expected.test(String(err))) fail_(err, expected, message ?? "The input did not match the regular expression " + inspect(expected) + ". Input:\n\n" + inspect(String(err)) + "\n", fn.name, fn); return; }
  if (typeof expected === "object" && expected !== null) {
    for (const k of Object.keys(expected)) {
      const ev = expected[k], av = err == null ? undefined : err[k];
      const okv = ev instanceof RegExp && typeof av === "string" ? ev.test(av) : deepEqual(av, ev, true, new Map());
      if (!okv) fail_(err, expected, message ?? "Expected values to be strictly deep-equal:\n" + inspect(err) + "\n\nshould equal\n\n" + inspect(expected), fn.name, fn);
    }
  }
}
export function throws(fn, expected, message) {
  if (typeof fn !== "function") throw new TypeError('The "fn" argument must be of type function');
  if (typeof expected === "string") { message = expected; expected = undefined; }
  let threw = false, err;
  try { fn(); } catch (e) { threw = true; err = e; }
  if (!threw) fail_(undefined, expected, message ?? "Missing expected exception" + (expected && expected.name ? " (" + expected.name + ")" : "") + ".", "throws", throws);
  matchesExpected(err, expected, message, throws);
}
export function doesNotThrow(fn, expected, message) {
  if (typeof expected === "string") { message = expected; expected = undefined; }
  try { fn(); } catch (e) { fail_(e, expected, message ?? "Got unwanted exception.\nActual message: \"" + (e && e.message) + "\"", "doesNotThrow", doesNotThrow); }
}
export async function rejects(p, expected, message) {
  if (typeof p === "function") p = p();
  if (typeof expected === "string") { message = expected; expected = undefined; }
  let threw = false, err;
  try { await p; } catch (e) { threw = true; err = e; }
  if (!threw) fail_(undefined, expected, message ?? "Missing expected rejection" + (expected && expected.name ? " (" + expected.name + ")" : "") + ".", "rejects", rejects);
  matchesExpected(err, expected, message, rejects);
}
export async function doesNotReject(p, expected, message) {
  if (typeof p === "function") p = p();
  if (typeof expected === "string") { message = expected; expected = undefined; }
  try { await p; } catch (e) { fail_(e, expected, message ?? "Got unwanted rejection.\nActual message: \"" + (e && e.message) + "\"", "doesNotReject", doesNotReject); }
}

function assert(value, message) { return ok.call(null, ...(arguments.length === 0 ? [] : [value, message])); }
Object.assign(assert, { AssertionError, ok, fail, equal, notEqual, strictEqual, notStrictEqual, deepEqual: deepEqual_, notDeepEqual, deepStrictEqual, notDeepStrictEqual, ifError, match, doesNotMatch, throws, doesNotThrow, rejects, doesNotReject });
const strict = Object.assign(function strict(v, m) { return ok(v, m); }, assert, { equal: strictEqual, notEqual: notStrictEqual, deepEqual: deepStrictEqual, notDeepEqual: notDeepStrictEqual });
strict.strict = strict;
assert.strict = strict;
export { deepEqual_ as deepEqual, strict };
export default assert;
