// node:http2 — HTTP/2 over the runtime's `h2` layer (crates/kestrel-engine/src/h2impl.rs):
// servers (`createServer` h2c, `createSecureServer` ALPN h2) with the stream API, the
// compatibility API, server push, ping and settings; clients (`connect`) with push promises.
// `allowHTTP1: true` servers run on the shared HTTP/1+2 acceptor instead (no push there).
import { EventEmitter } from "ext:kestrel/node/events.js";
import { Duplex } from "ext:kestrel/node/stream.js";
import { Buffer } from "ext:kestrel/node/buffer.js";
import { IncomingMessage, ServerResponse, STATUS_CODES } from "ext:kestrel/node/http.js";
import { ops, nodeError } from "ext:kestrel/internal.js";
import fs from "ext:kestrel/node/fs.js";

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
// "k\0v\0..." of the regular (non-pseudo) headers.
function flat(headers) {
  const parts = [];
  for (const [k, v] of Object.entries(headers)) { if (k.startsWith(":") || v === undefined) continue; if (Array.isArray(v)) for (const x of v) parts.push(k, String(x)); else parts.push(k, String(v)); }
  return parts.join("\0");
}
function fromPairs(pairs) {
  const h = {};
  for (const [k, v] of pairs) { if (h[k] === undefined) h[k] = v; else if (k === "set-cookie" || k === "cookie") h[k] = [].concat(h[k], v); else h[k] = h[k] + ", " + v; }
  if (h[":status"] !== undefined) h[":status"] = Number(h[":status"]);
  return h;
}
const flags = 0;

// ---------- sessions ----------
class Http2Session extends EventEmitter {
  constructor(type, info = {}) {
    super();
    this.type = type; this.closed = false; this.destroyed = false; this.connecting = false; this.pendingSettingsAck = false;
    this.alpnProtocol = "h2"; this.encrypted = !!info.encrypted; this.originSet = undefined; this._cid = info.cid ?? null;
    this.localSettings = { ...DEFAULTS }; this.remoteSettings = { ...DEFAULTS }; this.state = { effectiveLocalWindowSize: 65535, effectiveRecvDataLength: 0, nextStreamID: type === 1 ? 1 : 2, localWindowSize: 65535, lastProcStreamID: 0, remoteWindowSize: 65535, outboundQueueSize: 0, deflateDynamicTableSize: 0, inflateDynamicTableSize: 0 };
    this.socket = { remoteAddress: info.remote ?? "127.0.0.1", remotePort: info.remote_port ?? 0, localAddress: "127.0.0.1", localPort: info.local_port ?? 0, remoteFamily: "IPv4", encrypted: this.encrypted, alpnProtocol: "h2", destroyed: false, setTimeout() {}, setNoDelay() {}, setKeepAlive() {}, ref() {}, unref() {}, on() {}, once() {}, destroy: () => this.destroy(), end: () => this.close() };
    this._streams = new Set();
  }
  settings(settings = {}, cb) { Object.assign(this.localSettings, settings); if (cb) queueMicrotask(() => cb(null, this.localSettings, 0)); }
  ping(payload, cb) {
    if (typeof payload === "function") { cb = payload; payload = undefined; }
    if (!cb) throw nodeError("ERR_INVALID_ARG_TYPE", 'The "callback" argument must be of type function', TypeError);
    const p = payload ? Buffer.from(payload) : Buffer.alloc(8);
    if (this._cid === null) { queueMicrotask(() => cb(null, 0, p)); return true; }
    ops.op_h2_ping(this._cid).then((ms) => cb(null, ms, p), (e) => cb(e));
    return true;
  }
  goaway() { this.close(); }
  setTimeout(ms, cb) { if (cb) this.once("timeout", cb); return this; }
  setLocalWindowSize() {}
  ref() { return this; } unref() { return this; }
  close(cb) {
    if (this.closed) { if (cb) queueMicrotask(cb); return; }
    this.closed = true;
    if (cb) this.once("close", cb);
    const finish = () => { if (!this.destroyed) { this.destroyed = true; this.socket.destroyed = true; if (this._cid !== null) ops.op_h2_conn_close(this._cid); this.emit("close"); } };
    if (this._streams.size === 0) queueMicrotask(finish); else this._onIdle = finish;
  }
  destroy(error) {
    if (this.destroyed) return;
    this.destroyed = true; this.closed = true; this.socket.destroyed = true;
    for (const s of [...this._streams]) s.destroy(error);
    if (this._cid !== null) ops.op_h2_conn_close(this._cid);
    if (error) queueMicrotask(() => this.emit("error", error));
    queueMicrotask(() => this.emit("close"));
  }
  _track(stream) { this._streams.add(stream); stream.once("close", () => { this._streams.delete(stream); if (this._streams.size === 0 && this._onIdle) { const f = this._onIdle; this._onIdle = null; f(); } }); }
}
export class ServerHttp2Session extends Http2Session { constructor(info) { super(0, info); } altsvc() {} origin() {} }

// ---------- streams ----------
let nextStreamId = 1;
class Http2Stream extends Duplex {
  constructor(session, sid) {
    super({ allowHalfOpen: true });
    this.session = session; this.id = nextStreamId; nextStreamId += 2; this._sid = sid; this.rstCode = 0; this.aborted = false; this._h2closed = false; this.pending = sid === null; this.sentHeaders = undefined; this.sentInfoHeaders = []; this.sentTrailers = undefined; this.endAfterHeaders = false;
    this._headersSent = false; this._trailers = null; this._writeQueue = Promise.resolve();
    this.state = { localWindowSize: 65535, state: 2, localClose: 0, remoteClose: 0, sumDependencyWeight: 0, weight: 16 };
  }
  get bufferSize() { return 0; }
  get closed() { return this._h2closed; }
  set closed(v) { this._h2closed = v; }
  get headersSent() { return this._headersSent; }
  set headersSent(v) { this._headersSent = v; }
  _read() {}
  // Writable side: data goes to the h2 stream after the head has been sent (server: respond()).
  _write(chunk, enc, cb) {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, enc === "buffer" ? "utf8" : enc) : Buffer.from(chunk);
    this._writeQueue = this._writeQueue.then(() => this._ready()).then(() => ops.op_h2_write(this._sid, bytes)).then(() => cb(), (e) => cb(e));
  }
  _final(cb) {
    this._writeQueue = this._writeQueue.then(() => this._ready()).then(() => { ops.op_h2_end(this._sid, this._trailers ? flat(this._trailers) : ""); this.sentTrailers = this._trailers ?? undefined; }).then(() => cb(), (e) => cb(e));
  }
  _ready() { return Promise.resolve(); }
  // Readable side: pump incoming data.
  _pump() {
    (async () => {
      try {
        for (;;) {
          const chunk = await ops.op_h2_read(this._sid);
          if (chunk === null) { this.push(null); return; }
          this.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
        }
      } catch (e) { if (!this.destroyed) this.destroy(e); }
    })();
  }
  setTimeout(ms, cb) { if (cb) this.once("timeout", cb); return this; }
  priority() {}
  sendTrailers(headers) { this._trailers = headers; }
  close(code = 0, cb) {
    if (this._h2closed) { if (cb) queueMicrotask(cb); return; }
    this._h2closed = true; this.rstCode = code;
    if (cb) this.once("close", cb);
    if (this._sid !== null) ops.op_h2_rst(this._sid, code);
    this.destroy();
    queueMicrotask(() => this.emit("close"));
  }
  _destroy(err, cb) {
    if (!this._h2closed) { this._h2closed = true; if (this._sid !== null) { if (err) ops.op_h2_rst(this._sid, 2); else ops.op_h2_release(this._sid); } queueMicrotask(() => this.emit("close")); }
    cb(err);
  }
}
export class ServerHttp2Stream extends Http2Stream {
  constructor(session, sid, headers, hasBody, pushed = false) {
    super(session, sid);
    this._reqHeaders = headers; this.pushAllowed = !pushed; this._pushed = pushed;
    if (!pushed && hasBody) this._pump(); else this.push(null);
  }
  respond(headers = {}, options = {}) {
    if (this.destroyed || this._h2closed) throw nodeError("ERR_HTTP2_INVALID_STREAM", "The stream has been destroyed");
    if (this._headersSent) throw nodeError("ERR_HTTP2_HEADERS_SENT", "Response has already been initiated.");
    headers = { ...headers }; delete headers[sensitiveHeaders];
    assertValidHeaders(headers);
    const st = headers[":status"] !== undefined ? Number(headers[":status"]) : 200;
    if (!Number.isInteger(st) || st < 100 || st > 599) throw nodeError("ERR_HTTP2_STATUS_INVALID", "Invalid status code: " + headers[":status"], RangeError);
    for (const k of Object.keys(headers)) { if (k.startsWith(":") && k !== ":status") throw nodeError("ERR_HTTP2_INVALID_PSEUDOHEADER", '"' + k + '" is an invalid pseudoheader or is used incorrectly', TypeError); }
    this._headersSent = true; this.sentHeaders = { ":status": st, ...headers };
    ops.op_h2_respond(this._sid, st, flat(headers), !!options.endStream);
    if (options.endStream) { this._ended = true; this.end(); }
    return this;
  }
  _ready() { if (!this._headersSent) this.respond({}); return Promise.resolve(); }
  _final(cb) {
    if (this._ended) return cb();
    super._final(cb);
  }
  respondWithFile(path, headers = {}, options = {}) {
    let data;
    try { data = fs.readFileSync(path); } catch (e) { if (options.onError) return options.onError(e); throw e; }
    this.respond({ ...headers, "content-length": String(data.length) });
    this.end(data);
  }
  respondWithFD(fd, headers = {}) {
    const data = fs.readFileSync(fd);
    this.respond({ ...headers, "content-length": String(data.length) });
    this.end(data);
  }
  additionalHeaders(headers) { this.sentInfoHeaders.push(headers); }
  pushStream(headers, options, callback) {
    if (typeof options === "function") { callback = options; options = {}; }
    if (typeof callback !== "function") throw nodeError("ERR_INVALID_ARG_TYPE", 'The "callback" argument must be of type function', TypeError);
    if (!this.pushAllowed) { const e = nodeError("ERR_HTTP2_PUSH_DISABLED", "HTTP/2 client has disabled push streams"); queueMicrotask(() => callback(e)); return; }
    if (this._headersSent) { const e = nodeError("ERR_HTTP2_HEADERS_SENT", "Response has already been initiated."); queueMicrotask(() => callback(e)); return; }
    headers = { ...headers };
    const method = String(headers[":method"] ?? "GET").toUpperCase();
    const path = headers[":path"]; if (typeof path !== "string") throw nodeError("ERR_HTTP2_INVALID_PSEUDOHEADER", '":path" is required', TypeError);
    const authority = headers[":authority"] ?? this._reqHeaders[":authority"] ?? "localhost";
    const scheme = headers[":scheme"] ?? this._reqHeaders[":scheme"] ?? (this.session.encrypted ? "https" : "http");
    const promised = { ":method": method, ":path": path, ":authority": authority, ":scheme": scheme, ...headers };
    let psid;
    try { psid = ops.op_h2_push(this._sid, method, path, authority, scheme, flat(headers)); } catch (e) { queueMicrotask(() => callback(e)); return; }
    const push = new ServerHttp2Stream(this.session, psid, promised, false, true);
    this.session._track(push);
    queueMicrotask(() => callback(null, push, promised));
  }
}
export class ClientHttp2Stream extends Http2Stream {
  constructor(session, headers, options, sid = null, pushed = false) {
    super(session, sid);
    this._reqHeaders = headers; this._options = options; this._pushed = pushed;
    // endStream means the request body is already complete, so the writable side must not
    // send a trailing empty DATA frame (the h2 stream is half-closed the moment it opens).
    if (options && options.endStream) this._ended = true;
    this._open = sid !== null ? Promise.resolve(sid) : new Promise((r) => { this._resolveOpen = r; });
    if (pushed) this._awaitResponse("push");
  }
  _ready() { return this._open; }
  _start(cid) {
    const h = this._reqHeaders; const a = this.session._authority;
    const authority = h[":authority"] || a.host;
    const uri = (h[":scheme"] || a.protocol.replace(":", "")) + "://" + authority + (h[":path"] || "/");
    const end = this._options.endStream === true;
    ops.op_h2_request(cid, h[":method"], uri, flat(h), end).then((sid) => {
      this._sid = sid; this.pending = false;
      if (end) this._ended = true;
      this._resolveOpen(sid);
      this.emit("ready");
      this._awaitResponse("response");
      this._pumpPushes();
    }, (e) => { this._fail(e); });
  }
  _final(cb) { if (this._ended) return cb(); super._final(cb); }
  _fail(e) {
    const err = e instanceof Error ? e : new Error(String(e && e.message || e));
    if (!err.code) err.code = /refused/i.test(err.message) ? "ECONNREFUSED" : /ENOTFOUND|dns|resolve/i.test(err.message) ? "ENOTFOUND" : "ERR_HTTP2_STREAM_ERROR";
    this.destroy(err);
  }
  _awaitResponse(event) {
    ops.op_h2_response(this._sid).then((r) => {
      if (this.destroyed) return;
      const headers = fromPairs(r.headers);
      this.emit(event, headers, flags);
      if (r.has_body) this._pump(); else this.push(null);
    }, (e) => this._fail(e));
  }
  _pumpPushes() {
    (async () => {
      try {
        for (;;) {
          const p = await ops.op_h2_push_promise(this._sid);
          if (!p) return;
          const headers = fromPairs(p.headers);
          const pushed = new ClientHttp2Stream(this.session, headers, { endStream: true }, p.psid, true);
          this.session._track(pushed);
          // A client push stream is read-only; end its writable side so it reaches `close`
          // once the pushed body is consumed (otherwise the session never goes idle).
          pushed.end();
          this.session.emit("stream", pushed, headers, flags);
        }
      } catch { /* session gone */ }
    })();
  }
}
export class ClientHttp2Session extends Http2Session {
  constructor(authority, options = {}) {
    super(1, { encrypted: authority.protocol === "https:" });
    this._authority = authority; this._options = options; this.connecting = true;
    const tls = authority.protocol === "https:";
    const port = Number(authority.port || (tls ? 443 : 80));
    this._ready = ops.op_h2_connect(authority.hostname, port, tls, options.servername ?? authority.hostname, options.rejectUnauthorized === false).then((info) => {
      this._cid = info.cid; this.connecting = false;
      Object.assign(this.socket, { remoteAddress: info.remote, remotePort: info.remote_port, localPort: info.local_port });
      this.emit("connect", this, this.socket);
      return info.cid;
    }, (e) => { this.connecting = false; const err = e instanceof Error ? e : new Error(String(e.message || e)); if (!err.code) err.code = /refused/i.test(err.message) ? "ECONNREFUSED" : "ERR_HTTP2_ERROR"; this.destroy(err); throw err; });
    this._ready.catch(() => {});
  }
  request(headers = {}, options = {}) {
    if (this.destroyed) throw nodeError("ERR_HTTP2_INVALID_SESSION", "The session has been destroyed");
    if (this.closed) throw nodeError("ERR_HTTP2_GOAWAY_SESSION", "New streams cannot be created after receiving a GOAWAY");
    headers = { ...headers }; delete headers[sensitiveHeaders];
    assertValidHeaders(headers);
    const method = String(headers[":method"] ?? "GET").toUpperCase();
    if (headers[":status"] !== undefined) throw nodeError("ERR_HTTP2_INVALID_PSEUDOHEADER", '":status" is an invalid pseudoheader or is used incorrectly', TypeError);
    const endStream = options.endStream === undefined ? PAYLOAD_MEANINGLESS.has(method) : !!options.endStream;
    const stream = new ClientHttp2Stream(this, { ...headers, ":method": method }, { ...options, endStream });
    this._track(stream);
    this._ready.then((cid) => stream._start(cid), (e) => stream._fail(e));
    if (endStream) stream.end();
    return stream;
  }
}

// ---------- compatibility API ----------
export class Http2ServerRequest extends IncomingMessage {
  constructor(stream, headers, session) {
    const raw = []; for (const [k, v] of Object.entries(headers)) raw.push(k, String(v));
    super({ method: headers[":method"], url: headers[":path"], headers, rawHeaders: raw, socket: session.socket, bodyPromise: Promise.resolve(null) });
    this.complete = false;
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
    super(req, (status, flatHeaders, body) => {
      if (!stream.headersSent) {
        const h = {}; const parts = flatHeaders && flatHeaders !== "\0" ? flatHeaders.split("\0") : [];
        for (let i = 0; i + 1 < parts.length; i += 2) { if (h[parts[i]] === undefined) h[parts[i]] = parts[i + 1]; else h[parts[i]] = [].concat(h[parts[i]], parts[i + 1]); }
        stream.respond({ ":status": status, ...h }, { endStream: body.length === 0 });
        if (body.length === 0) return;
      }
      stream.end(body);
    });
    this.stream = stream; this.sendDate = true;
    stream.once("close", () => this.emit("close"));
  }
  get socket() { return this.stream.session.socket; }
  get connection() { return this.socket; }
  createPushResponse(headers, cb) {
    this.stream.pushStream(headers, (err, push, promised) => {
      if (err) return cb(err);
      const req = new Http2ServerRequest(push, promised, this.stream.session);
      cb(null, new Http2ServerResponse(push, req));
    });
  }
  writeContinue() {}
}

// ---------- servers ----------
class Http2ServerBase extends EventEmitter {
  constructor(opts = {}, handler, secure) {
    super();
    this._opts = opts; this._secure = secure; this.listening = false; this.timeout = 0; this._sessions = new Map();
    if (handler) this.on("request", handler);
  }
  listen(...args) {
    let port = 0, host, cb;
    for (const a of args) { if (typeof a === "function") cb = a; else if (typeof a === "number" || (typeof a === "string" && /^\d+$/.test(a))) port = Number(a); else if (typeof a === "string") host = a; else if (a && typeof a === "object") { port = a.port ?? port; host = a.host ?? host; } }
    if (cb) this.once("listening", cb);
    if (this._opts.allowHTTP1) return this._listenShared(port, host);
    try {
      if (this._secure) {
        const load = (v) => (typeof v === "string" ? v : new TextDecoder().decode(v));
        ops.op_tls_server_config(load(this._opts.cert), load(this._opts.key), "h2");
      }
      const [rid, bound] = ops.op_h2_listen(host || "0.0.0.0", port, this._secure);
      this._rid = rid; this._port = bound; this._host = host || "0.0.0.0"; this.listening = true;
      queueMicrotask(() => this.emit("listening"));
      this._accept(rid);
    } catch (e) { queueMicrotask(() => this.emit("error", e)); }
    return this;
  }
  async _accept(rid) {
    for (;;) {
      let m;
      try { m = await ops.op_h2_accept(rid); } catch { return; }
      if (!m) return;
      let session = this._sessions.get(m.cid);
      if (!session) {
        session = new ServerHttp2Session(m);
        this._sessions.set(m.cid, session);
        session.once("close", () => this._sessions.delete(m.cid));
        this.emit("session", session);
      }
      const headers = fromPairs(m.headers);
      const stream = new ServerHttp2Stream(session, m.sid, headers, m.has_body);
      session._track(stream);
      this.emit("stream", stream, headers, flags, m.headers.flat());
      if (this.listenerCount("request") > 0) {
        const req = new Http2ServerRequest(stream, headers, session);
        stream.on("data", (d) => req.push(d)); stream.on("end", () => { req.complete = true; req.push(null); });
        const res = new Http2ServerResponse(stream, req);
        this.emit("request", req, res);
      }
    }
  }
  // allowHTTP1: the shared HTTP/1+2 acceptor (hyper); compatibility API only, as Node offers
  // for HTTP/1 clients, and no server push.
  _listenShared(port, host) {
    const self = this;
    const session = new ServerHttp2Session({ encrypted: this._secure });
    const tls = this._secure ? { key: this._opts.key, cert: this._opts.cert, alpn: ["h2", "http/1.1"] } : undefined;
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
            const bodyPromise = hasBody ? ops.op_kestrel_http_body(id) : null;
            const respond = (status, flatHeaders, body) => resolve(new globalThis.Response(body, { status, headers: { "x-kestrel-raw": "1" }, __raw: flatHeaders }));
            const req = new IncomingMessage({ method: request.method, url: u.pathname + u.search, headers, rawHeaders: Object.entries(headers).flat(), bodyPromise, socket: session.socket });
            if (version === 2) { req.httpVersion = "2.0"; req.httpVersionMajor = 2; req.httpVersionMinor = 0; }
            const res = new ServerResponse(req, respond);
            self.emit("request", req, res);
          });
        },
      });
      this._server = info; this._port = info.port; this._host = info.hostname; this.listening = true;
      queueMicrotask(() => this.emit("listening"));
    } catch (e) { queueMicrotask(() => this.emit("error", e)); }
    return this;
  }
  address() { return this.listening ? { address: this._host, family: "IPv4", port: this._port } : null; }
  close(cb) {
    this.listening = false; if (cb) this.once("close", cb);
    const stopped = this._rid !== undefined ? ops.op_h2_close_listener(this._rid) : this._server?.stop();
    for (const s of this._sessions.values()) s.close();
    Promise.resolve(stopped).then(() => this.emit("close"), e => this.emit("error", e)); return this;
  }
  closeAllConnections() { for (const s of this._sessions.values()) s.destroy(); } closeIdleConnections() {}
  setTimeout(ms, cb) { this.timeout = ms; if (cb) this.on("timeout", cb); return this; }
  updateSettings(settings) { this._settings = settings; }
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

export default { constants, sensitiveHeaders, getDefaultSettings, getPackedSettings, getUnpackedSettings, performServerHandshake, createServer, createSecureServer, connect, Http2Server, Http2SecureServer, Http2ServerRequest, Http2ServerResponse, ServerHttp2Stream, ClientHttp2Stream, ClientHttp2Session, ServerHttp2Session };
