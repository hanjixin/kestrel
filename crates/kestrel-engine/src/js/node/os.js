// node:os
import { ops } from "ext:kestrel/internal.js";
let info = null;
const get = () => (info ??= ops.op_k_os_info());

export const EOL = "\n";
export const devNull = "/dev/null";
export function platform() { return get().platform; }
export function arch() { return get().arch; }
export function type() { const p = get().platform; return p === "darwin" ? "Darwin" : p === "linux" ? "Linux" : p === "win32" ? "Windows_NT" : p; }
export function release() { return get().release; }
export function version() { return get().version; }
export function hostname() { return get().hostname; }
export function homedir() { return get().homedir; }
export function tmpdir() { return get().tmpdir; }
export function totalmem() { return get().total_mem; }
export function freemem() { return Math.floor(get().total_mem / 4); }
export function uptime() { return Math.floor(ops.op_k_now_ms() / 1000); }
export function loadavg() { return [0, 0, 0]; }
export function endianness() { return new Uint8Array(new Uint16Array([1]).buffer)[0] === 1 ? "LE" : "BE"; }
export function availableParallelism() { return get().cpus; }
export function cpus() { return Array.from({ length: get().cpus }, () => ({ model: "cpu", speed: 0, times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } })); }
export function networkInterfaces() { return {}; }
export function userInfo() { const i = get(); return { uid: i.uid, gid: i.gid, username: i.username, homedir: i.homedir, shell: i.shell || null }; }
export function machine() { return get().arch === "arm64" ? "arm64" : "x86_64"; }
export function getPriority() { return 0; }
export function setPriority() {}
export const constants = { signals: { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGILL: 4, SIGTRAP: 5, SIGABRT: 6, SIGBUS: 10, SIGFPE: 8, SIGKILL: 9, SIGUSR1: 30, SIGSEGV: 11, SIGUSR2: 31, SIGPIPE: 13, SIGALRM: 14, SIGTERM: 15, SIGCHLD: 20, SIGCONT: 19, SIGSTOP: 17, SIGTSTP: 18, SIGWINCH: 28 }, errno: {}, priority: { PRIORITY_LOW: 19, PRIORITY_BELOW_NORMAL: 10, PRIORITY_NORMAL: 0, PRIORITY_ABOVE_NORMAL: -7, PRIORITY_HIGH: -14, PRIORITY_HIGHEST: -20 }, UV_UDP_REUSEADDR: 4 };
export default { EOL, devNull, platform, arch, type, release, version, hostname, homedir, tmpdir, totalmem, freemem, uptime, loadavg, endianness, availableParallelism, cpus, networkInterfaces, userInfo, machine, getPriority, setPriority, constants };
