// node:v8 — heap statistics and flags; serialization via structuredClone + JSON.
import { ops } from "ext:kestrel/internal.js";
import { Buffer } from "ext:kestrel/node/buffer.js";
export function getHeapStatistics() { return ops.op_v8_heap_stats(); }
export function getHeapSpaceStatistics() { return []; }
export function getHeapCodeStatistics() { return { code_and_metadata_size: 0, bytecode_and_metadata_size: 0, external_script_source_size: 0, cpu_profiler_metadata_size: 0 }; }
export function setFlagsFromString() {}
export function cachedDataVersionTag() { return 0; }
export function serialize(v) { return Buffer.from(JSON.stringify(v, (k, x) => (typeof x === "bigint" ? { __big: x.toString() } : x instanceof Map ? { __map: [...x] } : x instanceof Set ? { __set: [...x] } : x instanceof Uint8Array ? { __u8: Buffer.from(x).toString("base64") } : x))); }
export function deserialize(b) { return JSON.parse(Buffer.from(b).toString(), (k, x) => (x && typeof x === "object" ? (x.__big !== undefined ? BigInt(x.__big) : x.__map ? new Map(x.__map) : x.__set ? new Set(x.__set) : x.__u8 !== undefined ? Buffer.from(x.__u8, "base64") : x) : x)); }
export function writeHeapSnapshot() { throw new Error("v8.writeHeapSnapshot is not supported"); }
export function getHeapSnapshot() { throw new Error("v8.getHeapSnapshot is not supported"); }
export const promiseHooks = { onInit() { return () => {}; }, onSettled() { return () => {}; }, onBefore() { return () => {}; }, onAfter() { return () => {}; }, createHook() { return { enable() {}, disable() {} }; } };
export function takeCoverage() {} export function stopCoverage() {} export function setHeapSnapshotNearHeapLimit() {}
export default { getHeapStatistics, getHeapSpaceStatistics, getHeapCodeStatistics, setFlagsFromString, cachedDataVersionTag, serialize, deserialize, writeHeapSnapshot, getHeapSnapshot, promiseHooks, takeCoverage, stopCoverage, setHeapSnapshotNearHeapLimit };
