// node:async_hooks — AsyncLocalStorage on V8's continuation-preserved embedder data (the
// same mechanism Node 22's AsyncContextFrame uses); AsyncResource; createHook is a no-op.
import { core, nodeError } from "ext:kestrel/internal.js";

// The context is an immutable frame: a Map from storage -> value, copied on write.
const get = () => core.getAsyncContext();
const set = (f) => core.setAsyncContext(f);

export class AsyncLocalStorage {
  constructor() { this._enabled = true; }
  static bind(fn) { return AsyncResource.bind(fn); }
  static snapshot() { const frame = get(); return (fn, ...args) => { const prev = get(); set(frame); try { return fn(...args); } finally { set(prev); } }; }
  run(store, fn, ...args) {
    const prev = get();
    const next = new Map(prev instanceof Map ? prev : []);
    next.set(this, store);
    set(next);
    try { return fn(...args); } finally { set(prev); }
  }
  exit(fn, ...args) {
    const prev = get();
    const next = new Map(prev instanceof Map ? prev : []);
    next.delete(this);
    set(next);
    try { return fn(...args); } finally { set(prev); }
  }
  enterWith(store) { const prev = get(); const next = new Map(prev instanceof Map ? prev : []); next.set(this, store); set(next); }
  getStore() { if (!this._enabled) return undefined; const f = get(); return f instanceof Map ? f.get(this) : undefined; }
  disable() { this._enabled = false; const f = get(); if (f instanceof Map && f.has(this)) { const n = new Map(f); n.delete(this); set(n); } }
}

let asyncIdCounter = 1;
export class AsyncResource {
  constructor(type, opts = {}) { this.type = type; this._frame = get(); this._asyncId = ++asyncIdCounter; this._triggerAsyncId = typeof opts === "number" ? opts : opts.triggerAsyncId ?? 1; }
  runInAsyncScope(fn, thisArg, ...args) { const prev = get(); set(this._frame); try { return fn.apply(thisArg, args); } finally { set(prev); } }
  emitDestroy() { return this; }
  asyncId() { return this._asyncId; }
  triggerAsyncId() { return this._triggerAsyncId; }
  bind(fn, thisArg) { const res = this; const bound = function (...args) { return res.runInAsyncScope(fn, thisArg === undefined ? this : thisArg, ...args); }; Object.defineProperty(bound, "length", { value: fn.length }); bound.asyncResource = this; return bound; }
  static bind(fn, type, thisArg) { return new AsyncResource(type || fn.name || "bound-anonymous-fn").bind(fn, thisArg); }
}

export function executionAsyncId() { return 1; }
export function triggerAsyncId() { return 0; }
export function executionAsyncResource() { return {}; }
export function createHook() { return { enable() { return this; }, disable() { return this; } }; }
export const asyncWrapProviders = Object.freeze({ NONE: 0, PROMISE: 1, TIMERWRAP: 2 });
export default { AsyncLocalStorage, AsyncResource, executionAsyncId, triggerAsyncId, executionAsyncResource, createHook, asyncWrapProviders };
