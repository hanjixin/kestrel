// node:dns — lookup via the system resolver (getaddrinfo).
import { ops, nodeError } from "ext:kestrel/internal.js";
export function lookup(hostname, options, cb) {
  if (typeof options === "function") { cb = options; options = {}; }
  const family = typeof options === "number" ? options : options && options.family || 0;
  ops.op_dns_lookup(String(hostname)).then((addrs) => {
    const list = addrs.filter(([a, f]) => !family || f === family);
    if (!list.length) { const e = nodeError("ENOTFOUND", "getaddrinfo ENOTFOUND " + hostname); e.hostname = hostname; e.syscall = "getaddrinfo"; return cb(e); }
    if (options && options.all) cb(null, list.map(([address, family]) => ({ address, family })));
    else cb(null, list[0][0], list[0][1]);
  }, (e) => { const err = nodeError("ENOTFOUND", "getaddrinfo ENOTFOUND " + hostname); err.hostname = hostname; err.syscall = "getaddrinfo"; cb(err); });
}
export function resolve4(h, cb) { lookup(h, { all: true, family: 4 }, (e, r) => cb(e, r && r.map((x) => x.address))); }
export function resolve6(h, cb) { lookup(h, { all: true, family: 6 }, (e, r) => cb(e, r && r.map((x) => x.address))); }
export function resolve(h, type, cb) { if (typeof type === "function") { cb = type; type = "A"; } return (type === "AAAA" ? resolve6 : resolve4)(h, cb); }
export function getServers() { return []; }
export function setServers() {}
export function setDefaultResultOrder() {}
export class Resolver { resolve4(...a) { return resolve4(...a); } resolve6(...a) { return resolve6(...a); } resolve(...a) { return resolve(...a); } setServers() {} getServers() { return []; } }
export const ADDRCONFIG = 1024, V4MAPPED = 2048, ALL = 256;
import * as promises from "ext:kestrel/node/dns_promises.js";
export { promises };
export default { lookup, resolve4, resolve6, resolve, getServers, setServers, setDefaultResultOrder, Resolver, ADDRCONFIG, V4MAPPED, ALL, promises };
