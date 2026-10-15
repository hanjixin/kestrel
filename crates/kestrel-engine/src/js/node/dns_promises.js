// node:dns/promises
import { ops, nodeError } from "ext:kestrel/internal.js";
export async function lookup(hostname, options = {}) {
  const family = typeof options === "number" ? options : options.family || 0;
  let addrs; try { addrs = await ops.op_dns_lookup(String(hostname)); } catch { addrs = []; }
  const list = addrs.filter(([a, f]) => !family || f === family);
  if (!list.length) { const e = nodeError("ENOTFOUND", "getaddrinfo ENOTFOUND " + hostname); e.hostname = hostname; e.syscall = "getaddrinfo"; throw e; }
  return options.all ? list.map(([address, family]) => ({ address, family })) : { address: list[0][0], family: list[0][1] };
}
export async function resolve4(h) { return (await lookup(h, { all: true, family: 4 })).map((x) => x.address); }
export async function resolve6(h) { return (await lookup(h, { all: true, family: 6 })).map((x) => x.address); }
export async function resolve(h, type = "A") { return type === "AAAA" ? resolve6(h) : resolve4(h); }
export class Resolver { resolve4 = resolve4; resolve6 = resolve6; resolve = resolve; setServers() {} getServers() { return []; } }
export default { lookup, resolve4, resolve6, resolve, Resolver };
