// node:timers
export const setTimeout = globalThis.setTimeout;
export const clearTimeout = globalThis.clearTimeout;
export const setInterval = globalThis.setInterval;
export const clearInterval = globalThis.clearInterval;
export const setImmediate = globalThis.setImmediate;
export const clearImmediate = globalThis.clearImmediate;
import * as promises from "ext:kestrel/node/timers_promises.js";
export { promises };
export default { setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, clearImmediate, promises };
