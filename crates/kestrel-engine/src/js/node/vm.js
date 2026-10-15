// node:vm — scripts in this context or a fresh V8 context seeded from a sandbox object,
// and ES modules (SourceTextModule / SyntheticModule) over V8's module API.
import { ops, nodeError } from "ext:kestrel/internal.js";
const kCtx = Symbol("vm.context");
export function createContext(sandbox = {}) { Object.defineProperty(sandbox, kCtx, { value: true, enumerable: false, configurable: true }); return sandbox; }
export function isContext(o) { return !!(o && o[kCtx]); }
const fname = (o) => (typeof o === "string" ? o : (o && o.filename) || "evalmachine.<anonymous>");
export function runInThisContext(code, options) { return ops.op_vm_run_in_this_context(String(code), fname(options)); }
export function runInNewContext(code, sandbox = {}, options) { return ops.op_vm_run_in_new_context(String(code), sandbox, fname(options)); }
export function runInContext(code, context, options) { if (!isContext(context)) throw nodeError("ERR_INVALID_ARG_TYPE", 'The "contextifiedObject" argument must be an vm.Context', TypeError); return runInNewContext(code, context, options); }
export class Script {
  constructor(code, options) { this.code = String(code); this.filename = fname(options); if (typeof options === "object" && options && options.filename === undefined) this.filename = "evalmachine.<anonymous>"; }
  runInThisContext() { return runInThisContext(this.code, this.filename); }
  runInNewContext(sandbox, options) { return runInNewContext(this.code, sandbox, options ?? this.filename); }
  runInContext(context, options) { return runInContext(this.code, context, options ?? this.filename); }
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
    this[kId] = ops.op_vm_module_compile(code, this._identifier, ctx);
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
