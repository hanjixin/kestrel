// Globals that node:* modules may touch at evaluation time. Evaluated before them.
import { core, ops, inspect, format, utf8Encode, utf8Decode, nodeError } from "ext:kestrel/internal.js";
import { URL, URLSearchParams } from "ext:kestrel/node/url.js";

globalThis.global = globalThis;
globalThis.self = globalThis;

// ---------- console ----------
const counts = new Map();
const timers = new Map();
let groupIndent = "";
function write(isErr, args) {
  let s = format(...args);
  if (groupIndent) s = groupIndent + s.replace(/\n/g, "\n" + groupIndent);
  core.print(s + "\n", isErr);
}
function table(data, columns) {
  if (data === null || typeof data !== "object") return write(false, [data]);
  const rows = Array.isArray(data) ? data.map((v, i) => [String(i), v]) : Object.entries(data);
  const keys = columns || [...new Set(rows.flatMap(([, v]) => (v !== null && typeof v === "object" ? Object.keys(v) : [])))];
  const hasValues = rows.some(([, v]) => v === null || typeof v !== "object");
  const header = ["(index)", ...keys, ...(hasValues ? ["Values"] : [])];
  const body = rows.map(([k, v]) => [k, ...keys.map((c) => (v !== null && typeof v === "object" && c in v ? inspect(v[c]) : "")), ...(hasValues ? [v === null || typeof v !== "object" ? inspect(v) : ""] : [])]);
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((r) => r[i].length)));
  const line = (cells) => "│ " + cells.map((c, i) => c.padEnd(widths[i])).join(" │ ") + " │";
  const sep = (l, m, r) => l + widths.map((w) => "─".repeat(w + 2)).join(m) + r;
  core.print([sep("┌", "┬", "┐"), line(header), sep("├", "┼", "┤"), ...body.map(line), sep("└", "┴", "┘")].join("\n") + "\n", false);
}
const console = {
  log: (...a) => write(false, a),
  info: (...a) => write(false, a),
  debug: (...a) => write(false, a),
  warn: (...a) => write(true, a),
  error: (...a) => write(true, a),
  trace: (...a) => write(true, ["Trace" + (a.length ? ": " + format(...a) : "") + "\n" + new Error().stack.split("\n").slice(2).join("\n")]),
  assert: (ok, ...a) => { if (!ok) write(true, ["Assertion failed" + (a.length ? ": " + format(...a) : "")]); },
  dir: (v, opts) => write(false, [inspect(v, opts || {})]),
  dirxml: (...a) => write(false, a),
  table,
  count: (label = "default") => { const n = (counts.get(label) || 0) + 1; counts.set(label, n); write(false, [label + ": " + n]); },
  countReset: (label = "default") => counts.set(label, 0),
  time: (label = "default") => timers.set(label, ops.op_k_now_ms()),
  timeEnd: (label = "default") => { const t = timers.get(label); timers.delete(label); if (t !== undefined) write(false, [label + ": " + fmtMs(ops.op_k_now_ms() - t)]); },
  timeLog: (label = "default", ...a) => { const t = timers.get(label); if (t !== undefined) write(false, [label + ": " + fmtMs(ops.op_k_now_ms() - t), ...a]); },
  group: (...a) => { if (a.length) write(false, a); groupIndent += "  "; },
  groupCollapsed: (...a) => { if (a.length) write(false, a); groupIndent += "  "; },
  groupEnd: () => { groupIndent = groupIndent.slice(0, -2); },
  clear: () => {},
  profile: () => {}, profileEnd: () => {}, timeStamp: () => {},
};
function fmtMs(ms) { return ms < 1000 ? ms.toFixed(3) + "ms" : (ms / 1000).toFixed(3) + "s"; }
globalThis.console = console;

// ---------- timers ----------
const kTimer = Symbol("kestrel.timer");
class Timeout {
  constructor(t, repeat) { this[kTimer] = t; this._repeat = repeat; }
  ref() { core.refTimer(this[kTimer]); return this; }
  unref() { core.unrefTimer(this[kTimer]); return this; }
  hasRef() { return true; }
  refresh() { core.refreshTimer(this[kTimer]); return this; }
  close() { core.cancelTimer(this[kTimer]); return this; }
  [Symbol.toPrimitive]() { return this[kTimer]._timerId ?? 0; }
  [Symbol.dispose]() { this.close(); }
}
globalThis.setTimeout = (cb, ms, ...args) => { if (typeof cb !== "function") throw nodeError("ERR_INVALID_ARG_TYPE", 'The "callback" argument must be of type function', TypeError); return new Timeout(core.createTimer(cb, ms, args, false, true, false), false); };
globalThis.setInterval = (cb, ms, ...args) => { if (typeof cb !== "function") throw nodeError("ERR_INVALID_ARG_TYPE", 'The "callback" argument must be of type function', TypeError); return new Timeout(core.createTimer(cb, ms, args, true, true, false), true); };
globalThis.clearTimeout = (t) => { if (t && t[kTimer]) core.cancelTimer(t[kTimer]); };
globalThis.clearInterval = globalThis.clearTimeout;
const kRefed = core.kRefed;
class Immediate {
  constructor(cb, args) {
    this._idleNext = null; this._idlePrev = null; this._destroyed = false;
    this._onImmediate = args.length ? () => cb(...args) : cb;
    this[kRefed] = false;
    core.queueImmediate(this);
    this.ref();
  }
  ref() { if (this[kRefed] === false) { this[kRefed] = true; core.immediateRefCount(true); } return this; }
  unref() { if (this[kRefed] === true) { this[kRefed] = false; core.immediateRefCount(false); } return this; }
  hasRef() { return this[kRefed] === true; }
  [Symbol.dispose]() { globalThis.clearImmediate(this); }
}
globalThis.setImmediate = (cb, ...args) => { if (typeof cb !== "function") throw nodeError("ERR_INVALID_ARG_TYPE", 'The "callback" argument must be of type function', TypeError); return new Immediate(cb, args); };
globalThis.clearImmediate = (im) => { if (im) core.clearImmediate(im); };

// ---------- performance ----------
let timeOrigin = 0;
globalThis.performance = {
  now: () => ops.op_k_now_ms(),
  get timeOrigin() { return timeOrigin; },
  mark(name) { return { name, entryType: "mark", startTime: ops.op_k_now_ms(), duration: 0 }; },
  measure(name) { return { name, entryType: "measure", startTime: 0, duration: ops.op_k_now_ms() }; },
  getEntries() { return []; }, getEntriesByName() { return []; }, getEntriesByType() { return []; }, clearMarks() {}, clearMeasures() {},
  toJSON() { return { timeOrigin }; },
  eventLoopUtilization() { return { idle: 0, active: 0, utilization: 0 }; },
  timerify: (f) => f,
};

// ---------- TextEncoder / TextDecoder ----------
class TextEncoder {
  get encoding() { return "utf-8"; }
  encode(s = "") { return utf8Encode(String(s)); }
  encodeInto(s, dest) { const b = utf8Encode(String(s)); const n = Math.min(b.length, dest.length); dest.set(n === b.length ? b : b.subarray(0, n)); return { read: n === b.length ? s.length : utf8Decode(b.subarray(0, n)).length, written: n }; }
}
class TextDecoder {
  #enc; #fatal; #ignoreBOM; #pending = null;
  constructor(label = "utf-8", opts = {}) {
    const e = String(label).toLowerCase().trim();
    if (!["utf-8", "utf8", "unicode-1-1-utf-8", "latin1", "iso-8859-1", "ascii", "us-ascii", "windows-1252", "utf-16le", "utf-16"].includes(e)) throw new RangeError("The \"" + label + "\" encoding is not supported");
    this.#enc = e.startsWith("utf-16") ? "utf-16le" : e.includes("utf") ? "utf-8" : "latin1";
    this.#fatal = !!opts.fatal; this.#ignoreBOM = !!opts.ignoreBOM;
  }
  get encoding() { return this.#enc; }
  get fatal() { return this.#fatal; }
  get ignoreBOM() { return this.#ignoreBOM; }
  decode(input, opts = {}) {
    let u8 = input === undefined ? new Uint8Array(0) : input instanceof Uint8Array ? input : ArrayBuffer.isView(input) ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength) : new Uint8Array(input);
    if (this.#pending) { const m = new Uint8Array(this.#pending.length + u8.length); m.set(this.#pending); m.set(u8, this.#pending.length); u8 = m; this.#pending = null; }
    if (this.#enc === "latin1") return ops.op_k_latin1_decode(u8);
    if (this.#enc === "utf-16le") { let s = ""; for (let i = 0; i + 1 < u8.length; i += 2) s += String.fromCharCode(u8[i] | (u8[i + 1] << 8)); return s; }
    if (opts.stream) {
      let i = u8.length - 1, need = 0;
      for (let k = 0; k < 4 && i >= 0; k++, i--) { const c = u8[i]; if ((c & 0xc0) === 0x80) continue; need = (c & 0xe0) === 0xc0 ? 2 : (c & 0xf0) === 0xe0 ? 3 : (c & 0xf8) === 0xf0 ? 4 : 1; break; }
      if (i >= 0 && need > u8.length - i) { this.#pending = u8.slice(i); u8 = u8.subarray(0, i); }
    }
    if (this.#fatal) { for (let i = 0; i < u8.length;) { const c = u8[i]; const n = c < 0x80 ? 1 : (c & 0xe0) === 0xc0 ? 2 : (c & 0xf0) === 0xe0 ? 3 : (c & 0xf8) === 0xf0 ? 4 : 0; if (n === 0 || i + n > u8.length) throw new TypeError("The encoded data was not valid for encoding utf-8"); for (let j = 1; j < n; j++) if ((u8[i + j] & 0xc0) !== 0x80) throw new TypeError("The encoded data was not valid for encoding utf-8"); i += n; } }
    let s = utf8Decode(u8);
    if (!this.#ignoreBOM && s.charCodeAt(0) === 0xfeff) s = s.slice(1);
    return s;
  }
}
globalThis.TextEncoder = TextEncoder;
globalThis.TextDecoder = TextDecoder;
globalThis.atob = (s) => ops.op_k_latin1_decode(ops.op_k_base64_decode(String(s)));
globalThis.btoa = (s) => ops.op_k_base64_encode(ops.op_k_latin1_encode(String(s)), false);

// ---------- URL ----------
globalThis.URL = URL;
globalThis.URLSearchParams = URLSearchParams;

// ---------- Event / EventTarget / AbortController ----------
class Event {
  #type; #defaultPrevented = false; #stopped = false;
  constructor(type, init = {}) { this.#type = String(type); this.bubbles = !!init.bubbles; this.cancelable = !!init.cancelable; this.composed = !!init.composed; this.timeStamp = ops.op_k_now_ms(); this.target = null; this.currentTarget = null; this.isTrusted = false; }
  get type() { return this.#type; }
  get defaultPrevented() { return this.#defaultPrevented; }
  get _stopped() { return this.#stopped; }
  preventDefault() { if (this.cancelable) this.#defaultPrevented = true; }
  stopPropagation() {}
  stopImmediatePropagation() { this.#stopped = true; }
  composedPath() { return this.target ? [this.target] : []; }
  static NONE = 0; static CAPTURING_PHASE = 1; static AT_TARGET = 2; static BUBBLING_PHASE = 3;
  get eventPhase() { return 2; }
  get [Symbol.toStringTag]() { return "Event"; }
}
class CustomEvent extends Event { #detail; constructor(type, init = {}) { super(type, init); this.#detail = init.detail ?? null; } get detail() { return this.#detail; } }
class ErrorEvent extends Event { constructor(type, init = {}) { super(type, init); this.message = init.message ?? ""; this.error = init.error; this.filename = init.filename ?? ""; this.lineno = init.lineno ?? 0; this.colno = init.colno ?? 0; } }
class MessageEvent extends Event { constructor(type, init = {}) { super(type, init); this.data = init.data ?? null; this.origin = init.origin ?? ""; this.lastEventId = init.lastEventId ?? ""; this.source = init.source ?? null; this.ports = init.ports ?? []; } }
class EventTarget {
  #listeners = new Map();
  addEventListener(type, cb, opts) {
    if (cb === null || cb === undefined) return;
    const o = typeof opts === "boolean" ? { capture: opts } : opts || {};
    if (o.signal && o.signal.aborted) return;
    const list = this.#listeners.get(type) || [];
    if (list.some((l) => l.cb === cb && !!l.capture === !!o.capture)) return;
    const entry = { cb, once: !!o.once, capture: !!o.capture };
    list.push(entry);
    this.#listeners.set(type, list);
    if (o.signal) o.signal.addEventListener("abort", () => this.removeEventListener(type, cb, o), { once: true });
  }
  removeEventListener(type, cb, opts) {
    const o = typeof opts === "boolean" ? { capture: opts } : opts || {};
    const list = this.#listeners.get(type);
    if (!list) return;
    const i = list.findIndex((l) => l.cb === cb && !!l.capture === !!o.capture);
    if (i !== -1) list.splice(i, 1);
  }
  dispatchEvent(event) {
    if (!(event instanceof Event)) throw new TypeError("parameter 1 is not of type 'Event'");
    try { event.target = this; event.currentTarget = this; } catch {}
    const list = this.#listeners.get(event.type);
    if (list) for (const l of list.slice()) {
      if (l.once) this.removeEventListener(event.type, l.cb, l);
      try { if (typeof l.cb === "function") l.cb.call(this, event); else if (l.cb && typeof l.cb.handleEvent === "function") l.cb.handleEvent(event); }
      catch (e) { queueMicrotask(() => { throw e; }); }
      if (event._stopped) break;
    }
    const handler = this["on" + event.type];
    if (typeof handler === "function" && !event._stopped) handler.call(this, event);
    return !event.defaultPrevented;
  }
  get [Symbol.toStringTag]() { return "EventTarget"; }
}
class AbortSignal extends EventTarget {
  #aborted = false; #reason;
  constructor(key) { super(); if (key !== kSignalKey) throw new TypeError("Illegal constructor"); }
  get aborted() { return this.#aborted; }
  get reason() { return this.#reason; }
  throwIfAborted() { if (this.#aborted) throw this.#reason; }
  _abort(reason) {
    if (this.#aborted) return;
    this.#aborted = true;
    this.#reason = reason === undefined ? Object.assign(new Error("This operation was aborted"), { name: "AbortError", code: 20 }) : reason;
    this.dispatchEvent(new Event("abort"));
  }
  static abort(reason) { const c = new AbortController(); c.abort(reason); return c.signal; }
  static timeout(ms) { const c = new AbortController(); setTimeout(() => c.abort(Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError", code: 23 })), ms).unref(); return c.signal; }
  static any(signals) { const c = new AbortController(); for (const s of signals) { if (s.aborted) { c.abort(s.reason); break; } s.addEventListener("abort", () => c.abort(s.reason), { once: true }); } return c.signal; }
  get [Symbol.toStringTag]() { return "AbortSignal"; }
}
const kSignalKey = Symbol("signal");
class AbortController {
  #signal = new AbortSignal(kSignalKey);
  get signal() { return this.#signal; }
  abort(reason) { this.#signal._abort(reason); }
  get [Symbol.toStringTag]() { return "AbortController"; }
}
Object.assign(globalThis, { Event, CustomEvent, ErrorEvent, MessageEvent, EventTarget, AbortSignal, AbortController });

// ---------- structuredClone ----------
globalThis.structuredClone = function structuredClone(v, opts) {
  const seen = new Map();
  const clone = (x) => {
    if (x === null || typeof x !== "object") { if (typeof x === "function" || typeof x === "symbol") throw Object.assign(new Error(String(x) + " could not be cloned."), { name: "DataCloneError" }); return x; }
    if (seen.has(x)) return seen.get(x);
    let out;
    if (Array.isArray(x)) { out = []; seen.set(x, out); for (let i = 0; i < x.length; i++) out[i] = clone(x[i]); return out; }
    if (x instanceof Date) return new Date(x.getTime());
    if (x instanceof RegExp) return new RegExp(x.source, x.flags);
    if (x instanceof Map) { out = new Map(); seen.set(x, out); for (const [k, v2] of x) out.set(clone(k), clone(v2)); return out; }
    if (x instanceof Set) { out = new Set(); seen.set(x, out); for (const v2 of x) out.add(clone(v2)); return out; }
    if (x instanceof ArrayBuffer) return x.slice(0);
    if (ArrayBuffer.isView(x)) { const C = x.constructor === globalThis.Buffer ? Uint8Array : x.constructor; return new C(x.buffer.slice(x.byteOffset, x.byteOffset + x.byteLength)); }
    if (x instanceof Error) { const e = new (globalThis[x.name] || Error)(x.message); e.stack = x.stack; if ("cause" in x) e.cause = clone(x.cause); return e; }
    if (typeof x === "object" && (x instanceof Boolean || x instanceof Number || x instanceof String)) return Object(x.valueOf());
    out = {}; seen.set(x, out);
    for (const k of Object.keys(x)) out[k] = clone(x[k]);
    return out;
  };
  return clone(v);
};

// ---------- process ----------
const osInfo = ops.op_k_os_info;
let cachedOs = null;
const getOs = () => (cachedOs ??= osInfo());
const listeners = new Map();
const emitter = {
  on(ev, fn) { (listeners.get(ev) || listeners.set(ev, []).get(ev)).push(fn); return process; },
  once(ev, fn) { const w = (...a) => { process.off(ev, w); fn(...a); }; w.listener = fn; return process.on(ev, w); },
  off(ev, fn) { const l = listeners.get(ev); if (l) { const i = l.findIndex((x) => x === fn || x.listener === fn); if (i !== -1) l.splice(i, 1); } return process; },
  emit(ev, ...a) { const l = listeners.get(ev); if (!l || !l.length) return false; for (const fn of l.slice()) fn(...a); return true; },
  listeners(ev) { return (listeners.get(ev) || []).slice(); },
  listenerCount(ev) { return (listeners.get(ev) || []).length; },
  removeAllListeners(ev) { if (ev === undefined) listeners.clear(); else listeners.delete(ev); return process; },
  setMaxListeners() { return process; }, getMaxListeners() { return 10; }, prependListener(ev, fn) { (listeners.get(ev) || listeners.set(ev, []).get(ev)).unshift(fn); return process; }, eventNames() { return [...listeners.keys()]; },
};
emitter.addListener = emitter.on; emitter.removeListener = emitter.off;
const stdStream = (fd) => ({
  fd, get isTTY() { return ops.op_k_isatty(fd); }, writable: true, columns: 80, rows: 24,
  write(chunk, enc, cb) { if (typeof enc === "function") { cb = enc; enc = undefined; } ops.op_k_write_fd(fd, typeof chunk === "string" ? utf8Encode(chunk) : chunk instanceof Uint8Array ? chunk : utf8Encode(String(chunk))); if (cb) queueMicrotask(cb); return true; },
  end(chunk, enc, cb) { if (chunk !== undefined && typeof chunk !== "function") this.write(chunk, enc); if (typeof chunk === "function") chunk(); else if (typeof enc === "function") enc(); else if (cb) cb(); },
  on() { return this; }, once() { return this; }, off() { return this; }, removeListener() { return this; }, emit() { return false; }, addListener() { return this; }, removeAllListeners() { return this; }, listenerCount() { return 0; },
  getColorDepth() { return this.isTTY ? 8 : 1; }, hasColors() { return this.isTTY; }, getWindowSize() { return [80, 24]; }, cursorTo() {}, clearLine() {}, moveCursor() {},
  _writableState: {}, writableLength: 0, writableHighWaterMark: 16384, destroyed: false, destroy() {}, cork() {}, uncork() {}, setDefaultEncoding() { return this; },
});
const stdin = {
  fd: 0, get isTTY() { return ops.op_k_isatty(0); }, readable: true,
  on(ev, fn) { if (ev === "data" || ev === "end") { queueMicrotask(() => { if (!stdin._drained) { stdin._drained = true; const b = ops.op_k_read_stdin_all(); if (b.length) stdin._emit("data", globalThis.Buffer ? globalThis.Buffer.from(b) : b); stdin._emit("end"); stdin._emit("close"); } }); } (stdin._l[ev] ||= []).push(fn); return this; },
  _l: {}, _emit(ev, ...a) { for (const f of stdin._l[ev] || []) f(...a); }, once(ev, fn) { return this.on(ev, fn); }, off() { return this; }, removeListener() { return this; }, removeAllListeners() { return this; }, emit() { return false; },
  setEncoding() { return this; }, resume() { return this; }, pause() { return this; }, read() { return null; }, setRawMode() { return this; }, unref() { return this; }, ref() { return this; }, destroy() {}, pipe(d) { this.on("data", (c) => d.write(c)); this.on("end", () => d.end()); return d; },
  async *[Symbol.asyncIterator]() { const b = ops.op_k_read_stdin_all(); if (b.length) yield globalThis.Buffer ? globalThis.Buffer.from(b) : b; },
};
let startMs = 0;
let exitCode;
const process = {
  ...emitter,
  title: "kestrel", version: "v22.12.0", versions: { node: "22.12.0", kestrel: "0.0.1", v8: ops.op_kestrel_v8_version(), uv: "1.49.0", modules: "127" },
  argv: [], argv0: "kestrel", execArgv: [], env: {}, platform: "darwin", pid: 0, ppid: 0, arch: "arm64", execPath: "",
  release: { name: "node", lts: "Jod" }, config: { variables: {} }, features: { inspector: false, debug: false, uv: true, ipv6: true, tls: true, cached_builtins: true },
  get exitCode() { return exitCode; }, set exitCode(c) { exitCode = c; },
  exit(code) { if (code !== undefined) exitCode = code; process.emit("exit", exitCode ?? 0); if (ops.op_worker_self_exit((exitCode ?? 0) | 0)) { for (;;) {} } ops.op_kestrel_exit((exitCode ?? 0) | 0); },
  reallyExit(code) { ops.op_kestrel_exit((code ?? 0) | 0); },
  abort() { ops.op_kestrel_exit(134); },
  kill(pid, sig) { if (pid === process.pid) process.exit(sig === "SIGTERM" || sig === undefined ? 143 : 130); return true; },
  nextTick(cb, ...args) { if (typeof cb !== "function") throw nodeError("ERR_INVALID_ARG_TYPE", 'The "callback" argument must be of type function', TypeError); core.queueNextTick({ callback: cb, args: args.length ? args : undefined, snapshot: undefined, asyncId: 0, triggerAsyncId: 0 }); },
  cwd() { return ops.op_kestrel_cwd(); },
  chdir(d) { ops.op_k_chdir(String(d)); },
  umask(m) { return 0o22; },
  uptime() { return (ops.op_k_now_ms() - startMs) / 1000; },
  hrtime: Object.assign((prev) => { const ms = ops.op_k_now_ms(); let s = Math.floor(ms / 1000), ns = Math.round((ms % 1000) * 1e6); if (prev) { s -= prev[0]; ns -= prev[1]; if (ns < 0) { s--; ns += 1e9; } } return [s, ns]; }, { bigint: () => BigInt(Math.round(ops.op_k_now_ms() * 1e6)) }),
  memoryUsage: Object.assign(() => ({ rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 }), { rss: () => 0 }),
  cpuUsage() { return { user: Math.round(ops.op_k_now_ms() * 1000), system: 0 }; },
  resourceUsage() { return { userCPUTime: 0, systemCPUTime: 0, maxRSS: 0 }; },
  emitWarning(w, type, code) { const msg = w instanceof Error ? (w.name + ": " + w.message) : (typeof type === "string" ? type : "Warning") + (code ? " [" + code + "]" : "") + ": " + w; if (!process.noDeprecation || !/Deprecation/.test(msg)) core.print("(kestrel:" + process.pid + ") " + msg + "\n", true); process.emit("warning", w instanceof Error ? w : Object.assign(new Error(String(w)), { name: typeof type === "string" ? type : "Warning", code })); },
  binding() { throw nodeError("ERR_ACCESS_DENIED", "process.binding is not supported"); },
  dlopen() { throw nodeError("ERR_DLOPEN_FAILED", "native addons are not supported"); },
  getuid() { return getOs().uid; }, getgid() { return getOs().gid; }, geteuid() { return getOs().uid; }, getegid() { return getOs().gid; }, getgroups() { return []; },
  setuid() {}, setgid() {}, setSourceMapsEnabled() {}, hasUncaughtExceptionCaptureCallback() { return false; }, setUncaughtExceptionCaptureCallback() {},
  stdout: stdStream(1), stderr: stdStream(2), stdin,
  mainModule: undefined, exiting: false, noDeprecation: false, throwDeprecation: false, traceDeprecation: false, debugPort: 9229, connected: false, channel: undefined,
  allowedNodeEnvironmentFlags: new Set(), sourceMapsEnabled: false, report: { getReport() { return {}; } }, permission: { has() { return true; } },
  getBuiltinModule(name) { return globalThis[Symbol.for("kestrel.builtin")](name); },
  constrainedMemory() { return 0; }, availableMemory() { return getOs().total_mem; },
  loadEnvFile(path = ".env") { const src = ops.op_k_fs_read_text(String(path)); for (const line of src.split("\n")) { const m = /^\s*(?:export\s+)?([\w.-]+)\s*=\s*(.*)?\s*$/.exec(line); if (!m) continue; let v = (m[2] || "").trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); if (!(m[1] in process.env)) process.env[m[1]] = v; } },
  [Symbol.toStringTag]: "process",
};
globalThis.process = process;
// env writes propagate to the real environment (child-visible later).
process.env = new Proxy({}, {
  get: (t, k) => t[k],
  set: (t, k, v) => { t[k] = String(v); if (typeof k === "string") ops.op_k_setenv(k, String(v)); return true; },
  deleteProperty: (t, k) => { delete t[k]; return true; },
  has: (t, k) => k in t, ownKeys: (t) => Reflect.ownKeys(t), getOwnPropertyDescriptor: (t, k) => Reflect.getOwnPropertyDescriptor(t, k),
});
// IPC channel inherited from child_process.fork (KESTREL_IPC_FD).
function setupIpcChild(fd) {
  let rid = null, started = false;
  const open = () => { if (rid === null) { rid = ops.op_net_from_fd(fd); process.connected = true; process.channel = {}; } return rid; };
  const pump = () => {
    if (started) return; started = true; open();
    (async () => {
      let buf = "";
      try {
        for (;;) { const chunk = await ops.op_net_read(rid); if (chunk.length === 0) break; buf += utf8Decode(chunk); let i; while ((i = buf.indexOf("\n")) !== -1) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line) process.emit("message", JSON.parse(line)); } }
      } catch {}
      if (process.connected) { process.connected = false; process.emit("disconnect"); }
    })();
  };
  process.send = (message, sendHandle, options, callback) => {
    if (typeof sendHandle === "function") callback = sendHandle; else if (typeof options === "function") callback = options;
    open();
    if (!process.connected) { const e = nodeError("ERR_IPC_CHANNEL_CLOSED", "Channel closed"); if (callback) { queueMicrotask(() => callback(e)); return false; } throw e; }
    ops.op_net_write(rid, utf8Encode(JSON.stringify(message) + "\n")).then(() => callback && callback(null), (e) => { if (callback) callback(e); else process.emit("error", e); });
    return true;
  };
  process.disconnect = () => { if (!process.connected) return; process.connected = false; if (rid !== null) ops.op_net_shutdown(rid).then(() => {}, () => {}); process.emit("disconnect"); };
  process.connected = true;
  const origOn = process.on;
  process.on = function (ev, fn) { const r = origOn.call(process, ev, fn); if (ev === "message") pump(); return r; };
  process.addListener = process.on;
  process.once = function (ev, fn) { const w = (...a) => { process.off(ev, w); fn(...a); }; w.listener = fn; return process.on(ev, w); };
}
globalThis.__kestrel_init = (argv, env, platform, pid) => {
  startMs = ops.op_k_now_ms();
  if (env.KESTREL_IPC_FD) { setupIpcChild(Number(env.KESTREL_IPC_FD)); }
  timeOrigin = Date.now() - startMs;
  process.argv = [argv[0] === "kestrel" ? getOs().exec_path || "kestrel" : argv[0], ...argv.slice(1)];
  process.argv0 = "kestrel";
  for (const k of Object.keys(env)) process.env[k] = env[k];
  process.platform = platform; process.pid = pid; process.ppid = getOs().ppid; process.arch = getOs().arch; process.execPath = getOs().exec_path;
  delete globalThis.__kestrel_init;
};

core.setUnhandledPromiseRejectionHandler((promise, reason) => {
  if (process.emit("unhandledRejection", reason, promise)) return true;
  if (globalThis.__kestrel_worker_error) { globalThis.__kestrel_worker_error(reason); return true; }
  core.print((reason instanceof Error ? reason.stack || String(reason) : "Uncaught (in promise) " + inspect(reason)) + "\n", true);
  process.emit("exit", 1);
  ops.op_kestrel_exit(1);
  return true;
});
core.setReportExceptionCallback((e) => {
  if (process.emit("uncaughtException", e, "uncaughtException")) return;
  if (globalThis.__kestrel_worker_error) { globalThis.__kestrel_worker_error(e); return; }
  core.print((e instanceof Error ? e.stack || String(e) : "Uncaught " + inspect(e)) + "\n", true);
  process.emit("exit", 1);
  ops.op_kestrel_exit(1);
});
