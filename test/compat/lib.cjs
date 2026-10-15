const EventEmitter = require("events");
class Counter extends EventEmitter { constructor() { super(); this.n = 0; } inc() { this.n++; this.emit("inc", this.n); return this; } }
exports.Counter = Counter;
exports.add = (a, b) => a + b;
module.exports.VERSION = "1.2.3";
