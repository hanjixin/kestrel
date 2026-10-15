// node:readline — line-oriented reading from stdin (blocking reads), enough for prompts and scripts.
import { ops, nodeError } from "ext:kestrel/internal.js";
import { EventEmitter } from "ext:kestrel/node/events.js";

export class Interface extends EventEmitter {
  #closed = false; #paused = false; #prompt = "> "; #pumping = false;
  constructor(opts = {}) {
    super();
    this.input = opts.input; this.output = opts.output; this.terminal = !!opts.terminal; this.line = ""; this.cursor = 0; this.history = [];
    if (opts.prompt !== undefined) this.#prompt = opts.prompt;
    // Pump lines when someone listens for them.
    this.on("newListener", (ev) => { if (ev === "line") queueMicrotask(() => this.#pump()); });
  }
  #pump() {
    if (this.#pumping) return; this.#pumping = true;
    const step = () => {
      if (this.#closed || this.#paused) { this.#pumping = false; return; }
      const s = ops.op_k_read_stdin_line();
      if (s === "") { this.close(); this.#pumping = false; return; }
      this.emit("line", s.replace(/\r?\n$/, ""));
      setTimeout(step, 0);
    };
    step();
  }
  setPrompt(p) { this.#prompt = p; }
  getPrompt() { return this.#prompt; }
  prompt() { if (this.output) this.output.write(this.#prompt); }
  question(query, opts, cb) {
    if (typeof opts === "function") { cb = opts; opts = {}; }
    if (this.output) this.output.write(query);
    const s = ops.op_k_read_stdin_line();
    queueMicrotask(() => cb(s.replace(/\r?\n$/, "")));
  }
  pause() { this.#paused = true; this.emit("pause"); return this; }
  resume() { if (this.#paused) { this.#paused = false; this.emit("resume"); this.#pump(); } return this; }
  close() { if (this.#closed) return; this.#closed = true; this.emit("close"); }
  write(d) { if (this.output) this.output.write(d); }
  getCursorPos() { return { rows: 0, cols: 0 }; }
  async *[Symbol.asyncIterator]() { for (;;) { if (this.#closed) return; const s = ops.op_k_read_stdin_line(); if (s === "") { this.close(); return; } yield s.replace(/\r?\n$/, ""); } }
}
export function createInterface(input, output, completer, terminal) { const opts = input && typeof input === "object" && !input.on ? input : { input, output, completer, terminal }; return new Interface(opts); }
export function clearLine(stream, dir, cb) { if (cb) cb(); return true; }
export function clearScreenDown(stream, cb) { if (cb) cb(); return true; }
export function cursorTo(stream, x, y, cb) { if (typeof y === "function") cb = y; if (cb) cb(); return true; }
export function moveCursor(stream, dx, dy, cb) { if (cb) cb(); return true; }
export function emitKeypressEvents() {}
export const promises = { createInterface(...a) { const rl = createInterface(...a); rl.question = (q) => new Promise((res) => Interface.prototype.question.call(rl, q, res)); return rl; }, Interface };
export default { Interface, createInterface, clearLine, clearScreenDown, cursorTo, moveCursor, emitKeypressEvents, promises };
