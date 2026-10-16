// node:vm — scripts in this context or a fresh V8 context seeded from a sandbox object,
// and ES modules (SourceTextModule / SyntheticModule) over V8's module API.
import { ops, nodeError } from "ext:kestrel/internal.js";
const kCtx = Symbol("vm.context");
export function createContext(sandbox = {}) { Object.defineProperty(sandbox, kCtx, { value: true, enumerable: false, configurable: true }); return sandbox; }
export function isContext(o) { return !!(o && o[kCtx]); }
const fname = (o) => (typeof o === "string" ? o : (o && o.filename) || "evalmachine.<anonymous>");
// `importModuleDynamically`: a function (wrapped so `import()` resolves to a namespace), the
// USE_MAIN_CONTEXT_DEFAULT_LOADER constant (main loader), or absent (import() rejects with
// ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING, as in Node).
function dynOf(options, referrer) {
  const d = options && typeof options === "object" ? options.importModuleDynamically : undefined;
  if (d === undefined) return [null, false];
  if (d === constants.USE_MAIN_CONTEXT_DEFAULT_LOADER) return [null, true];
  if (typeof d !== "function") throw nodeError("ERR_INVALID_ARG_TYPE", 'The "options.importModuleDynamically" property must be of type function', TypeError);
  const wrap = (specifier, attributes) => (async () => {
    const m = await d(specifier, referrer(), attributes);
    if (m instanceof Module) {
      // As in Node: the module is returned as is (the callback evaluates it if it wants to).
      if (m.status === "errored") throw m.error;
      return m.namespace;
    }
    if (m !== null && typeof m === "object" && m[Symbol.toStringTag] === "Module") return m;
    throw nodeError("ERR_VM_MODULE_NOT_MODULE", "Provided module is not an instance of Module");
  })();
  return [wrap, false];
}
export function runInThisContext(code, options) { const [dyn, dl] = dynOf(options, () => undefined); return ops.op_vm_run_in_this_context(String(code), fname(options), dyn, dl); }
export function runInNewContext(code, sandbox = {}, options) { const [dyn, dl] = dynOf(options, () => undefined); return ops.op_vm_run_in_new_context(String(code), sandbox, fname(options), dyn, dl); }
export function runInContext(code, context, options) { if (!isContext(context)) throw nodeError("ERR_INVALID_ARG_TYPE", 'The "contextifiedObject" argument must be an vm.Context', TypeError); return runInNewContext(code, context, options); }
export class Script {
  constructor(code, options) {
    this.code = String(code); this.filename = fname(options); if (typeof options === "object" && options && options.filename === undefined) this.filename = "evalmachine.<anonymous>";
    [this._dyn, this._dl] = dynOf(options, () => this);
  }
  runInThisContext() { return ops.op_vm_run_in_this_context(this.code, this.filename, this._dyn, this._dl); }
  runInNewContext(sandbox = {}, options) { return ops.op_vm_run_in_new_context(this.code, sandbox, fname(options ?? this.filename), this._dyn, this._dl); }
  runInContext(context, options) { if (!isContext(context)) throw nodeError("ERR_INVALID_ARG_TYPE", 'The "contextifiedObject" argument must be an vm.Context', TypeError); return this.runInNewContext(context, options); }
  createCachedData() { return new Uint8Array(0); }
}
export function compileFunction(code, params = [], options = {}) { const f = new Function(...params, String(code)); return f; }
export function measureMemory() { return Promise.resolve({ total: { jsMemoryEstimate: 0, jsMemoryRange: [0, 0] } }); }
export const constants = { USE_MAIN_CONTEXT_DEFAULT_LOADER: Symbol("USE_MAIN_CONTEXT_DEFAULT_LOADER"), DONT_CONTEXTIFY: Symbol("DONT_CONTEXTIFY") };

// ---------- ES modules ----------
const kId = Symbol("vm.module.id");
const kLink = Symbol("vm.module.link");
let moduleCounter = 0;
function contextArg(options) {
  if (options.context === undefined) return null;
  if (!isContext(options.context)) throw nodeError("ERR_INVALID_ARG_TYPE", 'The "options.context" property must be an instance of Context', TypeError);
  return options.context;
}
export class Module {
  constructor() { if (new.target === Module) throw nodeError("ERR_CONSTRUCT_CALL_INVALID", "Constructor cannot be called", TypeError); this._status = "unlinked"; this._deps = []; }
  get identifier() { return this._identifier; }
  get context() { return this._context; }
  get dependencySpecifiers() { return this._deps; }
  get status() {
    const s = ops.op_vm_module_status(this[kId]);
    return s === "uninstantiated" || s === "instantiating" ? this._status : s;
  }
  get namespace() {
    const s = this.status;
    if (s === "unlinked" || s === "linking") throw nodeError("ERR_VM_MODULE_STATUS", "Module status must not be unlinked or linking");
    return ops.op_vm_module_namespace(this[kId]);
  }
  get error() {
    if (this.status !== "errored") throw nodeError("ERR_VM_MODULE_STATUS", "Module status must be errored");
    return ops.op_vm_module_error(this[kId]);
  }
  async link(linker) {
    if (typeof linker !== "function") throw nodeError("ERR_INVALID_ARG_TYPE", 'The "linker" argument must be of type function. Received ' + typeof linker, TypeError);
    if (this._status !== "unlinked") throw nodeError("ERR_VM_MODULE_STATUS", "Module status must be unlinked");
    await this[kLink](linker);
    ops.op_vm_module_instantiate(this[kId]);
  }
  async [kLink](linker) {
    if (this._status !== "unlinked") return;
    this._status = "linking";
    const linked = [];
    for (const spec of this._deps) {
      const m = await linker(spec, this, { attributes: Object.create(null), assert: Object.create(null) });
      if (!(m instanceof Module)) throw nodeError("ERR_VM_MODULE_NOT_MODULE", "Provided module is not an instance of Module");
      if (m._context !== this._context) throw nodeError("ERR_VM_MODULE_DIFFERENT_CONTEXT", "Linked modules must use the same context");
      await m[kLink](linker);
      linked.push([spec, m[kId]]);
    }
    ops.op_vm_module_link(this[kId], linked);
    this._status = "linked";
  }
  async evaluate(options = {}) {
    const s = this.status;
    if (s === "unlinked" || s === "linking") throw nodeError("ERR_VM_MODULE_STATUS", "Module status must be one of linked, evaluated, or errored");
    if (s === "errored") throw this.error;
    if (options.timeout !== undefined && (!Number.isInteger(options.timeout) || options.timeout <= 0)) throw nodeError("ERR_OUT_OF_RANGE", 'The value of "options.timeout" is out of range', RangeError);
    await ops.op_vm_module_evaluate(this[kId]);
  }
  [Symbol.for("nodejs.util.inspect.custom")]() { return `${this.constructor.name} { status: '${this.status}', identifier: '${this._identifier}' }`; }
}
export class SourceTextModule extends Module {
  constructor(code, options = {}) {
    super();
    if (typeof code !== "string") throw nodeError("ERR_INVALID_ARG_TYPE", 'The "sourceText" argument must be of type string', TypeError);
    if (options === null || typeof options !== "object") throw nodeError("ERR_INVALID_ARG_TYPE", 'The "options" argument must be of type object', TypeError);
    const ctx = contextArg(options);
    this._context = ctx ?? undefined;
    this._identifier = options.identifier !== undefined ? String(options.identifier) : `vm:module(${moduleCounter++})`;
    const [dyn, dl] = dynOf(options, () => this);
    if (options.initializeImportMeta !== undefined && typeof options.initializeImportMeta !== "function") throw nodeError("ERR_INVALID_ARG_TYPE", 'The "options.initializeImportMeta" property must be of type function', TypeError);
    const meta = options.initializeImportMeta ? (m) => options.initializeImportMeta(m, this) : null;
    this[kId] = ops.op_vm_module_compile(code, this._identifier, ctx, dyn, dl, meta);
    this._deps = Object.freeze(ops.op_vm_module_requests(this[kId]));
  }
  createCachedData() { return new Uint8Array(0); }
}
export class SyntheticModule extends Module {
  constructor(exportNames, evaluateCallback, options = {}) {
    super();
    if (!Array.isArray(exportNames) || exportNames.some((n) => typeof n !== "string")) throw nodeError("ERR_INVALID_ARG_TYPE", 'The "exportNames" argument must be an Array of unique strings', TypeError);
    if (typeof evaluateCallback !== "function") throw nodeError("ERR_INVALID_ARG_TYPE", 'The "evaluateCallback" argument must be of type function', TypeError);
    const ctx = contextArg(options);
    this._context = ctx ?? undefined;
    this._identifier = options.identifier !== undefined ? String(options.identifier) : `vm:module(${moduleCounter++})`;
    this[kId] = ops.op_vm_synthetic_create(this._identifier, exportNames, ctx, () => evaluateCallback.call(this));
  }
  setExport(name, value) {
    if (typeof name !== "string") throw nodeError("ERR_INVALID_ARG_TYPE", 'The "name" argument must be of type string', TypeError);
    ops.op_vm_synthetic_set_export(this[kId], name, value);
  }
}

export default { createContext, isContext, runInThisContext, runInNewContext, runInContext, Script, compileFunction, measureMemory, constants, Module, SourceTextModule, SyntheticModule };
