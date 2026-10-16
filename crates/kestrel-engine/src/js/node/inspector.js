// node:inspector — in-process Chrome DevTools Protocol sessions on this isolate's V8
// inspector (Runtime, Debugger, Profiler, HeapProfiler domains), and `open()`/`--inspect`
// for external debuggers (chrome://inspect, VS Code) over a WebSocket endpoint.
import { EventEmitter } from "ext:kestrel/node/events.js";
import { ops, nodeError } from "ext:kestrel/internal.js";

const kId = Symbol("inspector.session");
export class Session extends EventEmitter {
  constructor() { super(); this[kId] = null; this._next = 1; this._cbs = new Map(); }
  connect() {
    if (this[kId] !== null) throw nodeError("ERR_INSPECTOR_ALREADY_CONNECTED", "The inspector session is already connected");
    this[kId] = ops.op_inspector_connect();
    this._pump(this[kId]);
  }
  connectToMainThread() { this.connect(); }
  async _pump(id) {
    for (;;) {
      let msgs;
      try { msgs = await ops.op_inspector_recv(id); } catch { return; }
      if (this[kId] !== id || msgs.length === 0) return;
      for (const raw of msgs) this._onMessage(raw);
    }
  }
  _onMessage(raw) {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (m.id !== undefined) {
      const cb = this._cbs.get(m.id);
      this._cbs.delete(m.id);
      if (!cb) return;
      if (m.error) { const e = new Error(m.error.message); e.code = m.error.code; cb(e); }
      else cb(null, m.result ?? {});
    } else {
      this.emit("inspectorNotification", m);
      if (m.method) this.emit(m.method, m);
    }
  }
  post(method, params, callback) {
    if (typeof params === "function") { callback = params; params = undefined; }
    if (typeof method !== "string") throw nodeError("ERR_INVALID_ARG_TYPE", 'The "method" argument must be of type string', TypeError);
    if (params != null && typeof params !== "object") throw nodeError("ERR_INVALID_ARG_TYPE", 'The "params" argument must be of type object', TypeError);
    if (callback != null && typeof callback !== "function") throw nodeError("ERR_INVALID_ARG_TYPE", 'The "callback" argument must be of type function', TypeError);
    if (this[kId] === null) throw nodeError("ERR_INSPECTOR_NOT_CONNECTED", "Session is not connected");
    const id = this._next++;
    if (callback) this._cbs.set(id, callback);
    ops.op_inspector_post(this[kId], JSON.stringify(params == null ? { id, method } : { id, method, params }));
    // Responses to most commands are produced synchronously by V8; deliver them now so the
    // callback runs before the caller's next statement completes, as in Node.
    for (const raw of ops.op_inspector_take(this[kId])) this._onMessage(raw);
  }
  disconnect() {
    if (this[kId] === null) return;
    const id = this[kId];
    this[kId] = null;
    ops.op_inspector_disconnect(id);
    const pending = [...this._cbs.values()];
    this._cbs.clear();
    for (const cb of pending) cb(nodeError("ERR_INSPECTOR_CLOSED", "Session was closed"));
  }
}
export function open(port = 9229, host = "127.0.0.1", wait = false) {
  if (typeof port !== "number") throw nodeError("ERR_INVALID_ARG_TYPE", 'The "port" argument must be of type number', TypeError);
  if (ops.op_inspector_url()) throw nodeError("ERR_INSPECTOR_ALREADY_ACTIVATED", "Inspector is already activated. Close it with inspector.close() before activating it again.");
  ops.op_inspector_open(port | 0, host === undefined || host === null ? "127.0.0.1" : String(host));
  if (wait) waitForDebugger();
  return { [Symbol.dispose]() { close(); } };
}
export function close() { ops.op_inspector_close(); }
export function url() { return ops.op_inspector_url() ?? undefined; }
// Blocking until a client sends Runtime.runIfWaitingForDebugger is not supported from JS
// (the isolate thread must keep serving the session); `--inspect-brk` does it at startup.
export function waitForDebugger() { if (!ops.op_inspector_url()) throw nodeError("ERR_INSPECTOR_NOT_ACTIVE", "Inspector is not active"); }
export const console = globalThis.console;
export const Network = { requestWillBeSent() {}, responseReceived() {}, loadingFinished() {}, loadingFailed() {} };
export default { Session, open, close, url, waitForDebugger, console, Network };
