// node:vm — scripts in this context or a fresh V8 context seeded from a sandbox object.
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
export default { createContext, isContext, runInThisContext, runInNewContext, runInContext, Script, compileFunction, measureMemory, constants };
