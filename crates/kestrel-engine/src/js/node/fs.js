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
  if (typeof path === "number") {
    if (path === 0) { const b = ops.op_k_read_stdin_all(); return enc ? Buffer.from(b).toString(enc) : Buffer.from(b); }
    const chunks = []; const buf = Buffer.alloc(65536);
    for (;;) { const n = readSync(path, buf, 0, buf.length, null); if (n === 0) break; chunks.push(Buffer.from(buf.subarray(0, n))); }
    const all = Buffer.concat(chunks); return enc ? all.toString(enc) : all;
  }
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
const flagStr = (f) => (f === undefined || f === null ? "r" : typeof f === "number" ? ({ 0: "r", 1: "w", 2: "r+", 1537: "w", 577: "w", 1089: "a", 1090: "a+", 66: "r+" }[f] ?? "r") : String(f));
export function openSync(path, flags, mode) { return wrap(() => ops.op_fd_open(toPathString(path), flagStr(flags), typeof mode === "number" ? mode : 0o666), path); }
export function closeSync(fd) { wrap(() => ops.op_fd_close(fd | 0)); }
export function readSync(fd, buffer, offset, length, position) {
  if (offset !== null && typeof offset === "object") { ({ offset = 0, length, position } = offset); }
  offset = offset ?? 0; length = length ?? buffer.byteLength - offset;
  const view = new Uint8Array(buffer.buffer, buffer.byteOffset + offset, length);
  return wrap(() => ops.op_fd_read(fd | 0, view, position === null || position === undefined ? -1 : Number(position)));
}
export function writeSync(fd, data, offsetOrPos, lengthOrEnc, position) {
  let bytes;
  if (typeof data === "string") { bytes = Buffer.from(data, typeof lengthOrEnc === "string" ? lengthOrEnc : "utf8"); position = typeof offsetOrPos === "number" ? offsetOrPos : null; }
  else { const offset = typeof offsetOrPos === "number" ? offsetOrPos : 0; const len = typeof lengthOrEnc === "number" ? lengthOrEnc : data.byteLength - offset; bytes = new Uint8Array(data.buffer, data.byteOffset + offset, len); }
  return wrap(() => ops.op_fd_write(fd | 0, bytes, position === null || position === undefined ? -1 : Number(position)));
}
export function fstatSync(fd) { return new Stats(wrap(() => ops.op_fd_stat(fd | 0))); }
export function fsyncSync(fd) { wrap(() => ops.op_fd_sync(fd | 0)); }
export function fdatasyncSync(fd) { fsyncSync(fd); }
export function ftruncateSync(fd, len = 0) { wrap(() => ops.op_fd_truncate(fd | 0, len)); }
export function readvSync(fd, buffers, position) { let n = 0; for (const b of buffers) { const r = readSync(fd, b, 0, b.byteLength, position === undefined ? null : position + n); n += r; if (r < b.byteLength) break; } return n; }
export function writevSync(fd, buffers, position) { let n = 0; for (const b of buffers) n += writeSync(fd, b, 0, b.byteLength, position === undefined ? null : position + n); return n; }
export function opendirSync(path) { const entries = readdirSync(path, { withFileTypes: true }); let i = 0; return { path: toPathString(path), readSync: () => entries[i++] ?? null, read: (cb) => { const e = entries[i++] ?? null; if (cb) queueMicrotask(() => cb(null, e)); return Promise.resolve(e); }, closeSync() {}, close: (cb) => { if (cb) cb(null); return Promise.resolve(); }, async *[Symbol.asyncIterator]() { for (const e of entries) yield e; } }; }
export class FSWatcher extends EventEmitter {
  constructor(path, opts = {}) {
    super();
    let p = toPathString(path);
    this._rid = wrap(() => ops.op_fs_watch(p, !!opts.recursive), path);
    try { p = ops.op_k_fs_realpath(p); } catch {}
    this._base = p;
    (async () => {
      for (;;) {
        const ev = await ops.op_fs_watch_next(this._rid);
        if (ev === null || this._rid === null) break;
        let rel = ev[1];
        if (rel.startsWith(p + "/")) rel = rel.slice(p.length + 1); else if (rel === p) rel = p.slice(p.lastIndexOf("/") + 1);
        this.emit("change", ev[0], opts.encoding === "buffer" ? Buffer.from(rel) : rel);
      }
    })();
  }
  close() { if (this._rid !== null) { ops.op_fs_unwatch(this._rid); this._rid = null; queueMicrotask(() => this.emit("close")); } }
  ref() { return this; } unref() { return this; }
  [Symbol.asyncDispose]() { this.close(); return Promise.resolve(); }
}
export function watch(path, opts, listener) {
  if (typeof opts === "function") { listener = opts; opts = {}; }
  if (typeof opts === "string") opts = { encoding: opts };
  const w = new FSWatcher(path, opts || {});
  if (listener) w.on("change", listener);
  return w;
}
const watched = new Map();
export function watchFile(path, opts, listener) {
  if (typeof opts === "function") { listener = opts; opts = {}; }
  const p = toPathString(path);
  const interval = (opts && opts.interval) || 5007;
  let entry = watched.get(p);
  if (!entry) {
    const statOf = () => { try { return statSync(p); } catch { return new Stats({ dev: 0, mode: 0, nlink: 0, uid: 0, gid: 0, ino: 0, size: 0, mtime_ms: 0, atime_ms: 0, ctime_ms: 0, birthtime_ms: 0, is_file: false, is_dir: false, is_symlink: false }); } };
    entry = { listeners: new Set(), prev: statOf(), timer: null };
    entry.timer = setInterval(() => { const cur = statOf(); if (cur.mtimeMs !== entry.prev.mtimeMs || cur.size !== entry.prev.size || cur.ino !== entry.prev.ino) { const prev = entry.prev; entry.prev = cur; for (const l of entry.listeners) l(cur, prev); } }, interval);
    if (opts && opts.persistent === false && entry.timer.unref) entry.timer.unref();
    watched.set(p, entry);
  }
  entry.listeners.add(listener);
  return { ref() { return this; }, unref() { return this; } };
}
export function unwatchFile(path, listener) {
  const p = toPathString(path); const entry = watched.get(p);
  if (!entry) return;
  if (listener) entry.listeners.delete(listener); else entry.listeners.clear();
  if (entry.listeners.size === 0) { clearInterval(entry.timer); watched.delete(p); }
}
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
function asyncCallback(name) {
  return (...args) => {
    const cb = args.pop();
    if (typeof cb !== "function") throw nodeError("ERR_INVALID_ARG_TYPE", "callback must be a function", TypeError);
    // Numeric descriptors remain open after readFile/writeFile.
    if (typeof args[0] === "number") args[0] = new promises.FileHandle(args[0]);
    promises[name](...args).then(value => cb(null, value), cb);
  };
}
export const readFile = asyncCallback("readFile");
export const writeFile = asyncCallback("writeFile");
export const appendFile = asyncCallback("appendFile");
export const stat = asyncCallback("stat");
export const lstat = asyncCallback("lstat");
export const readdir = asyncCallback("readdir");
export const mkdir = asyncCallback("mkdir");
export const rm = asyncCallback("rm");
export const rmdir = asyncCallback("rmdir");
export const unlink = asyncCallback("unlink");
export const rename = asyncCallback("rename");
export const copyFile = asyncCallback("copyFile");
export const cp = asyncCallback("cp");
export const realpath = asyncCallback("realpath");
realpath.native = realpath;
export const readlink = asyncCallback("readlink");
export const symlink = asyncCallback("symlink");
export const access = asyncCallback("access");
export const chmod = asyncCallback("chmod");
export const chown = cbify(chownSync);
export const utimes = asyncCallback("utimes");
export const mkdtemp = asyncCallback("mkdtemp");
export const truncate = asyncCallback("truncate");
export function open(path, flags, mode, cb) { if (typeof mode === "function") { cb = mode; mode = undefined; } promises.open(path, flagStr(flags), mode).then(handle => cb(null, handle.fd), cb); }
export const close = (fd, cb) => new promises.FileHandle(fd).close().then(() => cb(null), cb);
export const fstat = (fd, ...args) => { const cb = args.pop(); new promises.FileHandle(fd).stat(...args).then(result => cb(null, result), cb); };
export const fsync = (fd, ...args) => { const cb = args.pop(); new promises.FileHandle(fd).sync(...args).then(result => cb(null, result), cb); };
export const fdatasync = (fd, ...args) => { const cb = args.pop(); new promises.FileHandle(fd).datasync(...args).then(result => cb(null, result), cb); };
export const ftruncate = (fd, ...args) => { const cb = args.pop(); new promises.FileHandle(fd).truncate(...args).then(result => cb(null, result), cb); };
export function read(fd, buffer, offset, length, position, cb) {
  if (typeof buffer === "function") { cb = buffer; buffer = Buffer.alloc(16384); offset = 0; length = buffer.length; position = null; }
  else if (typeof offset === "function") { cb = offset; const o = buffer && !ArrayBuffer.isView(buffer) ? buffer : {}; if (!ArrayBuffer.isView(buffer)) buffer = o.buffer ?? Buffer.alloc(16384); offset = o.offset ?? 0; length = o.length ?? buffer.length - offset; position = o.position ?? null; }
  else if (typeof length === "function") { cb = length; length = buffer.length - offset; position = null; }
  else if (typeof position === "function") { cb = position; position = null; }
  new promises.FileHandle(fd).read(buffer, offset, length, position).then(({bytesRead}) => cb(null, bytesRead, buffer), cb);
}
export function write(fd, data, ...rest) {
  const cb = rest.pop();
  new promises.FileHandle(fd).write(data, ...rest).then(({bytesWritten}) => cb(null, bytesWritten, data), cb);
}
export const readv = (fd, buffers, position, cb) => { if (typeof position === "function") { cb = position; position = undefined; } let n, err = null; try { n = readvSync(fd, buffers, position); } catch (e) { err = e; } queueMicrotask(() => (err ? cb(err) : cb(null, n, buffers))); };
export const writev = (fd, buffers, position, cb) => { if (typeof position === "function") { cb = position; position = undefined; } let n, err = null; try { n = writevSync(fd, buffers, position); } catch (e) { err = e; } queueMicrotask(() => (err ? cb(err) : cb(null, n, buffers))); };
export const opendir = asyncCallback("opendir");
export function exists(path, cb) { const r = existsSync(path); queueMicrotask(() => cb(r)); }
exists[Symbol.for("nodejs.util.promisify.custom")] = (p) => Promise.resolve(existsSync(p));

// ---------- streams (one in-flight native operation, demand-driven reads) ----------
import { Readable, Writable } from "ext:kestrel/node/stream.js";
export function createReadStream(path, opts = {}) {
  return new ReadStream(path, opts);
}
export function ReadStream(path, opts = {}) {
  if (!(this instanceof ReadStream)) return new ReadStream(path, opts);
  if (typeof opts === "string") opts = { encoding: opts };
  const r = this;
  let reading = false, position = opts.start ?? null;
  r.path = path; r.bytesRead = 0; r.fd = opts.fd ?? null; r.pending = r.fd === null;
  const opened = r.pending
    ? ops.op_fd_open_async(toPathString(path), opts.flags ?? "r", opts.mode ?? 0o666).then(fd => { r.fd = fd; r.pending = false; r.emit("open", fd); r.emit("ready"); return fd; })
    : Promise.resolve(r.fd);
  let closed;
  const closeFile = () => closed ??= opened.then(fd => { r.fd = null; return ops.op_fd_close_async(fd); });
  Readable.call(r, { ...opts, highWaterMark: opts.highWaterMark ?? 65536,
    read(size) {
      if (reading || r.destroyed) return;
      reading = true;
      (async () => {
        const fd = await opened;
        if (r.destroyed) return;
        const remaining = opts.end === undefined ? size : Math.min(size, opts.end - (position ?? r.bytesRead) + 1);
        const bytes = remaining > 0 ? await ops.op_fd_read_async(fd, remaining, position ?? -1) : new Uint8Array();
        if (r.destroyed) return;
        r.bytesRead += bytes.length;
        if (position !== null) position += bytes.length;
        reading = false;
        if (!bytes.length) { if (opts.autoClose !== false) await closeFile(); r.push(null); }
        else r.push(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
      })().catch(e => { reading = false; r.destroy(fsError(e, path)); });
    },
    destroy(err, cb) { if (opts.autoClose === false) cb(err); else closeFile().then(() => cb(err), e => cb(err || fsError(e, path))); },
  });
  opened.catch(e => r.destroy(fsError(e, path)));
  r.close = cb => { if (cb) r.once("close", cb); r.destroy(); };
  return r;
}
export function createWriteStream(path, opts = {}) {
  return new WriteStream(path, opts);
}
export function WriteStream(path, opts = {}) {
  if (!(this instanceof WriteStream)) return new WriteStream(path, opts);
  if (typeof opts === "string") opts = { encoding: opts };
  const w = this;
  let position = opts.start ?? null, closed;
  w.path = path; w.bytesWritten = 0; w.fd = opts.fd ?? null; w.pending = w.fd === null;
  const opened = w.pending
    ? ops.op_fd_open_async(toPathString(path), opts.flags ?? "w", opts.mode ?? 0o666).then(fd => { w.fd = fd; w.pending = false; w.emit("open", fd); w.emit("ready"); return fd; })
    : Promise.resolve(w.fd);
  const closeFile = () => closed ??= opened.then(fd => { w.fd = null; return ops.op_fd_close_async(fd); });
  Writable.call(w, { ...opts,
    write(chunk, enc, cb) {
      (async () => {
        const fd = await opened;
        const bytes = typeof chunk === "string" ? Buffer.from(chunk, enc) : chunk;
        for (let offset = 0; offset < bytes.length;) {
          const n = await ops.op_fd_write_async(fd, bytes.subarray(offset), position ?? -1);
          if (!n) throw new Error("EIO: write made no progress");
          offset += n; w.bytesWritten += n; if (position !== null) position += n;
        }
      })().then(() => cb(), e => cb(fsError(e, path)));
    },
    final(cb) { if (opts.autoClose === false) cb(); else closeFile().then(() => cb(), e => cb(fsError(e, path))); },
    destroy(err, cb) { if (opts.autoClose === false) cb(err); else closeFile().then(() => cb(err), e => cb(err || fsError(e, path))); },
  });
  opened.catch(e => w.destroy(fsError(e, path)));
  w.close = cb => { if (cb) w.once("close", cb); w.end(); };
  return w;
}
// Match Node's callable constructors, including util.inherits + .call(this).
Object.setPrototypeOf(ReadStream.prototype, Readable.prototype);
Object.setPrototypeOf(ReadStream, Readable);
Object.setPrototypeOf(WriteStream.prototype, Writable.prototype);
Object.setPrototypeOf(WriteStream, Writable);

import * as promises from "ext:kestrel/node/fs_promises.js";
export { promises };

const fs = {
  constants, F_OK, R_OK, W_OK, X_OK, Stats, Dirent, promises,
  readFileSync, writeFileSync, appendFileSync, existsSync, statSync, lstatSync, fstatSync, readdirSync, mkdirSync, rmSync, rmdirSync, unlinkSync, renameSync,
  copyFileSync, cpSync, realpathSync, readlinkSync, symlinkSync, accessSync, chmodSync, chownSync, utimesSync, mkdtempSync, truncateSync, openSync, closeSync, readSync, writeSync, fsyncSync, fdatasyncSync, ftruncateSync, readvSync, writevSync, opendirSync, watch, watchFile, unwatchFile, globSync,
  readFile, writeFile, appendFile, stat, lstat, fstat, readdir, mkdir, rm, rmdir, unlink, rename, copyFile, cp, realpath, readlink, symlink, access, chmod, chown, utimes, mkdtemp, truncate, open, close, read, write, readv, writev, fsync, fdatasync, ftruncate, opendir, exists,
  createReadStream, createWriteStream, ReadStream, WriteStream, FSWatcher,
};
export default fs;
