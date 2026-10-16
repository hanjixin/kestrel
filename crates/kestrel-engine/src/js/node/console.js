// node:console — the Console class plus the global console (undici and others require it).
import { format } from "ext:kestrel/internal.js";

export class Console {
  constructor(stdout, stderr, options) {
    if (stdout && typeof stdout === "object" && !stderr && stdout.stdout) { options = stdout; stdout = options.stdout; stderr = options.stderr; }
    this._out = stdout || globalThis.process.stdout;
    this._err = stderr || globalThis.process.stderr || this._out;
    this._counts = new Map(); this._timers = new Map(); this._groupIndent = "";
    const write = (stream, args) => { const s = this._groupIndent + format(...args) + "\n"; if (stream && stream.write) stream.write(s); };
    this.log = this.info = this.debug = this.dir = (...a) => write(this._out, a);
    this.error = this.warn = this.trace = (...a) => write(this._err, a);
    this.trace = (...a) => write(this._err, ["Trace:", ...a]);
  }
  assert(cond, ...a) { if (!cond) this.error("Assertion failed:", ...a); }
  count(label = "default") { const n = (this._counts.get(label) || 0) + 1; this._counts.set(label, n); this.log(`${label}: ${n}`); }
  countReset(label = "default") { this._counts.delete(label); }
  group(...a) { if (a.length) this.log(...a); this._groupIndent += "  "; }
  groupCollapsed(...a) { this.group(...a); }
  groupEnd() { this._groupIndent = this._groupIndent.slice(2); }
  time(label = "default") { this._timers.set(label, Date.now()); }
  timeEnd(label = "default") { const t = this._timers.get(label); if (t !== undefined) { this.log(`${label}: ${Date.now() - t}ms`); this._timers.delete(label); } }
  timeLog(label = "default", ...a) { const t = this._timers.get(label); if (t !== undefined) this.log(`${label}: ${Date.now() - t}ms`, ...a); }
  table(data) { this.log(data); }
  clear() {}
  dirxml(...a) { this.log(...a); }
}
const consoleModule = globalThis.console;
try { if (consoleModule && !consoleModule.Console) consoleModule.Console = Console; } catch {}
export default consoleModule;
