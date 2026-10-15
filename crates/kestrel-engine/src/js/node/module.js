// node:module — CommonJS loader shared by `require()` and the ESM shim for CJS files.
import { ops, nodeError } from "ext:kestrel/internal.js";
import { dirname } from "ext:kestrel/node/path.js";

export const builtinModules = ["assert", "buffer", "child_process", "crypto", "events", "fs", "fs/promises", "module", "os", "path", "path/posix", "process", "querystring", "stream", "string_decoder", "timers", "timers/promises", "tty", "url", "util", "util/types", "worker_threads", "zlib", "http", "https", "net", "readline", "tls", "dns", "dns/promises", "dgram", "perf_hooks", "v8", "vm", "cluster", "constants", "sys", "async_hooks"];
export function isBuiltin(spec) { return ops.op_k_is_builtin(String(spec)); }

const registry = new Map(); // builtin name -> module default export (set by bootstrap)
export function _registerBuiltins(map) { for (const [k, v] of Object.entries(map)) registry.set(k, v); }

const cache = Object.create(null);
let mainModule = null;

export class Module {
  constructor(id = "", parent = null) {
    this.id = id; this.path = dirname(id); this.exports = {}; this.filename = null; this.loaded = false; this.children = []; this.paths = []; this.parent = parent;
  }
  static _cache = cache;
  static _extensions = { ".js": null, ".json": null, ".node": null, ".cjs": null, ".ts": null };
  static builtinModules = builtinModules;
  static isBuiltin = isBuiltin;
  static createRequire = createRequire;
  static _nodeModulePaths(from) { const out = []; let d = from; while (d) { out.push(d + "/node_modules"); const i = d.lastIndexOf("/"); if (i <= 0) break; d = d.slice(0, i); } out.push("/node_modules"); return out; }
  static _resolveFilename(spec, parent) { return resolveFilename(spec, parent && parent.filename ? parent.filename : cwdMain()); }
  static _load(spec, parent) { return requireFrom(parent && parent.filename ? parent.filename : cwdMain())(spec); }
  static wrap(src) { return Module.wrapper[0] + src + Module.wrapper[1]; }
  static wrapper = ["(function (exports, require, module, __filename, __dirname) { ", "\n});"];
  static runMain() {}
  static syncBuiltinESMExports() {}
  static findSourceMap() { return undefined; }
  static register() {}
  static enableCompileCache() { return { status: 0 }; }
  static get SourceMap() { return class SourceMap {}; }
  require(spec) { return requireFrom(this.filename || cwdMain())(spec); }
  _compile(src, filename) { compileAndRun(this, src, filename); }
  load(filename) { this.filename = filename; loadInto(this, filename); }
}

function cwdMain() { return globalThis.process.cwd() + "/__main__"; }

function resolveFilename(spec, referrer) {
  const r = ops.op_k_resolve(String(spec), referrer, true);
  return r.startsWith("builtin:") ? r.slice(8) : r.slice(5);
}

export function createRequire(filename) {
  if (filename instanceof URL || (typeof filename === "string" && filename.startsWith("file:"))) filename = ops.op_k_url_to_path(String(filename));
  if (typeof filename !== "string") throw nodeError("ERR_INVALID_ARG_VALUE", 'The argument "filename" must be a file URL object, file URL string, or absolute path string', TypeError);
  return requireFrom(filename);
}

function requireFrom(referrer) {
  const req = function require(spec) {
    if (typeof spec !== "string") throw nodeError("ERR_INVALID_ARG_TYPE", 'The "id" argument must be of type string. Received ' + typeof spec, TypeError);
    if (spec === "") throw nodeError("ERR_INVALID_ARG_VALUE", "The argument 'id' must be a non-empty string. Received ''", TypeError);
    let r;
    try { r = ops.op_k_resolve(spec, referrer, true); }
    catch (e) { const err = new Error("Cannot find module '" + spec + "'\nRequire stack:\n- " + referrer); err.code = "MODULE_NOT_FOUND"; err.requireStack = [referrer]; throw err; }
    if (r.startsWith("builtin:")) {
      const name = r.slice(8);
      const m = registry.get(name);
      if (m === undefined) throw nodeError("ERR_UNKNOWN_BUILTIN_MODULE", "No such built-in module: " + spec);
      return m;
    }
    return loadFile(r.slice(5), referrer);
  };
  req.resolve = (spec, opts) => resolveFilename(spec, referrer);
  req.resolve.paths = (spec) => isBuiltin(spec) ? null : Module._nodeModulePaths(dirname(referrer));
  req.cache = cache;
  req.main = mainModule;
  req.extensions = Module._extensions;
  return req;
}

let requireLog = null; // resolved lazily: env is not available at snapshot time
function loadFile(filename, parentFilename) {
  const cached = cache[filename];
  if (cached) return cached.exports;
  if (requireLog === null) requireLog = !!globalThis.process.env.KESTREL_REQUIRE_LOG;
  if (requireLog) Deno.core.print("[require] " + filename + "\n", true);
  const module = new Module(filename, cache[parentFilename] || null);
  module.filename = filename;
  module.paths = Module._nodeModulePaths(dirname(filename));
  if (!mainModule) { mainModule = module; globalThis.process.mainModule = module; }
  cache[filename] = module;
  try { loadInto(module, filename); }
  catch (e) { delete cache[filename]; throw e; }
  return module.exports;
}

function loadInto(module, filename) {
  if (filename.endsWith(".json")) {
    const src = ops.op_k_fs_read_text(filename);
    try { module.exports = JSON.parse(src); } catch (e) { e.message = filename + ": " + e.message; throw e; }
    module.loaded = true;
    return;
  }
  if (filename.endsWith(".node")) throw nodeError("ERR_DLOPEN_FAILED", "Native addons (.node) are not supported: " + filename);
  let src = ops.op_k_fs_read_text(filename);
  if (/\.(ts|cts|mts|tsx)$/.test(filename)) src = ops.op_k_transpile(filename, src);
  // require(esm): rewrite ES module syntax to CommonJS on the fly (like Node 22).
  if (ops.op_k_module_format(filename, src) === "esm") src = ops.op_k_esm_to_cjs(filename, src);
  compileAndRun(module, src, filename);
  module.loaded = true;
}

function compileAndRun(module, src, filename) {
  if (src.startsWith("#!")) src = "//" + src;
  // Function constructor (not eval) so the module gets its own scope; sourceURL keeps stack traces readable.
  let fn;
  try { fn = new Function("exports", "require", "module", "__filename", "__dirname", src + "\n//# sourceURL=" + filename); }
  catch (e) { if (e instanceof SyntaxError) e.message += "\n    at " + filename; throw e; }
  const require = requireFrom(filename);
  fn.call(module.exports, module.exports, require, module, filename, dirname(filename));
}

// Used by the ESM loader's CommonJS shim.
globalThis[Symbol.for("kestrel.require")] = (filename) => loadFile(filename, filename);

export const _cache = cache;
export const _extensions = Module._extensions;
export const wrap = Module.wrap;
export const wrapper = Module.wrapper;
export const _nodeModulePaths = Module._nodeModulePaths;
export const _resolveFilename = Module._resolveFilename;
export const _load = Module._load;
export const runMain = Module.runMain;
export const syncBuiltinESMExports = Module.syncBuiltinESMExports;
export const findSourceMap = Module.findSourceMap;
export const register = Module.register;
export const enableCompileCache = Module.enableCompileCache;
export default Module;
