// node:worker_threads — main-thread view only; Worker is not implemented yet.
import { nodeError } from "ext:kestrel/internal.js";
import { EventEmitter } from "ext:kestrel/node/events.js";
export const isMainThread = true;
export const threadId = 0;
export const parentPort = null;
export const workerData = null;
export const resourceLimits = {};
export const SHARE_ENV = Symbol("nodejs.worker_threads.SHARE_ENV");
export class Worker extends EventEmitter { constructor() { super(); throw nodeError("ERR_METHOD_NOT_IMPLEMENTED", "worker_threads.Worker is not implemented in kestrel yet"); } }
export class MessageChannel { constructor() { const a = new MessagePort(), b = new MessagePort(); a._peer = b; b._peer = a; this.port1 = a; this.port2 = b; } }
export class MessagePort extends EventEmitter { postMessage(m) { queueMicrotask(() => this._peer && this._peer.emit("message", m)); } start() {} close() { this.emit("close"); } ref() {} unref() {} }
export class BroadcastChannel extends EventEmitter { constructor(name) { super(); this.name = name; } postMessage() {} close() {} }
export function markAsUntransferable() {}
export function isMarkedAsUntransferable() { return false; }
export function moveMessagePortToContext(p) { return p; }
export function receiveMessageOnPort() { return undefined; }
export function getEnvironmentData() { return undefined; }
export function setEnvironmentData() {}
export default { isMainThread, threadId, parentPort, workerData, resourceLimits, SHARE_ENV, Worker, MessageChannel, MessagePort, BroadcastChannel, markAsUntransferable, isMarkedAsUntransferable, moveMessagePortToContext, receiveMessageOnPort, getEnvironmentData, setEnvironmentData };
