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
export async function open(path, flags = "r") {
  // Minimal FileHandle: whole-file semantics.
  const fh = {
    fd: 3,
    async readFile(opts) { return fs.readFileSync(path, opts); },
    async writeFile(data, opts) { return fs.writeFileSync(path, data, { ...(typeof opts === "string" ? { encoding: opts } : opts), flag: flags }); },
    async appendFile(data, opts) { return fs.appendFileSync(path, data, opts); },
    async stat() { return fs.statSync(path); },
    async close() {},
    async truncate(len) { return fs.truncateSync(path, len); },
    async read() { throw nodeError("ERR_METHOD_NOT_IMPLEMENTED", "FileHandle.read is not implemented yet"); },
    async write(data) { fs.appendFileSync(path, data); return { bytesWritten: data.length, buffer: data }; },
    createReadStream(opts) { return fs.createReadStream(path, opts); },
    createWriteStream(opts) { return fs.createWriteStream(path, opts); },
    [Symbol.asyncDispose]() { return this.close(); },
  };
  if (flags.startsWith("w")) fs.writeFileSync(path, "");
  else if (flags.startsWith("r")) fs.statSync(path);
  return fh;
}
export function watch() { throw nodeError("ERR_METHOD_NOT_IMPLEMENTED", "fs.promises.watch is not implemented yet"); }
export function glob() { throw nodeError("ERR_METHOD_NOT_IMPLEMENTED", "fs.promises.glob is not implemented yet"); }

export default { readFile, writeFile, appendFile, stat, lstat, readdir, mkdir, rm, rmdir, unlink, rename, copyFile, cp, realpath, readlink, symlink, access, chmod, chown, utimes, mkdtemp, truncate, opendir, open, watch, glob, constants };
