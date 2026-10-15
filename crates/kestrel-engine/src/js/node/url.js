// node:url — WHATWG URL / URLSearchParams on the Rust `url` crate, plus the legacy helpers.
import { ops, nodeError, inspectCustom } from "ext:kestrel/internal.js";

const kParts = Symbol("url.parts");

function parse(href, base) {
  const r = ops.op_k_url_parse(String(href), base === undefined ? "" : String(base));
  if (r === null) throw nodeError("ERR_INVALID_URL", "Invalid URL", TypeError);
  return r; // [href, protocol, username, password, hostname, port, pathname, search, hash, host, origin]
}

export class URLSearchParams {
  #list = [];
  #url = null;
  constructor(init = "") {
    if (typeof init === "string") this.#parse(init);
    else if (init instanceof URLSearchParams) this.#list = init.#list.map((p) => [...p]);
    else if (Array.isArray(init) || (init && typeof init[Symbol.iterator] === "function")) { for (const pair of init) { if (pair.length !== 2) throw nodeError("ERR_INVALID_TUPLE", "Each query pair must be an iterable [name, value] tuple", TypeError); this.#list.push([String(pair[0]), String(pair[1])]); } }
    else if (init && typeof init === "object") for (const k of Object.keys(init)) this.#list.push([k, String(init[k])]);
  }
  #parse(s) { this.#list = []; if (s.startsWith("?")) s = s.slice(1); if (!s) return; for (const part of s.split("&")) { if (!part) continue; const i = part.indexOf("="); const k = i === -1 ? part : part.slice(0, i); const v = i === -1 ? "" : part.slice(i + 1); this.#list.push([decode(k), decode(v)]); } }
  static _attach(sp, url) { sp.#url = url; return sp; }
  static _reset(sp, s) { sp.#parse(s); }
  #update() { if (this.#url) this.#url._setSearchFromParams(this.toString()); }
  get size() { return this.#list.length; }
  append(k, v) { this.#list.push([String(k), String(v)]); this.#update(); }
  delete(k, v) { k = String(k); this.#list = this.#list.filter(([a, b]) => !(a === k && (v === undefined || b === String(v)))); this.#update(); }
  get(k) { k = String(k); const e = this.#list.find(([a]) => a === k); return e ? e[1] : null; }
  getAll(k) { k = String(k); return this.#list.filter(([a]) => a === k).map(([, b]) => b); }
  has(k, v) { k = String(k); return this.#list.some(([a, b]) => a === k && (v === undefined || b === String(v))); }
  set(k, v) { k = String(k); v = String(v); const i = this.#list.findIndex(([a]) => a === k); if (i === -1) this.#list.push([k, v]); else { this.#list[i][1] = v; this.#list = this.#list.filter(([a], j) => a !== k || j === i); } this.#update(); }
  sort() { this.#list.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)); this.#update(); }
  forEach(cb, thisArg) { for (const [k, v] of this.#list) cb.call(thisArg, v, k, this); }
  *keys() { for (const [k] of this.#list) yield k; }
  *values() { for (const [, v] of this.#list) yield v; }
  *entries() { for (const p of this.#list) yield [p[0], p[1]]; }
  [Symbol.iterator]() { return this.entries(); }
  toString() { return this.#list.map(([k, v]) => encode(k) + "=" + encode(v)).join("&"); }
  get [Symbol.toStringTag]() { return "URLSearchParams"; }
  [inspectCustom]() { return "URLSearchParams { " + this.#list.map(([k, v]) => "'" + k + "' => '" + v + "'").join(", ") + " }"; }
}
function encode(s) { return encodeURIComponent(s).replace(/%20/g, "+").replace(/[!'()~]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase()); }
function decode(s) { try { return decodeURIComponent(s.replace(/\+/g, " ")); } catch { return s; } }

export class URL {
  #p;
  #sp = null;
  constructor(href, base) {
    if (href instanceof URL) href = href.href;
    if (base instanceof URL) base = base.href;
    this.#p = parse(href, base);
  }
  static canParse(href, base) { try { new URL(href, base); return true; } catch { return false; } }
  static parse(href, base) { try { return new URL(href, base); } catch { return null; } }
  static createObjectURL() { throw nodeError("ERR_METHOD_NOT_IMPLEMENTED", "URL.createObjectURL is not implemented"); }
  static revokeObjectURL() {}
  #reparse(href) { this.#p = parse(href); if (this.#sp) URLSearchParams._reset(this.#sp, this.#p[7]); }
  _setSearchFromParams(s) { this.#p = parse(this.#p[0].split("?")[0].split("#")[0] + (s ? "?" + s : "") + this.#p[8]); }
  get href() { return this.#p[0]; } set href(v) { this.#reparse(String(v)); }
  get protocol() { return this.#p[1]; } set protocol(v) { v = String(v).replace(/:$/, ""); const rest = this.#p[0].slice(this.#p[1].length); try { this.#reparse(v + ":" + rest); } catch {} }
  get username() { return this.#p[2]; } set username(v) { this.#rebuild({ username: String(v) }); }
  get password() { return this.#p[3]; } set password(v) { this.#rebuild({ password: String(v) }); }
  get hostname() { return this.#p[4]; } set hostname(v) { this.#rebuild({ hostname: String(v) }); }
  get port() { return this.#p[5]; } set port(v) { this.#rebuild({ port: String(v) }); }
  get host() { return this.#p[9]; } set host(v) { const [h, p] = String(v).split(":"); this.#rebuild({ hostname: h, port: p ?? "" }); }
  get pathname() { return this.#p[6]; } set pathname(v) { v = String(v); this.#rebuild({ pathname: v.startsWith("/") ? v : "/" + v }); }
  get search() { return this.#p[7]; } set search(v) { v = String(v); this.#rebuild({ search: v && !v.startsWith("?") ? "?" + v : v }); }
  get hash() { return this.#p[8]; } set hash(v) { v = String(v); this.#rebuild({ hash: v && !v.startsWith("#") ? "#" + v : v }); }
  get origin() { return this.#p[10]; }
  get searchParams() { if (!this.#sp) this.#sp = URLSearchParams._attach(new URLSearchParams(this.#p[7]), this); return this.#sp; }
  #rebuild(o) {
    const p = this.#p;
    const username = o.username ?? p[2], password = o.password ?? p[3], hostname = o.hostname ?? p[4], port = o.port ?? p[5];
    const pathname = o.pathname ?? p[6], search = o.search ?? p[7], hash = o.hash ?? p[8];
    const auth = username || password ? username + (password ? ":" + password : "") + "@" : "";
    const hasHost = p[9] !== "" || hostname !== "";
    const href = p[1] + (hasHost ? "//" + auth + hostname + (port ? ":" + port : "") : "") + pathname + search + hash;
    try { this.#reparse(href); } catch { /* invalid mutation ignored, like WHATWG */ }
  }
  toString() { return this.#p[0]; }
  toJSON() { return this.#p[0]; }
  get [Symbol.toStringTag]() { return "URL"; }
  [inspectCustom]() { return "URL {\n  href: '" + this.href + "',\n  origin: '" + this.origin + "',\n  protocol: '" + this.protocol + "',\n  username: '" + this.username + "',\n  password: '" + this.password + "',\n  host: '" + this.host + "',\n  hostname: '" + this.hostname + "',\n  port: '" + this.port + "',\n  pathname: '" + this.pathname + "',\n  search: '" + this.search + "',\n  searchParams: " + this.searchParams[inspectCustom]() + ",\n  hash: '" + this.hash + "'\n}"; }
}

export function fileURLToPath(u) { const href = typeof u === "string" ? u : u.href; return ops.op_k_url_to_path(href); }
export function pathToFileURL(p) { return new URL(ops.op_k_path_to_url(String(p))); }
export function domainToASCII(d) { try { return new URL("http://" + d).hostname; } catch { return ""; } }
export function domainToUnicode(d) { return domainToASCII(d); }
export function urlToHttpOptions(u) { return { protocol: u.protocol, hostname: u.hostname.startsWith("[") ? u.hostname.slice(1, -1) : u.hostname, hash: u.hash, search: u.search, pathname: u.pathname, path: u.pathname + u.search, href: u.href, port: u.port !== "" ? Number(u.port) : undefined, auth: u.username || u.password ? decodeURIComponent(u.username) + ":" + decodeURIComponent(u.password) : undefined }; }

// Legacy API (url.parse / url.format / url.resolve)
export class Url { constructor() { this.protocol = null; this.slashes = null; this.auth = null; this.host = null; this.port = null; this.hostname = null; this.hash = null; this.search = null; this.query = null; this.pathname = null; this.path = null; this.href = null; } }
export function parse_(s, parseQuery = false) {
  const u = new Url();
  s = String(s).trim();
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*:)?(\/\/)?(?:([^/?#@]*)@)?([^/?#:]*)?(?::(\d+))?([^?#]*)(\?[^#]*)?(#.*)?$/.exec(s);
  if (!m) { u.href = s; return u; }
  const [, protocol, slashes, auth, host, port, pathname, search, hash] = m;
  u.protocol = protocol ? protocol.toLowerCase() : null;
  u.slashes = !!slashes || null;
  u.auth = auth ? decodeURIComponent(auth) : null;
  u.hostname = host ? host.toLowerCase() : (slashes ? "" : null);
  u.port = port ?? null;
  u.host = u.hostname !== null ? u.hostname + (port ? ":" + port : "") : null;
  u.pathname = pathname || (slashes || u.host ? "/" : null);
  u.search = search ?? null;
  u.query = search ? (parseQuery ? Object.fromEntries(new URLSearchParams(search)) : search.slice(1)) : (parseQuery ? {} : null);
  u.hash = hash ?? null;
  u.path = (u.pathname || "") + (u.search || "") || null;
  u.href = format_(u);
  return u;
}
export function format_(u, opts) {
  if (u instanceof URL) { let s = u.href; if (opts) { if (opts.fragment === false) s = s.replace(/#.*$/, ""); if (opts.search === false) s = s.replace(/\?[^#]*/, ""); if (opts.auth === false) s = s.replace(/\/\/[^@/]*@/, "//"); } return s; }
  if (typeof u === "string") return u;
  let s = "";
  if (u.protocol) s += u.protocol.endsWith(":") ? u.protocol : u.protocol + ":";
  const host = u.host ?? (u.hostname ? u.hostname + (u.port ? ":" + u.port : "") : null);
  if (u.slashes || host !== null || /^(https?|ftp|file|wss?):$/.test(u.protocol || "")) s += "//";
  if (u.auth) s += encodeURI(u.auth) + "@";
  if (host) s += host;
  if (u.pathname) s += u.pathname.startsWith("/") || !host ? u.pathname : "/" + u.pathname;
  if (u.search) s += u.search.startsWith("?") ? u.search : "?" + u.search;
  else if (u.query && typeof u.query === "object" && Object.keys(u.query).length) s += "?" + new URLSearchParams(u.query).toString();
  else if (typeof u.query === "string" && u.query) s += "?" + u.query;
  if (u.hash) s += u.hash.startsWith("#") ? u.hash : "#" + u.hash;
  return s;
}
export function resolve(from, to) { try { return new URL(to, new URL(from, "resolve://")).href.replace(/^resolve:\/\//, ""); } catch { return to; } }
export function resolveObject(from, to) { return parse_(resolve(typeof from === "string" ? from : format_(from), to)); }

export { parse_ as parse, format_ as format };
const url = { URL, URLSearchParams, fileURLToPath, pathToFileURL, domainToASCII, domainToUnicode, urlToHttpOptions, Url, parse: parse_, format: format_, resolve, resolveObject };
export default url;
