// Framing shared by both ends of child_process IPC. Buffer fragments are joined
// once per complete frame, avoiding repeated copying as a large message arrives.
import { ops, utf8Encode, utf8Decode } from "ext:kestrel/internal.js";
export function encodeMessage(value, advanced) {
  if (!advanced) return utf8Encode(JSON.stringify(value) + "\n");
  const data = ops.op_ipc_encode(value), frame = new Uint8Array(data.length + 4);
  new DataView(frame.buffer).setUint32(0, data.length);
  frame.set(data, 4); return frame;
}
export class MessageDecoder {
  constructor(advanced) { this.advanced = advanced; this.parts = []; this.length = 0; }
  push(chunk, receive) {
    if (!this.advanced) {
      let offset = 0;
      for (;;) {
        const newline = chunk.indexOf(10, offset);
        const part = chunk.subarray(offset, newline < 0 ? undefined : newline);
        if (part.length) { this.parts.push(part); this.length += part.length; }
        if (newline < 0) return;
        if (this.length) receive(JSON.parse(utf8Decode(this.peek(this.length))));
        this.parts = []; this.length = 0; offset = newline + 1;
        if (offset === chunk.length) return;
      }
    }
    this.parts.push(chunk); this.length += chunk.length;
    for (;;) {
      if (this.length < 4) return;
      const header = this.peek(4);
      const size = new DataView(header.buffer, header.byteOffset, 4).getUint32(0) + 4;
      if (size > 256 * 1024 * 1024) throw new RangeError("IPC frame exceeds limit");
      if (this.length < size) return;
      const frame = this.peek(size);
      let remaining = size;
      while (remaining) {
        const part = this.parts[0];
        if (part.length <= remaining) { remaining -= part.length; this.parts.shift(); }
        else { this.parts[0] = part.subarray(remaining); remaining = 0; }
      }
      this.length -= size;
      receive(ops.op_ipc_decode(frame.subarray(4)));
      if (!this.length) return;
    }
  }
  peek(size) {
    if (this.parts[0].length >= size) return this.parts[0].subarray(0, size);
    const out = new Uint8Array(size); let offset = 0;
    for (const part of this.parts) { const n = Math.min(part.length, size - offset); out.set(part.subarray(0, n), offset); offset += n; if (offset === size) break; }
    return out;
  }
}

export async function closeChannel(rid) {
  // Drain queued writes before closing both halves; half-close alone leaves an
  // outstanding read op alive when the child initiates disconnect.
  try { await ops.op_net_shutdown(rid); } finally { ops.op_net_close(rid); }
}
