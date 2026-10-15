// node:net — TCP sockets and servers on native ops.
import { ops, nodeError } from "ext:kestrel/internal.js";
import { EventEmitter } from "ext:kestrel/node/events.js";
import { Duplex } from "ext:kestrel/node/stream.js";
import { Buffer } from "ext:kestrel/node/buffer.js";

export function isIPv4(s) { return /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/.test(String(s)); }
export function isIPv6(s) { s = String(s); return s.includes(":") && /^[0-9a-fA-F:.]+(%[\w.]+)?$/.test(s) && s.split("::").length <= 2; }
export function isIP(s) { return isIPv4(s) ? 4 : isIPv6(s) ? 6 : 0; }

const kRid = Symbol("net.rid");
const kTls = Symbol("net.tls");

function netError(e, syscall, host, port) {
  const m = /^([A-Z]+): (.*)/.exec(e.message || "");
  const err = new Error(m ? m[1] + ": " + m[2] : e.message);
  err.code = m ? m[1] : "EIO"; err.errno = -1; err.syscall = syscall; if (host) err.address = host; if (port) err.port = port;
  return err;
}

export class Socket extends Duplex {
  constructor(options = {}) {
    super({ allowHalfOpen: options.allowHalfOpen ?? false, read() {} });
    this[kRid] = null; this[kTls] = false;
    this.connecting = false; this.pending = true; this.destroyed = false; this.bytesRead = 0; this.bytesWritten = 0; this.timeout = 0; this._timer = null;
    this.remoteAddress = undefined; this.remotePort = undefined; this.remoteFamily = undefined; this.localAddress = undefined; this.localPort = undefined;
    if (options.fd !== undefined) throw nodeError("ERR_METHOD_NOT_IMPLEMENTED", "net.Socket from fd is not supported");
  }
  get readyState() { return this.connecting ? "opening" : this[kRid] !== null ? (this.writable ? "open" : "readOnly") : "closed"; }
  _attach(rid, tls = false) {
    this[kRid] = rid; this[kTls] = tls; this.pending = false; this.connecting = false;
    const a = tls ? null : ops.op_net_addr(rid);
    if (a) { this.localAddress = a[0]; this.localPort = a[1]; this.remoteAddress = a[2]; this.remotePort = a[3]; this.remoteFamily = isIPv6(a[2]) ? "IPv6" : "IPv4"; }
    this._readLoop();
    return this;
  }
  async _readLoop() {
    const rid = this[kRid];
    const read = this[kTls] ? () => ops.op_tls_read(rid) : () => ops.op_net_read(rid);
    try {
      for (;;) {
        if (this[kRid] !== rid) return;
        if (this.isPaused() && this._readableState.flowing === false) { await new Promise((r) => this.once("resume", r)); continue; }
        const chunk = await read();
        if (this[kRid] !== rid) return;
        this._touch();
        if (chunk.length === 0) { this.push(null); if (!this.allowHalfOpen) this.end(); return; }
        this.bytesRead += chunk.length;
        this.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
      }
    } catch (e) { if (this[kRid] === rid) this.destroy(netError(e, "read")); }
  }
  _write(chunk, enc, cb) {
    if (this[kRid] === null) { if (this.connecting) { this.once("connect", () => this._write(chunk, enc, cb)); return; } return cb(nodeError("ERR_SOCKET_CLOSED", "Socket is closed")); }
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, enc) : chunk;
    const w = this[kTls] ? ops.op_tls_write(this[kRid], bytes) : ops.op_net_write(this[kRid], bytes);
    w.then(() => { this.bytesWritten += bytes.length; this._touch(); cb(); }, (e) => cb(netError(e, "write")));
  }
  _final(cb) {
    if (this[kRid] === null) return cb();
    const s = this[kTls] ? ops.op_tls_shutdown(this[kRid]) : ops.op_net_shutdown(this[kRid]);
    s.then(() => cb(), () => cb());
  }
  _destroy(err, cb) {
    const rid = this[kRid]; this[kRid] = null;
    if (rid !== null) { if (this[kTls]) ops.op_tls_close(rid); else ops.op_net_close(rid); }
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    cb(err);
  }
  connect(...args) {
    let options = {}, cb;
    if (typeof args[0] === "object" && args[0] !== null) { options = args[0]; cb = args[1]; }
    else { options.port = args[0]; if (typeof args[1] === "string") { options.host = args[1]; cb = args[2]; } else cb = args[1]; }
    if (options.path) throw nodeError("ERR_METHOD_NOT_IMPLEMENTED", "Unix domain sockets are not supported in kestrel yet");
    const host = options.host || "localhost", port = Number(options.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw nodeError("ERR_SOCKET_BAD_PORT", 'Port should be >= 0 and < 65536. Received ' + options.port, RangeError);
    if (cb) this.once("connect", cb);
    this.connecting = true;
    ops.op_net_connect(host, port).then((rid) => { this._attach(rid); this.emit("connect"); this.emit("ready"); }, (e) => { this.connecting = false; this.destroy(netError(e, "connect", host, port)); });
    return this;
  }
  setTimeout(ms, cb) { this.timeout = ms; if (cb) this.once("timeout", cb); this._touch(); return this; }
  _touch() { if (this._timer) clearTimeout(this._timer); if (this.timeout > 0) { this._timer = setTimeout(() => this.emit("timeout"), this.timeout); if (this._timer.unref) this._timer.unref(); } }
  setNoDelay() { return this; }
  setKeepAlive() { return this; }
  address() { return { address: this.localAddress, family: this.localAddress && isIPv6(this.localAddress) ? "IPv6" : "IPv4", port: this.localPort }; }
  ref() { return this; } unref() { return this; }
  resetAndDestroy() { return this.destroy(); }
}

export function createConnection(...args) { const opts = typeof args[0] === "object" && args[0] !== null ? args[0] : {}; const s = new Socket(opts); return s.connect(...args); }
export const connect = createConnection;

export class Server extends EventEmitter {
  constructor(options, listener) {
    super();
    if (typeof options === "function") { listener = options; options = {}; }
    this._options = options || {}; this[kRid] = null; this.listening = false; this.maxConnections = undefined; this._connections = 0;
    if (listener) this.on("connection", listener);
  }
  listen(...args) {
    let port = 0, host = "0.0.0.0", cb;
    for (const a of args) { if (typeof a === "function") cb = a; else if (typeof a === "number" || (typeof a === "string" && /^\d+$/.test(a))) port = Number(a); else if (typeof a === "string") host = a; else if (a && typeof a === "object") { if (a.path) throw nodeError("ERR_METHOD_NOT_IMPLEMENTED", "Unix domain sockets are not supported"); port = a.port ?? port; host = a.host ?? host; } }
    if (cb) this.once("listening", cb);
    try { this[kRid] = ops.op_net_listen(host === "localhost" ? "127.0.0.1" : host, port); }
    catch (e) { queueMicrotask(() => this.emit("error", netError(e, "listen", host, port))); return this; }
    this.listening = true;
    queueMicrotask(() => this.emit("listening"));
    this._acceptLoop();
    return this;
  }
  async _acceptLoop() {
    const rid = this[kRid];
    try {
      for (;;) {
        const crid = await ops.op_net_accept(rid);
        if (crid === 0xffffffff || this[kRid] !== rid) return;
        const sock = new Socket({ allowHalfOpen: this._options.allowHalfOpen });
        sock._attach(crid);
        this._connections++;
        sock.once("close", () => { this._connections--; if (this._closing && this._connections === 0) this.emit("close"); });
        this.emit("connection", sock);
      }
    } catch (e) { if (this[kRid] === rid) this.emit("error", netError(e, "accept")); }
  }
  address() { if (this[kRid] === null) return null; const a = ops.op_net_listen_addr(this[kRid]); return a ? { address: a[0], family: isIPv6(a[0]) ? "IPv6" : "IPv4", port: a[1] } : null; }
  close(cb) {
    if (cb) this.once("close", cb);
    if (this[kRid] !== null) { ops.op_net_close_listener(this[kRid]); this[kRid] = null; }
    this.listening = false; this._closing = true;
    if (this._connections === 0) queueMicrotask(() => this.emit("close"));
    return this;
  }
  getConnections(cb) { queueMicrotask(() => cb(null, this._connections)); }
  ref() { return this; } unref() { return this; }
}
export function createServer(options, listener) { return new Server(options, listener); }

export class BlockList { addAddress() {} addRange() {} addSubnet() {} check() { return false; } }
export class SocketAddress { constructor(o = {}) { this.address = o.address ?? "127.0.0.1"; this.port = o.port ?? 0; this.family = o.family ?? "ipv4"; this.flowlabel = 0; } }
export const _kRid = kRid;
export default { isIP, isIPv4, isIPv6, Socket, Server, createServer, createConnection, connect, BlockList, SocketAddress };
