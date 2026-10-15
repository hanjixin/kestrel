// node:stream — function-constructor style (like Node) so legacy `Readable.call(this)` +
// `util.inherits` code works. Push-based, buffered; supports pipe, backpressure, async iteration.
import { EventEmitter } from "ext:kestrel/node/events.js";
import { Buffer } from "ext:kestrel/node/buffer.js";
import { nodeError } from "ext:kestrel/internal.js";

function inherits(ctor, superCtor) {
  Object.setPrototypeOf(ctor.prototype, superCtor.prototype);
  Object.defineProperty(ctor, "super_", { value: superCtor, writable: true, configurable: true });
}

// ---------- Stream ----------
export function Stream(opts) {
  if (!(this instanceof Stream)) return new Stream(opts);
  EventEmitter.call(this, opts);
}
inherits(Stream, EventEmitter);
Stream.prototype.pipe = function pipe(dest, opts = {}) {
  const src = this;
  const ondata = (chunk) => { if (dest.write(chunk) === false && typeof src.pause === "function") src.pause(); };
  src.on("data", ondata);
  const ondrain = () => { if (typeof src.resume === "function") src.resume(); };
  dest.on("drain", ondrain);
  if (opts.end !== false) src.once("end", () => dest.end());
  src.once("error", (e) => { if (typeof dest.destroy === "function") dest.destroy(e); });
  dest.emit("pipe", src);
  if (typeof src.resume === "function") src.resume();
  return dest;
};

// ---------- Readable ----------
function readableInit(self, opts) {
  self._readableState = {
    buffer: [], length: 0, flowing: null, ended: false, endEmitted: false, reading: false, flowingLock: false,
    objectMode: !!(opts.objectMode || opts.readableObjectMode),
    highWaterMark: opts.highWaterMark ?? opts.readableHighWaterMark ?? (opts.objectMode || opts.readableObjectMode ? 16 : 65536),
    encoding: opts.encoding || null, destroyed: false, errored: null, pipes: [], readableListening: false,
  };
  if (typeof opts.read === "function") self._read = opts.read;
  if (typeof opts.destroy === "function") self._destroy = opts.destroy;
  self.readable = true;
}
export function Readable(opts = {}) {
  if (!(this instanceof Readable)) return new Readable(opts);
  Stream.call(this, opts);
  readableInit(this, opts);
}
inherits(Readable, Stream);

function rflow(self) {
  const st = self._readableState;
  if (st.flowingLock) return;
  st.flowingLock = true;
  try {
    while (st.flowing && st.buffer.length) { const c = st.buffer.shift(); st.length -= st.objectMode ? 1 : c.length; self.emit("data", c); }
  } finally { st.flowingLock = false; }
  if (st.flowing && st.buffer.length === 0 && !st.ended && !st.reading) {
    st.reading = true;
    queueMicrotask(() => { st.reading = false; if (!st.ended && !st.destroyed) self._read(st.highWaterMark); });
  }
  rmaybeEnd(self);
}
function rmaybeEnd(self) {
  const st = self._readableState;
  if (st.ended && st.buffer.length === 0 && !st.endEmitted) {
    st.endEmitted = true; self.readable = false;
    // A Duplex stays alive until its writable side has finished too (Node's autoDestroy).
    queueMicrotask(() => { self.emit("end"); if (!st.destroyed && !(self._writableState && !self._writableState.finished)) { st.destroyed = true; self.emit("close"); } });
  }
}
Object.defineProperties(Readable.prototype, {
  readableEnded: { get() { return this._readableState.endEmitted; } },
  readableFlowing: { get() { return this._readableState.flowing; }, set(v) { this._readableState.flowing = v; } },
  readableLength: { get() { return this._readableState.length; } },
  readableObjectMode: { get() { return this._readableState.objectMode; } },
  readableHighWaterMark: { get() { return this._readableState.highWaterMark; } },
  readableEncoding: { get() { return this._readableState.encoding; } },
  readableAborted: { get() { return this._readableState.destroyed && !this._readableState.endEmitted; } },
  readableDidRead: { get() { return this._readableState.endEmitted || this._readableState.length > 0; } },
  destroyed: { get() { return this._readableState.destroyed; }, set(v) { this._readableState.destroyed = v; } },
  errored: { get() { return this._readableState.errored; } },
  closed: { get() { return this._readableState.destroyed; } },
});
Readable.prototype._read = function () {};
Readable.prototype.push = function push(chunk, encoding) {
  const st = this._readableState;
  if (chunk === null) { st.ended = true; if (st.flowing) rflow(this); else { this.emit("readable"); rmaybeEnd(this); } return false; }
  if (st.ended) { this.destroy(nodeError("ERR_STREAM_PUSH_AFTER_EOF", "stream.push() after EOF")); return false; }
  if (!st.objectMode && typeof chunk === "string") chunk = Buffer.from(chunk, encoding);
  if (st.encoding && !st.objectMode && chunk instanceof Uint8Array) chunk = Buffer.from(chunk).toString(st.encoding);
  st.buffer.push(chunk);
  st.length += st.objectMode ? 1 : chunk.length;
  if (st.flowing) rflow(this);
  else this.emit("readable");
  return st.length < st.highWaterMark;
};
Readable.prototype.unshift = function (chunk) { const st = this._readableState; if (!st.objectMode && typeof chunk === "string") chunk = Buffer.from(chunk); st.buffer.unshift(chunk); st.length += st.objectMode ? 1 : chunk.length; };
Readable.prototype.read = function read(n) {
  const st = this._readableState;
  if (st.buffer.length === 0) { if (!st.ended && !st.destroyed) this._read(st.highWaterMark); if (st.buffer.length === 0) { rmaybeEnd(this); return null; } }
  let chunk;
  if (st.objectMode) chunk = st.buffer.shift();
  else if (n === undefined || n >= st.length) { chunk = Buffer.concat(st.buffer.map((b) => (typeof b === "string" ? Buffer.from(b) : b))); st.buffer = []; if (st.encoding) chunk = chunk.toString(st.encoding); }
  else { const all = Buffer.concat(st.buffer.map((b) => (typeof b === "string" ? Buffer.from(b) : b))); chunk = all.subarray(0, n); const rest = all.subarray(n); st.buffer = rest.length ? [rest] : []; if (st.encoding) chunk = chunk.toString(st.encoding); }
  st.length = st.objectMode ? st.buffer.length : st.buffer.reduce((a, b) => a + b.length, 0);
  if (st.buffer.length === 0 && !st.ended) queueMicrotask(() => { if (!st.ended && !st.destroyed) this._read(st.highWaterMark); });
  rmaybeEnd(this);
  return chunk;
};
Readable.prototype.on = function on(ev, fn) {
  EventEmitter.prototype.on.call(this, ev, fn);
  const st = this._readableState;
  if (ev === "data" && st.flowing !== false) this.resume();
  else if (ev === "readable") { st.readableListening = true; queueMicrotask(() => { if (st.buffer.length || st.ended) this.emit("readable"); else if (!st.destroyed) this._read(st.highWaterMark); }); }
  return this;
};
Readable.prototype.addListener = Readable.prototype.on;
Readable.prototype.resume = function resume() { const st = this._readableState; if (!st.flowing) { st.flowing = true; queueMicrotask(() => { rflow(this); if (st.flowing && !st.ended && st.buffer.length === 0 && !st.destroyed) this._read(st.highWaterMark); }); } return this; };
Readable.prototype.pause = function pause() { this._readableState.flowing = false; this.emit("pause"); return this; };
Readable.prototype.isPaused = function () { return this._readableState.flowing === false; };
Readable.prototype.setEncoding = function (enc) { this._readableState.encoding = enc; return this; };
Readable.prototype.unpipe = function () { return this; };
Readable.prototype.wrap = function (s) { s.on("data", (c) => this.push(c)); s.on("end", () => this.push(null)); return this; };
Readable.prototype._destroy = function (err, cb) { cb(err); };
Readable.prototype.destroy = function destroy(err) {
  const st = this._readableState;
  if (st.destroyed) return this;
  st.destroyed = true; this.readable = false;
  const done = (e) => queueMicrotask(() => { if (e) { st.errored = e; this.emit("error", e); } this.emit("close"); });
  this._destroy(err || null, done);
  return this;
};
Readable.prototype[Symbol.asyncIterator] = async function* () {
  const st = this._readableState;
  let error = null;
  this.on("error", (e) => { error = e; });
  try {
    for (;;) {
      if (error) throw error;
      if (st.buffer.length) { const c = st.buffer.shift(); st.length -= st.objectMode ? 1 : c.length; yield c; continue; }
      if (st.ended) { rmaybeEnd(this); return; }
      await new Promise((resolve) => {
        const onAny = () => { this.off("readable", onAny); this.off("end", onAny); this.off("error", onAny); this.off("close", onAny); resolve(); };
        this.once("readable", onAny); this.once("end", onAny); this.once("error", onAny); this.once("close", onAny);
        if (!st.destroyed) this._read(st.highWaterMark);
      });
    }
  } finally { if (!st.ended) this.destroy(); }
};
Readable.prototype.toArray = function () { return (async () => { const out = []; for await (const c of this) out.push(c); return out; })(); };
Readable.prototype.map = function (fn) { const self = this; return Readable.from((async function* () { for await (const c of self) yield await fn(c); })()); };
Readable.prototype.filter = function (fn) { const self = this; return Readable.from((async function* () { for await (const c of self) if (await fn(c)) yield c; })()); };
Readable.prototype.forEach = function (fn) { return (async () => { for await (const c of this) await fn(c); })(); };
Readable.from = function from(iterable, opts = {}) {
  const r = new Readable({ objectMode: true, ...opts, read() {} });
  (async () => { try { if (typeof iterable === "string" || iterable instanceof Uint8Array) r.push(iterable); else for await (const c of iterable) r.push(c); r.push(null); } catch (e) { r.destroy(e); } })();
  return r;
};
Readable.fromWeb = function (rs, opts) { return Readable.from((async function* () { const reader = rs.getReader(); for (;;) { const { value, done } = await reader.read(); if (done) return; yield value; } })(), { objectMode: false, ...opts }); };
Readable.toWeb = function (r) { return new ReadableStream({ start(c) { r.on("data", (d) => c.enqueue(d)); r.on("end", () => c.close()); r.on("error", (e) => c.error(e)); } }); };
Readable.ReadableState = function ReadableState() {};

// ---------- Writable ----------
function writableInit(self, opts) {
  self._writableState = {
    ended: false, finished: false, finishing: false, destroyed: false,
    objectMode: !!(opts.objectMode || opts.writableObjectMode),
    highWaterMark: opts.highWaterMark ?? opts.writableHighWaterMark ?? 16384, length: 0, writing: false, queue: [],
    decodeStrings: opts.decodeStrings !== false, errored: null, corked: 0, needDrain: false, defaultEncoding: opts.defaultEncoding || "utf8",
  };
  if (typeof opts.write === "function") self._write = opts.write;
  if (typeof opts.writev === "function") self._writev = opts.writev;
  if (typeof opts.final === "function") self._final = opts.final;
  if (typeof opts.destroy === "function") self._destroy = opts.destroy;
  self.writable = true;
}
export function Writable(opts = {}) {
  if (!(this instanceof Writable)) return new Writable(opts);
  Stream.call(this, opts);
  writableInit(this, opts);
}
inherits(Writable, Stream);
function wdrain(self) {
  const st = self._writableState;
  if (st.writing || st.corked) return;
  if (st.queue.length === 0) { wmaybeFinish(self); return; }
  st.writing = true;
  const [chunk, enc, cb] = st.queue.shift();
  let sync = true;
  self._write(chunk, enc, (err) => {
    st.writing = false;
    st.length -= st.objectMode ? 1 : chunk.length;
    if (err) { st.errored = err; if (cb) cb(err); self.destroy(err); return; }
    if (cb) cb(null);
    const next = () => { if (st.queue.length) wdrain(self); else { if (st.needDrain && !st.ended) { st.needDrain = false; self.emit("drain"); } wmaybeFinish(self); } };
    if (sync) queueMicrotask(next); else next();
  });
  sync = false;
}
function wmaybeFinish(self) {
  const st = self._writableState;
  if (st.ended && !st.finished && !st.finishing && st.queue.length === 0 && !st.writing) {
    st.finishing = true;
    const fin = (err) => { if (err) return self.destroy(err); st.finished = true; self.writable = false; self.emit("finish"); if (!st.destroyed && !(self._readableState && !self._readableState.endEmitted)) { st.destroyed = true; queueMicrotask(() => self.emit("close")); } };
    if (typeof self._final === "function") self._final(fin); else fin();
  }
}
const writableMethods = {
  _write(chunk, enc, cb) { cb(nodeError("ERR_METHOD_NOT_IMPLEMENTED", "The _write() method is not implemented")); },
  write(chunk, encoding, cb) {
    if (typeof encoding === "function") { cb = encoding; encoding = undefined; }
    const st = this._writableState;
    if (st.ended) { const e = nodeError("ERR_STREAM_WRITE_AFTER_END", "write after end"); queueMicrotask(() => { if (cb) cb(e); this.emit("error", e); }); return false; }
    if (st.destroyed) { const e = nodeError("ERR_STREAM_DESTROYED", "Cannot call write after a stream was destroyed"); queueMicrotask(() => { if (cb) cb(e); }); return false; }
    if (!st.objectMode && typeof chunk === "string" && st.decodeStrings) { chunk = Buffer.from(chunk, encoding || st.defaultEncoding); encoding = "buffer"; }
    else if (!st.objectMode && chunk instanceof Uint8Array) encoding = "buffer";
    st.length += st.objectMode ? 1 : chunk.length;
    st.queue.push([chunk, encoding || st.defaultEncoding, cb]);
    if (!st.writing && !st.corked) wdrain(this);
    const ok = st.length < st.highWaterMark;
    if (!ok) st.needDrain = true;
    return ok;
  },
  end(chunk, encoding, cb) {
    if (typeof chunk === "function") { cb = chunk; chunk = undefined; } else if (typeof encoding === "function") { cb = encoding; encoding = undefined; }
    const st = this._writableState;
    if (chunk !== undefined && chunk !== null) this.write(chunk, encoding);
    if (cb) { if (st.finished) queueMicrotask(cb); else this.once("finish", cb); }
    if (!st.ended) { st.ended = true; st.corked = 0; if (!st.writing && st.queue.length === 0) wmaybeFinish(this); else wdrain(this); }
    return this;
  },
  cork() { this._writableState.corked++; },
  uncork() { const st = this._writableState; if (st.corked) st.corked--; if (!st.corked) wdrain(this); },
  setDefaultEncoding(enc) { this._writableState.defaultEncoding = enc; return this; },
  _destroy(err, cb) { cb(err); },
  destroy(err) {
    const st = this._writableState;
    if (st.destroyed) return this;
    st.destroyed = true; this.writable = false;
    if (this._readableState) { this._readableState.destroyed = true; this.readable = false; }
    const done = (e) => queueMicrotask(() => { if (e) { st.errored = e; this.emit("error", e); } this.emit("close"); });
    this._destroy(err || null, done);
    return this;
  },
};
Object.assign(Writable.prototype, writableMethods);
Object.defineProperties(Writable.prototype, {
  writableEnded: { get() { return this._writableState.ended; } },
  writableFinished: { get() { return this._writableState.finished; } },
  writableLength: { get() { return this._writableState.length; } },
  writableObjectMode: { get() { return this._writableState.objectMode; } },
  writableHighWaterMark: { get() { return this._writableState.highWaterMark; } },
  writableNeedDrain: { get() { return this._writableState.needDrain; } },
  writableCorked: { get() { return this._writableState.corked; } },
  destroyed: { get() { return this._writableState.destroyed; }, set(v) { this._writableState.destroyed = v; } },
  errored: { get() { return this._writableState.errored; } },
  closed: { get() { return this._writableState.destroyed; } },
});
Writable.fromWeb = function (ws) { const writer = ws.getWriter(); return new Writable({ write(c, e, cb) { writer.write(c).then(() => cb(), cb); }, final(cb) { writer.close().then(() => cb(), cb); } }); };
Writable.toWeb = function (w) { return new WritableStream({ write(c) { return new Promise((res, rej) => w.write(c, (e) => (e ? rej(e) : res()))); }, close() { return new Promise((res) => w.end(res)); } }); };
Writable.WritableState = function WritableState() {};

// ---------- Duplex ----------
export function Duplex(opts = {}) {
  if (!(this instanceof Duplex)) return new Duplex(opts);
  Readable.call(this, opts);
  writableInit(this, opts);
  if (opts.readable === false) { this.readable = false; this._readableState.ended = true; this._readableState.endEmitted = true; }
  if (opts.writable === false) { this.writable = false; this._writableState.ended = true; this._writableState.finished = true; }
  this.allowHalfOpen = opts.allowHalfOpen !== false;
  if (!this.allowHalfOpen) this.once("end", () => { if (!this._writableState.ended) this.end(); });
}
inherits(Duplex, Readable);
for (const k of Object.keys(writableMethods)) if (k !== "destroy" && k !== "_destroy") Duplex.prototype[k] = writableMethods[k];
Duplex.prototype.destroy = function (err) {
  const rs = this._readableState, ws = this._writableState;
  if (rs.destroyed && ws.destroyed) return this;
  rs.destroyed = true; ws.destroyed = true; this.readable = false; this.writable = false;
  const done = (e) => queueMicrotask(() => { if (e) { rs.errored = e; ws.errored = e; this.emit("error", e); } this.emit("close"); });
  this._destroy(err || null, done);
  return this;
};
Object.defineProperties(Duplex.prototype, {
  writableEnded: { get() { return this._writableState.ended; } },
  writableFinished: { get() { return this._writableState.finished; } },
  writableLength: { get() { return this._writableState.length; } },
  writableObjectMode: { get() { return this._writableState.objectMode; } },
  writableHighWaterMark: { get() { return this._writableState.highWaterMark; } },
  writableNeedDrain: { get() { return this._writableState.needDrain; } },
  writableCorked: { get() { return this._writableState.corked; } },
  destroyed: { get() { return this._readableState.destroyed || this._writableState.destroyed; }, set(v) { this._readableState.destroyed = v; this._writableState.destroyed = v; } },
});
Duplex.from = function (x) { return Readable.from(x); };
Duplex.fromWeb = function (pair, opts) { const r = Readable.fromWeb(pair.readable, opts); const w = Writable.fromWeb(pair.writable); const d = new Duplex({ ...opts, read() {}, write: (c, e, cb) => w.write(c, e, cb), final: (cb) => w.end(cb) }); r.on("data", (c) => d.push(c)); r.on("end", () => d.push(null)); return d; };

// ---------- Transform / PassThrough ----------
export function Transform(opts = {}) {
  if (!(this instanceof Transform)) return new Transform(opts);
  Duplex.call(this, opts);
  if (typeof opts.transform === "function") this._transform = opts.transform;
  if (typeof opts.flush === "function") this._flush = opts.flush;
}
inherits(Transform, Duplex);
Transform.prototype._transform = function (chunk, enc, cb) { cb(null, chunk); };
Transform.prototype._write = function (chunk, enc, cb) {
  this._transform(chunk, enc, (err, data) => { if (err) return cb(err); if (data !== undefined && data !== null) this.push(data); cb(); });
};
Transform.prototype._final = function (cb) {
  const done = (err, data) => { if (err) return cb(err); if (data !== undefined && data !== null) this.push(data); this.push(null); cb(); };
  if (typeof this._flush === "function") this._flush(done); else done();
};
export function PassThrough(opts) {
  if (!(this instanceof PassThrough)) return new PassThrough(opts);
  Transform.call(this, opts);
}
inherits(PassThrough, Transform);

// ---------- helpers ----------
export function finished(stream, opts, cb) {
  if (typeof opts === "function") { cb = opts; opts = {}; }
  let called = false;
  const done = (err) => { if (called) return; called = true; cleanup(); cb(err); };
  const onErr = (e) => done(e);
  const isReadable = typeof stream.read === "function" && stream.readable !== false && !!stream._readableState;
  const isWritable = typeof stream.write === "function" && stream.writable !== false && !!stream._writableState;
  const readEnded = () => !isReadable || stream._readableState.endEmitted;
  const writeFinished = () => !isWritable || stream._writableState.finished;
  const check = () => { if (readEnded() && writeFinished()) done(); };
  const onClose = () => { if (!readEnded() && !writeFinished()) done(nodeError("ERR_STREAM_PREMATURE_CLOSE", "Premature close")); else done(); };
  stream.on("end", check); stream.on("finish", check); stream.on("error", onErr); stream.on("close", onClose);
  const cleanup = () => { stream.off("end", check); stream.off("finish", check); stream.off("error", onErr); stream.off("close", onClose); };
  if (stream.destroyed && (stream.errored || readEnded())) queueMicrotask(() => done(stream.errored || undefined));
  else queueMicrotask(check);
  return cleanup;
}
export function pipeline(...streams) {
  const cb = typeof streams[streams.length - 1] === "function" && streams.length > 1 && !(streams[streams.length - 1] instanceof Stream) ? streams.pop() : null;
  if (Array.isArray(streams[0])) streams = streams[0];
  const p = new Promise((resolve, reject) => {
    let last = streams[0];
    if (!(last instanceof Stream) && last && (typeof last[Symbol.asyncIterator] === "function" || typeof last[Symbol.iterator] === "function")) last = Readable.from(last);
    for (let i = 1; i < streams.length; i++) {
      let s = streams[i];
      if (typeof s === "function" && !(s instanceof Stream)) { const src = last; s = Readable.from(s(src), { objectMode: true }); }
      last.once("error", reject);
      last = last.pipe(s);
    }
    finished(last, (err) => (err ? reject(err) : resolve()));
  });
  if (cb) p.then(() => cb(), cb);
  return cb ? streams[streams.length - 1] : p;
}
export function addAbortSignal(signal, stream) { signal.addEventListener("abort", () => stream.destroy(Object.assign(new Error("The operation was aborted"), { name: "AbortError", code: "ABORT_ERR" })), { once: true }); return stream; }
export function isReadable(s) { return !!s && typeof s.read === "function" && s.readable !== false; }
export function isWritable(s) { return !!s && typeof s.write === "function" && s.writable !== false; }
export function isErrored(s) { return !!(s && s.errored); }
export function isDisturbed(s) { return !!(s && s._readableState && (s._readableState.endEmitted || s._readableState.length > 0)); }
export function getDefaultHighWaterMark(objectMode) { return objectMode ? 16 : 65536; }
export function setDefaultHighWaterMark() {}
export function compose(...streams) { return pipeline(...streams, () => {}); }

export const promises = {
  pipeline: (...s) => { const p = pipeline(...s); return p instanceof Promise ? p : Promise.resolve(); },
  finished: (s, o) => new Promise((res, rej) => finished(s, o, (e) => (e ? rej(e) : res()))),
};
Object.assign(Stream, { Readable, Writable, Duplex, Transform, PassThrough, Stream, finished, pipeline, promises, addAbortSignal, isReadable, isWritable, isErrored, isDisturbed, getDefaultHighWaterMark, setDefaultHighWaterMark, compose });
export default Stream;
