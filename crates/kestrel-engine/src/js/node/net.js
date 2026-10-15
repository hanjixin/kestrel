// node:net — helpers only; raw sockets are not available yet.
import { nodeError } from "ext:kestrel/internal.js";
import { EventEmitter } from "ext:kestrel/node/events.js";
export function isIP(s) { return isIPv4(s) ? 4 : isIPv6(s) ? 6 : 0; }
export function isIPv4(s) { return /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/.test(String(s)); }
export function isIPv6(s) { return /^[0-9a-fA-F:]+(%[\w.]+)?$/.test(String(s)) && String(s).includes(":") && String(s).split("::").length <= 2; }
export class Socket extends EventEmitter { constructor() { super(); throw nodeError("ERR_METHOD_NOT_IMPLEMENTED", "net.Socket is not implemented in kestrel yet"); } }
export class Server extends EventEmitter { constructor() { super(); throw nodeError("ERR_METHOD_NOT_IMPLEMENTED", "net.Server is not implemented in kestrel yet"); } }
export function createServer() { return new Server(); }
export function createConnection() { return new Socket(); }
export const connect = createConnection;
export class BlockList { addAddress() {} addRange() {} addSubnet() {} check() { return false; } }
export class SocketAddress { constructor(o = {}) { this.address = o.address ?? "127.0.0.1"; this.port = o.port ?? 0; this.family = o.family ?? "ipv4"; this.flowlabel = 0; } }
export default { isIP, isIPv4, isIPv6, Socket, Server, createServer, createConnection, connect, BlockList, SocketAddress };
