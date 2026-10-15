// node:worker_threads — Worker runs a module on its own thread with its own isolate;
// messages are JSON with typed arrays encoded.
import { ops, nodeError } from "ext:kestrel/internal.js";
import { EventEmitter } from "ext:kestrel/node/events.js";
import { Buffer } from "ext:kestrel/node/buffer.js";

// Values here are refreshed by _refresh() before a worker's main module runs
// (module code is evaluated once, at snapshot time, so these cannot be constants).
export let isMainThread = true;
export let threadId = 0;
export let workerData = null;
export let parentPort = null;
export const resourceLimits = {};
export const SHARE_ENV = Symbol("nodejs.worker_threads.SHARE_ENV");

function encode(v) {
  return JSON.stringify(v, (k, x) => {
    if (x instanceof Uint8Array) return { __k_u8: Buffer.from(x).toString("base64"), buffer: x.constructor.name === "Buffer" };
    if (ArrayBuffer.isView(x)) return { __k_ta: x.constructor.name, data: Buffer.from(x.buffer, x.byteOffset, x.byteLength).toString("base64") };
    if (x instanceof ArrayBuffer) return { __k_ab: Buffer.from(x).toString("base64") };
    if (x instanceof Map) return { __k_map: [...x] };
    if (x instanceof Set) return { __k_set: [...x] };
    if (x instanceof Date) return { __k_date: x.getTime() };
    if (x instanceof Error) return { __k_err: { name: x.name, message: x.message, stack: x.stack } };
    if (typeof x === "bigint") return { __k_big: x.toString() };
    return x;
  });
}
function decode(s) {
  return JSON.parse(s, (k, x) => {
    if (x && typeof x === "object") {
      if (x.__k_u8 !== undefined) { const b = Buffer.from(x.__k_u8, "base64"); return x.buffer ? b : new Uint8Array(b); }
      if (x.__k_ta !== undefined) { const b = Buffer.from(x.data, "base64"); const C = globalThis[x.__k_ta]; return C ? new C(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)) : b; }
      if (x.__k_ab !== undefined) { const b = Buffer.from(x.__k_ab, "base64"); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); }
      if (x.__k_map !== undefined) return new Map(x.__k_map);
      if (x.__k_set !== undefined) return new Set(x.__k_set);
      if (x.__k_date !== undefined) return new Date(x.__k_date);
      if (x.__k_err !== undefined) { const e = new Error(x.__k_err.message); e.name = x.__k_err.name; e.stack = x.__k_err.stack; return e; }
      if (x.__k_big !== undefined) return BigInt(x.__k_big);
    }
    return x;
  });
}

class MessagePortBase extends EventEmitter {
  constructor() { super(); this._started = false; }
  on(ev, fn) { super.on(ev, fn); if (ev === "message") this.start(); return this; }
  addEventListener(ev, fn) { return this.on(ev, (data) => fn({ data, type: ev })); }
  removeEventListener(ev, fn) { return this.off(ev, fn); }
  start() { this._started = true; this._pump && this._pump(); }
  ref() {} unref() {}
}

class ParentPort extends MessagePortBase {
  postMessage(v) { ops.op_worker_parent_post(encode(v)); }
  close() {}
  _pump() {
    if (this._pumping) return; this._pumping = true;
    (async () => { for (;;) { const m = await ops.op_worker_parent_recv(); if (m === null) break; this.emit("message", decode(m)); } })();
  }
}

export class Worker extends EventEmitter {
  constructor(filename, options = {}) {
    super();
    let path = filename instanceof URL ? ops.op_k_url_to_path(filename.href) : String(filename);
    if (path.startsWith("file:")) path = ops.op_k_url_to_path(path);
    if (options.eval) throw nodeError("ERR_METHOD_NOT_IMPLEMENTED", "Worker { eval: true } is not supported in kestrel yet");
    if (!path.startsWith("/")) path = globalThis.process.cwd() + "/" + path.replace(/^\.\//, "");
    this.threadId = ops.op_worker_spawn(path, encode(options.workerData === undefined ? null : options.workerData));
    this.resourceLimits = {}; this.performance = { eventLoopUtilization: () => ({}) };
    this.stdout = null; this.stderr = null; this.stdin = null;
    (async () => {
      try {
        for (;;) { const m = await ops.op_worker_recv(this.threadId); if (m === null) break; const v = decode(m); if (v && v.__k_worker_error) this.emit("error", v.__k_worker_error); else this.emit("message", v); }
        const code = await ops.op_worker_exit_code(this.threadId);
        this.emit("exit", code);
      } catch (e) { this.emit("error", e); }
    })();
    queueMicrotask(() => this.emit("online"));
  }
  postMessage(v) { ops.op_worker_post(this.threadId, encode(v)); }
  terminate() { ops.op_worker_terminate(this.threadId); return new Promise((res) => this.once("exit", res)); }
  ref() {} unref() {}
  getHeapSnapshot() { return Promise.reject(new Error("not supported")); }
  [Symbol.asyncDispose]() { return this.terminate(); }
}

export class MessageChannel { constructor() { const a = new MessagePort(), b = new MessagePort(); a._peer = b; b._peer = a; this.port1 = a; this.port2 = b; } }
export class MessagePort extends MessagePortBase { postMessage(m) { queueMicrotask(() => this._peer && this._peer.emit("message", decode(encode(m)))); } close() { this.emit("close"); } }
export class BroadcastChannel extends EventEmitter { constructor(name) { super(); this.name = name; } postMessage() {} close() {} }
export function markAsUntransferable() {}
export function isMarkedAsUntransferable() { return false; }
export function moveMessagePortToContext(p) { return p; }
export function receiveMessageOnPort() { return undefined; }
const envData = new Map();
export function getEnvironmentData(k) { return envData.get(k); }
export function setEnvironmentData(k, v) { envData.set(k, v); }

/// Called by the bootstrap right before the main module runs.
export function _refresh() {
  const info = ops.op_worker_info();
  isMainThread = info.is_main;
  threadId = info.thread_id;
  if (!info.is_main) {
    workerData = info.data === null || info.data === undefined ? null : decode(info.data);
    parentPort = new ParentPort();
    // Uncaught errors go to the parent's 'error' event and end this worker with code 1.
    globalThis.__kestrel_worker_error = (e) => { try { ops.op_worker_parent_post(encode({ __k_worker_error: e instanceof Error ? e : new Error(String(e)) })); } catch {} ops.op_worker_self_exit(1); };
  }
}

const mod = {
  get isMainThread() { return isMainThread; }, get threadId() { return threadId; }, get workerData() { return workerData; }, get parentPort() { return parentPort; },
  resourceLimits, SHARE_ENV, Worker, MessageChannel, MessagePort, BroadcastChannel, markAsUntransferable, isMarkedAsUntransferable, moveMessagePortToContext, receiveMessageOnPort, getEnvironmentData, setEnvironmentData,
};
export default mod;
