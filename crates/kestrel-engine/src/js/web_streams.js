// Standard Web Streams implementation, pinned with its license and provenance in vendor/.
// All stream constructors share one implementation so BYOB, tee and pipeTo agree on brands.
import * as streams from "ext:kestrel/vendor/web-streams-polyfill.js";
export * from "ext:kestrel/vendor/web-streams-polyfill.js";
const { TransformStream } = streams;
const { TextEncoder, TextDecoder } = globalThis;

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

const defs = { ...streams, TextEncoderStream, TextDecoderStream };
for (const [name, value] of Object.entries(defs)) {
  Object.defineProperty(globalThis, name, { value, writable: true, enumerable: false, configurable: true });
}
