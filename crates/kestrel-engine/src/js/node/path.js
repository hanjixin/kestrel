// node:path (POSIX semantics; win32 is aliased to posix on this platform).
function assertPath(p) {
  if (typeof p !== "string") {
    const e = new TypeError('The "path" argument must be of type string. Received ' + (p === null ? "null" : typeof p));
    e.code = "ERR_INVALID_ARG_TYPE";
    throw e;
  }
}

function normalizeString(path, allowAboveRoot) {
  let res = "";
  let lastSegmentLength = 0;
  let lastSlash = -1;
  let dots = 0;
  let code = 0;
  for (let i = 0; i <= path.length; ++i) {
    if (i < path.length) code = path.charCodeAt(i);
    else if (code === 47) break;
    else code = 47;
    if (code === 47) {
      if (lastSlash === i - 1 || dots === 1) {
        // noop
      } else if (dots === 2) {
        if (res.length < 2 || lastSegmentLength !== 2 || res.charCodeAt(res.length - 1) !== 46 || res.charCodeAt(res.length - 2) !== 46) {
          if (res.length > 2) {
            const lastSlashIndex = res.lastIndexOf("/");
            if (lastSlashIndex === -1) { res = ""; lastSegmentLength = 0; }
            else { res = res.slice(0, lastSlashIndex); lastSegmentLength = res.length - 1 - res.lastIndexOf("/"); }
            lastSlash = i; dots = 0; continue;
          } else if (res.length !== 0) {
            res = ""; lastSegmentLength = 0; lastSlash = i; dots = 0; continue;
          }
        }
        if (allowAboveRoot) { res += res.length > 0 ? "/.." : ".."; lastSegmentLength = 2; }
      } else {
        if (res.length > 0) res += "/" + path.slice(lastSlash + 1, i);
        else res = path.slice(lastSlash + 1, i);
        lastSegmentLength = i - lastSlash - 1;
      }
      lastSlash = i; dots = 0;
    } else if (code === 46 && dots !== -1) {
      ++dots;
    } else {
      dots = -1;
    }
  }
  return res;
}

export const sep = "/";
export const delimiter = ":";

export function resolve(...args) {
  let resolvedPath = "";
  let resolvedAbsolute = false;
  for (let i = args.length - 1; i >= -1 && !resolvedAbsolute; i--) {
    const path = i >= 0 ? args[i] : globalThis.process.cwd();
    assertPath(path);
    if (path.length === 0) continue;
    resolvedPath = path + "/" + resolvedPath;
    resolvedAbsolute = path.charCodeAt(0) === 47;
  }
  resolvedPath = normalizeString(resolvedPath, !resolvedAbsolute);
  if (resolvedAbsolute) return "/" + resolvedPath;
  return resolvedPath.length > 0 ? resolvedPath : ".";
}

export function normalize(path) {
  assertPath(path);
  if (path.length === 0) return ".";
  const isAbsolute = path.charCodeAt(0) === 47;
  const trailingSeparator = path.charCodeAt(path.length - 1) === 47;
  path = normalizeString(path, !isAbsolute);
  if (path.length === 0) { if (isAbsolute) return "/"; return trailingSeparator ? "./" : "."; }
  if (trailingSeparator) path += "/";
  return isAbsolute ? "/" + path : path;
}

export function isAbsolute(path) { assertPath(path); return path.length > 0 && path.charCodeAt(0) === 47; }

export function join(...args) {
  if (args.length === 0) return ".";
  let joined;
  for (const arg of args) {
    assertPath(arg);
    if (arg.length > 0) joined = joined === undefined ? arg : joined + "/" + arg;
  }
  if (joined === undefined) return ".";
  return normalize(joined);
}

export function relative(from, to) {
  assertPath(from); assertPath(to);
  if (from === to) return "";
  from = resolve(from); to = resolve(to);
  if (from === to) return "";
  const fromStart = 1, fromEnd = from.length, fromLen = fromEnd - fromStart;
  const toStart = 1, toLen = to.length - toStart;
  const length = fromLen < toLen ? fromLen : toLen;
  let lastCommonSep = -1;
  let i = 0;
  for (; i < length; i++) {
    const fromCode = from.charCodeAt(fromStart + i);
    if (fromCode !== to.charCodeAt(toStart + i)) break;
    else if (fromCode === 47) lastCommonSep = i;
  }
  if (i === length) {
    if (toLen > length) {
      if (to.charCodeAt(toStart + i) === 47) return to.slice(toStart + i + 1);
      if (i === 0) return to.slice(toStart + i);
    } else if (fromLen > length) {
      if (from.charCodeAt(fromStart + i) === 47) lastCommonSep = i;
      else if (i === 0) lastCommonSep = 0;
    }
  }
  let out = "";
  for (i = fromStart + lastCommonSep + 1; i <= fromEnd; ++i) {
    if (i === fromEnd || from.charCodeAt(i) === 47) out += out.length === 0 ? ".." : "/..";
  }
  return out + to.slice(toStart + lastCommonSep);
}

export function toNamespacedPath(path) { return path; }

export function dirname(path) {
  assertPath(path);
  if (path.length === 0) return ".";
  const hasRoot = path.charCodeAt(0) === 47;
  let end = -1, matchedSlash = true;
  for (let i = path.length - 1; i >= 1; --i) {
    if (path.charCodeAt(i) === 47) { if (!matchedSlash) { end = i; break; } }
    else matchedSlash = false;
  }
  if (end === -1) return hasRoot ? "/" : ".";
  if (hasRoot && end === 1) return "//";
  return path.slice(0, end);
}

export function basename(path, suffix) {
  if (suffix !== undefined && typeof suffix !== "string") throw new TypeError('The "ext" argument must be of type string');
  assertPath(path);
  let start = 0, end = -1, matchedSlash = true;
  if (suffix !== undefined && suffix.length > 0 && suffix.length <= path.length) {
    if (suffix === path) return "";
    let extIdx = suffix.length - 1, firstNonSlashEnd = -1;
    for (let i = path.length - 1; i >= 0; --i) {
      const code = path.charCodeAt(i);
      if (code === 47) { if (!matchedSlash) { start = i + 1; break; } }
      else {
        if (firstNonSlashEnd === -1) { matchedSlash = false; firstNonSlashEnd = i + 1; }
        if (extIdx >= 0) {
          if (code === suffix.charCodeAt(extIdx)) { if (--extIdx === -1) end = i; }
          else { extIdx = -1; end = firstNonSlashEnd; }
        }
      }
    }
    if (start === end) end = firstNonSlashEnd;
    else if (end === -1) end = path.length;
    return path.slice(start, end);
  }
  for (let i = path.length - 1; i >= 0; --i) {
    if (path.charCodeAt(i) === 47) { if (!matchedSlash) { start = i + 1; break; } }
    else if (end === -1) { matchedSlash = false; end = i + 1; }
  }
  if (end === -1) return "";
  return path.slice(start, end);
}

export function extname(path) {
  assertPath(path);
  let startDot = -1, startPart = 0, end = -1, matchedSlash = true, preDotState = 0;
  for (let i = path.length - 1; i >= 0; --i) {
    const code = path.charCodeAt(i);
    if (code === 47) { if (!matchedSlash) { startPart = i + 1; break; } continue; }
    if (end === -1) { matchedSlash = false; end = i + 1; }
    if (code === 46) { if (startDot === -1) startDot = i; else if (preDotState !== 1) preDotState = 1; }
    else if (startDot !== -1) preDotState = -1;
  }
  if (startDot === -1 || end === -1 || preDotState === 0 || (preDotState === 1 && startDot === end - 1 && startDot === startPart + 1)) return "";
  return path.slice(startDot, end);
}

export function format(obj) {
  if (obj === null || typeof obj !== "object") throw new TypeError('The "pathObject" argument must be of type object');
  const dir = obj.dir || obj.root;
  const base = obj.base || (obj.name || "") + (obj.ext ? (obj.ext[0] === "." ? "" : ".") + obj.ext : "");
  if (!dir) return base;
  return dir === obj.root ? dir + base : dir + "/" + base;
}

export function parse(path) {
  assertPath(path);
  const ret = { root: "", dir: "", base: "", ext: "", name: "" };
  if (path.length === 0) return ret;
  const isAbs = path.charCodeAt(0) === 47;
  let start;
  if (isAbs) { ret.root = "/"; start = 1; } else start = 0;
  let startDot = -1, startPart = 0, end = -1, matchedSlash = true, i = path.length - 1, preDotState = 0;
  for (; i >= start; --i) {
    const code = path.charCodeAt(i);
    if (code === 47) { if (!matchedSlash) { startPart = i + 1; break; } continue; }
    if (end === -1) { matchedSlash = false; end = i + 1; }
    if (code === 46) { if (startDot === -1) startDot = i; else if (preDotState !== 1) preDotState = 1; }
    else if (startDot !== -1) preDotState = -1;
  }
  if (end !== -1) {
    const start2 = startPart === 0 && isAbs ? 1 : startPart;
    if (startDot === -1 || preDotState === 0 || (preDotState === 1 && startDot === end - 1 && startDot === startPart + 1)) {
      ret.base = ret.name = path.slice(start2, end);
    } else {
      ret.name = path.slice(start2, startDot);
      ret.base = path.slice(start2, end);
      ret.ext = path.slice(startDot, end);
    }
  }
  if (startPart > 0) ret.dir = path.slice(0, startPart - 1);
  else if (isAbs) ret.dir = "/";
  return ret;
}

export function matchesGlob() { throw new Error("path.matchesGlob is not implemented"); }

const path = { sep, delimiter, resolve, normalize, isAbsolute, join, relative, toNamespacedPath, dirname, basename, extname, format, parse, matchesGlob };
path.posix = path;
path.win32 = path;
export const posix = path;
export const win32 = path;
export default path;
