// node:cluster — primary forks worker processes over child_process.fork; workers' servers bind
// with SO_REUSEPORT (balanced by the kernel on Linux; macOS delivers to one process at a time).
import { EventEmitter } from "ext:kestrel/node/events.js";
import { fork } from "ext:kestrel/node/child_process.js";
const env = globalThis.process.env;
const cluster = new EventEmitter();
cluster.isPrimary = !env.KESTREL_CLUSTER_WORKER;
cluster.isMaster = cluster.isPrimary;
cluster.isWorker = !cluster.isPrimary;
cluster.workers = {};
cluster.settings = {};
cluster.schedulingPolicy = 2; cluster.SCHED_NONE = 1; cluster.SCHED_RR = 2;
let nextId = 1;
class Worker extends EventEmitter {
  constructor(id, proc) {
    super(); this.id = id; this.process = proc; this.exitedAfterDisconnect = undefined; this.state = "online";
    proc.on("message", (m) => this.emit("message", m));
    proc.on("exit", (code, sig) => { this.state = "dead"; delete cluster.workers[id]; this.emit("exit", code, sig); cluster.emit("exit", this, code, sig); });
    proc.on("disconnect", () => { this.emit("disconnect"); cluster.emit("disconnect", this); });
    proc.on("error", (e) => this.emit("error", e));
  }
  send(...a) { return this.process.send(...a); }
  kill(sig) { this.exitedAfterDisconnect = true; this.process.kill(sig); }
  destroy(sig) { this.kill(sig); }
  disconnect() { this.exitedAfterDisconnect = true; this.process.disconnect(); return this; }
  isConnected() { return this.process.connected; }
  isDead() { return this.state === "dead"; }
}
cluster.Worker = Worker;
cluster.setupPrimary = cluster.setupMaster = (s = {}) => { cluster.settings = { ...cluster.settings, ...s }; };
cluster.fork = (envExtra = {}) => {
  const id = nextId++;
  const exec = cluster.settings.exec || globalThis.process.argv[1];
  const args = cluster.settings.args || globalThis.process.argv.slice(2);
  const proc = fork(exec, args, { env: { ...env, ...envExtra, KESTREL_CLUSTER_WORKER: String(id), KESTREL_REUSEPORT: "1" }, stdio: cluster.settings.silent ? ["pipe", "pipe", "pipe", "ipc"] : ["inherit", "inherit", "inherit", "ipc"] });
  const w = new Worker(id, proc);
  cluster.workers[id] = w;
  queueMicrotask(() => { cluster.emit("fork", w); cluster.emit("online", w); w.emit("online"); });
  proc.once("message", () => {});
  cluster.emit("listening", w, {});
  return w;
};
cluster.disconnect = (cb) => { for (const w of Object.values(cluster.workers)) w.disconnect(); if (cb) queueMicrotask(cb); };
if (cluster.isWorker) {
  cluster.worker = { id: Number(env.KESTREL_CLUSTER_WORKER), process: globalThis.process, send: (...a) => globalThis.process.send(...a), kill: () => globalThis.process.exit(0), disconnect: () => globalThis.process.disconnect && globalThis.process.disconnect(), isConnected: () => !!globalThis.process.connected, isDead: () => false, exitedAfterDisconnect: false };
}
// Worker id is only known after init (env is filled then): recompute lazily.
Object.defineProperty(cluster, "isPrimary", { get: () => !globalThis.process.env.KESTREL_CLUSTER_WORKER, enumerable: true });
Object.defineProperty(cluster, "isMaster", { get: () => !globalThis.process.env.KESTREL_CLUSTER_WORKER, enumerable: true });
Object.defineProperty(cluster, "isWorker", { get: () => !!globalThis.process.env.KESTREL_CLUSTER_WORKER, enumerable: true });
Object.defineProperty(cluster, "worker", { get: () => (globalThis.process.env.KESTREL_CLUSTER_WORKER ? { id: Number(globalThis.process.env.KESTREL_CLUSTER_WORKER), process: globalThis.process, send: (...a) => globalThis.process.send(...a), kill: () => globalThis.process.exit(0), disconnect: () => globalThis.process.disconnect(), isConnected: () => !!globalThis.process.connected, isDead: () => false } : undefined), enumerable: true });
export default cluster;
export const isPrimary = cluster.isPrimary, isMaster = cluster.isMaster, isWorker = cluster.isWorker, workers = cluster.workers, settings = cluster.settings;
export const fork_ = cluster.fork;
export { fork_ as fork, Worker };
export const setupPrimary = cluster.setupPrimary, setupMaster = cluster.setupMaster, disconnect = cluster.disconnect, schedulingPolicy = 2, SCHED_NONE = 1, SCHED_RR = 2;
