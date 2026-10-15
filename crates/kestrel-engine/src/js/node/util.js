// node:util
import { inspect as _inspect, format as _format, inspectCustom, nodeError } from "ext:kestrel/internal.js";
import * as types from "ext:kestrel/node/util_types.js";

export function inspect(v, opts) {
  if (typeof opts === "boolean") opts = { showHidden: opts };
  return _inspect(v, opts || {});
}
inspect.custom = inspectCustom;
inspect.defaultOptions = { depth: 2, colors: false, showHidden: false, maxArrayLength: 100 };
inspect.colors = {};
inspect.styles = {};

export const format = _format;
export function formatWithOptions(opts, ...args) { return _format(...args); }

const kCustomPromisify = Symbol.for("nodejs.util.promisify.custom");
export function promisify(fn) {
  if (typeof fn !== "function") throw nodeError("ERR_INVALID_ARG_TYPE", 'The "original" argument must be of type function', TypeError);
  if (fn[kCustomPromisify]) return fn[kCustomPromisify];
  function wrapped(...args) {
    return new Promise((resolve, reject) => {
      fn.call(this, ...args, (err, ...values) => {
        if (err) return reject(err);
        resolve(values.length > 1 ? values : values[0]);
      });
    });
  }
  Object.setPrototypeOf(wrapped, Object.getPrototypeOf(fn));
  Object.defineProperty(wrapped, kCustomPromisify, { value: wrapped, enumerable: false, writable: false, configurable: true });
  return Object.defineProperties(wrapped, Object.getOwnPropertyDescriptors(fn));
}
promisify.custom = kCustomPromisify;

export function callbackify(fn) {
  if (typeof fn !== "function") throw nodeError("ERR_INVALID_ARG_TYPE", 'The "original" argument must be of type function', TypeError);
  return function (...args) {
    const cb = args.pop();
    if (typeof cb !== "function") throw nodeError("ERR_INVALID_ARG_TYPE", "The last argument must be of type function", TypeError);
    fn.apply(this, args).then((v) => queueMicrotask(() => cb(null, v)), (err) => queueMicrotask(() => {
      if (!err) { const e = new Error("Promise was rejected with a falsy value"); e.code = "ERR_FALSY_VALUE_REJECTION"; e.reason = err; err = e; }
      cb(err);
    }));
  };
}

export function inherits(ctor, superCtor) {
  if (ctor === undefined || ctor === null) throw nodeError("ERR_INVALID_ARG_TYPE", 'The "ctor" argument must be of type function', TypeError);
  if (superCtor === undefined || superCtor === null) throw nodeError("ERR_INVALID_ARG_TYPE", 'The "superCtor" argument must be of type function', TypeError);
  if (superCtor.prototype === undefined) throw nodeError("ERR_INVALID_ARG_TYPE", 'The "superCtor.prototype" property must be of type object', TypeError);
  Object.defineProperty(ctor, "super_", { value: superCtor, writable: true, configurable: true });
  Object.setPrototypeOf(ctor.prototype, superCtor.prototype);
}

const deprecations = new Set();
export function deprecate(fn, msg, code) {
  let warned = false;
  function deprecated(...args) {
    if (!warned) { warned = true; if (!code || !deprecations.has(code)) { if (code) deprecations.add(code); globalThis.process.emitWarning(msg, "DeprecationWarning", code); } }
    return new.target ? Reflect.construct(fn, args, new.target) : fn.apply(this, args);
  }
  Object.setPrototypeOf(deprecated, fn);
  if (fn.prototype) deprecated.prototype = fn.prototype;
  return deprecated;
}

export function debuglog(section) {
  const enabled = (globalThis.process.env.NODE_DEBUG || "").split(",").some((s) => s.trim().toUpperCase() === section.toUpperCase());
  const fn = enabled ? (...args) => console.error(section.toUpperCase() + " " + globalThis.process.pid + ": " + _format(...args)) : () => {};
  fn.enabled = enabled;
  return fn;
}
export const debug = debuglog;

export function isDeepStrictEqual(a, b) { return deepEqual(a, b, true, new Map()); }
export function deepEqual(a, b, strict, seen) {
  if (strict ? Object.is(a, b) : a == b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    if (!strict && typeof a !== "object" && typeof b !== "object") return a == b;
    return strict ? false : a == b;
  }
  if (strict && Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
  if (seen.get(a) === b) return true;
  seen.set(a, b);
  if (a instanceof Date) return b instanceof Date && a.getTime() === b.getTime();
  if (a instanceof RegExp) return b instanceof RegExp && String(a) === String(b);
  if (a instanceof Error) { if (!(b instanceof Error) || a.message !== b.message || a.name !== b.name) return false; }
  if (ArrayBuffer.isView(a)) { if (!ArrayBuffer.isView(b) || a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; }
  if (a instanceof Map) { if (!(b instanceof Map) || a.size !== b.size) return false; for (const [k, v] of a) { if (!b.has(k) || !deepEqual(v, b.get(k), strict, seen)) return false; } return true; }
  if (a instanceof Set) { if (!(b instanceof Set) || a.size !== b.size) return false; outer: for (const v of a) { if (b.has(v)) continue; for (const w of b) if (deepEqual(v, w, strict, seen)) continue outer; return false; } return true; }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) { if (!Object.prototype.hasOwnProperty.call(b, k) || !deepEqual(a[k], b[k], strict, seen)) return false; }
  if (strict) {
    const sa = Object.getOwnPropertySymbols(a).filter((s) => Object.prototype.propertyIsEnumerable.call(a, s));
    const sb = Object.getOwnPropertySymbols(b).filter((s) => Object.prototype.propertyIsEnumerable.call(b, s));
    if (sa.length !== sb.length) return false;
    for (const s of sa) if (!deepEqual(a[s], b[s], strict, seen)) return false;
  }
  return true;
}

export function isArray(v) { return Array.isArray(v); }
export function isBoolean(v) { return typeof v === "boolean"; }
export function isNull(v) { return v === null; }
export function isNullOrUndefined(v) { return v == null; }
export function isNumber(v) { return typeof v === "number"; }
export function isString(v) { return typeof v === "string"; }
export function isSymbol(v) { return typeof v === "symbol"; }
export function isUndefined(v) { return v === undefined; }
export function isRegExp(v) { return v instanceof RegExp; }
export function isObject(v) { return v !== null && typeof v === "object"; }
export function isDate(v) { return v instanceof Date; }
export function isError(v) { return v instanceof Error; }
export function isFunction(v) { return typeof v === "function"; }
export function isPrimitive(v) { return v === null || (typeof v !== "object" && typeof v !== "function"); }
export function isBuffer(v) { return globalThis.Buffer.isBuffer(v); }

export function inspectDefaultOptions() { return inspect.defaultOptions; }
export function stripVTControlCharacters(s) { return String(s).replace(/\u001b\[[0-9;]*[A-Za-z]/g, ""); }
export function toUSVString(s) { return String(s).toWellFormed(); }
export function getSystemErrorName(n) { return { "-2": "ENOENT", "-13": "EACCES", "-17": "EEXIST", "-20": "ENOTDIR", "-21": "EISDIR", "-22": "EINVAL" }[String(n)] || "Unknown system error " + n; }
export function aborted(signal, resource) { return new Promise((resolve) => { if (signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), { once: true }); }); }
export function styleText(fmt, text) { return String(text); }
export function parseArgs(config = {}) {
  const args = config.args ?? globalThis.process.argv.slice(2);
  const options = config.options ?? {};
  const values = {}, positionals = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") { positionals.push(...args.slice(i + 1)); break; }
    if (a.startsWith("--")) {
      let [name, val] = a.slice(2).split(/=(.*)/s);
      const opt = options[name];
      if (!opt) { if (config.strict !== false) throw nodeError("ERR_PARSE_ARGS_UNKNOWN_OPTION", "Unknown option '--" + name + "'", TypeError); }
      if (opt && opt.type === "string") { if (val === undefined) val = args[++i]; }
      else val = true;
      if (opt && opt.multiple) (values[name] ??= []).push(val); else values[name] = val;
    } else if (a.startsWith("-") && a.length > 1) {
      for (const ch of a.slice(1)) { const name = Object.keys(options).find((k) => options[k].short === ch); if (name) values[name] = options[name].type === "string" ? args[++i] : true; else if (config.strict !== false) throw nodeError("ERR_PARSE_ARGS_UNKNOWN_OPTION", "Unknown option '-" + ch + "'", TypeError); }
    } else { if (config.allowPositionals === false && config.strict !== false) throw nodeError("ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL", "Unexpected argument '" + a + "'", TypeError); positionals.push(a); }
  }
  for (const [k, o] of Object.entries(options)) if (values[k] === undefined && o.default !== undefined) values[k] = o.default;
  return { values, positionals };
}

export const TextEncoder = globalThis.TextEncoder;
export const TextDecoder = globalThis.TextDecoder;
export { types };
export class MIMEType { constructor(s) { const [essence, ...params] = String(s).split(";"); const [type, subtype] = essence.trim().split("/"); this.type = type; this.subtype = subtype; this.params = new Map(params.map((p) => p.trim().split("=").map((x) => x.replace(/^"|"$/g, "")))); } get essence() { return this.type + "/" + this.subtype; } toString() { let s = this.essence; for (const [k, v] of this.params) s += ";" + k + "=" + v; return s; } }

const util = {
  inspect, format, formatWithOptions, promisify, callbackify, inherits, deprecate, debuglog, debug, isDeepStrictEqual, types,
  isArray, isBoolean, isNull, isNullOrUndefined, isNumber, isString, isSymbol, isUndefined, isRegExp, isObject, isDate, isError, isFunction, isPrimitive, isBuffer,
  stripVTControlCharacters, toUSVString, getSystemErrorName, aborted, styleText, parseArgs, TextEncoder, TextDecoder, MIMEType,
};
export default util;
