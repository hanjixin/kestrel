// node:https — client over the fetch backend; server not available (no TLS termination yet).
import http, { Agent as HttpAgent, ClientRequest } from "ext:kestrel/node/http.js";
import { nodeError } from "ext:kestrel/internal.js";

export class Agent extends HttpAgent {}
export const globalAgent = new Agent({ keepAlive: true });
export function request(input, options, cb) {
  if (typeof input === "string" || input instanceof URL) return new ClientRequest(input, options, cb);
  if (typeof input === "function") { cb = input; input = {}; }
  return new ClientRequest({ ...(input || {}), protocol: (input && input.protocol) || "https:", _https: true }, options, cb);
}
export function get(input, options, cb) { const r = request(input, options, cb); r.end(); return r; }
export function createServer() { throw nodeError("ERR_METHOD_NOT_IMPLEMENTED", "https.createServer is not implemented yet (terminate TLS in front of kestrel)"); }
export class Server {}
export default { Agent, globalAgent, request, get, createServer, Server, STATUS_CODES: http.STATUS_CODES, METHODS: http.METHODS };
