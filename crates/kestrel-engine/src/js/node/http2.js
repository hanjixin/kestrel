// node:http2 — HTTP/2 server (over the runtime's hyper h1/h2 acceptor: ALPN "h2" on TLS,
// prior knowledge on plain TCP) and client (reqwest). Exposes the stream API
// ('stream' events, `respond`) and the compatibility API ('request' events with
// Http2ServerRequest/Http2ServerResponse). One request = one stream; server push,
// settings negotiation and flow-control tuning are not exposed.
import { EventEmitter } from "ext:kestrel/node/events.js";
import { Duplex } from "ext:kestrel/node/stream.js";
import { Buffer } from "ext:kestrel/node/buffer.js";
import { IncomingMessage, ServerResponse, STATUS_CODES } from "ext:kestrel/node/http.js";
import { nodeError } from "ext:kestrel/internal.js";
import fs from "ext:kestrel/node/fs.js";

const ops = Deno.core.ops;
export const sensitiveHeaders = Symbol.for("nodejs.http2.sensitiveHeaders");

const HTTP_STATUS = {};
for (const [code, text] of Object.entries(STATUS_CODES)) HTTP_STATUS["HTTP_STATUS_" + text.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/_$/, "")] = Number(code);
export const constants = Object.freeze({
  NGHTTP2_SESSION_SERVER: 0, NGHTTP2_SESSION_CLIENT: 1,
  NGHTTP2_STREAM_STATE_IDLE: 1, NGHTTP2_STREAM_STATE_OPEN: 2, NGHTTP2_STREAM_STATE_RESERVED_LOCAL: 3, NGHTTP2_STREAM_STATE_RESERVED_REMOTE: 4, NGHTTP2_STREAM_STATE_HALF_CLOSED_LOCAL: 5, NGHTTP2_STREAM_STATE_HALF_CLOSED_REMOTE: 6, NGHTTP2_STREAM_STATE_CLOSED: 7,
  NGHTTP2_NO_ERROR: 0, NGHTTP2_PROTOCOL_ERROR: 1, NGHTTP2_INTERNAL_ERROR: 2, NGHTTP2_FLOW_CONTROL_ERROR: 3, NGHTTP2_SETTINGS_TIMEOUT: 4, NGHTTP2_STREAM_CLOSED: 5, NGHTTP2_FRAME_SIZE_ERROR: 6, NGHTTP2_REFUSED_STREAM: 7, NGHTTP2_CANCEL: 8, NGHTTP2_COMPRESSION_ERROR: 9, NGHTTP2_CONNECT_ERROR: 10, NGHTTP2_ENHANCE_YOUR_CALM: 11, NGHTTP2_INADEQUATE_SECURITY: 12, NGHTTP2_HTTP_1_1_REQUIRED: 13,
  NGHTTP2_DEFAULT_WEIGHT: 16, NGHTTP2_SETTINGS_HEADER_TABLE_SIZE: 1, NGHTTP2_SETTINGS_ENABLE_PUSH: 2, NGHTTP2_SETTINGS_MAX_CONCURRENT_STREAMS: 3, NGHTTP2_SETTINGS_INITIAL_WINDOW_SIZE: 4, NGHTTP2_SETTINGS_MAX_FRAME_SIZE: 5, NGHTTP2_SETTINGS_MAX_HEADER_LIST_SIZE: 6, NGHTTP2_SETTINGS_ENABLE_CONNECT_PROTOCOL: 8,
  DEFAULT_SETTINGS_HEADER_TABLE_SIZE: 4096, DEFAULT_SETTINGS_ENABLE_PUSH: 1, DEFAULT_SETTINGS_MAX_CONCURRENT_STREAMS: 4294967295, DEFAULT_SETTINGS_INITIAL_WINDOW_SIZE: 65535, DEFAULT_SETTINGS_MAX_FRAME_SIZE: 16384, DEFAULT_SETTINGS_MAX_HEADER_LIST_SIZE: 65535, DEFAULT_SETTINGS_ENABLE_CONNECT_PROTOCOL: 0,
  MAX_MAX_FRAME_SIZE: 16777215, MIN_MAX_FRAME_SIZE: 16384, MAX_INITIAL_WINDOW_SIZE: 2147483647,
  NGHTTP2_ERR_FRAME_SIZE_ERROR: -522,
  HTTP2_HEADER_STATUS: ":status", HTTP2_HEADER_METHOD: ":method", HTTP2_HEADER_AUTHORITY: ":authority", HTTP2_HEADER_SCHEME: ":scheme", HTTP2_HEADER_PATH: ":path", HTTP2_HEADER_PROTOCOL: ":protocol",
  HTTP2_HEADER_ACCEPT: "accept", HTTP2_HEADER_ACCEPT_CHARSET: "accept-charset", HTTP2_HEADER_ACCEPT_ENCODING: "accept-encoding", HTTP2_HEADER_ACCEPT_LANGUAGE: "accept-language", HTTP2_HEADER_ACCEPT_RANGES: "accept-ranges", HTTP2_HEADER_ACCESS_CONTROL_ALLOW_CREDENTIALS: "access-control-allow-credentials", HTTP2_HEADER_ACCESS_CONTROL_ALLOW_HEADERS: "access-control-allow-headers", HTTP2_HEADER_ACCESS_CONTROL_ALLOW_METHODS: "access-control-allow-methods", HTTP2_HEADER_ACCESS_CONTROL_ALLOW_ORIGIN: "access-control-allow-origin", HTTP2_HEADER_ACCESS_CONTROL_EXPOSE_HEADERS: "access-control-expose-headers", HTTP2_HEADER_ACCESS_CONTROL_MAX_AGE: "access-control-max-age", HTTP2_HEADER_ACCESS_CONTROL_REQUEST_HEADERS: "access-control-request-headers", HTTP2_HEADER_ACCESS_CONTROL_REQUEST_METHOD: "access-control-request-method", HTTP2_HEADER_AGE: "age", HTTP2_HEADER_ALLOW: "allow", HTTP2_HEADER_AUTHORIZATION: "authorization", HTTP2_HEADER_CACHE_CONTROL: "cache-control", HTTP2_HEADER_CONNECTION: "connection", HTTP2_HEADER_CONTENT_DISPOSITION: "content-disposition", HTTP2_HEADER_CONTENT_ENCODING: "content-encoding", HTTP2_HEADER_CONTENT_LANGUAGE: "content-language", HTTP2_HEADER_CONTENT_LENGTH: "content-length", HTTP2_HEADER_CONTENT_LOCATION: "content-location", HTTP2_HEADER_CONTENT_MD5: "content-md5", HTTP2_HEADER_CONTENT_RANGE: "content-range", HTTP2_HEADER_CONTENT_TYPE: "content-type", HTTP2_HEADER_COOKIE: "cookie", HTTP2_HEADER_DATE: "date", HTTP2_HEADER_ETAG: "etag", HTTP2_HEADER_EXPECT: "expect", HTTP2_HEADER_EXPIRES: "expires", HTTP2_HEADER_FORWARDED: "forwarded", HTTP2_HEADER_FROM: "from", HTTP2_HEADER_HOST: "host", HTTP2_HEADER_IF_MATCH: "if-match", HTTP2_HEADER_IF_MODIFIED_SINCE: "if-modified-since", HTTP2_HEADER_IF_NONE_MATCH: "if-none-match", HTTP2_HEADER_IF_RANGE: "if-range", HTTP2_HEADER_IF_UNMODIFIED_SINCE: "if-unmodified-since", HTTP2_HEADER_LAST_MODIFIED: "last-modified", HTTP2_HEADER_LINK: "link", HTTP2_HEADER_LOCATION: "location", HTTP2_HEADER_MAX_FORWARDS: "max-forwards", HTTP2_HEADER_PREFER: "prefer", HTTP2_HEADER_PROXY_AUTHENTICATE: "proxy-authenticate", HTTP2_HEADER_PROXY_AUTHORIZATION: "proxy-authorization", HTTP2_HEADER_RANGE: "range", HTTP2_HEADER_REFERER: "referer", HTTP2_HEADER_REFRESH: "refresh", HTTP2_HEADER_RETRY_AFTER: "retry-after", HTTP2_HEADER_SERVER: "server", HTTP2_HEADER_SET_COOKIE: "set-cookie", HTTP2_HEADER_STRICT_TRANSPORT_SECURITY: "strict-transport-security", HTTP2_HEADER_TRANSFER_ENCODING: "transfer-encoding", HTTP2_HEADER_TE: "te", HTTP2_HEADER_UPGRADE: "upgrade", HTTP2_HEADER_USER_AGENT: "user-agent", HTTP2_HEADER_VARY: "vary", HTTP2_HEADER_VIA: "via", HTTP2_HEADER_WWW_AUTHENTICATE: "www-authenticate", HTTP2_HEADER_HTTP2_SETTINGS: "http2-settings", HTTP2_HEADER_KEEP_ALIVE: "keep-alive", HTTP2_HEADER_PROXY_CONNECTION: "proxy-connection", HTTP2_HEADER_X_XSS_PROTECTION: "x-xss-protection", HTTP2_HEADER_X_FRAME_OPTIONS: "x-frame-options", HTTP2_HEADER_X_CONTENT_TYPE_OPTIONS: "x-content-type-options",
  HTTP2_METHOD_ACL: "ACL", HTTP2_METHOD_CONNECT: "CONNECT", HTTP2_METHOD_DELETE: "DELETE", HTTP2_METHOD_GET: "GET", HTTP2_METHOD_HEAD: "HEAD", HTTP2_METHOD_OPTIONS: "OPTIONS", HTTP2_METHOD_PATCH: "PATCH", HTTP2_METHOD_POST: "POST", HTTP2_METHOD_PUT: "PUT", HTTP2_METHOD_TRACE: "TRACE",
  ...HTTP_STATUS,
});

const DEFAULTS = { headerTableSize: 4096, enablePush: true, initialWindowSize: 65535, maxFrameSize: 16384, maxConcurrentStreams: 4294967295, maxHeaderListSize: 65535, maxHeaderSize: 65535, enableConnectProtocol: false };
export function getDefaultSettings() { return { ...DEFAULTS }; }
const SETTING_IDS = [["headerTableSize", 1], ["enablePush", 2], ["maxConcurrentStreams", 3], ["initialWindowSize", 4], ["maxFrameSize", 5], ["maxHeaderListSize", 6], ["enableConnectProtocol", 8]];
export function getPackedSettings(settings = {}) {
  const parts = [];
  for (const [name, id] of SETTING_IDS) {
    if (settings[name] === undefined) continue;
    const b = Buffer.alloc(6); b.writeUInt16BE(id, 0); b.writeUInt32BE(typeof settings[name] === "boolean" ? (settings[name] ? 1 : 0) : settings[name] >>> 0, 2); parts.push(b);
  }
  return Buffer.concat(parts);
}
export function getUnpackedSettings(buf) {
  if (!(buf instanceof Uint8Array)) throw nodeError("ERR_INVALID_ARG_TYPE", 'The "buf" argument must be an instance of Buffer, TypedArray, or DataView', TypeError);
  if (buf.length % 6 !== 0) throw nodeError("ERR_HTTP2_INVALID_PACKED_SETTINGS_LENGTH", "Packed settings length must be a multiple of six", RangeError);
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength); const out = {};
  for (let i = 0; i < b.length; i += 6) { const id = b.readUInt16BE(i), v = b.readUInt32BE(i + 2); const e = SETTING_IDS.find((x) => x[1] === id); if (e) out[e[0]] = e[0] === "enablePush" || e[0] === "enableConnectProtocol" ? v === 1 : v; }
  return out;
}
export function performServerHandshake() { throw nodeError("ERR_METHOD_NOT_IMPLEMENTED", "http2.performServerHandshake is not supported"); }

const PAYLOAD_MEANINGLESS = new Set(["GET", "HEAD", "DELETE", "OPTIONS", "TRACE", "CONNECT"]);
function assertValidHeaders(headers) {
  for (const k of Object.keys(headers)) {
    if (k === "connection" || k === "upgrade" || k === "http2-settings" || k === "keep-alive" || k === "proxy-connection" || k === "transfer-encoding") throw nodeError("ERR_HTTP2_INVALID_CONNECTION_HEADERS", "HTTP/1 Connection specific headers are forbidden: \"" + k + "\"", TypeError);
  }
}

// ---------- sessions ----------
class Http2Session extends EventEmitter {
  constructor(type, opts = {}) {
    super();
    this.type = type; this.closed = false; this.destroyed = false; this.connecting = false; this.pendingSettingsAck = false;
    this.alpnProtocol = "h2"; this.encrypted = !!opts.encrypted; this.originSet = undefined;
    this.localSettings = { ...DEFAULTS }; this.remoteSettings = { ...DEFAULTS }; this.state = { effectiveLocalWindowSize: 65535, effectiveRecvDataLength: 0, nextStreamID: type === 1 ? 1 : 2, localWindowSize: 65535, lastProcStreamID: 0, remoteWindowSize: 65535, outboundQueueSize: 0, deflateDynamicTableSize: 0, inflateDynamicTableSize: 0 };
    this.socket = { remoteAddress: opts.remoteAddress ?? "127.0.0.1", remotePort: opts.remotePort ?? 0, localAddress: opts.localAddress ?? "127.0.0.1", localPort: opts.localPort ?? 0, encrypted: this.encrypted, alpnProtocol: "h2", destroyed: false, setTimeout() {}, setNoDelay() {}, setKeepAlive() {}, ref() {}, unref() {}, on() {}, once() {}, destroy: () => this.destroy(), end: () => this.close() };
    this._streams = new Set();
  }
  settings(settings = {}, cb) { Object.assign(this.localSettings, settings); if (cb) queueMicrotask(() => cb(null, this.localSettings, 0)); }
  ping(payload, cb) { if (typeof payload === "function") { cb = payload; payload = undefined; } if (!cb) throw nodeError("ERR_INVALID_ARG_TYPE", 'The "callback" argument must be of type function', TypeError); const p = payload ? Buffer.from(payload) : Buffer.alloc(8); queueMicrotask(() => cb(null, 0, p)); return true; }
  goaway() {}
  setTimeout(ms, cb) { if (cb) this.once("timeout", cb); return this; }
  setLocalWindowSize() {}
  ref() { return this; } unref() { return this; }
  close(cb) {
    if (this.closed) { if (cb) queueMicrotask(cb); return; }
    this.closed = true;
    if (cb) this.once("close", cb);
    const finish = () => { if (!this.destroyed) { this.destroyed = true; this.socket.destroyed = true; this.emit("close"); } };
    if (this._streams.size === 0) queueMicrotask(finish); else this._onIdle = finish;
  }
  destroy(error, code) {
    if (this.destroyed) return;
    this.destroyed = true; this.closed = true; this.socket.destroyed = true;
    for (const s of [...this._streams]) s.destroy(error);
    if (error) queueMicrotask(() => this.emit("error", error));
    queueMicrotask(() => this.emit("close"));
  }
  _track(stream) { this._streams.add(stream); stream.once("close", () => { this._streams.delete(stream); if (this._streams.size === 0 && this._onIdle) { const f = this._onIdle; this._onIdle = null; f(); } }); }
}
class ServerHttp2Session extends Http2Session { constructor(opts) { super(0, opts); } altsvc() {} origin() {} }
export class ClientHttp2Session extends Http2Session {
  constructor(authority, options = {}) {
    super(1, { encrypted: authority.protocol === "https:" });
    this._authority = authority; this._options = options; this.connecting = true;
    queueMicrotask(() => { this.connecting = false; this.emit("connect", this, this.socket); });
  }
  request(headers = {}, options = {}) {
    if (this.destroyed) throw nodeError("ERR_HTTP2_INVALID_SESSION", "The session has been destroyed");
    if (this.closed) throw nodeError("ERR_HTTP2_GOAWAY_SESSION", "New streams cannot be created after receiving a GOAWAY");
    headers = { ...headers }; delete headers[sensitiveHeaders];
    assertValidHeaders(headers);
    const method = String(headers[":method"] ?? "GET").toUpperCase();
    if (headers[":status"] !== undefined) throw nodeError("ERR_HTTP2_INVALID_PSEUDOHEADER", '":status" is an invalid pseudoheader or is used incorrectly', TypeError);
    const stream = new ClientHttp2Stream(this, { ...headers, ":method": method }, options);
    this._track(stream);
    if (options.endStream === undefined ? PAYLOAD_MEANINGLESS.has(method) : options.endStream) stream.end();
    return stream;
  }
}

// ---------- streams ----------
let nextStreamId = 1;
class Http2Stream extends Duplex {
  constructor(session) {
    super({ allowHalfOpen: true });
    this.session = session; this.id = nextStreamId; nextStreamId += 2; this.rstCode = 0; this.aborted = false; this._h2closed = false; this.pending = false; this.sentHeaders = undefined; this.sentInfoHeaders = []; this.sentTrailers = undefined; this.endAfterHeaders = false;
    this._chunks = [];
    this.state = { localWindowSize: 65535, state: 2, localClose: 0, remoteClose: 0, sumDependencyWeight: 0, weight: 16 };
  }
  get bufferSize() { return 0; }
  // Node's Http2Stream exposes `closed` as a plain property; our Readable has a getter.
  get closed() { return this._h2closed; }
  set closed(v) { this._h2closed = v; }
  _read() {}
  _write(chunk, enc, cb) { this._chunks.push(typeof chunk === "string" ? Buffer.from(chunk, enc === "buffer" ? "utf8" : enc) : Buffer.from(chunk)); cb(); }
  setTimeout(ms, cb) { if (cb) this.once("timeout", cb); return this; }
  priority() {} sendTrailers() {}
  close(code = 0, cb) { if (this.closed) return; this.closed = true; this.rstCode = code; if (cb) this.once("close", cb); this._finishClose(); }
  _finishClose() { this.destroy(); }
  _destroy(err, cb) { if (!this.closed) { this.closed = true; } cb(err); queueMicrotask(() => { if (!this._closeEmitted) { this._closeEmitted = true; } }); }
}
export class ServerHttp2Stream extends Http2Stream {
  constructor(session, headers, bodyPromise, resolveResponse) {
    super(session);
    this.headersSent = false; this.pushAllowed = false; this._resolve = resolveResponse; this._status = 200; this._headers = {};
    this._reqHeaders = headers;
    bodyPromise.then((b) => { if (b && b.length) this.push(Buffer.from(b)); this.push(null); }, (e) => this.destroy(e));
    this.once("finish", () => this._send());
  }
  get headersSent() { return this._headersSent; } set headersSent(v) { this._headersSent = v; }
  respond(headers = {}, options = {}) {
    if (this.destroyed || this.closed) throw nodeError("ERR_HTTP2_INVALID_STREAM", "The stream has been destroyed");
    if (this._headersSent) throw nodeError("ERR_HTTP2_HEADERS_SENT", "Response has already been initiated.");
    headers = { ...headers }; delete headers[sensitiveHeaders];
    assertValidHeaders(headers);
    const st = headers[":status"] !== undefined ? Number(headers[":status"]) : 200;
    if (!Number.isInteger(st) || st < 100 || st > 599) throw nodeError("ERR_HTTP2_STATUS_INVALID", "Invalid status code: " + headers[":status"], RangeError);
    for (const k of Object.keys(headers)) { if (k.startsWith(":") && k !== ":status") throw nodeError("ERR_HTTP2_INVALID_PSEUDOHEADER", '"' + k + '" is an invalid pseudoheader or is used incorrectly', TypeError); }
    this._status = st; delete headers[":status"]; this._headers = headers; this._headersSent = true; this.sentHeaders = { ":status": st, ...headers };
    if (options.endStream) this.end();
    return this;
  }
  respondWithFile(path, headers = {}, options = {}) {
    let data;
    try { data = fs.readFileSync(path); } catch (e) { if (options.onError) return options.onError(e); throw e; }
    this.respond({ ...headers, "content-length": String(data.length) });
    this.end(data);
  }
  respondWithFD(fd, headers = {}, options = {}) {
    const data = fs.readFileSync(fd);
    this.respond({ ...headers, "content-length": String(data.length) });
    this.end(data);
  }
  additionalHeaders(headers) { this.sentInfoHeaders.push(headers); }
  pushStream(headers, options, cb) { if (typeof options === "function") cb = options; const e = nodeError("ERR_HTTP2_PUSH_DISABLED", "HTTP/2 client has disabled push streams"); if (cb) queueMicrotask(() => cb(e)); else throw e; }
  _send() {
    if (this._sent) return;
    this._sent = true;
    if (!this._headersSent) this._headersSent = true;
    const flat = [];
    for (const [k, v] of Object.entries(this._headers)) { if (v === undefined) continue; if (Array.isArray(v)) for (const x of v) flat.push(k, String(x)); else flat.push(k, String(v)); }
    // "\0" = explicitly no headers (an empty string would get the runtime's default content-type).
    this._resolve(this._status, flat.length ? flat.join("\0") : "\0", Buffer.concat(this._chunks));
    this.closed = true;
    queueMicrotask(() => this.emit("close"));
  }
  _finishClose() { if (!this._sent) { this._sent = true; this._resolve(this.rstCode === 0 ? this._status : 500, "", Buffer.alloc(0)); } this.destroy(); queueMicrotask(() => this.emit("close")); }
}
export class ClientHttp2Stream extends Http2Stream {
  constructor(session, headers, options) {
    super(session);
    this._reqHeaders = headers; this._options = options;
    this.once("finish", () => this._send());
  }
  _send() {
    const h = this._reqHeaders; const s = this.session; const a = s._authority;
    const authority = h[":authority"] || a.host;
    const url = (h[":scheme"] || a.protocol.replace(":", "")) + "://" + authority + (h[":path"] || "/");
    const headers = [];
    for (const [k, v] of Object.entries(h)) { if (k.startsWith(":") || v === undefined) continue; if (Array.isArray(v)) for (const x of v) headers.push([k, String(x)]); else headers.push([k, String(v)]); }
    const body = Buffer.concat(this._chunks);
    const insecure = s._options.rejectUnauthorized === false;
    const op = a.protocol === "https:" ? ops.op_kestrel_fetch(url, h[":method"], headers, body, body.length > 0 || !PAYLOAD_MEANINGLESS.has(h[":method"]), false) : ops.op_kestrel_fetch_h2(url, h[":method"], headers, body, body.length > 0 || !PAYLOAD_MEANINGLESS.has(h[":method"]), insecure);
    op.then((r) => {
      if (this.destroyed) return;
      const hdrs = { ":status": r.status };
      for (const [k, v] of r.headers) hdrs[k] = hdrs[k] === undefined ? v : k === "set-cookie" ? [].concat(hdrs[k], v) : hdrs[k] + ", " + v;
      this.emit("response", hdrs, 0);
      const data = Buffer.from(r.body);
      if (data.length) this.push(data);
      this.push(null);
      this.closed = true;
      this.once("end", () => queueMicrotask(() => this.emit("close")));
    }, (e) => {
      const err = new Error(e.message); err.code = /refused/i.test(e.message) ? "ECONNREFUSED" : /ENOTFOUND|dns|resolve/i.test(e.message) ? "ENOTFOUND" : "ERR_HTTP2_STREAM_ERROR";
      this.destroy(err);
      queueMicrotask(() => this.emit("close"));
    });
  }
  _finishClose() { this.destroy(); queueMicrotask(() => this.emit("close")); }
}

// ---------- compatibility API ----------
export class Http2ServerRequest extends IncomingMessage {
  constructor(stream, headers, bodyPromise, session) {
    const raw = []; for (const [k, v] of Object.entries(headers)) raw.push(k, String(v));
    super({ method: headers[":method"], url: headers[":path"], headers, rawHeaders: raw, bodyPromise, socket: session.socket });
    this.stream = stream; this.httpVersion = "2.0"; this.httpVersionMajor = 2; this.httpVersionMinor = 0;
    this.authority = headers[":authority"]; this.scheme = headers[":scheme"];
    stream.once("close", () => this.emit("close"));
  }
  get aborted() { return this.stream.aborted; }
  set aborted(_) {}
  setTimeout(ms, cb) { this.stream.setTimeout(ms, cb); return this; }
}
export class Http2ServerResponse extends ServerResponse {
  constructor(stream, req) {
    super(req, (status, flat, body) => { if (!stream._headersSent) { const h = {}; const parts = flat ? flat.split("\0") : []; for (let i = 0; i + 1 < parts.length; i += 2) { if (h[parts[i]] === undefined) h[parts[i]] = parts[i + 1]; else h[parts[i]] = [].concat(h[parts[i]], parts[i + 1]); } stream.respond({ ":status": status, ...h }); } stream.end(body); });
    this.stream = stream; this.sendDate = true;
    stream.once("close", () => this.emit("close"));
  }
  get socket() { return this.stream.session.socket; }
  get connection() { return this.socket; }
  createPushResponse(headers, cb) { queueMicrotask(() => cb(nodeError("ERR_HTTP2_PUSH_DISABLED", "HTTP/2 client has disabled push streams"))); }
  writeContinue() {}
}

// ---------- servers ----------
class Http2ServerBase extends EventEmitter {
  constructor(opts = {}, handler, secure) {
    super();
    this._opts = opts; this._secure = secure; this.listening = false; this.timeout = 0;
    if (handler) this.on("request", handler);
    this.on("newListener", (ev) => { if (ev === "request" && !this._checked) this._checked = true; });
  }
  listen(...args) {
    let port = 0, host, cb;
    for (const a of args) { if (typeof a === "function") cb = a; else if (typeof a === "number" || (typeof a === "string" && /^\d+$/.test(a))) port = Number(a); else if (typeof a === "string") host = a; else if (a && typeof a === "object") { port = a.port ?? port; host = a.host ?? host; } }
    if (cb) this.once("listening", cb);
    const self = this;
    const session = new ServerHttp2Session({ encrypted: this._secure });
    this._session = session;
    const tls = this._secure ? { key: this._opts.key, cert: this._opts.cert, alpn: this._opts.allowHTTP1 ? ["h2", "http/1.1"] : ["h2"] } : undefined;
    try {
      const info = globalThis.Kestrel.serve({
        port, hostname: host || "0.0.0.0", workers: 1, silent: true, tls,
        fetch(request) {
          return new Promise((resolve) => {
            const id = request[Symbol.for("kestrel.reqId")];
            const u = new URL(request.url, "http://" + (request.headers.get("host") || "localhost"));
            const version = ops.op_kestrel_http_version(id);
            const headers = {};
            if (version === 2) { headers[":method"] = request.method; headers[":path"] = u.pathname + u.search; headers[":scheme"] = u.protocol.replace(":", ""); headers[":authority"] = u.host; }
            for (const [k, v] of request.headers) { if (version === 2 && k === "host") continue; headers[k] = headers[k] === undefined ? v : k === "set-cookie" ? [].concat(headers[k], v) : headers[k] + ", " + v; }
            const hasBody = request.method !== "GET" && request.method !== "HEAD";
            const bodyPromise = hasBody ? ops.op_kestrel_http_body(id) : Promise.resolve(null);
            const respond = (status, flat, body) => resolve(new globalThis.Response(body, { status, headers: { "x-kestrel-raw": "1" }, __raw: flat }));
            if (version !== 2) {
              // HTTP/1.x on an allowHTTP1 server: compatibility API only, like Node.
              const req = new IncomingMessage({ method: request.method, url: u.pathname + u.search, headers, rawHeaders: Object.entries(headers).flat(), bodyPromise: hasBody ? bodyPromise : null, socket: session.socket });
              const res = new ServerResponse(req, respond);
              self.emit("request", req, res);
              return;
            }
            if (!self._sessionEmitted) { self._sessionEmitted = true; self.emit("session", session); }
            const stream = new ServerHttp2Stream(session, headers, bodyPromise, respond);
            session._track(stream);
            self.emit("stream", stream, headers, 0, Object.entries(headers).flat());
            if (self.listenerCount("request") > 0) {
              const req = new Http2ServerRequest(stream, headers, bodyPromise, session);
              const res = new Http2ServerResponse(stream, req);
              self.emit("request", req, res);
            }
          });
        },
      });
      this._port = info.port; this._host = info.hostname; this.listening = true;
      queueMicrotask(() => this.emit("listening"));
    } catch (e) { queueMicrotask(() => this.emit("error", e)); }
    return this;
  }
  address() { return this.listening ? { address: this._host, family: "IPv4", port: this._port } : null; }
  close(cb) { this.listening = false; if (cb) this.once("close", cb); if (this._session) this._session.close(); queueMicrotask(() => this.emit("close")); return this; }
  closeAllConnections() {} closeIdleConnections() {}
  setTimeout(ms, cb) { this.timeout = ms; if (cb) this.on("timeout", cb); return this; }
  updateSettings(settings) { Object.assign(DEFAULTS, {}); this._settings = settings; }
  ref() { return this; } unref() { return this; }
}
export class Http2Server extends Http2ServerBase { constructor(opts, handler) { super(opts, handler, false); } }
export class Http2SecureServer extends Http2ServerBase {
  constructor(opts, handler) { super(opts, handler, true); }
  setSecureContext() {}
  addContext() {}
}
export function createServer(opts, handler) { if (typeof opts === "function") { handler = opts; opts = {}; } return new Http2Server(opts || {}, handler); }
export function createSecureServer(opts, handler) { if (typeof opts === "function") { handler = opts; opts = {}; } if (!opts || (!opts.key && !opts.pfx)) throw nodeError("ERR_MISSING_ARGS", 'The "options.key" or "options.pfx" argument must be specified', TypeError); return new Http2SecureServer(opts, handler); }
export function connect(authority, options, listener) {
  if (typeof options === "function") { listener = options; options = {}; }
  const u = typeof authority === "string" ? new URL(authority) : authority instanceof URL ? authority : new URL(String(authority));
  if (u.protocol !== "http:" && u.protocol !== "https:") throw nodeError("ERR_HTTP2_UNSUPPORTED_PROTOCOL", 'protocol "' + u.protocol + '" is unsupported.');
  const session = new ClientHttp2Session(u, options || {});
  if (listener) session.once("connect", listener);
  return session;
}

export default { constants, sensitiveHeaders, getDefaultSettings, getPackedSettings, getUnpackedSettings, performServerHandshake, createServer, createSecureServer, connect, Http2Server, Http2SecureServer, Http2ServerRequest, Http2ServerResponse, ServerHttp2Stream, ClientHttp2Stream, ClientHttp2Session };
