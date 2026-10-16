// node:http — server on Kestrel.serve, client on fetch. Bodies are buffered.
import { EventEmitter } from "ext:kestrel/node/events.js";
import { Readable, Writable } from "ext:kestrel/node/stream.js";
import { Buffer } from "ext:kestrel/node/buffer.js";
import { nodeError } from "ext:kestrel/internal.js";

export const METHODS = ["ACL", "BIND", "CHECKOUT", "CONNECT", "COPY", "DELETE", "GET", "HEAD", "LINK", "LOCK", "M-SEARCH", "MERGE", "MKACTIVITY", "MKCALENDAR", "MKCOL", "MOVE", "NOTIFY", "OPTIONS", "PATCH", "POST", "PROPFIND", "PROPPATCH", "PURGE", "PUT", "QUERY", "REBIND", "REPORT", "SEARCH", "SOURCE", "SUBSCRIBE", "TRACE", "UNBIND", "UNLINK", "UNLOCK", "UNSUBSCRIBE"];
export const STATUS_CODES = { 100: "Continue", 101: "Switching Protocols", 102: "Processing", 103: "Early Hints", 200: "OK", 201: "Created", 202: "Accepted", 203: "Non-Authoritative Information", 204: "No Content", 205: "Reset Content", 206: "Partial Content", 300: "Multiple Choices", 301: "Moved Permanently", 302: "Found", 303: "See Other", 304: "Not Modified", 307: "Temporary Redirect", 308: "Permanent Redirect", 400: "Bad Request", 401: "Unauthorized", 402: "Payment Required", 403: "Forbidden", 404: "Not Found", 405: "Method Not Allowed", 406: "Not Acceptable", 407: "Proxy Authentication Required", 408: "Request Timeout", 409: "Conflict", 410: "Gone", 411: "Length Required", 412: "Precondition Failed", 413: "Payload Too Large", 414: "URI Too Long", 415: "Unsupported Media Type", 416: "Range Not Satisfiable", 417: "Expectation Failed", 418: "I'm a Teapot", 422: "Unprocessable Entity", 425: "Too Early", 426: "Upgrade Required", 428: "Precondition Required", 429: "Too Many Requests", 431: "Request Header Fields Too Large", 451: "Unavailable For Legal Reasons", 500: "Internal Server Error", 501: "Not Implemented", 502: "Bad Gateway", 503: "Service Unavailable", 504: "Gateway Timeout", 505: "HTTP Version Not Supported" };

export class IncomingMessage extends Readable {
  constructor(opts) {
    super({});
    this.method = opts.method; this.url = opts.url; this.headers = opts.headers; this.rawHeaders = opts.rawHeaders || [];
    this.httpVersion = "1.1"; this.httpVersionMajor = 1; this.httpVersionMinor = 1; this.complete = false; this.aborted = false;
    this.statusCode = opts.statusCode; this.statusMessage = opts.statusMessage;
    // Node-like socket stub. `on-finished` (express's finalhandler) decides a request is
    // finished from `complete && !readable` on the message itself: a bodyless GET ends its
    // Readable (readable=false, complete=true) so finalhandler responds, while a POST stays
    // readable until its body is read so body parsers still read it.
    this.socket = opts.socket || { remoteAddress: "127.0.0.1", remotePort: 0, encrypted: false, readable: true, writable: true, setTimeout() {}, destroy() {}, on() {}, once() {}, removeListener() {}, end() {} };
    this.connection = this.socket;
    this.trailers = {}; this.rawTrailers = [];
    this._bodyFetch = null; this._bodyStarted = false;
    if (opts.body) { this.push(Buffer.from(opts.body)); this.push(null); this.complete = true; }
    else if (opts.bodyFetch) { this._bodyFetch = opts.bodyFetch; } // read lazily in _read
    else if (opts.bodyPromise) opts.bodyPromise.then((b) => { if (b && b.length) this.push(Buffer.from(b)); this.push(null); this.complete = true; }, (e) => this.destroy(e));
    else { this.push(null); this.complete = true; }
  }
  // Lazy body: fetch only when the consumer actually reads (Node semantics; also what
  // raw-body 3.x / body-parser 2.x expect). Never reading leaves the body op uncalled.
  _read() {
    if (this._bodyFetch && !this._bodyStarted) {
      this._bodyStarted = true;
      this._bodyFetch().then((b) => { if (b && b.length) this.push(Buffer.from(b)); this.push(null); this.complete = true; }, (e) => this.destroy(e));
    }
  }
  setTimeout(ms, cb) { if (cb) this.once("timeout", cb); return this; }
}

export class OutgoingMessage extends Writable {
  constructor() {
    super({ write: (c, e, cb) => { this._chunks.push(typeof c === "string" ? Buffer.from(c, e === "buffer" ? "utf8" : e) : c); cb(); }, final: (cb) => cb() });
    this._headers = new Map(); this._chunks = []; this.headersSent = false; this.finished = false; this.sendDate = true; this.chunkedEncoding = false; this.useChunkedEncodingByDefault = true;
  }
  setHeader(k, v) { if (this.headersSent) throw nodeError("ERR_HTTP_HEADERS_SENT", "Cannot set headers after they are sent to the client"); this._headers.set(String(k).toLowerCase(), v); return this; }
  setHeaders(h) { for (const [k, v] of h instanceof Map || h instanceof Headers ? h : Object.entries(h)) this.setHeader(k, v); return this; }
  appendHeader(k, v) { const cur = this._headers.get(String(k).toLowerCase()); this.setHeader(k, cur === undefined ? v : [].concat(cur, v)); return this; }
  getHeader(k) { return this._headers.get(String(k).toLowerCase()); }
  getHeaders() { return Object.fromEntries(this._headers); }
  getHeaderNames() { return [...this._headers.keys()]; }
  getRawHeaderNames() { return [...this._headers.keys()]; }
  hasHeader(k) { return this._headers.has(String(k).toLowerCase()); }
  removeHeader(k) { this._headers.delete(String(k).toLowerCase()); }
  flushHeaders() { this.headersSent = true; }
  setTimeout(ms, cb) { if (cb) this.once("timeout", cb); return this; }
  addTrailers() {}
  get writableEnded() { return super.writableEnded; }
}

export class ServerResponse extends OutgoingMessage {
  constructor(req, respond) {
    super();
    this.req = req; this.statusCode = 200; this.statusMessage = undefined; this._respond = respond;
    this.once("finish", () => this._send());
  }
  writeHead(status, reason, headers) {
    if (typeof reason === "object" && reason !== null) { headers = reason; reason = undefined; }
    this.statusCode = status; if (reason) this.statusMessage = reason;
    if (headers) { if (Array.isArray(headers)) { for (let i = 0; i + 1 < headers.length; i += 2) this.setHeader(headers[i], headers[i + 1]); } else for (const k of Object.keys(headers)) this.setHeader(k, headers[k]); }
    this.headersSent = true;
    return this;
  }
  writeContinue() {}
  writeEarlyHints() {}
  assignSocket() {} detachSocket() {}
  _send() {
    if (this.finished) return;
    this.finished = true; this.headersSent = true;
    const body = Buffer.concat(this._chunks);
    const parts = [];
    for (const [k, v] of this._headers) { if (Array.isArray(v)) for (const x of v) parts.push(k, String(x)); else parts.push(k, String(v)); }
    // Node sends no default content-type; "\0" tells the runtime "no headers at all".
    this._respond(this.statusCode, parts.length ? parts.join("\0") : "\0", body);
  }
}

export class Server extends EventEmitter {
  constructor(opts, handler) {
    super();
    if (typeof opts === "function") { handler = opts; opts = {}; }
    this.listening = false; this.timeout = 0; this.keepAliveTimeout = 5000; this.headersTimeout = 60000; this.requestTimeout = 300000; this.maxHeadersCount = null;
    if (handler) this.on("request", handler);
    if (opts && (opts.key || opts.cert)) this._tls = { key: opts.key, cert: opts.cert };
  }
  listen(...args) {
    let port = 0, host, cb;
    for (const a of args) { if (typeof a === "function") cb = a; else if (typeof a === "number" || (typeof a === "string" && /^\d+$/.test(a))) port = Number(a); else if (typeof a === "string") host = a; else if (a && typeof a === "object") { port = a.port ?? port; host = a.host ?? host; } }
    if (cb) this.once("listening", cb);
    const respondOps = Deno.core.ops;
    const self = this;
    try {
      const info = globalThis.Kestrel.serve({
        port, hostname: host || "0.0.0.0", workers: 1, silent: true, tls: this._tls,
        fetch(request) {
          return new Promise((resolve) => {
            const id = request[Symbol.for("kestrel.reqId")];
            const hdrs = {}; const raw = [];
            for (const [k, v] of request.headers) { hdrs[k] = v; raw.push(k, v); }
            const hasBody = request.method !== "GET" && request.method !== "HEAD";
            // Node's req.url is the request target (path + query); Request.url is absolute.
            const u = new URL(request.url);
            const req = new IncomingMessage({ method: request.method, url: u.pathname + u.search, headers: hdrs, rawHeaders: raw, bodyFetch: hasBody ? () => respondOps.op_kestrel_http_body(id) : null });
            const res = new ServerResponse(req, (status, headersFlat, body) => resolve(new globalThis.Response(body, { status, headers: { "x-kestrel-raw": "1" }, __raw: headersFlat })));
            self.emit("request", req, res);
          });
        },
      });
      this._port = info.port; this._host = info.hostname; this.listening = true;
      queueMicrotask(() => this.emit("listening"));
    } catch (e) { queueMicrotask(() => this.emit("error", e)); }
    return this;
  }
  address() { return this.listening ? { address: this._host, family: "IPv4", port: this._port } : null; }
  close(cb) { this.listening = false; if (cb) queueMicrotask(() => cb()); this.emit("close"); return this; }
  closeAllConnections() {} closeIdleConnections() {}
  setTimeout(ms, cb) { this.timeout = ms; if (cb) this.on("timeout", cb); return this; }
  ref() { return this; } unref() { return this; }
}

export function createServer(opts, handler) { return new Server(opts, handler); }

export class Agent extends EventEmitter { constructor(opts = {}) { super(); this.options = opts; this.keepAlive = !!opts.keepAlive; this.maxSockets = opts.maxSockets ?? Infinity; this.sockets = {}; this.requests = {}; this.freeSockets = {}; } destroy() {} }
export const globalAgent = new Agent({ keepAlive: true });

export class ClientRequest extends OutgoingMessage {
  constructor(input, options, cb) {
    super();
    if (typeof input === "string" || input instanceof URL) { const u = new URL(String(input)); options = { ...(typeof options === "object" && options !== null ? options : {}), protocol: u.protocol, hostname: u.hostname, port: u.port, path: u.pathname + u.search, auth: u.username ? u.username + ":" + u.password : undefined }; }
    else { cb = options; options = input || {}; }
    if (typeof options === "function") { cb = options; options = {}; }
    this.method = (options.method || "GET").toUpperCase();
    const proto = options.protocol || (options._https ? "https:" : "http:");
    const host = options.hostname || options.host || "localhost";
    const port = options.port ? ":" + options.port : (options.defaultPort && options.defaultPort !== (proto === "https:" ? 443 : 80) ? ":" + options.defaultPort : "");
    this.path = options.path || "/";
    this._url = proto + "//" + host + port + this.path;
    this.host = host; this.protocol = proto; this.aborted = false; this.reusedSocket = false;
    if (options.headers) for (const k of Object.keys(options.headers)) this.setHeader(k, options.headers[k]);
    if (options.auth) this.setHeader("authorization", "Basic " + Buffer.from(options.auth).toString("base64"));
    this._timeout = options.timeout;
    this.socket = { remoteAddress: host, setTimeout() {}, on() {}, once() {}, destroy() {}, setNoDelay() {}, setKeepAlive() {} };
    if (cb) this.once("response", cb);
    this.once("finish", () => this._send());
  }
  _send() {
    const headers = [];
    for (const [k, v] of this._headers) { if (Array.isArray(v)) for (const x of v) headers.push([k, String(x)]); else headers.push([k, String(v)]); }
    const body = Buffer.concat(this._chunks);
    const hasBody = body.length > 0 || !["GET", "HEAD"].includes(this.method);
    Deno.core.ops.op_kestrel_fetch(this._url, this.method, headers, body, hasBody, false).then((r) => {
      const hdrs = {}; const raw = [];
      for (const [k, v] of r.headers) { hdrs[k] = hdrs[k] === undefined ? v : (k === "set-cookie" ? [].concat(hdrs[k], v) : hdrs[k] + ", " + v); raw.push(k, v); }
      const res = new IncomingMessage({ statusCode: r.status, statusMessage: r.status_text, headers: hdrs, rawHeaders: raw, body: new Uint8Array(r.body), method: this.method, url: this.path });
      res.url = ""; res.req = this;
      this.emit("response", res);
    }, (e) => { const err = new Error(e.message); err.code = /ENOTFOUND|dns|resolve/i.test(e.message) ? "ENOTFOUND" : /refused/i.test(e.message) ? "ECONNREFUSED" : "ECONNRESET"; this.emit("error", err); });
  }
  abort() { this.aborted = true; this.destroy(); }
  setNoDelay() {} setSocketKeepAlive() {}
  setTimeout(ms, cb) { if (cb) this.once("timeout", cb); return this; }
}

export function request(input, options, cb) { return new ClientRequest(input, options, cb); }
export function get(input, options, cb) { const r = request(input, options, cb); r.end(); return r; }
export function validateHeaderName(n) { if (!/^[\^_`a-zA-Z\-0-9!#$%&'*+.|~]+$/.test(n)) throw nodeError("ERR_INVALID_HTTP_TOKEN", 'Header name must be a valid HTTP token ["' + n + '"]', TypeError); }
export function validateHeaderValue(n, v) { if (v === undefined) throw nodeError("ERR_HTTP_INVALID_HEADER_VALUE", 'Invalid value "undefined" for header "' + n + '"', TypeError); }
export function setMaxIdleHTTPParsers() {}
export const maxHeaderSize = 16384;

const http = { METHODS, STATUS_CODES, IncomingMessage, OutgoingMessage, ServerResponse, Server, createServer, Agent, globalAgent, ClientRequest, request, get, validateHeaderName, validateHeaderValue, setMaxIdleHTTPParsers, maxHeaderSize };
export default http;
