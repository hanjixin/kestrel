// node:events
const kCapture = Symbol("kCapture");

// A plain function constructor (not a class) so legacy `EventEmitter.call(this)` +
// `util.inherits` code keeps working, exactly like Node.
export function EventEmitter(opts) {
  EventEmitter.init.call(this, opts);
}
class EventEmitterImpl {
  static defaultMaxListeners = 10;
  static captureRejectionSymbol = Symbol.for("nodejs.rejection");
  static errorMonitor = Symbol("events.errorMonitor");

  setMaxListeners(n) { this._maxListeners = n; return this; }
  getMaxListeners() { return this._maxListeners === undefined ? EventEmitter.defaultMaxListeners : this._maxListeners; }

  emit(type, ...args) {
    if (this._events === undefined) this._events = Object.create(null);
    const events = this._events;
    if (type === "error" && events[EventEmitter.errorMonitor] !== undefined) this.emit(EventEmitter.errorMonitor, ...args);
    const handler = events[type];
    if (handler === undefined) {
      if (type === "error") {
        let er = args[0];
        if (er instanceof Error) throw er;
        const err = new Error("Unhandled error." + (er === undefined ? "" : " (" + String(er) + ")"));
        err.code = "ERR_UNHANDLED_ERROR";
        err.context = er;
        throw err;
      }
      return false;
    }
    if (typeof handler === "function") {
      Reflect.apply(handler, this, args);
    } else {
      const listeners = handler.slice();
      for (let i = 0; i < listeners.length; ++i) Reflect.apply(listeners[i], this, args);
    }
    return true;
  }

  _addListener(type, listener, prepend) {
    checkListener(listener);
    if (this._events === undefined) { this._events = Object.create(null); this._eventsCount = 0; }
    const events = this._events;
    if (events.newListener !== undefined) {
      this.emit("newListener", type, listener.listener ? listener.listener : listener);
    }
    let existing = events[type];
    if (existing === undefined) {
      events[type] = listener;
      ++this._eventsCount;
    } else if (typeof existing === "function") {
      events[type] = prepend ? [listener, existing] : [existing, listener];
    } else if (prepend) existing.unshift(listener);
    else existing.push(listener);
    const m = this.getMaxListeners();
    const list = events[type];
    if (m > 0 && Array.isArray(list) && list.length > m && !list.warned) {
      list.warned = true;
      const w = new Error("Possible EventEmitter memory leak detected. " + list.length + " " + String(type) + " listeners added to " + (this.constructor.name || "EventEmitter") + ". Use emitter.setMaxListeners() to increase limit");
      w.name = "MaxListenersExceededWarning";
      w.emitter = this; w.type = type; w.count = list.length;
      globalThis.process.emitWarning(w);
    }
    return this;
  }

  addListener(type, listener) { return this._addListener(type, listener, false); }
  on(type, listener) { return this._addListener(type, listener, false); }
  prependListener(type, listener) { return this._addListener(type, listener, true); }

  once(type, listener) { checkListener(listener); this.on(type, _onceWrap(this, type, listener)); return this; }
  prependOnceListener(type, listener) { checkListener(listener); this.prependListener(type, _onceWrap(this, type, listener)); return this; }

  removeListener(type, listener) {
    checkListener(listener);
    const events = this._events;
    if (events === undefined) return this;
    const list = events[type];
    if (list === undefined) return this;
    if (list === listener || list.listener === listener) {
      if (--this._eventsCount === 0) this._events = Object.create(null);
      else {
        delete events[type];
        if (events.removeListener) this.emit("removeListener", type, list.listener || listener);
      }
    } else if (typeof list !== "function") {
      let position = -1;
      for (let i = list.length - 1; i >= 0; i--) {
        if (list[i] === listener || list[i].listener === listener) { position = i; break; }
      }
      if (position < 0) return this;
      if (position === 0) list.shift(); else list.splice(position, 1);
      if (list.length === 1) events[type] = list[0];
      if (events.removeListener !== undefined) this.emit("removeListener", type, listener);
    }
    return this;
  }
  off(type, listener) { return this.removeListener(type, listener); }

  removeAllListeners(type) {
    const events = this._events;
    if (events === undefined) return this;
    if (events.removeListener === undefined) {
      if (arguments.length === 0) { this._events = Object.create(null); this._eventsCount = 0; }
      else if (events[type] !== undefined) {
        if (--this._eventsCount === 0) this._events = Object.create(null); else delete events[type];
      }
      return this;
    }
    if (arguments.length === 0) {
      for (const key of Reflect.ownKeys(events)) { if (key === "removeListener") continue; this.removeAllListeners(key); }
      this.removeAllListeners("removeListener");
      this._events = Object.create(null); this._eventsCount = 0;
      return this;
    }
    const listeners = events[type];
    if (typeof listeners === "function") this.removeListener(type, listeners);
    else if (listeners !== undefined) for (let i = listeners.length - 1; i >= 0; i--) this.removeListener(type, listeners[i]);
    return this;
  }

  listeners(type) { return _listeners(this, type, true); }
  rawListeners(type) { return _listeners(this, type, false); }
  listenerCount(type, listener) {
    const events = this._events;
    if (events === undefined) return 0;
    const l = events[type];
    if (l === undefined) return 0;
    if (typeof l === "function") return listener === undefined || l === listener || l.listener === listener ? 1 : 0;
    if (listener === undefined) return l.length;
    return l.filter((x) => x === listener || x.listener === listener).length;
  }
  eventNames() { return this._eventsCount > 0 ? Reflect.ownKeys(this._events) : []; }

  static listenerCount(emitter, type) { return emitter.listenerCount(type); }
  static once(emitter, name, opts = {}) {
    return new Promise((resolve, reject) => {
      const signal = opts.signal;
      if (signal && signal.aborted) return reject(abortError(signal.reason));
      const errorListener = (err) => { emitter.removeListener(name, resolver); cleanup(); reject(err); };
      const resolver = (...args) => { if (typeof emitter.removeListener === "function") emitter.removeListener("error", errorListener); cleanup(); resolve(args); };
      const onAbort = () => { emitter.removeListener(name, resolver); emitter.removeListener("error", errorListener); reject(abortError(signal.reason)); };
      const cleanup = () => { if (signal) signal.removeEventListener("abort", onAbort); };
      emitter.once(name, resolver);
      if (name !== "error" && typeof emitter.once === "function") emitter.once("error", errorListener);
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
    });
  }
  static on(emitter, event) {
    const queue = [];
    const waiting = [];
    let done = false, error = null;
    const push = (...args) => { if (waiting.length) waiting.shift().resolve({ value: args, done: false }); else queue.push(args); };
    const onError = (e) => { error = e; while (waiting.length) waiting.shift().reject(e); };
    emitter.on(event, push); emitter.on("error", onError);
    return {
      next() {
        if (queue.length) return Promise.resolve({ value: queue.shift(), done: false });
        if (error) return Promise.reject(error);
        if (done) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve, reject) => waiting.push({ resolve, reject }));
      },
      return() { done = true; emitter.off(event, push); emitter.off("error", onError); return Promise.resolve({ value: undefined, done: true }); },
      throw(e) { error = e; return Promise.reject(e); },
      [Symbol.asyncIterator]() { return this; },
    };
  }
  static getEventListeners(target, type) { return typeof target.listeners === "function" ? target.listeners(type) : []; }
  static setMaxListeners(n, ...targets) { if (targets.length === 0) EventEmitter.defaultMaxListeners = n; else for (const t of targets) t.setMaxListeners(n); }
}

function abortError(reason) { const e = new Error("The operation was aborted"); e.name = "AbortError"; e.code = "ABORT_ERR"; e.cause = reason; return e; }
function checkListener(l) {
  if (typeof l !== "function") { const e = new TypeError('The "listener" argument must be of type function. Received ' + (l === null ? "null" : typeof l)); e.code = "ERR_INVALID_ARG_TYPE"; throw e; }
}
function _onceWrap(target, type, listener) {
  const state = { fired: false, wrapFn: undefined, target, type, listener };
  const wrapped = function (...args) {
    if (!state.fired) { state.target.removeListener(state.type, state.wrapFn); state.fired = true; return state.listener.apply(state.target, args); }
  };
  wrapped.listener = listener;
  state.wrapFn = wrapped;
  return wrapped;
}
function _listeners(target, type, unwrap) {
  const events = target._events;
  if (events === undefined) return [];
  const l = events[type];
  if (l === undefined) return [];
  if (typeof l === "function") return unwrap ? [l.listener || l] : [l];
  return unwrap ? l.map((x) => x.listener || x) : l.slice();
}

// Move the class prototype/statics onto the function constructor.
EventEmitter.prototype = EventEmitterImpl.prototype;
// Node defines the prototype methods by assignment, so they are enumerable; code that copies
// them with `for (k in EventEmitter.prototype)` (node-sqlite3's inherits, older mixins)
// depends on that.
for (const k of Object.getOwnPropertyNames(EventEmitterImpl.prototype)) {
  if (k === "constructor" || k.startsWith("_")) continue;
  const d = Object.getOwnPropertyDescriptor(EventEmitterImpl.prototype, k);
  if (d && "value" in d && typeof d.value === "function") Object.defineProperty(EventEmitterImpl.prototype, k, { ...d, enumerable: true });
}
Object.defineProperty(EventEmitter.prototype, "constructor", { value: EventEmitter, writable: true, configurable: true });
for (const k of Object.getOwnPropertyNames(EventEmitterImpl)) {
  if (k === "prototype" || k === "length" || k === "name") continue;
  Object.defineProperty(EventEmitter, k, Object.getOwnPropertyDescriptor(EventEmitterImpl, k));
}
EventEmitter.EventEmitter = EventEmitter;
EventEmitter.prototype._events = undefined;
EventEmitter.prototype._eventsCount = 0;
EventEmitter.prototype._maxListeners = undefined;
EventEmitter.init = function (opts) {
  if (this._events === undefined || this._events === Object.getPrototypeOf(this)._events) { this._events = Object.create(null); this._eventsCount = 0; }
  this._maxListeners = this._maxListeners || undefined;
  this[kCapture] = !!(opts && opts.captureRejections);
};

export const once = EventEmitter.once;
export const on = EventEmitter.on;
export const getEventListeners = EventEmitter.getEventListeners;
export const setMaxListeners = EventEmitter.setMaxListeners;
export const listenerCount = EventEmitter.listenerCount;
export const errorMonitor = EventEmitter.errorMonitor;
export const captureRejectionSymbol = EventEmitter.captureRejectionSymbol;
export const defaultMaxListeners = 10;
export default EventEmitter;
