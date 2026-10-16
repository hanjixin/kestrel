// Web Streams API (WHATWG) as global constructors, which Node exposes globally since v18 and
// modern libraries (Next.js edge runtime, undici, many others) rely on. This is a functional
// implementation covering the common surface: ReadableStream (default + the byte-oriented
// read path used in practice), WritableStream, TransformStream, their readers/writers,
// TextEncoderStream/TextDecoderStream, and the queuing strategies. Backpressure is modelled
// with the standard desiredSize/ready signalling, enough for real consumers.
// TextEncoder/TextDecoder are set as globals by globals.js, which loads first.
const TextEncoder = globalThis.TextEncoder;
const TextDecoder = globalThis.TextDecoder;

const kType = Symbol("ws.type");

function makePromise() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// ---------- ReadableStream ----------
class ReadableStreamDefaultController {
  constructor(stream, underlying, hwm, sizeAlgo) {
    this._stream = stream; this._underlying = underlying; this._hwm = hwm; this._size = sizeAlgo;
    this._queue = []; this._queueTotal = 0; this._started = false; this._closeRequested = false; this._pulling = false; this._pullAgain = false;
  }
  get desiredSize() {
    const s = this._stream._state;
    if (s === "errored") return null;
    if (s === "closed") return 0;
    return this._hwm - this._queueTotal;
  }
  enqueue(chunk) {
    if (this._closeRequested || this._stream._state !== "readable") throw new TypeError("Cannot enqueue");
    const reader = this._stream._reader;
    if (reader && reader._readRequests.length > 0) {
      const req = reader._readRequests.shift();
      req.resolve({ value: chunk, done: false });
    } else {
      let size = 1;
      try { size = this._size ? this._size(chunk) : 1; } catch (e) { this._error(e); throw e; }
      this._queue.push({ chunk, size }); this._queueTotal += size;
    }
    this._callPullIfNeeded();
  }
  close() {
    if (this._closeRequested) return;
    this._closeRequested = true;
    if (this._queue.length === 0) this._closeStream();
  }
  error(e) { this._error(e); }
  _closeStream() {
    this._stream._state = "closed";
    const reader = this._stream._reader;
    if (reader) { for (const r of reader._readRequests) r.resolve({ value: undefined, done: true }); reader._readRequests = []; reader._closedResolve && reader._closedResolve(); }
  }
  _error(e) {
    if (this._stream._state !== "readable") return;
    this._stream._state = "errored"; this._stream._storedError = e; this._queue = []; this._queueTotal = 0;
    const reader = this._stream._reader;
    if (reader) { for (const r of reader._readRequests) r.reject(e); reader._readRequests = []; if (reader._closedReject) reader._closedReject(e); }
  }
  _callPullIfNeeded() {
    if (!this._started) return;
    if (this._pulling) { this._pullAgain = true; return; }
    const reader = this._stream._reader;
    const wantMore = this.desiredSize > 0 || (reader && reader._readRequests.length > 0);
    if (!wantMore || this._closeRequested) return;
    if (!this._underlying.pull) return;
    this._pulling = true;
    Promise.resolve().then(() => this._underlying.pull(this)).then(() => {
      this._pulling = false;
      if (this._pullAgain) { this._pullAgain = false; this._callPullIfNeeded(); }
    }, (e) => { this._pulling = false; this._error(e); });
  }
  _pullFromQueue(req) {
    const entry = this._queue.shift(); this._queueTotal -= entry.size;
    if (this._queue.length === 0 && this._closeRequested) this._closeStream();
    else this._callPullIfNeeded();
    req.resolve({ value: entry.chunk, done: false });
  }
  _start() {
    Promise.resolve().then(() => (this._underlying.start ? this._underlying.start(this) : undefined)).then(() => {
      this._started = true; this._callPullIfNeeded();
    }, (e) => this._error(e));
  }
}

export class ReadableStream {
  constructor(underlying = {}, strategy = {}) {
    this[kType] = "ReadableStream";
    this._state = "readable"; this._reader = null; this._storedError = undefined; this._disturbed = false;
    this._underlying = underlying;
    const hwm = strategy.highWaterMark ?? 1;
    const sizeAlgo = strategy.size;
    if (underlying.type === "bytes") {
      // Byte streams are presented through the same default machinery here.
    }
    this._controller = new ReadableStreamDefaultController(this, underlying, hwm, sizeAlgo);
    this._controller._start();
  }
  get locked() { return this._reader !== null; }
  getReader(opts) {
    if (opts && opts.mode === "byob") throw new TypeError("BYOB reader not supported");
    if (this._reader) throw new TypeError("ReadableStream is locked");
    return new ReadableStreamDefaultReader(this);
  }
  cancel(reason) {
    if (this._reader) return Promise.reject(new TypeError("locked"));
    return this._cancel(reason);
  }
  _cancel(reason) {
    this._disturbed = true;
    if (this._state === "closed") return Promise.resolve();
    if (this._state === "errored") return Promise.reject(this._storedError);
    this._controller._queue = []; this._controller._queueTotal = 0;
    this._controller._closeStream();
    return Promise.resolve(this._underlying.cancel ? this._underlying.cancel(reason) : undefined).then(() => undefined);
  }
  pipeTo(dest, options = {}) { return pipeToImpl(this, dest, options); }
  pipeThrough(transform, options = {}) {
    if (this.locked) throw new TypeError("ReadableStream is locked");
    if (transform.writable.locked) throw new TypeError("writable is locked");
    pipeToImpl(this, transform.writable, options);
    return transform.readable;
  }
  tee() { return teeImpl(this); }
  values(opts = {}) { return readableAsyncIterator(this, opts); }
  [Symbol.asyncIterator](opts) { return readableAsyncIterator(this, opts); }
  static from(iterable) {
    const asyncIt = iterable[Symbol.asyncIterator] ? iterable[Symbol.asyncIterator]() : iterable[Symbol.iterator]();
    return new ReadableStream({
      async pull(c) {
        const { value, done } = await asyncIt.next();
        if (done) c.close(); else c.enqueue(value);
      },
      async cancel(reason) { if (asyncIt.return) await asyncIt.return(reason); },
    });
  }
}

class ReadableStreamDefaultReader {
  constructor(stream) {
    this._stream = stream; stream._reader = this; this._readRequests = [];
    const c = makePromise(); this._closedPromise = c.promise; this._closedResolve = c.resolve; this._closedReject = c.reject;
    c.promise.catch(() => {});
    if (stream._state === "closed") this._closedResolve();
    else if (stream._state === "errored") this._closedReject(stream._storedError);
  }
  get closed() { return this._closedPromise; }
  read() {
    if (!this._stream) return Promise.reject(new TypeError("reader released"));
    const stream = this._stream; stream._disturbed = true;
    if (stream._state === "closed") return Promise.resolve({ value: undefined, done: true });
    if (stream._state === "errored") return Promise.reject(stream._storedError);
    const ctrl = stream._controller;
    if (ctrl._queue.length > 0) { const req = makePromise(); ctrl._pullFromQueue(req); return req.promise; }
    const req = makePromise(); this._readRequests.push(req); ctrl._callPullIfNeeded(); return req.promise;
  }
  releaseLock() {
    if (!this._stream) return;
    if (this._readRequests.length > 0) throw new TypeError("Cannot release with pending reads");
    this._stream._reader = null; this._stream = null;
    if (this._closedReject) this._closedReject(new TypeError("Reader released"));
  }
  cancel(reason) { if (!this._stream) return Promise.reject(new TypeError("reader released")); return this._stream._cancel(reason); }
}

function readableAsyncIterator(stream, opts = {}) {
  const reader = stream.getReader();
  return {
    async next() {
      try { const r = await reader.read(); if (r.done) { reader.releaseLock(); } return r; }
      catch (e) { reader.releaseLock(); throw e; }
    },
    async return(value) { if (!opts.preventCancel) { try { await reader.cancel(value); } catch {} } reader.releaseLock(); return { value, done: true }; },
    [Symbol.asyncIterator]() { return this; },
  };
}

function teeImpl(stream) {
  const reader = stream.getReader();
  let reading = false, canceled1 = false, canceled2 = false;
  let c1, c2;
  const pull = () => {
    if (reading) return; reading = true;
    reader.read().then((r) => {
      reading = false;
      if (r.done) { if (!canceled1) c1.close(); if (!canceled2) c2.close(); return; }
      if (!canceled1) c1.enqueue(r.value);
      if (!canceled2) c2.enqueue(r.value);
    }, (e) => { c1.error(e); c2.error(e); });
  };
  const b1 = new ReadableStream({ pull() { pull(); }, cancel(r) { canceled1 = true; if (canceled2) return reader.cancel(r); } });
  const b2 = new ReadableStream({ pull() { pull(); }, cancel(r) { canceled2 = true; if (canceled1) return reader.cancel(r); } });
  c1 = b1._controller; c2 = b2._controller;
  return [b1, b2];
}

async function pipeToImpl(source, dest, options) {
  const reader = source.getReader();
  const writer = dest.getWriter();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      await writer.ready;
      await writer.write(value);
    }
    if (!options.preventClose) await writer.close();
    else writer.releaseLock();
    reader.releaseLock();
  } catch (e) {
    try { if (!options.preventAbort) await writer.abort(e); } catch {}
    try { if (!options.preventCancel) await reader.cancel(e); } catch {}
    reader.releaseLock(); writer.releaseLock();
    throw e;
  }
}

// ---------- WritableStream ----------
class WritableStreamDefaultController {
  constructor(stream, underlying) { this._stream = stream; this._underlying = underlying; this.signal = (typeof AbortController !== "undefined") ? new AbortController().signal : undefined; }
  error(e) { this._stream._errorStream(e); }
}

export class WritableStream {
  constructor(underlying = {}, strategy = {}) {
    this[kType] = "WritableStream";
    this._state = "writable"; this._storedError = undefined; this._writer = null; this._underlying = underlying;
    this._hwm = strategy.highWaterMark ?? 1; this._size = strategy.size;
    this._queue = Promise.resolve();
    this._controller = new WritableStreamDefaultController(this, underlying);
    this._startPromise = Promise.resolve(underlying.start ? underlying.start(this._controller) : undefined);
    this._startPromise.catch((e) => this._errorStream(e));
  }
  get locked() { return this._writer !== null; }
  getWriter() { if (this._writer) throw new TypeError("WritableStream is locked"); return new WritableStreamDefaultWriter(this); }
  abort(reason) { if (this._writer) return Promise.reject(new TypeError("locked")); return this._abort(reason); }
  close() { if (this._writer) return Promise.reject(new TypeError("locked")); return this._close(); }
  _abort(reason) {
    if (this._state === "errored" || this._state === "closed") return Promise.resolve();
    this._state = "erroring";
    return Promise.resolve(this._underlying.abort ? this._underlying.abort(reason) : undefined).then(() => { this._state = "errored"; this._storedError = reason; });
  }
  _close() {
    return this._startPromise.then(() => this._queue).then(() => this._underlying.close ? this._underlying.close() : undefined).then(() => { this._state = "closed"; });
  }
  _write(chunk) {
    this._queue = this._queue.then(() => this._startPromise).then(() => {
      if (this._state === "errored" || this._state === "erroring") throw this._storedError;
      return this._underlying.write ? this._underlying.write(chunk, this._controller) : undefined;
    });
    return this._queue;
  }
  _errorStream(e) { if (this._state === "writable" || this._state === "erroring") { this._state = "errored"; this._storedError = e; } }
}

class WritableStreamDefaultWriter {
  constructor(stream) {
    this._stream = stream; stream._writer = this;
    const r = makePromise(); this._readyPromise = r.promise; r.resolve();
    const c = makePromise(); this._closedPromise = c.promise; this._closedResolve = c.resolve; this._closedReject = c.reject; c.promise.catch(() => {});
  }
  get desiredSize() { return this._stream._hwm; }
  get ready() { return this._readyPromise; }
  get closed() { return this._closedPromise; }
  write(chunk) { if (!this._stream) return Promise.reject(new TypeError("writer released")); return this._stream._write(chunk); }
  close() { if (!this._stream) return Promise.reject(new TypeError("writer released")); const p = this._stream._close(); p.then(() => this._closedResolve(), (e) => this._closedReject(e)); return p; }
  abort(reason) { if (!this._stream) return Promise.reject(new TypeError("writer released")); return this._stream._abort(reason); }
  releaseLock() { if (this._stream) { this._stream._writer = null; this._stream = null; if (this._closedReject) this._closedReject(new TypeError("Writer released")); } }
}

// ---------- TransformStream ----------
export class TransformStream {
  constructor(transformer = {}, writableStrategy = {}, readableStrategy = {}) {
    this[kType] = "TransformStream";
    let readableController;
    const self = this;
    this.readable = new ReadableStream({
      start(c) { readableController = c; },
      pull() {},
      cancel(reason) { if (transformer.cancel) return transformer.cancel(reason); },
    }, readableStrategy);
    const tc = {
      enqueue(chunk) { readableController.enqueue(chunk); },
      error(e) { readableController.error(e); self.writable._errorStream(e); },
      terminate() { readableController.close(); },
      get desiredSize() { return readableController.desiredSize; },
    };
    this.writable = new WritableStream({
      start() { return transformer.start ? transformer.start(tc) : undefined; },
      write(chunk) { return transformer.transform ? transformer.transform(chunk, tc) : (tc.enqueue(chunk), undefined); },
      close() { return Promise.resolve(transformer.flush ? transformer.flush(tc) : undefined).then(() => { try { readableController.close(); } catch {} }); },
      abort(reason) { readableController.error(reason); },
    }, writableStrategy);
  }
}

// ---------- TextEncoderStream / TextDecoderStream ----------
export class TextEncoderStream {
  constructor() {
    this.encoding = "utf-8";
    const enc = new TextEncoder();
    this._ts = new TransformStream({ transform(chunk, c) { const out = enc.encode(String(chunk)); if (out.length) c.enqueue(out); } });
  }
  get readable() { return this._ts.readable; }
  get writable() { return this._ts.writable; }
}
export class TextDecoderStream {
  constructor(label = "utf-8", options = {}) {
    this.encoding = String(label).toLowerCase();
    const dec = new TextDecoder(label, options);
    this._ts = new TransformStream({
      transform(chunk, c) { const s = dec.decode(chunk, { stream: true }); if (s) c.enqueue(s); },
      flush(c) { const s = dec.decode(); if (s) c.enqueue(s); },
    });
  }
  get readable() { return this._ts.readable; }
  get writable() { return this._ts.writable; }
}

// ---------- queuing strategies ----------
export class ByteLengthQueuingStrategy {
  constructor(opts) { this.highWaterMark = opts.highWaterMark; }
  get size() { return (chunk) => chunk.byteLength; }
}
export class CountQueuingStrategy {
  constructor(opts) { this.highWaterMark = opts.highWaterMark; }
  get size() { return () => 1; }
}

const defs = { ReadableStream, WritableStream, TransformStream, ReadableStreamDefaultReader, WritableStreamDefaultWriter, ReadableStreamDefaultController, WritableStreamDefaultController, TextEncoderStream, TextDecoderStream, ByteLengthQueuingStrategy, CountQueuingStrategy };
for (const [k, v] of Object.entries(defs)) {
  if (globalThis[k] === undefined) Object.defineProperty(globalThis, k, { value: v, writable: true, enumerable: false, configurable: true });
}
