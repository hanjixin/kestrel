// node:fs — synchronous core on native ops; callback and promise forms wrap it.
import { ops, fsError, toPathString, nodeError, utf8Encode, utf8Decode } from "ext:kestrel/internal.js";
import { Buffer } from "ext:kestrel/node/buffer.js";
import { EventEmitter } from "ext:kestrel/node/events.js";

export const constants = { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1, COPYFILE_EXCL: 1, COPYFILE_FICLONE: 2, COPYFILE_FICLONE_FORCE: 4, O_RDONLY: 0, O_WRONLY: 1, O_RDWR: 2, O_CREAT: 512, O_EXCL: 2048, O_TRUNC: 1024, O_APPEND: 8, S_IFMT: 0o170000, S_IFREG: 0o100000, S_IFDIR: 0o040000, S_IFLNK: 0o120000, UV_FS_O_FILEMAP: 0 };
export const F_OK = 0, R_OK = 4, W_OK = 2, X_OK = 1;

function wrap(fn, pathArg) { try { return fn(); } catch (e) { throw fsError(e, pathArg); } }
function encOf(opts) { return typeof opts === "string" ? opts : opts && opts.encoding ? opts.encoding : null; }

export class Stats {
  constructor(s) {
    this.dev = s.dev; this.mode = s.mode; this.nlink = s.nlink; this.uid = s.uid; this.gid = s.gid; this.rdev = 0; this.blksize = 4096; this.ino = s.ino;
    this.size = s.size; this.blocks = Math.ceil(s.size / 512);
    this.atimeMs = s.atime_ms; this.mtimeMs = s.mtime_ms; this.ctimeMs = s.ctime_ms; this.birthtimeMs = s.birthtime_ms;
    this.atime = new Date(s.atime_ms); this.mtime = new Date(s.mtime_ms); this.ctime = new Date(s.ctime_ms); this.birthtime = new Date(s.birthtime_ms);
    this._f = s.is_file; this._d = s.is_dir; this._l = s.is_symlink;
  }
  isFile() { return this._f; }
  isDirectory() { return this._d; }
  isSymbolicLink() { return this._l; }
  isBlockDevice() { return false; }
  isCharacterDevice() { return false; }
  isFIFO() { return false; }
  isSocket() { return false; }
}
export class Dirent {
  constructor(name, kind, parentPath) { this.name = name; this._k = kind; this.parentPath = parentPath; this.path = parentPath; }
  isFile() { return this._k === 1; }
  isDirectory() { return this._k === 2; }
  isSymbolicLink() { return this._k === 3; }
  isBlockDevice() { return false; }
  isCharacterDevice() { return false; }
  isFIFO() { return false; }
  isSocket() { return false; }
}

// ---------- sync ----------
export function readFileSync(path, opts) {
  const enc = encOf(opts);
  if (typeof path === "number") { if (path === 0) { const b = ops.op_k_read_stdin_all(); return enc ? Buffer.from(b).toString(enc) : Buffer.from(b); } throw nodeError("EBADF", "bad file descriptor"); }
  const p = toPathString(path);
  if (enc === "utf8" || enc === "utf-8") return wrap(() => ops.op_k_fs_read_text(p), path);
  const bytes = wrap(() => ops.op_k_fs_read_bytes(p), path);
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return enc ? buf.toString(enc) : buf;
}
function dataToBytes(data, enc) {
  if (typeof data === "string") return Buffer.from(data, enc || "utf8");
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (data && typeof data === "object" && typeof data.toString === "function") return utf8Encode(String(data));
  throw nodeError("ERR_INVALID_ARG_TYPE", 'The "data" argument must be of type string or an instance of Buffer, TypedArray, or DataView. Received ' + typeof data, TypeError);
}
export function writeFileSync(path, data, opts) {
  if (typeof path === "number") { ops.op_k_write_fd(path, dataToBytes(data, encOf(opts))); return; }
  const p = toPathString(path);
  const flag = opts && typeof opts === "object" && opts.flag;
  const append = typeof flag === "string" && flag.startsWith("a");
  if (typeof data === "string" && !(opts && opts.encoding && opts.encoding !== "utf8" && opts.encoding !== "utf-8")) wrap(() => ops.op_k_fs_write_text(p, data, append), path);
  else wrap(() => ops.op_k_fs_write_bytes(p, dataToBytes(data, encOf(opts)), append), path);
  if (opts && typeof opts === "object" && opts.mode !== undefined) wrap(() => ops.op_k_fs_chmod(p, opts.mode), path);
}
export function appendFileSync(path, data, opts) {
  if (typeof path === "number") return writeFileSync(path, data, opts);
  const p = toPathString(path);
  if (typeof data === "string") wrap(() => ops.op_k_fs_write_text(p, data, true), path);
  else wrap(() => ops.op_k_fs_write_bytes(p, dataToBytes(data, encOf(opts)), true), path);
}
export function existsSync(path) { try { return ops.op_k_fs_exists(toPathString(path)); } catch { return false; } }
export function statSync(path, opts) { const p = toPathString(path); try { return new Stats(ops.op_k_fs_stat(p, true)); } catch (e) { if (opts && opts.throwIfNoEntry === false && /^ENOENT/.test(e.message)) return undefined; throw fsError(e, path); } }
export function lstatSync(path, opts) { const p = toPathString(path); try { return new Stats(ops.op_k_fs_stat(p, false)); } catch (e) { if (opts && opts.throwIfNoEntry === false && /^ENOENT/.test(e.message)) return undefined; throw fsError(e, path); } }
export function fstatSync() { throw nodeError("ERR_METHOD_NOT_IMPLEMENTED", "fs.fstat is not implemented"); }
export function readdirSync(path, opts) {
  const p = toPathString(path);
  const entries = wrap(() => ops.op_k_fs_readdir(p), path);
  const withTypes = opts && typeof opts === "object" && opts.withFileTypes;
  const recursive = opts && typeof opts === "object" && opts.recursive;
  if (!recursive) return withTypes ? entries.map(([n, k]) => new Dirent(n, k, p)) : entries.map(([n]) => n);
  const out = [];
  const walk = (dir, rel) => {
    for (const [n, k] of (dir === p ? entries : ops.op_k_fs_readdir(dir))) {
      out.push(withTypes ? new Dirent(n, k, dir) : (rel ? rel + "/" + n : n));
      if (k === 2) walk(dir + "/" + n, rel ? rel + "/" + n : n);
    }
  };
  walk(p, "");
  return out;
}
export function mkdirSync(path, opts) {
  const p = toPathString(path);
  const recursive = typeof opts === "object" && opts !== null && !!opts.recursive;
  const mode = typeof opts === "number" ? opts : (opts && opts.mode) ?? 0o777;
  if (recursive) { let first; let cur = p; const missing = []; while (cur && !ops.op_k_fs_exists(cur)) { missing.unshift(cur); const i = cur.lastIndexOf("/"); cur = i > 0 ? cur.slice(0, i) : ""; } if (missing.length) first = missing[0]; wrap(() => ops.op_k_fs_mkdir(p, true, mode), path); return first; }
  wrap(() => ops.op_k_fs_mkdir(p, false, mode), path);
}
export function rmSync(path, opts) { const p = toPathString(path); wrap(() => ops.op_k_fs_remove(p, !!(opts && opts.recursive), !!(opts && opts.force)), path); }
export function rmdirSync(path, opts) { const p = toPathString(path); wrap(() => ops.op_k_fs_remove(p, !!(opts && opts.recursive), false), path); }
export function unlinkSync(path) { const p = toPathString(path); wrap(() => ops.op_k_fs_remove(p, false, false), path); }
export function renameSync(a, b) { wrap(() => ops.op_k_fs_rename(toPathString(a), toPathString(b)), a); }
export function copyFileSync(a, b, mode) { if (mode & 1 && existsSync(b)) throw fsError(new Error("EEXIST: file already exists, copyfile '" + toPathString(b) + "'")); wrap(() => ops.op_k_fs_copy(toPathString(a), toPathString(b)), a); }
export function cpSync(src, dest, opts = {}) {
  const s = toPathString(src), d = toPathString(dest);
  const st = statSync(s);
  if (st.isDirectory()) { if (!opts.recursive) throw nodeError("ERR_FS_EISDIR", "Recursive option is required to copy a directory: " + s); mkdirSync(d, { recursive: true }); for (const e of readdirSync(s)) cpSync(s + "/" + e, d + "/" + e, opts); }
  else copyFileSync(s, d);
}
export function realpathSync(path, opts) { const r = wrap(() => ops.op_k_fs_realpath(toPathString(path)), path); return encOf(opts) === "buffer" ? Buffer.from(r) : r; }
realpathSync.native = realpathSync;
export function readlinkSync(path) { return wrap(() => ops.op_k_fs_readlink(toPathString(path)), path); }
export function symlinkSync(target, path) { wrap(() => ops.op_k_fs_symlink(toPathString(target), toPathString(path)), path); }
export function accessSync(path, mode) { const p = toPathString(path); if (!ops.op_k_fs_exists(p)) throw fsError(new Error("ENOENT: no such file or directory, access '" + p + "'")); }
export function chmodSync(path, mode) { wrap(() => ops.op_k_fs_chmod(toPathString(path), typeof mode === "string" ? parseInt(mode, 8) : mode), path); }
export function chownSync() {}
export function utimesSync(path, atime, mtime) { const t = (x) => x instanceof Date ? x.getTime() : typeof x === "number" ? x * 1000 : Date.now(); wrap(() => ops.op_k_fs_utimes(toPathString(path), t(atime), t(mtime)), path); }
export function mkdtempSync(prefix) { return wrap(() => ops.op_k_fs_mkdtemp(toPathString(prefix)), prefix); }
export function truncateSync(path, len = 0) { const b = readFileSync(path); writeFileSync(path, b.subarray(0, len)); }
export function openSync() { throw nodeError("ERR_METHOD_NOT_IMPLEMENTED", "fs.open with file descriptors is not implemented yet; use readFileSync/writeFileSync"); }
export function closeSync() {}
export function readSync() { throw nodeError("ERR_METHOD_NOT_IMPLEMENTED", "fs.read is not implemented yet"); }
export function writeSync(fd, data) { if (fd === 1 || fd === 2) { ops.op_k_write_fd(fd, dataToBytes(data)); return data.length; } throw nodeError("ERR_METHOD_NOT_IMPLEMENTED", "fs.write to arbitrary fds is not implemented yet"); }
export function fsyncSync() {}
export function opendirSync(path) { const entries = readdirSync(path, { withFileTypes: true }); let i = 0; return { path: toPathString(path), readSync: () => entries[i++] ?? null, read: (cb) => { const e = entries[i++] ?? null; if (cb) queueMicrotask(() => cb(null, e)); return Promise.resolve(e); }, closeSync() {}, close: (cb) => { if (cb) cb(null); return Promise.resolve(); }, async *[Symbol.asyncIterator]() { for (const e of entries) yield e; } }; }
export function watch() { throw nodeError("ERR_METHOD_NOT_IMPLEMENTED", "fs.watch is not implemented yet"); }
export function watchFile() { throw nodeError("ERR_METHOD_NOT_IMPLEMENTED", "fs.watchFile is not implemented yet"); }
export function unwatchFile() {}
export function globSync() { throw nodeError("ERR_METHOD_NOT_IMPLEMENTED", "fs.glob is not implemented yet"); }

// ---------- callback forms ----------
function cbify(syncFn) {
  return function (...args) {
    const cb = args.pop();
    if (typeof cb !== "function") throw nodeError("ERR_INVALID_ARG_TYPE", 'The "cb" argument must be of type function', TypeError);
    let r, err = null;
    try { r = syncFn(...args); } catch (e) { err = e; }
    queueMicrotask(() => (err ? cb(err) : cb(null, r)));
  };
}
export const readFile = cbify(readFileSync);
export const writeFile = cbify(writeFileSync);
export const appendFile = cbify(appendFileSync);
export const stat = cbify(statSync);
export const lstat = cbify(lstatSync);
export const readdir = cbify(readdirSync);
export const mkdir = cbify(mkdirSync);
export const rm = cbify(rmSync);
export const rmdir = cbify(rmdirSync);
export const unlink = cbify(unlinkSync);
export const rename = cbify(renameSync);
export const copyFile = cbify(copyFileSync);
export const cp = cbify(cpSync);
export const realpath = cbify(realpathSync);
realpath.native = realpath;
export const readlink = cbify(readlinkSync);
export const symlink = cbify(symlinkSync);
export const access = cbify(accessSync);
export const chmod = cbify(chmodSync);
export const chown = cbify(chownSync);
export const utimes = cbify(utimesSync);
export const mkdtemp = cbify(mkdtempSync);
export const truncate = cbify(truncateSync);
export const open = cbify(openSync);
export const close = cbify(closeSync);
export const opendir = cbify(opendirSync);
export function exists(path, cb) { const r = existsSync(path); queueMicrotask(() => cb(r)); }
exists[Symbol.for("nodejs.util.promisify.custom")] = (p) => Promise.resolve(existsSync(p));

// ---------- streams (buffered, enough for pipe/for-await) ----------
import { Readable, Writable } from "ext:kestrel/node/stream.js";
export function createReadStream(path, opts = {}) {
  if (typeof opts === "string") opts = { encoding: opts };
  const r = new Readable({ read() {}, highWaterMark: opts.highWaterMark ?? 65536, encoding: opts.encoding });
  r.path = path; r.bytesRead = 0;
  queueMicrotask(() => {
    try {
      let b = readFileSync(path);
      if (opts.start !== undefined || opts.end !== undefined) b = b.subarray(opts.start ?? 0, opts.end !== undefined ? opts.end + 1 : undefined);
      r.emit("open", 0); r.emit("ready");
      const chunk = opts.highWaterMark ?? 65536;
      for (let i = 0; i < b.length; i += chunk) { r.bytesRead += Math.min(chunk, b.length - i); r.push(b.subarray(i, i + chunk)); }
      r.push(null);
    } catch (e) { r.destroy(e); }
  });
  r.close = (cb) => { r.destroy(); if (cb) cb(); };
  return r;
}
export function createWriteStream(path, opts = {}) {
  if (typeof opts === "string") opts = { encoding: opts };
  const flags = opts.flags ?? "w";
  let first = !flags.startsWith("a");
  const w = new Writable({
    write(chunk, enc, cb) { try { const bytes = typeof chunk === "string" ? Buffer.from(chunk, enc === "buffer" ? "utf8" : enc) : chunk; ops.op_k_fs_write_bytes(toPathString(path), bytes, !first); first = false; w.bytesWritten += bytes.length; cb(); } catch (e) { cb(fsError(e, path)); } },
    final(cb) { cb(); },
  });
  w.path = path; w.bytesWritten = 0; w.pending = false;
  if (first) { try { ops.op_k_fs_write_bytes(toPathString(path), new Uint8Array(0), false); first = false; } catch (e) { queueMicrotask(() => w.destroy(fsError(e, path))); } }
  queueMicrotask(() => { w.emit("open", 0); w.emit("ready"); });
  w.close = (cb) => { w.end(); if (cb) w.once("finish", cb); };
  return w;
}
export class ReadStream extends Readable {}
export class WriteStream extends Writable {}
export class FSWatcher extends EventEmitter {}

import * as promises from "ext:kestrel/node/fs_promises.js";
export { promises };

const fs = {
  constants, F_OK, R_OK, W_OK, X_OK, Stats, Dirent, promises,
  readFileSync, writeFileSync, appendFileSync, existsSync, statSync, lstatSync, fstatSync, readdirSync, mkdirSync, rmSync, rmdirSync, unlinkSync, renameSync,
  copyFileSync, cpSync, realpathSync, readlinkSync, symlinkSync, accessSync, chmodSync, chownSync, utimesSync, mkdtempSync, truncateSync, openSync, closeSync, readSync, writeSync, fsyncSync, opendirSync, watch, watchFile, unwatchFile, globSync,
  readFile, writeFile, appendFile, stat, lstat, readdir, mkdir, rm, rmdir, unlink, rename, copyFile, cp, realpath, readlink, symlink, access, chmod, chown, utimes, mkdtemp, truncate, open, close, opendir, exists,
  createReadStream, createWriteStream, ReadStream, WriteStream, FSWatcher,
};
export default fs;
