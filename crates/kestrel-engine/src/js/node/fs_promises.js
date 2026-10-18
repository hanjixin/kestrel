// node:fs/promises — native pool operations keep filesystem work off the isolate.
import * as fs from "ext:kestrel/node/fs.js";
import { ops, fsError, toPathString, nodeError } from "ext:kestrel/internal.js";

// `fs` and this module import each other; resolve the sync function at call time.
const p = (name) => (...args) => { try { return Promise.resolve(fs[name](...args)); } catch (e) { return Promise.reject(e); } };

const encoding = options => typeof options === "string" ? options : options?.encoding;
export async function readFile(path, options) {
  if (path instanceof FileHandle) return path.readFile(options);
  try {
    const bytes = await ops.op_k_fs_read_async(toPathString(path));
    const buffer = globalThis.Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return encoding(options) ? buffer.toString(encoding(options)) : buffer;
  } catch (e) { throw fsError(e, path); }
}
export async function writeFile(path, data, options) {
  if (path instanceof FileHandle) return path.writeFile(data, options);
  const bytes = typeof data === "string" ? globalThis.Buffer.from(data, encoding(options) || "utf8") : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  try { await ops.op_k_fs_write_async(toPathString(path), bytes, options?.flag || "w", options?.mode ?? 0o666); }
  catch (e) { throw fsError(e, path); }
}
export function appendFile(path, data, options) { return writeFile(path, data, { ...(typeof options === "string" ? { encoding: options } : options), flag: options?.flag || "a" }); }
async function native(name, path, ...args) {
  try { return await ops["op_k_fs_" + name + "_async"](toPathString(path), ...args); }
  catch (e) { throw fsError(e, path); }
}
export async function stat(path) { return new fs.Stats(await native("stat", path, true)); }
export async function lstat(path) { return new fs.Stats(await native("stat", path, false)); }
export async function readdir(path, options) {
  const base = toPathString(path), out = [];
  const walk = async (dir, rel) => {
    for (const [name, kind] of await native("readdir", dir)) {
      out.push(options?.withFileTypes ? new fs.Dirent(name, kind, dir) : rel + name);
      if (options?.recursive && kind === 2) await walk(dir + "/" + name, rel + name + "/");
    }
  };
  await walk(base, ""); return out;
}
export async function mkdir(path, options) {
  const recursive = !!options?.recursive;
  let first;
  if (recursive) {
    let current = toPathString(path);
    for (;;) {
      try { await stat(current); break; }
      catch (e) { if (e.code !== "ENOENT") throw e; first = current; }
      const slash = current.lastIndexOf("/");
      if (slash < 0) break;
      current = slash ? current.slice(0, slash) : "/";
    }
  }
  await native("mkdir", path, recursive, typeof options === "number" ? options : options?.mode ?? 0o777);
  return first;
}
export const rm = (path, options) => native("remove", path, !!options?.recursive, !!options?.force);
export const rmdir = (path, options) => native("remove", path, !!options?.recursive, false);
export const unlink = path => native("remove", path, false, false);
export const rename = (from, to) => native("rename", from, toPathString(to));
export async function copyFile(from, to, mode) {
  if (mode & 1) {
    try { await stat(to); throw fsError(new Error("EEXIST: file already exists, copyfile"), to); }
    catch (e) { if (e.code !== "ENOENT") throw e; }
  }
  await native("copy", from, toPathString(to));
}
export async function cp(from, to, options = {}) {
  const source = toPathString(from), dest = toPathString(to);
  if ((await stat(source)).isDirectory()) {
    if (!options.recursive) throw nodeError("ERR_FS_EISDIR", "Recursive option is required");
    await mkdir(dest, { recursive: true });
    for (const name of await readdir(source)) await cp(source + "/" + name, dest + "/" + name, options);
  } else await copyFile(source, dest);
}
export async function realpath(path, options) { const result = await native("realpath", path); return encoding(options) === "buffer" ? globalThis.Buffer.from(result) : result; }
export const readlink = path => native("readlink", path);
export const symlink = (target, path) => native("symlink", target, toPathString(path));
export async function access(path) { await stat(path); }
export const chmod = (path, mode) => native("chmod", path, typeof mode === "string" ? parseInt(mode, 8) : mode);
export const chown = p("chownSync");
export const utimes = (path, atime, mtime) => native("utimes", path, atime instanceof Date ? atime.getTime() : Number(atime) * 1000, mtime instanceof Date ? mtime.getTime() : Number(mtime) * 1000);
export const mkdtemp = prefix => native("mkdtemp", prefix);
export async function truncate(path, length = 0) { const handle = await open(path, "r+"); try { await handle.truncate(length); } finally { await handle.close(); } }
export async function opendir(path) {
  const entries = await readdir(path, { withFileTypes: true }); let index = 0;
  return { path: toPathString(path), readSync: () => entries[index++] ?? null,
    async read() { return entries[index++] ?? null; }, async close() {}, closeSync() {},
    async *[Symbol.asyncIterator]() { while (index < entries.length) yield entries[index++]; } };
}
export const constants = { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1, COPYFILE_EXCL: 1, COPYFILE_FICLONE: 2, COPYFILE_FICLONE_FORCE: 4 };
export class FileHandle {
  constructor(fd, path) { this.fd = fd; this._path = path; }
  async read(buffer, offset, length, position) {
    if (buffer === undefined || (buffer && !ArrayBuffer.isView(buffer))) { const o = buffer || {}; buffer = o.buffer ?? globalThis.Buffer.alloc(16384); offset = o.offset ?? 0; length = o.length ?? buffer.byteLength - offset; position = o.position ?? null; }
    const bytes = await ops.op_fd_read_async(this.fd, length ?? buffer.byteLength - (offset ?? 0), position ?? -1);
    new Uint8Array(buffer.buffer, buffer.byteOffset + (offset ?? 0), bytes.length).set(bytes);
    const bytesRead = bytes.length;
    return { bytesRead, buffer };
  }
  async write(data, offset, length, position = null) {
    let bytes;
    if (typeof data === "string") { bytes = globalThis.Buffer.from(data, typeof length === "string" ? length : "utf8"); position = offset ?? -1; }
    else { offset ??= 0; bytes = new Uint8Array(data.buffer, data.byteOffset + offset, length ?? data.byteLength - offset); }
    const bytesWritten = await ops.op_fd_write_async(this.fd, bytes, position ?? -1);
    return { bytesWritten, buffer: data };
  }
  async readFile(opts) {
    const chunks = [];
    for (;;) { const b = await ops.op_fd_read_async(this.fd, 65536, -1); if (!b.length) break; chunks.push(b); }
    const data = globalThis.Buffer.concat(chunks);
    return encoding(opts) ? data.toString(encoding(opts)) : data;
  }
  async writeFile(data, opts) {
    const bytes = typeof data === "string" ? globalThis.Buffer.from(data, encoding(opts) || "utf8") : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    for (let offset = 0; offset < bytes.length;) offset += await ops.op_fd_write_async(this.fd, bytes.subarray(offset), -1);
  }
  async appendFile(data, opts) { await this.writeFile(data, opts); }
  async stat() { return new fs.Stats(await ops.op_fd_stat_async(this.fd)); }
  async truncate(len = 0) { if (!Number.isInteger(len) || len < 0) throw new RangeError("invalid length"); await ops.op_fd_control_async(this.fd, true, len); }
  async sync() { await ops.op_fd_control_async(this.fd, false, 0); }
  async datasync() { await this.sync(); }
  async close() { if (this.fd >= 0) { const fd = this.fd; this.fd = -1; await ops.op_fd_close_async(fd); } }
  async chmod(mode) { if (this._path) await chmod(this._path, mode); }
  async utimes(a, m) { if (this._path) await utimes(this._path, a, m); }
  createReadStream(opts) { return fs.createReadStream(this._path, { autoClose: false, ...opts, fd: this.fd }); }
  createWriteStream(opts) { return fs.createWriteStream(this._path, { autoClose: false, ...opts, fd: this.fd }); }
  async *readLines() { const lines = (await this.readFile("utf8")).split(/\r?\n/); if (lines.at(-1) === "") lines.pop(); yield* lines; }
  [Symbol.asyncDispose]() { return this.close(); }
}
export async function open(path, flags = "r", mode) {
  const p = typeof path === "string" ? path : String(path);
  return new FileHandle(await ops.op_fd_open_async(p, flags, mode ?? 0o666), p);
}
export function watch() { throw nodeError("ERR_METHOD_NOT_IMPLEMENTED", "fs.promises.watch is not implemented yet"); }
export function glob() { throw nodeError("ERR_METHOD_NOT_IMPLEMENTED", "fs.promises.glob is not implemented yet"); }

export default { readFile, writeFile, appendFile, stat, lstat, readdir, mkdir, rm, rmdir, unlink, rename, copyFile, cp, realpath, readlink, symlink, access, chmod, chown, utimes, mkdtemp, truncate, opendir, open, FileHandle, watch, glob, constants };
