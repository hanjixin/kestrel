// node:tls — TLS client sockets (rustls); servers go through https / Kestrel.serve({ tls }).
import { ops, nodeError } from "ext:kestrel/internal.js";
import { Socket, _kRid } from "ext:kestrel/node/net.js";
export class TLSSocket extends Socket {
  constructor(socket, options = {}) { super(options); this.encrypted = true; this.authorized = true; this.authorizationError = null; this.servername = options.servername; }
  getPeerCertificate() { return {}; }
  getProtocol() { return "TLSv1.3"; }
  getCipher() { return { name: "TLS_AES_256_GCM_SHA384", version: "TLSv1.3" }; }
  getSession() { return undefined; }
  isSessionReused() { return false; }
}
export function connect(...args) {
  let options = {}, cb;
  if (typeof args[0] === "object" && args[0] !== null) { options = args[0]; cb = args[1]; }
  else { options.port = args[0]; if (typeof args[1] === "string") { options.host = args[1]; options = { ...options, ...(typeof args[2] === "object" ? args[2] : {}) }; cb = typeof args[2] === "function" ? args[2] : args[3]; } else { options = { ...options, ...(typeof args[1] === "object" ? args[1] : {}) }; cb = typeof args[1] === "function" ? args[1] : args[2]; } }
  const s = new TLSSocket(null, options);
  if (cb) s.once("secureConnect", cb);
  const host = options.host || "localhost", port = Number(options.port || 443);
  s.connecting = true;
  ops.op_tls_connect(host, port, options.servername || (/^[\d.]+$/.test(host) ? "" : host), options.rejectUnauthorized !== false).then((rid) => { s._attach(rid, true); s.remoteAddress = host; s.remotePort = port; s.emit("connect"); s.emit("secureConnect"); s.emit("ready"); }, (e) => { s.connecting = false; s.destroy(Object.assign(new Error(e.message), { code: /^([A-Z]+):/.exec(e.message)?.[1] || "ECONNREFUSED" })); });
  return s;
}
export const createSecureContext = (o) => ({ context: o });
export function createServer() { throw nodeError("ERR_METHOD_NOT_IMPLEMENTED", "tls.createServer is not supported; use https.createServer or Kestrel.serve({ tls })"); }
export const DEFAULT_MIN_VERSION = "TLSv1.2";
export const DEFAULT_MAX_VERSION = "TLSv1.3";
export const rootCertificates = [];
export const checkServerIdentity = () => undefined;
export default { TLSSocket, connect, createSecureContext, createServer, DEFAULT_MIN_VERSION, DEFAULT_MAX_VERSION, rootCertificates, checkServerIdentity };
