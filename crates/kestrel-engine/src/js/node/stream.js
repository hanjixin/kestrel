// node:stream — a compact but functional implementation (push-based, buffered, pipe, async iteration).
import { EventEmitter } from "ext:kestrel/node/events.js";
import { Buffer } from "ext:kestrel/node/buffer.js";
import { nodeError } from "ext:kestrel/internal.js";

export class Stream extends EventEmitter {
  pipe(dest, opts) { return pipeImpl(this, dest, opts); }
}

function pipeImpl(src, dest, opts = {}) {
  const ondata = (chunk) => { if (dest.write(chunk) === false && typeof src.pause === "function") src.pause(); };
  src.on("data", ondata);
  dest.on("drain", () => { if (typeof src.resume === "function") src.resume(); });
  if (opts.end !== false) src.once("end", () => dest.end());
  src.once("error", (e) => { if (typeof dest.destroy === "function") dest.destroy(e); });
  dest.emit("pipe", src);
  if (typeof src.resume === "function") src.resume();
  return dest;
}

export class Readable extends Stream {
  constructor(opts = {}) {
    super(opts);
    this._readableState = { buffer: [], length: 0, flowing: null, ended: false, endEmitted: false, reading: false, objectMode: !!(opts.objectMode || opts.readableObjectMode), highWaterMark: opts.highWaterMark ?? (opts.objectMode ? 16 : 65536), encoding: opts.encoding || null, destroyed: false, errored: null, pipes: [] };
    if (typeof opts.read === "function") this._read = opts.read;
    if (typeof opts.destroy === "function") this._destroy = opts.destroy;
    this.readable = true;
  }
  get readableEnded() { return this._readableState.endEmitted; }
  get readableFlowing() { return this._readableState.flowing; }
  get readableLength() { return this._readableState.length; }
  get readableObjectMode() { return this._readableState.objectMode; }
  get readableHighWaterMark() { return this._readableState.highWaterMark; }
  get destroyed() { return this._readableState.destroyed; }
  get errored() { return this._readableState.errored; }
  get closed() { return this._readableState.destroyed; }
  _read() {}
  push(chunk, encoding) {
    const st = this._readableState;
    if (chunk === null) { st.ended = true; this.#maybeEnd(); return false; }
    if (st.ended) { this.destroy(nodeError("ERR_STREAM_PUSH_AFTER_EOF", "stream.push() after EOF")); return false; }
    if (!st.objectMode && typeof chunk === "string") chunk = Buffer.from(chunk, encoding);
    if (st.encoding && !st.objectMode && chunk instanceof Uint8Array) chunk = Buffer.from(chunk).toString(st.encoding);
    st.buffer.push(chunk);
    st.length += st.objectMode ? 1 : chunk.length;
    if (st.flowing) this.#flow();
    else this.emit("readable");
    return st.length < st.highWaterMark;
  }
  unshift(chunk) { const st = this._readableState; st.buffer.unshift(chunk); st.length += st.objectMode ? 1 : chunk.length; }
  #flow() {
    const st = this._readableState;
    if (st.flowingLock) return;
    st.flowingLock = true;
    try {
      while (st.flowing && st.buffer.length) { const c = st.buffer.shift(); st.length -= st.objectMode ? 1 : c.length; this.emit("data", c); }
    } finally { st.flowingLock = false; }
    if (st.buffer.length === 0 && !st.ended && !st.reading) { st.reading = true; queueMicrotask(() => { st.reading = false; this._read(st.highWaterMark); }); }
    this.#maybeEnd();
  }
  #maybeEnd() {
    const st = this._readableState;
    if (st.ended && st.buffer.length === 0 && !st.endEmitted && (st.flowing || st.flowing === null)) {
      st.endEmitted = true; this.readable = false;
      queueMicrotask(() => { this.emit("end"); if (!st.destroyed) { st.destroyed = true; this.emit("close"); } });
    }
  }
  read(n) {
    const st = this._readableState;
    if (st.buffer.length === 0) { if (!st.ended) { this._read(st.highWaterMark); } else this.#maybeEnd(); return null; }
    let chunk;
    if (st.objectMode || n === undefined) { chunk = st.objectMode ? st.buffer.shift() : Buffer.concat(st.buffer.map((b) => typeof b === "string" ? Buffer.from(b) : b)); if (!st.objectMode) { if (st.encoding) chunk = chunk.toString(st.encoding); st.buffer = []; } }
    else { const all = Buffer.concat(st.buffer.map((b) => typeof b === "string" ? Buffer.from(b) : b)); chunk = all.subarray(0, n); const rest = all.subarray(n); st.buffer = rest.length ? [rest] : []; if (st.encoding) chunk = chunk.toString(st.encoding); }
    st.length = st.objectMode ? st.buffer.length : st.buffer.reduce((a, b) => a + b.length, 0);
    if (st.buffer.length === 0 && !st.ended) queueMicrotask(() => this._read(st.highWaterMark));
    this.#maybeEnd();
    return chunk;
  }
  on(ev, fn) { super.on(ev, fn); if (ev === "data" && this._readableState.flowing !== false) this.resume(); else if (ev === "readable") queueMicrotask(() => { if (this._readableState.buffer.length) this.emit("readable"); else this._read(this._readableState.highWaterMark); }); return this; }
  resume() { const st = this._readableState; if (!st.flowing) { st.flowing = true; queueMicrotask(() => { this.#flow(); if (!st.ended && st.buffer.length === 0) this._read(st.highWaterMark); }); } return this; }
  pause() { this._readableState.flowing = false; this.emit("pause"); return this; }
  isPaused() { return this._readableState.flowing === false; }
  setEncoding(enc) { this._readableState.encoding = enc; return this; }
  unpipe() { return this; }
  destroy(err) {
    const st = this._readableState;
    if (st.destroyed) return this;
    st.destroyed = true; this.readable = false;
    const done = (e) => queueMicrotask(() => { if (e) { st.errored = e; this.emit("error", e); } this.emit("close"); });
    if (this._destroy && this._destroy !== Readable.prototype._destroy) this._destroy(err || null, done); else done(err);
    return this;
  }
  _destroy(err, cb) { cb(err); }
  async *[Symbol.asyncIterator]() {
    const st = this._readableState;
    let error = null;
    this.on("error", (e) => { error = e; });
    try {
      for (;;) {
        if (error) throw error;
        if (st.buffer.length) { const c = st.buffer.shift(); st.length -= st.objectMode ? 1 : c.length; yield c; continue; }
        if (st.ended) { this.#maybeEnd(); return; }
        await new Promise((resolve) => { const onAny = () => { this.off("readable", onAny); this.off("end", onAny); this.off("error", onAny); this.off("close", onAny); resolve(); }; this.once("readable", onAny); this.once("end", onAny); this.once("error", onAny); this.once("close", onAny); this._read(st.highWaterMark); });
      }
    } finally { if (!st.ended) this.destroy(); }
  }
  static from(iterable, opts = {}) {
    const r = new Readable({ objectMode: true, ...opts, read() {} });
    (async () => { try { if (typeof iterable === "string" || iterable instanceof Uint8Array) r.push(iterable); else for await (const c of iterable) r.push(c); r.push(null); } catch (e) { r.destroy(e); } })();
    return r;
  }
  static fromWeb(rs, opts) { return Readable.from((async function* () { const reader = rs.getReader(); for (;;) { const { value, done } = await reader.read(); if (done) return; yield value; } })(), { objectMode: false, ...opts }); }
  static toWeb(r) { return new ReadableStream({ start(c) { r.on("data", (d) => c.enqueue(d)); r.on("end", () => c.close()); r.on("error", (e) => c.error(e)); } }); }
  toArray() { return (async () => { const out = []; for await (const c of this) out.push(c); return out; })(); }
  map(fn) { const self = this; return Readable.from((async function* () { for await (const c of self) yield await fn(c); })()); }
  filter(fn) { const self = this; return Readable.from((async function* () { for await (const c of self) if (await fn(c)) yield c; })()); }
  forEach(fn) { return (async () => { for await (const c of this) await fn(c); })(); }
}

export class Writable extends Stream {
  constructor(opts = {}) {
    super(opts);
    this._writableState = { ended: false, finished: false, destroyed: false, objectMode: !!(opts.objectMode || opts.writableObjectMode), highWaterMark: opts.highWaterMark ?? 16384, length: 0, writing: false, queue: [], decodeStrings: opts.decodeStrings !== false, errored: null, corked: 0, needDrain: false };
    if (typeof opts.write === "function") this._write = opts.write;
    if (typeof opts.writev === "function") this._writev = opts.writev;
    if (typeof opts.final === "function") this._final = opts.final;
    if (typeof opts.destroy === "function") this._destroy = opts.destroy;
    this.writable = true;
  }
  get writableEnded() { return this._writableState.ended; }
  get writableFinished() { return this._writableState.finished; }
  get writableLength() { return this._writableState.length; }
  get writableObjectMode() { return this._writableState.objectMode; }
  get writableHighWaterMark() { return this._writableState.highWaterMark; }
  get writableNeedDrain() { return this._writableState.needDrain; }
  get destroyed() { return this._writableState.destroyed; }
  get errored() { return this._writableState.errored; }
  get closed() { return this._writableState.destroyed; }
  _write(chunk, enc, cb) { cb(nodeError("ERR_METHOD_NOT_IMPLEMENTED", "The _write() method is not implemented")); }
  write(chunk, encoding, cb) {
    if (typeof encoding === "function") { cb = encoding; encoding = undefined; }
    const st = this._writableState;
    if (st.ended) { const e = nodeError("ERR_STREAM_WRITE_AFTER_END", "write after end"); queueMicrotask(() => { if (cb) cb(e); this.emit("error", e); }); return false; }
    if (!st.objectMode && typeof chunk === "string" && st.decodeStrings) { chunk = Buffer.from(chunk, encoding || "utf8"); encoding = "buffer"; }
    else if (!st.objectMode && chunk instanceof Uint8Array) encoding = "buffer";
    st.length += st.objectMode ? 1 : chunk.length;
    st.queue.push([chunk, encoding || "utf8", cb]);
    if (!st.writing && !st.corked) this.#drainQueue();
    const ok = st.length < st.highWaterMark;
    if (!ok) st.needDrain = true;
    return ok;
  }
  #drainQueue() {
    const st = this._writableState;
    if (st.writing || st.corked || st.queue.length === 0) { if (st.queue.length === 0) this.#maybeFinish(); return; }
    st.writing = true;
    const [chunk, enc, cb] = st.queue.shift();
    let sync = true;
    this._write(chunk, enc, (err) => {
      st.writing = false;
      st.length -= st.objectMode ? 1 : chunk.length;
      if (err) { st.errored = err; if (cb) cb(err); this.destroy(err); return; }
      if (cb) cb(null);
      const next = () => { if (st.queue.length) this.#drainQueue(); else { if (st.needDrain && !st.ended) { st.needDrain = false; this.emit("drain"); } this.#maybeFinish(); } };
      if (sync) queueMicrotask(next); else next();
    });
    sync = false;
  }
  #maybeFinish() {
    const st = this._writableState;
    if (st.ended && !st.finished && st.queue.length === 0 && !st.writing && !st.finishing) {
      st.finishing = true;
      const fin = (err) => { if (err) return this.destroy(err); st.finished = true; this.writable = false; this.emit("finish"); if (!st.destroyed) { st.destroyed = true; queueMicrotask(() => this.emit("close")); } };
      if (this._final) this._final(fin); else fin();
    }
  }
  end(chunk, encoding, cb) {
    if (typeof chunk === "function") { cb = chunk; chunk = undefined; } else if (typeof encoding === "function") { cb = encoding; encoding = undefined; }
    const st = this._writableState;
    if (chunk !== undefined && chunk !== null) this.write(chunk, encoding);
    if (cb) this.once("finish", cb);
    if (!st.ended) { st.ended = true; this.uncork(); if (!st.writing && st.queue.length === 0) this.#maybeFinish(); }
    return this;
  }
  cork() { this._writableState.corked++; }
  uncork() { const st = this._writableState; if (st.corked) st.corked--; if (!st.corked) this.#drainQueue(); }
  setDefaultEncoding() { return this; }
  destroy(err) {
    const st = this._writableState;
    if (st.destroyed) return this;
    st.destroyed = true; this.writable = false;
    const done = (e) => queueMicrotask(() => { if (e) { st.errored = e; this.emit("error", e); } this.emit("close"); });
    if (this._destroy && this._destroy !== Writable.prototype._destroy) this._destroy(err || null, done); else done(err);
    return this;
  }
  _destroy(err, cb) { cb(err); }
  static fromWeb(ws) { const writer = ws.getWriter(); return new Writable({ write(c, e, cb) { writer.write(c).then(() => cb(), cb); }, final(cb) { writer.close().then(() => cb(), cb); } }); }
  static toWeb(w) { return new WritableStream({ write(c) { return new Promise((res, rej) => w.write(c, (e) => (e ? rej(e) : res()))); }, close() { return new Promise((res) => w.end(res)); } }); }
}

export class Duplex extends Readable {
  constructor(opts = {}) {
    super(opts);
    const w = new Writable({ ...opts, write: (c, e, cb) => this._write(c, e, cb), final: (cb) => (this._final ? this._final(cb) : cb()) });
    this._writableState = w._writableState;
    this.writable = true;
    this._w = w;
    if (typeof opts.write === "function") this._write = opts.write;
    if (typeof opts.final === "function") this._final = opts.final;
    w.on("drain", () => this.emit("drain"));
    w.on("finish", () => this.emit("finish"));
    w.on("error", (e) => this.emit("error", e));
    if (opts.allowHalfOpen === false) this.once("end", () => this.end());
  }
  _write(chunk, enc, cb) { cb(nodeError("ERR_METHOD_NOT_IMPLEMENTED", "The _write() method is not implemented")); }
  write(c, e, cb) { return this._w.write(c, e, cb); }
  end(c, e, cb) { this._w.end(c, e, cb); return this; }
  cork() { this._w.cork(); }
  uncork() { this._w.uncork(); }
  setDefaultEncoding() { return this; }
  get writableEnded() { return this._w.writableEnded; }
  get writableFinished() { return this._w.writableFinished; }
  get writableLength() { return this._w.writableLength; }
  get writableHighWaterMark() { return this._w.writableHighWaterMark; }
  get writableObjectMode() { return this._w.writableObjectMode; }
  get writableNeedDrain() { return this._w.writableNeedDrain; }
  static from(x) { return Readable.from(x); }
}

export class Transform extends Duplex {
  constructor(opts = {}) {
    super({ ...opts, write: undefined, final: undefined });
    if (typeof opts.transform === "function") this._transform = opts.transform;
    if (typeof opts.flush === "function") this._flush = opts.flush;
  }
  _transform(chunk, enc, cb) { cb(null, chunk); }
  _write(chunk, enc, cb) { this._transform(chunk, enc, (err, data) => { if (err) return cb(err); if (data !== undefined && data !== null) this.push(data); cb(); }); }
  _final(cb) { const done = (err, data) => { if (err) return cb(err); if (data !== undefined && data !== null) this.push(data); this.push(null); cb(); }; if (this._flush) this._flush(done); else done(); }
}
export class PassThrough extends Transform {}

export function finished(stream, opts, cb) {
  if (typeof opts === "function") { cb = opts; opts = {}; }
  let called = false;
  const done = (err) => { if (called) return; called = true; cleanup(); cb(err); };
  const onEnd = () => done(), onErr = (e) => done(e);
  const isReadable = typeof stream.read === "function", isWritable = typeof stream.write === "function";
  const readEnded = () => !isReadable || stream._readableState?.endEmitted || stream.readableEnded;
  const writeFinished = () => !isWritable || stream._writableState?.finished || stream.writableFinished;
  const check = () => { if (readEnded() && writeFinished()) done(); };
  const onClose = () => { if (!readEnded() && !writeFinished()) done(nodeError("ERR_STREAM_PREMATURE_CLOSE", "Premature close")); else done(); };
  stream.on("end", check); stream.on("finish", check); stream.on("error", onErr); stream.on("close", onClose);
  const cleanup = () => { stream.off("end", check); stream.off("finish", check); stream.off("error", onErr); stream.off("close", onClose); };
  if (stream.destroyed && (stream.errored || readEnded())) queueMicrotask(() => done(stream.errored || undefined));
  return cleanup;
}
export function pipeline(...streams) {
  const cb = typeof streams[streams.length - 1] === "function" ? streams.pop() : null;
  if (Array.isArray(streams[0])) streams = streams[0];
  const p = new Promise((resolve, reject) => {
    let last = streams[0];
    for (let i = 1; i < streams.length; i++) {
      let s = streams[i];
      if (typeof s === "function") { const src = last; const out = Readable.from(s(src[Symbol.asyncIterator] ? src : Readable.from(src)), { objectMode: true }); s = out; }
      last.once("error", reject);
      last = last.pipe(s);
    }
    finished(last, (err) => (err ? reject(err) : resolve()));
  });
  if (cb) p.then(() => cb(), cb);
  return cb ? streams[streams.length - 1] : p;
}
export function addAbortSignal(signal, stream) { signal.addEventListener("abort", () => stream.destroy(new Error("AbortError")), { once: true }); return stream; }
export function isReadable(s) { return !!s && typeof s.read === "function" && s.readable !== false; }
export function isWritable(s) { return !!s && typeof s.write === "function" && s.writable !== false; }
export function isErrored(s) { return !!(s && s.errored); }
export function isDisturbed(s) { return !!(s && (s.readableDidRead || s._readableState?.endEmitted)); }
export function getDefaultHighWaterMark(objectMode) { return objectMode ? 16 : 65536; }
export function setDefaultHighWaterMark() {}

const promises = { pipeline: (...s) => pipeline(...s.filter((x) => typeof x !== "function" || x.length !== 1 || true)), finished: (s, o) => new Promise((res, rej) => finished(s, o, (e) => (e ? rej(e) : res()))) };
promises.pipeline = (...s) => { const p = pipeline(...s); return p instanceof Promise ? p : Promise.resolve(); };
export { promises };
Stream.Readable = Readable; Stream.Writable = Writable; Stream.Duplex = Duplex; Stream.Transform = Transform; Stream.PassThrough = PassThrough; Stream.Stream = Stream;
Stream.finished = finished; Stream.pipeline = pipeline; Stream.promises = promises; Stream.addAbortSignal = addAbortSignal; Stream.isReadable = isReadable; Stream.isWritable = isWritable; Stream.isErrored = isErrored; Stream.isDisturbed = isDisturbed; Stream.getDefaultHighWaterMark = getDefaultHighWaterMark; Stream.setDefaultHighWaterMark = setDefaultHighWaterMark;
export default Stream;
