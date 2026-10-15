// node:child_process — spawn/exec/execFile/fork and the *Sync variants on native ops.
import { ops, nodeError, utf8Decode } from "ext:kestrel/internal.js";
import { EventEmitter } from "ext:kestrel/node/events.js";
import { Readable, Writable } from "ext:kestrel/node/stream.js";
import { Buffer } from "ext:kestrel/node/buffer.js";

const SIGNALS = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGILL: 4, SIGTRAP: 5, SIGABRT: 6, SIGBUS: 7, SIGFPE: 8, SIGKILL: 9, SIGUSR1: 10, SIGSEGV: 11, SIGUSR2: 12, SIGPIPE: 13, SIGALRM: 14, SIGTERM: 15, SIGCHLD: 17, SIGCONT: 18, SIGSTOP: 19, SIGTSTP: 20, SIGWINCH: 28 };
const SIGNAL_NAMES = Object.fromEntries(Object.entries(SIGNALS).map(([k, v]) => [v, k]));
if (globalThis.process.platform === "darwin") { SIGNALS.SIGUSR1 = 30; SIGNALS.SIGUSR2 = 31; SIGNALS.SIGCHLD = 20; SIGNALS.SIGCONT = 19; SIGNALS.SIGSTOP = 17; SIGNALS.SIGTSTP = 18; SIGNALS.SIGBUS = 10; for (const [k, v] of Object.entries(SIGNALS)) SIGNAL_NAMES[v] = k; }
const sigNum = (s) => (typeof s === "number" ? s : SIGNALS[s] ?? SIGNALS.SIGTERM);

function normStdio(stdio) {
  if (stdio === undefined) stdio = "pipe";
  if (typeof stdio === "string") stdio = [stdio, stdio, stdio];
  const out = [];
  for (let i = 0; i < 3; i++) {
    const v = stdio[i] ?? "pipe";
    out.push(v === "inherit" || v === "ignore" ? v : v === "pipe" || v === "overlapped" || v === null || v === undefined ? "pipe" : typeof v === "object" && v && (v.fd === i || v === globalThis.process.stdout || v === globalThis.process.stderr || v === globalThis.process.stdin) ? "inherit" : v === 0 || v === 1 || v === 2 ? "inherit" : "pipe");
  }
  return out;
}
function envList(env) {
  if (!env) return null;
  return Object.keys(env).filter((k) => env[k] !== undefined).map((k) => [k, String(env[k])]);
}
function buildOpts(file, args, options, shellDefault) {
  options = options || {};
  const shell = options.shell === undefined ? shellDefault : options.shell;
  let cmd = file, argv = Array.isArray(args) ? args.map(String) : [];
  if (shell) {
    // Node joins file and args for the shell command line.
    cmd = [file, ...argv].join(" ");
    argv = [];
  }
  return { cmd, args: argv, cwd: options.cwd ? String(options.cwd) : null, env: envList(options.env), stdio: normStdio(options.stdio), shell: !!shell, detached: !!options.detached };
}

export class ChildProcess extends EventEmitter {
  constructor() {
    super();
    this.pid = undefined; this.exitCode = null; this.signalCode = null; this.killed = false; this.connected = false; this.spawnfile = ""; this.spawnargs = [];
    this.stdin = null; this.stdout = null; this.stderr = null; this.stdio = [null, null, null];
    this._rid = null; this._pending = 0;
  }
  _start(o, file, args) {
    this.spawnfile = file; this.spawnargs = [file, ...args];
    let rid, pid;
    try { [rid, pid] = ops.op_cp_spawn(o); }
    catch (e) {
      const err = nodeError(/^([A-Z]+):/.exec(e.message)?.[1] ?? "ENOENT", e.message); err.syscall = "spawn " + file; err.path = file; err.spawnargs = args;
      queueMicrotask(() => { this.emit("error", err); this.emit("close", -2, null); });
      return this;
    }
    this._rid = rid; this.pid = pid;
    if (o.stdio[0] === "pipe") {
      this.stdin = new Writable({ write: (chunk, enc, cb) => { ops.op_cp_write(rid, typeof chunk === "string" ? Buffer.from(chunk, enc) : chunk).then(() => cb(), (e) => cb(e)); }, final: (cb) => { ops.op_cp_close_stdin(rid); cb(); } });
      this.stdin.on("error", () => {});
    }
    const pipe = (which) => {
      const r = new Readable({ read() {} });
      this._pending++;
      (async () => {
        try { for (;;) { const chunk = await ops.op_cp_read(rid, which); if (chunk.length === 0) break; r.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)); } }
        catch {}
        r.push(null);
        if (--this._pending === 0 && this._exited) this._close();
      })();
      return r;
    };
    if (o.stdio[1] === "pipe") this.stdout = pipe(1);
    if (o.stdio[2] === "pipe") this.stderr = pipe(2);
    this.stdio = [this.stdin, this.stdout, this.stderr];
    queueMicrotask(() => this.emit("spawn"));
    ops.op_cp_wait(rid).then(([code, sig]) => {
      this._exited = true;
      this.exitCode = sig ? null : code; this.signalCode = sig ? SIGNAL_NAMES[sig] || String(sig) : null;
      this.emit("exit", this.exitCode, this.signalCode);
      if (this._pending === 0) this._close();
    }, (e) => this.emit("error", e));
    return this;
  }
  _close() { if (this._closed) return; this._closed = true; this.emit("close", this.exitCode, this.signalCode); }
  kill(signal = "SIGTERM") { if (this._rid === null) return false; const ok = ops.op_cp_kill(this._rid, sigNum(signal)); if (ok) this.killed = true; return ok; }
  ref() {} unref() {} disconnect() {}
  send() { throw nodeError("ERR_IPC_CHANNEL_CLOSED", "IPC channels are not supported in kestrel yet"); }
  [Symbol.dispose]() { this.kill(); }
}

export function spawn(file, args, options) {
  if (!Array.isArray(args)) { options = args; args = []; }
  const o = buildOpts(String(file), args, options, false);
  return new ChildProcess()._start(o, String(file), args.map(String));
}

function collect(child, options, callback) {
  const enc = options && options.encoding !== undefined ? options.encoding : "utf8";
  const maxBuffer = (options && options.maxBuffer) || 1024 * 1024;
  const out = [], err = []; let outLen = 0, errLen = 0, killedForBuffer = null;
  const onChunk = (list, c, isOut) => { list.push(c); if (isOut) outLen += c.length; else errLen += c.length; if (outLen > maxBuffer || errLen > maxBuffer) { killedForBuffer = nodeError("ERR_CHILD_PROCESS_STDIO_MAXBUFFER", (isOut ? "stdout" : "stderr") + " maxBuffer length exceeded", RangeError); child.kill(); } };
  if (child.stdout) child.stdout.on("data", (c) => onChunk(out, c, true));
  if (child.stderr) child.stderr.on("data", (c) => onChunk(err, c, false));
  let timer = null;
  if (options && options.timeout > 0) timer = setTimeout(() => child.kill(options.killSignal || "SIGTERM"), options.timeout);
  const fmt = (list) => (enc === "buffer" || enc === null ? Buffer.concat(list) : Buffer.concat(list).toString(enc));
  child.once("error", (e) => { if (timer) clearTimeout(timer); if (callback) callback(e, fmt(out), fmt(err)); });
  child.once("close", (code, signal) => {
    if (timer) clearTimeout(timer);
    const stdout = fmt(out), stderr = fmt(err);
    let e = killedForBuffer;
    if (!e && (code !== 0 || signal)) {
      e = new Error("Command failed: " + child.spawnargs.join(" ") + (stderr.length ? "\n" + stderr : ""));
      e.code = code; e.killed = child.killed; e.signal = signal; e.cmd = child.spawnargs.join(" ");
    }
    if (callback) callback(e, stdout, stderr);
  });
  return child;
}
export function exec(command, options, callback) {
  if (typeof options === "function") { callback = options; options = {}; }
  const o = buildOpts(String(command), [], { ...options, shell: options && options.shell !== undefined && options.shell !== true ? options.shell : true }, true);
  const child = new ChildProcess()._start(o, "/bin/sh", ["-c", String(command)]);
  child.spawnargs = [String(command)];
  return collect(child, options, callback);
}
export function execFile(file, args, options, callback) {
  if (typeof args === "function") { callback = args; args = []; options = {}; }
  else if (!Array.isArray(args)) { callback = options; options = args; args = []; }
  if (typeof options === "function") { callback = options; options = {}; }
  const child = spawn(file, args, options);
  return collect(child, options, callback);
}
const kPromisify = Symbol.for("nodejs.util.promisify.custom");
exec[kPromisify] = (command, options) => new Promise((resolve, reject) => exec(command, options, (e, stdout, stderr) => (e ? reject(Object.assign(e, { stdout, stderr })) : resolve({ stdout, stderr }))));
execFile[kPromisify] = (file, args, options) => new Promise((resolve, reject) => execFile(file, args, options, (e, stdout, stderr) => (e ? reject(Object.assign(e, { stdout, stderr })) : resolve({ stdout, stderr }))));

export function fork(modulePath, args, options) {
  if (!Array.isArray(args)) { options = args; args = []; }
  options = options || {};
  const execArgv = options.execArgv || [];
  const child = spawn(options.execPath || globalThis.process.execPath, [...execArgv, String(modulePath), ...args], { ...options, stdio: options.silent ? "pipe" : "inherit" });
  child.connected = false;
  return child;
}

function syncResult(file, args, options, o, input) {
  const r = ops.op_cp_spawn_sync(o, input, options && options.timeout > 0 ? options.timeout : 0);
  const enc = options && options.encoding !== undefined && options.encoding !== "buffer" ? options.encoding : null;
  const stdout = Buffer.from(r.stdout), stderr = Buffer.from(r.stderr);
  const res = { pid: r.pid, output: [null, enc ? stdout.toString(enc) : stdout, enc ? stderr.toString(enc) : stderr], stdout: enc ? stdout.toString(enc) : stdout, stderr: enc ? stderr.toString(enc) : stderr, status: r.status, signal: r.signal ? SIGNAL_NAMES[r.signal] || String(r.signal) : null, error: undefined };
  if (r.error) { const e = nodeError(/^([A-Z]+):/.exec(r.error)?.[1] ?? "ENOENT", r.error); e.syscall = "spawnSync " + file; e.path = file; e.spawnargs = args; res.error = e; res.status = null; }
  return res;
}
function inputBytes(options) { const i = options && options.input; return i == null ? new Uint8Array(0) : typeof i === "string" ? Buffer.from(i) : i; }
export function spawnSync(file, args, options) {
  if (!Array.isArray(args)) { options = args; args = []; }
  const o = buildOpts(String(file), args, options, false);
  return syncResult(String(file), args, options, o, inputBytes(options));
}
function checkSync(res, cmd) {
  if (res.error) throw res.error;
  if (res.status !== 0) {
    const stderrText = typeof res.stderr === "string" ? res.stderr : utf8Decode(res.stderr);
    const e = new Error("Command failed: " + cmd + (stderrText ? "\n" + stderrText : ""));
    Object.assign(e, { status: res.status, signal: res.signal, output: res.output, pid: res.pid, stdout: res.stdout, stderr: res.stderr });
    throw e;
  }
  return res.stdout;
}
export function execSync(command, options) {
  const opts = { stdio: ["pipe", "pipe", "inherit"], ...options };
  const o = buildOpts(String(command), [], { ...opts, shell: true }, true);
  const res = syncResult("/bin/sh", ["-c", String(command)], opts, o, inputBytes(opts));
  return checkSync(res, String(command));
}
export function execFileSync(file, args, options) {
  if (!Array.isArray(args)) { options = args; args = []; }
  const opts = { stdio: ["pipe", "pipe", "inherit"], ...options };
  const o = buildOpts(String(file), args, opts, false);
  const res = syncResult(String(file), args, opts, o, inputBytes(opts));
  return checkSync(res, [file, ...args].join(" "));
}

export default { ChildProcess, spawn, exec, execFile, fork, spawnSync, execSync, execFileSync };
