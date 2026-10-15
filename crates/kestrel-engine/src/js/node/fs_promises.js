// node:fs/promises — promise wrappers over the synchronous core (the calls block the thread for now).
import * as fs from "ext:kestrel/node/fs.js";
import { nodeError } from "ext:kestrel/internal.js";

// `fs` and this module import each other; resolve the sync function at call time.
const p = (name) => (...args) => { try { return Promise.resolve(fs[name](...args)); } catch (e) { return Promise.reject(e); } };

export const readFile = p("readFileSync");
export const writeFile = p("writeFileSync");
export const appendFile = p("appendFileSync");
export const stat = p("statSync");
export const lstat = p("lstatSync");
export const readdir = p("readdirSync");
export const mkdir = p("mkdirSync");
export const rm = p("rmSync");
export const rmdir = p("rmdirSync");
export const unlink = p("unlinkSync");
export const rename = p("renameSync");
export const copyFile = p("copyFileSync");
export const cp = p("cpSync");
export const realpath = p("realpathSync");
export const readlink = p("readlinkSync");
export const symlink = p("symlinkSync");
export const access = p("accessSync");
export const chmod = p("chmodSync");
export const chown = p("chownSync");
export const utimes = p("utimesSync");
export const mkdtemp = p("mkdtempSync");
export const truncate = p("truncateSync");
export const opendir = p("opendirSync");
export const constants = { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1, COPYFILE_EXCL: 1, COPYFILE_FICLONE: 2, COPYFILE_FICLONE_FORCE: 4 };
export class FileHandle {
  constructor(fd, path) { this.fd = fd; this._path = path; }
  async read(buffer, offset, length, position) {
    if (buffer === undefined || (buffer && !ArrayBuffer.isView(buffer))) { const o = buffer || {}; buffer = o.buffer ?? globalThis.Buffer.alloc(16384); offset = o.offset ?? 0; length = o.length ?? buffer.byteLength - offset; position = o.position ?? null; }
    const bytesRead = fs.readSync(this.fd, buffer, offset ?? 0, length ?? buffer.byteLength - (offset ?? 0), position ?? null);
    return { bytesRead, buffer };
  }
  async write(data, ...rest) { const bytesWritten = fs.writeSync(this.fd, data, ...rest); return { bytesWritten, buffer: data }; }
  async readFile(opts) { const data = fs.readFileSync(this.fd, opts); return data; }
  async writeFile(data, opts) { fs.writeSync(this.fd, typeof data === "string" ? data : data, typeof opts === "string" ? undefined : undefined); }
  async appendFile(data) { fs.writeSync(this.fd, data); }
  async stat() { return fs.fstatSync(this.fd); }
  async truncate(len) { fs.ftruncateSync(this.fd, len); }
  async sync() { fs.fsyncSync(this.fd); }
  async datasync() { fs.fsyncSync(this.fd); }
  async close() { if (this.fd >= 0) { fs.closeSync(this.fd); this.fd = -1; } }
  async chmod(mode) { if (this._path) fs.chmodSync(this._path, mode); }
  async utimes(a, m) { if (this._path) fs.utimesSync(this._path, a, m); }
  createReadStream(opts) { return fs.createReadStream(this._path, opts); }
  createWriteStream(opts) { return fs.createWriteStream(this._path, opts); }
  readLines() { const text = fs.readFileSync(this.fd, "utf8"); const lines = text.split(/\r?\n/); if (lines.at(-1) === "") lines.pop(); return { async *[Symbol.asyncIterator]() { yield* lines; } }; }
  [Symbol.asyncDispose]() { return this.close(); }
}
export async function open(path, flags = "r", mode) {
  const p = typeof path === "string" ? path : String(path);
  return new FileHandle(fs.openSync(p, flags, mode), p);
}
export function watch() { throw nodeError("ERR_METHOD_NOT_IMPLEMENTED", "fs.promises.watch is not implemented yet"); }
export function glob() { throw nodeError("ERR_METHOD_NOT_IMPLEMENTED", "fs.promises.glob is not implemented yet"); }

export default { readFile, writeFile, appendFile, stat, lstat, readdir, mkdir, rm, rmdir, unlink, rename, copyFile, cp, realpath, readlink, symlink, access, chmod, chown, utimes, mkdtemp, truncate, opendir, open, FileHandle, watch, glob, constants };
