// node:querystring
export function escape(s) { return encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase()); }
export function unescape(s) { try { return decodeURIComponent(s); } catch { return s; } }
function str(v) { return typeof v === "string" ? v : typeof v === "number" && isFinite(v) ? "" + v : typeof v === "bigint" ? "" + v : typeof v === "boolean" ? (v ? "true" : "false") : ""; }
export function stringify(obj, sep = "&", eq = "=", opts) {
  const enc = (opts && opts.encodeURIComponent) || escape;
  if (obj === null || typeof obj !== "object") return "";
  const parts = [];
  for (const k of Object.keys(obj)) { const v = obj[k]; const ks = enc(str(k)) + eq; if (Array.isArray(v)) { for (const x of v) parts.push(ks + enc(str(x))); } else parts.push(ks + enc(str(v))); }
  return parts.join(sep);
}
export function parse(qs, sep = "&", eq = "=", opts) {
  const out = Object.create(null);
  if (typeof qs !== "string" || qs.length === 0) return out;
  const dec = (opts && opts.decodeURIComponent) || ((s) => unescape(s.replace(/\+/g, " ")));
  let max = opts && typeof opts.maxKeys === "number" ? opts.maxKeys : 1000;
  const parts = qs.split(sep);
  if (max > 0 && parts.length > max) parts.length = max;
  for (const part of parts) { if (!part) continue; const i = part.indexOf(eq); const k = dec(i === -1 ? part : part.slice(0, i)); const v = i === -1 ? "" : dec(part.slice(i + eq.length)); if (k in out) { if (Array.isArray(out[k])) out[k].push(v); else out[k] = [out[k], v]; } else out[k] = v; }
  return out;
}
export const encode = stringify;
export const decode = parse;
export default { escape, unescape, stringify, parse, encode, decode };
