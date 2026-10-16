// node:diagnostics_channel — lightweight named pub/sub channels used by undici, loaders, etc.
const channels = new Map();

class Channel {
  constructor(name) { this.name = name; this._subs = new Set(); }
  get hasSubscribers() { return this._subs.size > 0; }
  subscribe(fn) { this._subs.add(fn); }
  unsubscribe(fn) { return this._subs.delete(fn); }
  publish(message) { for (const fn of [...this._subs]) { try { fn(message, this.name); } catch { /* subscribers must not break publishers */ } } }
  bindStore() {} unbindStore() {} runStores(_ctx, fn, thisArg, ...args) { return fn.apply(thisArg, args); }
}

export function channel(name) {
  let c = channels.get(name);
  if (!c) { c = new Channel(name); channels.set(name, c); }
  return c;
}
export function hasSubscribers(name) { const c = channels.get(name); return !!c && c.hasSubscribers; }
export function subscribe(name, fn) { channel(name).subscribe(fn); }
export function unsubscribe(name, fn) { const c = channels.get(name); return c ? c.unsubscribe(fn) : false; }

class TracingChannel {
  constructor(nameOrChannels) {
    const base = typeof nameOrChannels === "string" ? nameOrChannels : null;
    const mk = (suffix, key) => (base ? channel("tracing:" + base + ":" + suffix) : (nameOrChannels[key] || new Channel(suffix)));
    this.start = mk("start", "start"); this.end = mk("end", "end");
    this.asyncStart = mk("asyncStart", "asyncStart"); this.asyncEnd = mk("asyncEnd", "asyncEnd"); this.error = mk("error", "error");
  }
  get hasSubscribers() { return this.start.hasSubscribers || this.end.hasSubscribers || this.asyncStart.hasSubscribers || this.asyncEnd.hasSubscribers || this.error.hasSubscribers; }
  subscribe(handlers) { for (const k of ["start","end","asyncStart","asyncEnd","error"]) if (handlers[k]) this[k].subscribe(handlers[k]); }
  unsubscribe(handlers) { let ok = true; for (const k of ["start","end","asyncStart","asyncEnd","error"]) if (handlers[k]) ok = this[k].unsubscribe(handlers[k]) && ok; return ok; }
  traceSync(fn, ctx = {}, thisArg, ...args) {
    this.start.publish(ctx);
    try { const r = fn.apply(thisArg, args); ctx.result = r; return r; }
    catch (e) { ctx.error = e; this.error.publish(ctx); throw e; }
    finally { this.end.publish(ctx); }
  }
  tracePromise(fn, ctx = {}, thisArg, ...args) {
    this.start.publish(ctx);
    let p;
    try { p = fn.apply(thisArg, args); } catch (e) { ctx.error = e; this.error.publish(ctx); this.end.publish(ctx); throw e; }
    this.asyncStart.publish(ctx);
    return Promise.resolve(p).then((r) => { ctx.result = r; this.asyncEnd.publish(ctx); this.end.publish(ctx); return r; },
      (e) => { ctx.error = e; this.error.publish(ctx); this.asyncEnd.publish(ctx); this.end.publish(ctx); throw e; });
  }
  traceCallback(fn, position, ctx = {}, thisArg, ...args) {
    this.start.publish(ctx);
    const cb = args[position];
    const wrapped = (err, ...rest) => { if (err) { ctx.error = err; this.error.publish(ctx); } this.asyncStart.publish(ctx); try { return cb.call(thisArg, err, ...rest); } finally { this.asyncEnd.publish(ctx); this.end.publish(ctx); } };
    if (position >= 0) args[position] = wrapped;
    try { return fn.apply(thisArg, args); } catch (e) { ctx.error = e; this.error.publish(ctx); this.end.publish(ctx); throw e; }
  }
}
export function tracingChannel(nameOrChannels) { return new TracingChannel(nameOrChannels); }

export { Channel };
export default { channel, hasSubscribers, subscribe, unsubscribe, tracingChannel, Channel };
