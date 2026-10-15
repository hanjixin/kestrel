// node:perf_hooks
export const performance = globalThis.performance;
export class PerformanceObserver { constructor(cb) { this._cb = cb; } observe() {} disconnect() {} static supportedEntryTypes = ["mark", "measure", "function"]; }
export class PerformanceEntry { constructor(name, type, start, duration) { this.name = name; this.entryType = type; this.startTime = start; this.duration = duration; } }
export function monitorEventLoopDelay() { return { enable() {}, disable() {}, reset() {}, min: 0, max: 0, mean: 0, stddev: 0, percentiles: new Map(), percentile() { return 0; } }; }
export function createHistogram() { return { record() {}, min: 0, max: 0, mean: 0, stddev: 0, percentile() { return 0; }, percentiles: new Map(), reset() {} }; }
export const constants = { NODE_PERFORMANCE_GC_MAJOR: 4, NODE_PERFORMANCE_GC_MINOR: 1, NODE_PERFORMANCE_GC_INCREMENTAL: 8, NODE_PERFORMANCE_GC_WEAKCB: 16 };
export default { performance, PerformanceObserver, PerformanceEntry, monitorEventLoopDelay, createHistogram, constants };
