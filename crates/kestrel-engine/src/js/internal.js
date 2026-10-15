// Shared primitives for the bootstrap and the node:* modules.
const core = Deno.core;
export const ops = core.ops;
export { core };

// ---------- inspect / format (Node-compatible for common cases) ----------
export const inspectCustom = Symbol.for("nodejs.util.inspect.custom");
const kMaxDepth = 2;

function quote(s) {
  const q = s.includes("'") && !s.includes('"') ? '"' : "'";
  return q + s.replace(/\\/g, "\\\\").replace(new RegExp(q, "g"), "\\" + q).replace(/\n/g, "\\n") + q;
}
const identRe = /^[A-Za-z_$][\w$]*$/;

export function inspect(v, opts = {}, depth = 0, seen = new Set()) {
  const maxDepth = opts.depth === null || opts.depth === Infinity ? Infinity : (opts.depth ?? kMaxDepth);
  switch (typeof v) {
    case "string": return depth === 0 && opts.topLevelString ? v : quote(v);
    case "number": return Object.is(v, -0) ? "-0" : String(v);
    case "bigint": return v + "n";
    case "boolean":
    case "undefined": return String(v);
    case "symbol": return v.toString();
    case "function": {
      const isClass = /^class[\s{]/.test(Function.prototype.toString.call(v));
      if (isClass) return "[class " + (v.name || "(anonymous)") + "]";
      const kind = v.constructor && v.constructor.name === "AsyncFunction" ? "AsyncFunction" : v.constructor && v.constructor.name === "GeneratorFunction" ? "GeneratorFunction" : "Function";
      const base = "[" + kind + (v.name ? ": " + v.name : " (anonymous)") + "]";
      const keys = Object.keys(v);
      return keys.length ? base + " " + inspectObjectBody(v, keys, opts, depth, seen, maxDepth, "") : base;
    }
  }
  if (v === null) return "null";
  if (seen.has(v)) return "[Circular *1]";
  if (typeof v[inspectCustom] === "function" && v[inspectCustom] !== inspect) {
    const r = v[inspectCustom](depth, { ...opts, depth: maxDepth - depth }, inspect);
    return typeof r === "string" ? r : inspect(r, opts, depth, seen);
  }
  if (v instanceof Error) {
    let s = v.stack || (v.name + ": " + v.message);
    const keys = Object.keys(v).filter((k) => k !== "stack" && k !== "message");
    if (keys.length) s += " " + inspectObjectBody(v, keys, opts, depth, seen, maxDepth, "");
    return s;
  }
  if (v instanceof Date) return isNaN(v) ? "Invalid Date" : v.toISOString();
  if (v instanceof RegExp) return v.toString();
  if (v instanceof Promise) return "Promise { <pending> }";
  if (v instanceof WeakMap) return "WeakMap { <items unknown> }";
  if (v instanceof WeakSet) return "WeakSet { <items unknown> }";
  if (typeof v === "object" && v instanceof Boolean) return "[Boolean: " + v.valueOf() + "]";
  if (typeof v === "object" && v instanceof Number) return "[Number: " + v.valueOf() + "]";
  if (typeof v === "object" && v instanceof String) return "[String: " + quote(v.valueOf()) + "]";
  if (depth > maxDepth) return Array.isArray(v) ? "[Array]" : "[" + (v.constructor && v.constructor.name || "Object") + "]";
  seen.add(v);
  try {
    if (Array.isArray(v)) {
      const items = [];
      let holes = 0;
      for (let i = 0; i < v.length; i++) {
        if (!(i in v)) { holes++; continue; }
        if (holes) { items.push("<" + holes + " empty item" + (holes > 1 ? "s" : "") + ">"); holes = 0; }
        if (items.length >= 100) { items.push("... " + (v.length - i) + " more items"); break; }
        items.push(inspect(v[i], opts, depth + 1, seen));
      }
      if (holes) items.push("<" + holes + " empty item" + (holes > 1 ? "s" : "") + ">");
      const extra = Object.keys(v).filter((k) => !/^\d+$/.test(k));
      for (const k of extra) items.push((identRe.test(k) ? k : quote(k)) + ": " + inspect(v[k], opts, depth + 1, seen));
      const ctor = v.constructor && v.constructor !== Array ? v.constructor.name + "(" + v.length + ") " : "";
      return wrap(ctor + "[", items, "]", depth);
    }
    if (ArrayBuffer.isView(v)) {
      const tag = v[Symbol.toStringTag];
      if (tag === "DataView") return "DataView { byteLength: " + v.byteLength + ", byteOffset: " + v.byteOffset + " }";
      const n = Math.min(v.length, 100);
      const items = [];
      for (let i = 0; i < n; i++) items.push(String(v[i]));
      if (v.length > n) items.push("... " + (v.length - n) + " more items");
      const name = v.constructor && v.constructor.name === "Buffer" ? "<Buffer " + Array.prototype.map.call(v.subarray(0, 50), (b) => b.toString(16).padStart(2, "0")).join(" ") + (v.length > 50 ? " ... " + (v.length - 50) + " more bytes" : "") + ">" : null;
      if (name) return name;
      return wrap(tag + "(" + v.length + ") [", items, "]", depth);
    }
    if (v instanceof ArrayBuffer) return "ArrayBuffer { [Uint8Contents]: <" + Array.from(new Uint8Array(v).subarray(0, 50), (b) => b.toString(16).padStart(2, "0")).join(" ") + ">, byteLength: " + v.byteLength + " }";
    if (v instanceof Map) {
      const items = [];
      for (const [k, x] of v) items.push(inspect(k, opts, depth + 1, seen) + " => " + inspect(x, opts, depth + 1, seen));
      return wrap("Map(" + v.size + ") {", items, "}", depth);
    }
    if (v instanceof Set) {
      const items = [];
      for (const x of v) items.push(inspect(x, opts, depth + 1, seen));
      return wrap("Set(" + v.size + ") {", items, "}", depth);
    }
    const keys = Object.keys(v);
    const syms = Object.getOwnPropertySymbols(v).filter((s) => Object.getOwnPropertyDescriptor(v, s).enumerable);
    const proto = Object.getPrototypeOf(v);
    let prefix = "";
    if (proto === null) prefix = "[Object: null prototype] ";
    else if (proto.constructor && proto.constructor.name && proto.constructor !== Object) prefix = proto.constructor.name + " ";
    const tag = v[Symbol.toStringTag];
    if (tag && typeof tag === "string" && !prefix.startsWith(tag)) prefix = (prefix || "Object ") + "[" + tag + "] ";
    return inspectObjectBody(v, keys, opts, depth, seen, maxDepth, prefix, syms);
  } finally {
    seen.delete(v);
  }
}

function inspectObjectBody(v, keys, opts, depth, seen, maxDepth, prefix, syms = []) {
  if (keys.length === 0 && syms.length === 0) return prefix + "{}";
  const items = keys.map((k) => {
    const d = Object.getOwnPropertyDescriptor(v, k);
    let val;
    if (d && (d.get || d.set)) val = d.get && d.set ? "[Getter/Setter]" : d.get ? "[Getter]" : "[Setter]";
    else val = inspect(v[k], opts, depth + 1, seen);
    return (identRe.test(k) ? k : quote(k)) + ": " + val;
  });
  for (const s of syms) items.push("[" + s.toString() + "]: " + inspect(v[s], opts, depth + 1, seen));
  return wrap(prefix + "{", items, "}", depth);
}

function wrap(open, items, close, depth) {
  if (items.length === 0) return open + close;
  const oneLine = open + " " + items.join(", ") + " " + close;
  if (oneLine.length <= 72 && !oneLine.includes("\n")) return oneLine;
  const indent = "  ".repeat(depth + 1);
  return open + "\n" + items.map((s) => indent + s.replace(/\n/g, "\n" + "  ")).join(",\n") + "\n" + "  ".repeat(depth) + close;
}

export function format(...args) {
  if (args.length === 0) return "";
  let i = 0;
  let out = "";
  if (typeof args[0] === "string" && args[0].includes("%")) {
    i = 1;
    out = args[0].replace(/%[sdifjoOc%]/g, (m) => {
      if (m === "%%") return "%";
      if (m === "%c") { i++; return ""; }
      if (i >= args.length) return m;
      const a = args[i++];
      switch (m) {
        case "%s": return typeof a === "string" ? a : typeof a === "bigint" ? a + "n" : typeof a === "object" && a !== null ? inspect(a, { depth: 1 }) : String(a);
        case "%d": return typeof a === "bigint" ? a + "n" : typeof a === "object" && a !== null ? "NaN" : String(Number(a));
        case "%i": return typeof a === "bigint" ? a + "n" : String(parseInt(a));
        case "%f": return String(parseFloat(a));
        case "%j": try { return JSON.stringify(a); } catch { return "[Circular]"; }
        case "%o": return Array.isArray(a) ? inspect(a, { depth: 4 }).replace(/ \]$/, ", [length]: " + a.length + " ]").replace(/^\[\]$/, "[ [length]: 0 ]") : inspect(a, { depth: 4 });
        default: return inspect(a);
      }
    });
    if (args[0].includes("%%")) out = out.replace(/%%/g, "%");
  }
  for (; i < args.length; i++) {
    out += (out.length || i > 0 ? " " : "") + (typeof args[i] === "string" ? args[i] : inspect(args[i]));
  }
  return out;
}

// ---------- text encoding ----------
export const utf8Encode = (s) => ops.op_k_utf8_encode(s);
export const utf8Decode = (u8) => ops.op_k_utf8_decode(u8);

export function toUint8(x) {
  if (x instanceof Uint8Array) return x;
  if (ArrayBuffer.isView(x)) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
  if (x instanceof ArrayBuffer) return new Uint8Array(x);
  if (typeof x === "string") return utf8Encode(x);
  throw new TypeError("expected a buffer-like value, got " + typeof x);
}

// ---------- Node-style errors ----------
export function nodeError(code, message, ctor = Error) {
  const e = new ctor(message);
  e.code = code;
  return e;
}

/// Convert an error thrown by a filesystem op ("ENOENT: no such file or directory, open '/x'")
/// into a Node-shaped error with code / syscall / path / errno.
const errnoMap = { ENOENT: -2, EACCES: -13, EEXIST: -17, ENOTDIR: -20, EISDIR: -21, ENOTEMPTY: -66, EINVAL: -22, EIO: -5 };
export function fsError(e, pathArg) {
  const m = /^([A-Z]+): (.*?), (\w+) '(.*)'$/.exec(e && e.message || "");
  if (!m) return e;
  const err = new Error(e.message);
  err.code = m[1];
  err.syscall = m[3];
  err.path = m[4];
  err.errno = errnoMap[m[1]] ?? -1;
  if (pathArg !== undefined && typeof pathArg !== "string") err.path = pathArg;
  return err;
}

export function toPathString(p) {
  if (typeof p === "string") return p;
  if (p instanceof URL) return ops.op_k_url_to_path(p.href);
  if (p instanceof Uint8Array) return utf8Decode(p);
  if (p && typeof p.href === "string") return ops.op_k_url_to_path(p.href);
  throw nodeError("ERR_INVALID_ARG_TYPE", 'The "path" argument must be of type string or an instance of Buffer or URL. Received ' + inspect(p), TypeError);
}

export const kEmpty = Object.freeze({});
