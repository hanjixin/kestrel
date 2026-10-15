// Kestrel runtime bootstrap. Runs once at snapshot time; globals installed here
// are available to every user module.
const core = Deno.core;

// ---------- console (Node-compatible formatting for the common cases) ----------
const kMaxDepth = 4;
function quote(s) {
  return "'" + s.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n") + "'";
}
function inspect(v, depth, seen) {
  switch (typeof v) {
    case "string": return depth === 0 ? v : quote(v);
    case "number": return Object.is(v, -0) ? "-0" : String(v);
    case "bigint": return v + "n";
    case "boolean":
    case "undefined": return String(v);
    case "symbol": return v.toString();
    case "function": {
      const name = v.name ? ": " + v.name : " (anonymous)";
      return (v.constructor && v.constructor.name === "AsyncFunction" ? "[AsyncFunction" : "[Function") + name + "]";
    }
  }
  if (v === null) return "null";
  if (seen.has(v)) return "[Circular *1]";
  if (v instanceof Error) return v.stack || String(v);
  if (v instanceof Date) return isNaN(v) ? "Invalid Date" : v.toISOString();
  if (v instanceof RegExp) return v.toString();
  if (v instanceof Promise) return "Promise { <pending> }";
  if (depth > kMaxDepth) return Array.isArray(v) ? "[Array]" : "[Object]";
  seen.add(v);
  try {
    if (Array.isArray(v)) {
      const items = v.map((x) => inspect(x, depth + 1, seen));
      return items.length === 0 ? "[]" : "[ " + items.join(", ") + " ]";
    }
    if (ArrayBuffer.isView(v)) {
      return v[Symbol.toStringTag] + "(" + v.length + ") [ " + Array.prototype.join.call(v, ", ") + " ]";
    }
    if (v instanceof Map) {
      const items = [];
      for (const [k, x] of v) items.push(inspect(k, depth + 1, seen) + " => " + inspect(x, depth + 1, seen));
      return "Map(" + v.size + ") {" + (items.length ? " " + items.join(", ") + " " : "") + "}";
    }
    if (v instanceof Set) {
      const items = [];
      for (const x of v) items.push(inspect(x, depth + 1, seen));
      return "Set(" + v.size + ") {" + (items.length ? " " + items.join(", ") + " " : "") + "}";
    }
    const keys = Object.keys(v);
    const proto = Object.getPrototypeOf(v);
    const ctor = proto && proto.constructor && proto.constructor.name;
    const prefix = ctor && ctor !== "Object" ? ctor + " " : "";
    if (keys.length === 0) return prefix + "{}";
    const items = keys.map((k) => {
      const key = /^[A-Za-z_$][\w$]*$/.test(k) ? k : quote(k);
      return key + ": " + inspect(v[k], depth + 1, seen);
    });
    return prefix + "{ " + items.join(", ") + " }";
  } finally {
    seen.delete(v);
  }
}
function format(args) {
  if (args.length === 0) return "";
  let i = 0;
  let out = "";
  if (typeof args[0] === "string" && args[0].includes("%")) {
    i = 1;
    out = args[0].replace(/%[sdifjoO%]/g, (m) => {
      if (m === "%%") return "%";
      if (i >= args.length) return m;
      const a = args[i++];
      switch (m) {
        case "%s": return typeof a === "string" ? a : inspect(a, 1, new Set());
        case "%d": case "%i": return typeof a === "bigint" ? a + "n" : String(m === "%i" ? parseInt(a) : Number(a));
        case "%f": return String(parseFloat(a));
        case "%j": return JSON.stringify(a);
        default: return inspect(a, 1, new Set());
      }
    });
  }
  for (; i < args.length; i++) {
    out += (out.length ? " " : "") + inspect(args[i], 0, new Set());
  }
  return out;
}
const counts = new Map();
const timers = new Map();
let groupIndent = "";
function write(isErr, args) {
  let s = format(args);
  if (groupIndent) s = groupIndent + s.replace(/\n/g, "\n" + groupIndent);
  core.print(s + "\n", isErr);
}
const console = {
  log: (...a) => write(false, a),
  info: (...a) => write(false, a),
  debug: (...a) => write(false, a),
  warn: (...a) => write(true, a),
  error: (...a) => write(true, a),
  trace: (...a) => write(true, ["Trace: " + format(a) + "\n" + new Error().stack.split("\n").slice(2).join("\n")]),
  assert: (ok, ...a) => { if (!ok) write(true, ["Assertion failed" + (a.length ? ": " + format(a) : "")]); },
  dir: (v) => write(false, [v]),
  table: (v) => write(false, [v]),
  count: (label = "default") => { const n = (counts.get(label) || 0) + 1; counts.set(label, n); write(false, [label + ": " + n]); },
  countReset: (label = "default") => counts.set(label, 0),
  time: (label = "default") => timers.set(label, performance.now()),
  timeEnd: (label = "default") => { const t = timers.get(label); timers.delete(label); if (t !== undefined) write(false, [label + ": " + (performance.now() - t).toFixed(3) + "ms"]); },
  timeLog: (label = "default", ...a) => { const t = timers.get(label); if (t !== undefined) write(false, [label + ": " + (performance.now() - t).toFixed(3) + "ms", ...a]); },
  group: (...a) => { if (a.length) write(false, a); groupIndent += "  "; },
  groupEnd: () => { groupIndent = groupIndent.slice(0, -2); },
};
globalThis.console = console;

// ---------- timers ----------
globalThis.setTimeout = (cb, ms, ...args) => core.createTimer(cb, ms, args, false, true, false);
globalThis.setInterval = (cb, ms, ...args) => core.createTimer(cb, ms, args, true, true, false);
globalThis.clearTimeout = (t) => { if (t) core.cancelTimer(t); };
globalThis.clearInterval = globalThis.clearTimeout;
globalThis.setImmediate = (cb, ...args) => { const im = { _onImmediate: () => cb(...args), _destroyed: false }; core.queueImmediate(im); return im; };
globalThis.clearImmediate = (im) => { if (im) core.clearImmediate(im); };

// ---------- performance ----------
const t0 = Date.now();
globalThis.performance = { now: () => Date.now() - t0, timeOrigin: t0 };

// ---------- process (minimal, grows with Node compat work) ----------
globalThis.process = {
  argv: [],
  env: {},
  platform: "darwin",
  pid: 0,
  exitCode: 0,
  exit: (code) => core.ops.op_kestrel_exit(code ?? globalThis.process.exitCode ?? 0),
  nextTick: (cb, ...args) => core.queueNextTick(() => cb(...args)),
  hrtime: Object.assign((prev) => {
    const ms = performance.now();
    const s = Math.floor(ms / 1000), ns = Math.floor((ms % 1000) * 1e6);
    return prev ? [s - prev[0], ns - prev[1]] : [s, ns];
  }, { bigint: () => BigInt(Math.floor(performance.now() * 1e6)) }),
  cwd: () => core.ops.op_kestrel_cwd(),
  memoryUsage: () => ({ rss: 0, heapTotal: 0, heapUsed: 0, external: 0 }),
  on: () => globalThis.process,
  once: () => globalThis.process,
  off: () => globalThis.process,
  emit: () => false,
  versions: { kestrel: "0.0.1", v8: core.ops.op_kestrel_v8_version() },
  version: "v22.0.0-kestrel",
  stdout: { write: (s) => { core.print(String(s), false); return true; }, isTTY: false },
  stderr: { write: (s) => { core.print(String(s), true); return true; }, isTTY: false },
};
// Filled by Rust right before the main module runs.
globalThis.__kestrel_init = (argv, env, platform, pid) => {
  globalThis.process.argv = argv;
  globalThis.process.env = env;
  globalThis.process.platform = platform;
  globalThis.process.pid = pid;
  delete globalThis.__kestrel_init;
};

// Unhandled promise rejections: print and keep going (Node's default is exit 1;
// we align with Node by exiting through the runtime after the loop drains).
core.setUnhandledPromiseRejectionHandler((_promise, reason) => {
  core.print("Uncaught (in promise) " + inspect(reason, 0, new Set()) + "\n", true);
  globalThis.process.exitCode = 1;
  return true;
});

// ---------- Fetch-style Request / Response / Headers (minimal) ----------
class Headers {
  #m = new Map();
  constructor(init) {
    if (init instanceof Headers) { for (const [k, v] of init) this.#m.set(k, v); }
    else if (Array.isArray(init)) { for (const [k, v] of init) this.append(k, v); }
    else if (init && typeof init === "object") { for (const k of Object.keys(init)) this.set(k, init[k]); }
  }
  get(k) { const v = this.#m.get(String(k).toLowerCase()); return v === undefined ? null : v; }
  has(k) { return this.#m.has(String(k).toLowerCase()); }
  set(k, v) { this.#m.set(String(k).toLowerCase(), String(v)); }
  append(k, v) { k = String(k).toLowerCase(); const cur = this.#m.get(k); this.#m.set(k, cur === undefined ? String(v) : cur + ", " + v); }
  delete(k) { this.#m.delete(String(k).toLowerCase()); }
  forEach(cb, thisArg) { for (const [k, v] of this.#m) cb.call(thisArg, v, k, this); }
  *entries() { yield* this.#m.entries(); }
  *keys() { yield* this.#m.keys(); }
  *values() { yield* this.#m.values(); }
  [Symbol.iterator]() { return this.#m.entries(); }
}
globalThis.Headers = Headers;

const kReqId = Symbol("kestrel.reqId");
class Request {
  #headers = null;
  constructor(url, init = {}, id) {
    this.url = url;
    this.method = init.method ? String(init.method).toUpperCase() : "GET";
    this[kReqId] = id;
    if (init.headers) this.#headers = new Headers(init.headers);
    this.body = init.body ?? null;
  }
  get headers() {
    if (this.#headers === null) {
      this.#headers = new Headers();
      if (this[kReqId] !== undefined) {
        const raw = core.ops.op_kestrel_http_headers(this[kReqId]);
        if (raw.length) { const parts = raw.split("\0"); for (let i = 0; i + 1 < parts.length; i += 2) this.#headers.append(parts[i], parts[i + 1]); }
      }
    }
    return this.#headers;
  }
  async text() { return this.body == null ? "" : String(this.body); }
  async json() { return JSON.parse(await this.text()); }
}
globalThis.Request = Request;

const kBody = Symbol("kestrel.body");
class Response {
  constructor(body = null, init = {}) {
    this.status = init.status ?? 200;
    this.statusText = init.statusText ?? "";
    this.headers = new Headers(init.headers);
    this[kBody] = body == null ? "" : typeof body === "string" ? body : body instanceof Uint8Array ? new TextDecoder().decode(body) : String(body);
    this.ok = this.status >= 200 && this.status < 300;
  }
  static json(data, init = {}) {
    const r = new Response(JSON.stringify(data), init);
    if (!r.headers.has("content-type")) r.headers.set("content-type", "application/json");
    return r;
  }
  static redirect(url, status = 302) { return new Response(null, { status, headers: { location: url } }); }
  async text() { return this[kBody]; }
  async json() { return JSON.parse(this[kBody]); }
}
globalThis.Response = Response;

// ---------- Kestrel namespace ----------
function serve(options) {
  const workerId = core.ops.op_kestrel_worker_id();
  const handler = typeof options === "function" ? options : options.fetch;
  if (typeof handler !== "function") throw new TypeError("Kestrel.serve: fetch handler required");
  const port = options.port ?? 3000;
  const hostname = options.hostname ?? "0.0.0.0";
  const cpus = core.ops.op_kestrel_cpus();
  const workers = Math.max(1, Math.min(options.workers === "auto" || options.workers === undefined ? cpus : options.workers | 0, 256));
  if (workerId === 0 && workers > 1) core.ops.op_kestrel_spawn_workers(workers - 1);

  const rid = core.ops.op_kestrel_http_listen(hostname, port);
  const accept = core.ops.op_kestrel_http_accept;
  const respond = core.ops.op_kestrel_http_respond;
  const errorResp = new Response("Internal Server Error", { status: 500 });
  const send = (id, r) => {
    if (!(r instanceof Response)) r = errorResp;
    respond(id, r.status, r.headers.get("content-type") ?? "text/plain;charset=UTF-8", r[kBody]);
  };
  (async () => {
    for (;;) {
      const s = await accept(rid);
      const i1 = s.indexOf("\0");
      const i2 = s.indexOf("\0", i1 + 1);
      const id = +s.slice(0, i1);
      const req = new Request(s.slice(i2 + 1), { method: s.slice(i1 + 1, i2) }, id);
      let r;
      try { r = handler(req); } catch (e) { console.error(e); send(id, errorResp); continue; }
      if (r instanceof Promise) r.then((v) => send(id, v), (e) => { console.error(e); send(id, errorResp); });
      else send(id, r);
    }
  })();
  if (workerId === 0 && options.silent !== true) {
    console.log(`Kestrel listening on http://${hostname}:${port} (${workers} worker${workers > 1 ? "s" : ""})`);
  }
  return { port, hostname, workers };
}
globalThis.Kestrel = Object.freeze({ serve, get workerId() { return core.ops.op_kestrel_worker_id(); }, version: "0.0.1" });
