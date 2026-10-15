// node:inspector — no debugger protocol is wired up; the API surface exists so modules load.
import { EventEmitter } from "ext:kestrel/node/events.js";
import { nodeError } from "ext:kestrel/internal.js";
export class Session extends EventEmitter {
  connect() {} connectToMainThread() {} disconnect() {}
  post(method, params, cb) { if (typeof params === "function") cb = params; const e = nodeError("ERR_INSPECTOR_NOT_AVAILABLE", "Inspector is not available in kestrel"); if (cb) queueMicrotask(() => cb(e)); }
}
export function open() {} export function close() {} export function url() { return undefined; } export function waitForDebugger() {}
export const console = globalThis.console;
export default { Session, open, close, url, waitForDebugger, console };
