// Kestrel runtime bootstrap. Runs once at snapshot time; everything installed here is
// available to user modules. Order matters: globals first, then node:* modules.
import "ext:kestrel/globals.js";
import { core, ops, utf8Decode, utf8Encode, nodeError, kEmpty } from "ext:kestrel/internal.js";
import assert from "ext:kestrel/node/assert.js";
import buffer, { Buffer, Blob, File } from "ext:kestrel/node/buffer.js";
import child_process from "ext:kestrel/node/child_process.js";
import crypto from "ext:kestrel/node/crypto.js";
import events from "ext:kestrel/node/events.js";
import fs from "ext:kestrel/node/fs.js";
import fsPromises from "ext:kestrel/node/fs_promises.js";
import http from "ext:kestrel/node/http.js";
import https from "ext:kestrel/node/https.js";
import module, { _registerBuiltins } from "ext:kestrel/node/module.js";
import net from "ext:kestrel/node/net.js";
import os from "ext:kestrel/node/os.js";
import path from "ext:kestrel/node/path.js";
import querystring from "ext:kestrel/node/querystring.js";
import readline from "ext:kestrel/node/readline.js";
import stream from "ext:kestrel/node/stream.js";
import string_decoder from "ext:kestrel/node/string_decoder.js";
import timers from "ext:kestrel/node/timers.js";
import timersPromises from "ext:kestrel/node/timers_promises.js";
import tty from "ext:kestrel/node/tty.js";
import url from "ext:kestrel/node/url.js";
import util from "ext:kestrel/node/util.js";
import utilTypes from "ext:kestrel/node/util_types.js";
import worker_threads, { _refresh as refreshWorkerThreads } from "ext:kestrel/node/worker_threads.js";
import zlib from "ext:kestrel/node/zlib.js";
import tls from "ext:kestrel/node/tls.js";
import dns from "ext:kestrel/node/dns.js";
import dnsPromises from "ext:kestrel/node/dns_promises.js";
import dgram from "ext:kestrel/node/dgram.js";
import perf_hooks from "ext:kestrel/node/perf_hooks.js";
import v8 from "ext:kestrel/node/v8.js";
import vm from "ext:kestrel/node/vm.js";
import cluster from "ext:kestrel/node/cluster.js";
import constants from "ext:kestrel/node/constants.js";

{
  const prevInit = globalThis.__kestrel_init;
  globalThis.__kestrel_init = (...a) => { prevInit(...a); refreshWorkerThreads(); };
}

const builtins = {
  assert, "assert/strict": assert.strict, buffer, child_process, crypto, events, fs, "fs/promises": fsPromises, http, https, module, net, os, path, "path/posix": path,
  process: globalThis.process, querystring, readline, stream, "stream/promises": stream.promises, string_decoder, timers, "timers/promises": timersPromises, tty, url, util, "util/types": utilTypes, worker_threads, zlib,
  tls, dns, "dns/promises": dnsPromises, dgram, perf_hooks, v8, vm, cluster, constants, sys: util,
};
_registerBuiltins(builtins);
globalThis[Symbol.for("kestrel.builtin")] = (name) => builtins[String(name).replace(/^node:/, "")];

// ---------- Node globals ----------
globalThis.Buffer = Buffer;
globalThis.Blob = Blob;
globalThis.File = File;
globalThis.crypto = crypto.webcrypto;
let mainRequire = null;
Object.defineProperty(globalThis, "require", { configurable: true, enumerable: false, get() { return mainRequire ??= module.createRequire(globalThis.process.cwd() + "/__main__"); }, set(v) { mainRequire = v; } });
Object.defineProperty(globalThis, "module", { value: undefined, writable: true, configurable: true });

// ---------- Fetch API: Headers / Request / Response / fetch ----------
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
  getSetCookie() { const v = this.#m.get("set-cookie"); return v === undefined ? [] : v.split(/,\s*(?=[^;,]+=)/); }
  *entries() { yield* [...this.#m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)); }
  *keys() { for (const [k] of this.entries()) yield k; }
  *values() { for (const [, v] of this.entries()) yield v; }
  [Symbol.iterator]() { return this.entries(); }
  get [Symbol.toStringTag]() { return "Headers"; }
  _flat() { const parts = []; for (const [k, v] of this.#m) parts.push(k, v); return parts.join("\0"); }
  _size() { return this.#m.size; }
}
globalThis.Headers = Headers;

const kReqId = Symbol.for("kestrel.reqId");
const kBody = Symbol("kestrel.body");
const kBodyUsed = Symbol("kestrel.bodyUsed");

function bodyToBytes(body) {
  if (body === null || body === undefined) return null;
  if (typeof body === "string") return utf8Encode(body);
  if (body instanceof Uint8Array) return body;
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (body instanceof URLSearchParams) return utf8Encode(body.toString());
  if (body instanceof Blob) return body;
  if (typeof body.getReader === "function") return body; // ReadableStream: drained lazily
  if (body instanceof FormData) return utf8Encode(new URLSearchParams([...body]).toString());
  return utf8Encode(String(body));
}
async function drainBody(b) {
  if (b === null) return new Uint8Array(0);
  if (typeof b === "string") return utf8Encode(b);
  if (b instanceof Uint8Array) return b;
  if (b instanceof Blob) return await b.bytes();
  if (typeof b.getReader === "function") { const r = b.getReader(); const chunks = []; let n = 0; for (;;) { const { value, done } = await r.read(); if (done) break; const u = typeof value === "string" ? utf8Encode(value) : value; chunks.push(u); n += u.length; } const out = new Uint8Array(n); let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; } return out; }
  return new Uint8Array(0);
}
const BodyMixin = {
  get bodyUsed() { return !!this[kBodyUsed]; },
  async arrayBuffer() { const u = await this._bytes(); return u.buffer.byteLength === u.byteLength && u.byteOffset === 0 ? u.buffer : u.slice().buffer; },
  async bytes() { return await this._bytes(); },
  async text() { return utf8Decode(await this._bytes()); },
  async json() { return JSON.parse(utf8Decode(await this._bytes())); },
  async blob() { return new Blob([await this._bytes()], { type: this.headers.get("content-type") || "" }); },
  async formData() { const t = await this.text(); const fd = new FormData(); for (const [k, v] of new URLSearchParams(t)) fd.append(k, v); return fd; },
  get body() { if (this[kBody] === null || this[kBody] === undefined) { if (this[kReqId] === undefined) return null; } const self = this; return new ReadableStream({ async start(c) { c.enqueue(await self._bytes()); c.close(); } }); },
};

class Request {
  #headers = null;
  // Server requests (id !== undefined) read url/method/headers from the native side on first access.
  constructor(input, init = kEmpty, id) {
    this[kReqId] = id;
    if (id !== undefined) { this[kBody] = undefined; return; }
    if (input instanceof Request) { this._url = input.url; this._method = input.method; this.#headers = new Headers(input.headers); this[kBody] = input[kBody]; this.signal = input.signal; this.redirect = input.redirect; }
    else { this._url = String(input); this._method = "GET"; }
    if (init.method) this._method = String(init.method).toUpperCase();
    if (init.headers) this.#headers = new Headers(init.headers);
    if (init.body !== undefined) this[kBody] = bodyToBytes(init.body);
    else if (this[kBody] === undefined) this[kBody] = null;
    if (init.signal) this.signal = init.signal;
    if (init.redirect) this.redirect = init.redirect;
    if (init.credentials) this.credentials = init.credentials;
    if (init.mode) this.mode = init.mode;
    if (init.cache) this.cache = init.cache;
  }
  get url() { return this._url !== undefined ? this._url : (this._url = ops.op_kestrel_http_url(this[kReqId])); }
  set url(v) { this._url = v; }
  get method() { return this._method !== undefined ? this._method : (this._method = ops.op_kestrel_http_method(this[kReqId])); }
  set method(v) { this._method = v; }
  get headers() {
    if (this.#headers === null) {
      this.#headers = new Headers();
      if (this[kReqId] !== undefined) {
        const raw = ops.op_kestrel_http_headers(this[kReqId]);
        if (raw.length) { const parts = raw.split("\0"); for (let i = 0; i + 1 < parts.length; i += 2) this.#headers.append(parts[i], parts[i + 1]); }
      }
    }
    return this.#headers;
  }
  async _bytes() {
    if (this[kBodyUsed]) throw new TypeError("Body is unusable: Body has already been read");
    this[kBodyUsed] = true;
    if (this[kBody] === undefined && this[kReqId] !== undefined) { this[kBody] = await ops.op_kestrel_http_body(this[kReqId]); }
    return await drainBody(this[kBody] ?? null);
  }
  clone() { const r = new Request(this); r[kReqId] = this[kReqId]; return r; }
  get [Symbol.toStringTag]() { return "Request"; }
}
Object.assign(Request.prototype, { signal: null, redirect: "follow", credentials: "same-origin", mode: "cors", cache: "default", referrer: "about:client", integrity: "", keepalive: false, destination: "", _url: undefined, _method: undefined });
Object.defineProperties(Request.prototype, Object.getOwnPropertyDescriptors(BodyMixin));
globalThis.Request = Request;

const kHeaders = Symbol("kestrel.headers");
const kHeadersInit = Symbol("kestrel.headersInit");
class Response {
  constructor(body = null, init = kEmpty) {
    const status = init.status;
    this.status = status === undefined ? 200 : status;
    this[kBody] = typeof body === "string" ? body : bodyToBytes(body);
    if (init !== kEmpty) {
      if (this.status < 200 || this.status > 599) throw new RangeError("The status provided (" + this.status + ") is outside the range [200, 599]");
      if (init.statusText !== undefined) this.statusText = init.statusText;
      if (init.headers !== undefined) this[kHeadersInit] = init.headers;
      if (init.url !== undefined) this.url = init.url;
      if (init.__raw !== undefined) this._raw = init.__raw;
    }
  }
  get ok() { return this.status >= 200 && this.status < 300; }
  get headers() { let h = this[kHeaders]; if (h === undefined) { h = new Headers(this[kHeadersInit]); this[kHeaders] = h; } return h; }
  get hasHeaders() { return this[kHeaders] !== undefined || this[kHeadersInit] !== undefined; }
  async _bytes() { if (this[kBodyUsed]) throw new TypeError("Body is unusable: Body has already been read"); this[kBodyUsed] = true; return await drainBody(this[kBody]); }
  clone() { const r = new Response(this[kBody], { status: this.status, statusText: this.statusText, headers: this.headers }); r.url = this.url; return r; }
  static json(data, init = kEmpty) { const h = new Headers(init.headers); if (!h.has("content-type")) h.set("content-type", "application/json"); return new Response(JSON.stringify(data), { ...init, headers: h }); }
  static error() { const r = new Response(null, { status: 500 }); r.type = "error"; r.status = 0; return r; }
  static redirect(u, status = 302) { return new Response(null, { status, headers: { location: String(u) } }); }
  get [Symbol.toStringTag]() { return "Response"; }
}
Object.assign(Response.prototype, { statusText: "", type: "default", url: "", redirected: false, _raw: undefined, [kHeaders]: undefined, [kHeadersInit]: undefined });
Object.defineProperties(Response.prototype, Object.getOwnPropertyDescriptors(BodyMixin));
globalThis.Response = Response;

class FormData {
  #l = [];
  append(k, v) { this.#l.push([String(k), typeof v === "string" ? v : v]); }
  set(k, v) { this.delete(k); this.append(k, v); }
  get(k) { const e = this.#l.find(([a]) => a === String(k)); return e ? e[1] : null; }
  getAll(k) { return this.#l.filter(([a]) => a === String(k)).map(([, v]) => v); }
  has(k) { return this.#l.some(([a]) => a === String(k)); }
  delete(k) { this.#l = this.#l.filter(([a]) => a !== String(k)); }
  *entries() { yield* this.#l; } *keys() { for (const [k] of this.#l) yield k; } *values() { for (const [, v] of this.#l) yield v; }
  forEach(cb, t) { for (const [k, v] of this.#l) cb.call(t, v, k, this); }
  [Symbol.iterator]() { return this.entries(); }
  get [Symbol.toStringTag]() { return "FormData"; }
}
globalThis.FormData = FormData;

globalThis.fetch = async function fetch(input, init = kEmpty) {
  const req = input instanceof Request && init === kEmpty ? input : new Request(input, init);
  const signal = init.signal || req.signal;
  if (signal && signal.aborted) throw signal.reason;
  const headers = [];
  for (const [k, v] of req.headers) headers.push([k, v]);
  let body = req[kBody];
  const hasBody = body !== null && body !== undefined;
  const bytes = hasBody ? await drainBody(body) : new Uint8Array(0);
  if (hasBody && !req.headers.has("content-type") && typeof init.body === "string") headers.push(["content-type", "text/plain;charset=UTF-8"]);
  if (hasBody && init.body instanceof URLSearchParams && !req.headers.has("content-type")) headers.push(["content-type", "application/x-www-form-urlencoded;charset=UTF-8"]);
  const url = new URL(req.url, "http://localhost/").href;
  if (!/^https?:/.test(url)) throw new TypeError("fetch failed: unsupported scheme in " + url);
  const p = ops.op_kestrel_fetch(url, req.method, headers, bytes, hasBody, req.redirect !== "manual");
  const r = await (signal ? Promise.race([p, new Promise((_, rej) => signal.addEventListener("abort", () => rej(signal.reason), { once: true }))]) : p);
  const h = new Headers();
  for (const [k, v] of r.headers) h.append(k, v);
  const resp = new Response(new Uint8Array(r.body), { status: r.status, statusText: r.status_text, headers: h });
  resp.url = r.url; resp.redirected = r.url !== url;
  return resp;
};

// ---------- Kestrel namespace: serve ----------
const TEXT_PLAIN = "content-type\0text/plain;charset=UTF-8";
function serve(options) {
  const workerId = ops.op_kestrel_worker_id();
  const handler = typeof options === "function" ? options : options.fetch;
  if (typeof handler !== "function") throw new TypeError("Kestrel.serve: fetch handler required");
  const port = options.port ?? 3000;
  const hostname = options.hostname ?? "0.0.0.0";
  const cpus = ops.op_kestrel_cpus();
  const workers = Math.max(1, Math.min(options.workers === "auto" || options.workers === undefined ? cpus : options.workers | 0, 256));
  if (workerId === 0 && workers > 1) ops.op_kestrel_spawn_workers(workers - 1);

  if (options.tls) {
    const load = (v) => (typeof v === "string" && !v.includes("-----BEGIN") ? fs.readFileSync(v, "utf8") : typeof v === "string" ? v : new TextDecoder().decode(v));
    ops.op_tls_server_config(load(options.tls.cert), load(options.tls.key));
  }
  const rid = ops.op_kestrel_http_listen(hostname, port, workers);
  const accept = ops.op_kestrel_http_accept;
  const respond = ops.op_kestrel_http_respond;
  const respondBytes = ops.op_kestrel_http_respond_bytes;
  const errorResp = new Response("Internal Server Error", { status: 500 });
  const send = (id, r) => {
    if (!(r instanceof Response)) r = errorResp;
    const hdrs = r._raw !== undefined ? r._raw : r.hasHeaders ? (r.headers.has("content-type") ? r.headers._flat() : r.headers._flat() + (r.headers._size() ? "\0" : "") + TEXT_PLAIN) : "";
    const b = r[kBody];
    if (b === null) respond(id, r.status, hdrs, "");
    else if (typeof b === "string") respond(id, r.status, hdrs, b);
    else if (b instanceof Uint8Array) respondBytes(id, r.status, hdrs, b);
    else drainBody(b).then((u) => respondBytes(id, r.status, hdrs, u), () => respond(id, 500, "", "Internal Server Error"));
  };
  const onError = (id) => (e) => { console.error(e); send(id, errorResp); };
  const ERR_TUPLE = [500, "", "Internal Server Error"];
  const headersOf = (r) => r._raw !== undefined ? r._raw : r.hasHeaders ? (r.headers.has("content-type") ? r.headers._flat() : r.headers._flat() + (r.headers._size() ? "\0" : "") + TEXT_PLAIN) : "";
  // Called synchronously from the native HTTP task for every request. Returns
  // [status, headersFlat, body] for synchronous handlers, undefined when the handler
  // returned a promise (then `send` finishes the request through the respond op).
  const trampoline = (id) => {
    const req = new Request(undefined, kEmpty, id);
    let r;
    try { r = handler(req); } catch (e) { console.error(e); return ERR_TUPLE; }
    if (r instanceof Promise) { r.then((v) => send(id, v), onError(id)); return undefined; }
    if (!(r instanceof Response)) return ERR_TUPLE;
    const b = r[kBody];
    if (typeof b === "string" && r.status === 200 && !r.hasHeaders && r._raw === undefined) return b;
    const hdrs = headersOf(r);
    if (b === null) return [r.status, hdrs, ""];
    if (typeof b === "string" || b instanceof Uint8Array) return [r.status, hdrs, b];
    drainBody(b).then((u) => respondBytes(id, r.status, hdrs, u), () => respond(id, 500, "", "Internal Server Error"));
    return undefined;
  };
  ops.op_kestrel_http_set_handler(trampoline);
  // Keeps the event loop alive for the lifetime of the server (never resolves).
  accept(rid).catch(() => {});
  if (workerId === 0 && options.silent !== true) {
    console.log(`Kestrel listening on ${options.tls ? "https" : "http"}://${hostname}:${port} (${workers} worker${workers > 1 ? "s" : ""})`);
  }
  return { port, hostname, workers };
}
globalThis.Kestrel = Object.freeze({ serve, get workerId() { return ops.op_kestrel_worker_id(); }, version: "0.0.1" });
