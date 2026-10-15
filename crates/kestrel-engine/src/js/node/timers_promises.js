// node:timers/promises
function abortErr(reason) { const e = new Error("The operation was aborted"); e.name = "AbortError"; e.code = "ABORT_ERR"; e.cause = reason; return e; }
export function setTimeout(ms = 1, value, opts = {}) {
  return new Promise((resolve, reject) => {
    const signal = opts.signal;
    if (signal && signal.aborted) return reject(abortErr(signal.reason));
    const t = globalThis.setTimeout(() => { if (signal) signal.removeEventListener("abort", onAbort); resolve(value); }, ms);
    if (opts.ref === false && t && typeof t.unref === "function") t.unref();
    const onAbort = () => { globalThis.clearTimeout(t); reject(abortErr(signal.reason)); };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
  });
}
export function setImmediate(value, opts = {}) {
  return new Promise((resolve, reject) => {
    const signal = opts.signal;
    if (signal && signal.aborted) return reject(abortErr(signal.reason));
    globalThis.setImmediate(() => resolve(value));
  });
}
export async function* setInterval(ms = 1, value, opts = {}) {
  const signal = opts.signal;
  for (;;) { if (signal && signal.aborted) throw abortErr(signal.reason); await setTimeout(ms, undefined, opts); yield value; }
}
export const scheduler = { wait: (ms, opts) => setTimeout(ms, undefined, opts), yield: () => setImmediate() };
export default { setTimeout, setImmediate, setInterval, scheduler };
