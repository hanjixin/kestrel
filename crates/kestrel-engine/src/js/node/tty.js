// node:tty
import { ops } from "ext:kestrel/internal.js";
export function isatty(fd) { return ops.op_k_isatty(fd >>> 0); }
export class ReadStream { constructor(fd) { this.fd = fd; this.isTTY = isatty(fd); this.isRaw = false; } setRawMode(m) { this.isRaw = m; return this; } }
export class WriteStream { constructor(fd) { this.fd = fd; this.isTTY = isatty(fd); this.columns = 80; this.rows = 24; } getColorDepth() { return 8; } hasColors() { return this.isTTY; } getWindowSize() { return [this.columns, this.rows]; } }
export default { isatty, ReadStream, WriteStream };
