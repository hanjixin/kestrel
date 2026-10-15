// node:dgram — UDP sockets.
import { ops, nodeError } from "ext:kestrel/internal.js";
import { EventEmitter } from "ext:kestrel/node/events.js";
import { Buffer } from "ext:kestrel/node/buffer.js";
export class Socket extends EventEmitter {
  constructor(type, listener) {
    super();
    const opts = typeof type === "object" ? type : { type };
    this.type = opts.type || "udp4"; this._reuse = !!opts.reuseAddr; this._rid = null;
    if (listener) this.on("message", listener);
  }
  bind(...args) {
    let port = 0, address, cb;
    for (const a of args) { if (typeof a === "function") cb = a; else if (typeof a === "number") port = a; else if (typeof a === "string") address = a; else if (a && typeof a === "object") { port = a.port ?? 0; address = a.address; } }
    if (cb) this.once("listening", cb);
    try { this._rid = ops.op_udp_bind(address || (this.type === "udp6" ? "::" : "0.0.0.0"), port, this._reuse); }
    catch (e) { queueMicrotask(() => this.emit("error", Object.assign(new Error(e.message), { code: /^([A-Z]+):/.exec(e.message)?.[1] || "EADDRINUSE", syscall: "bind" }))); return this; }
    queueMicrotask(() => this.emit("listening"));
    this._recvLoop();
    return this;
  }
  async _recvLoop() {
    const rid = this._rid;
    try { for (;;) { const d = await ops.op_udp_recv(rid); if (d === null || this._rid !== rid) return; this.emit("message", Buffer.from(d.data), { address: d.address, family: d.family, port: d.port, size: d.data.byteLength }); } }
    catch (e) { if (this._rid === rid) this.emit("error", e); }
  }
  send(msg, ...rest) {
    let offset, length, port, address, cb;
    if (typeof rest[0] === "number" && typeof rest[1] === "number") { [offset, length, port, address, cb] = rest; }
    else { [port, address, cb] = rest; }
    if (typeof address === "function") { cb = address; address = undefined; }
    if (this._rid === null) this.bind(0);
    const list = Array.isArray(msg) ? msg : [msg];
    let buf = Buffer.concat(list.map((m) => (typeof m === "string" ? Buffer.from(m) : Buffer.from(m.buffer, m.byteOffset, m.byteLength))));
    if (offset !== undefined) buf = buf.subarray(offset, offset + length);
    ops.op_udp_send(this._rid, address || "127.0.0.1", port, buf).then((n) => cb && cb(null, n), (e) => { if (cb) cb(e); else this.emit("error", e); });
  }
  address() { const a = ops.op_udp_addr(this._rid); return a ? { address: a[0], family: a[0].includes(":") ? "IPv6" : "IPv4", port: a[1] } : {}; }
  close(cb) { if (this._rid !== null) { ops.op_udp_close(this._rid); this._rid = null; } if (cb) this.once("close", cb); queueMicrotask(() => this.emit("close")); return this; }
  setBroadcast(v) { ops.op_udp_multicast(this._rid, "broadcast", "", "", v ? 1 : 0); }
  setTTL(v) { ops.op_udp_multicast(this._rid, "ttl", "", "", v >>> 0); return v; }
  setMulticastTTL(v) { ops.op_udp_multicast(this._rid, "mttl", "", "", v >>> 0); return v; }
  setMulticastLoopback(v) { ops.op_udp_multicast(this._rid, "loop", "", "", v ? 1 : 0); return v; }
  setMulticastInterface() {}
  addMembership(group, iface) { if (this._rid === null) this.bind(0); ops.op_udp_multicast(this._rid, "join", String(group), iface ? String(iface) : "", 0); }
  dropMembership(group, iface) { ops.op_udp_multicast(this._rid, "leave", String(group), iface ? String(iface) : "", 0); }
  addSourceSpecificMembership() { throw nodeError("ERR_METHOD_NOT_IMPLEMENTED", "source-specific multicast is not supported"); }
  setRecvBufferSize() {} setSendBufferSize() {} getRecvBufferSize() { return 212992; } getSendBufferSize() { return 212992; }
  ref() { return this; } unref() { return this; }
  connect() { throw nodeError("ERR_METHOD_NOT_IMPLEMENTED", "dgram connect() is not implemented yet"); }
}
export function createSocket(type, listener) { return new Socket(type, listener); }
export default { Socket, createSocket };
