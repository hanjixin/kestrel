// Node-API addon loaded through require(): see napi/hello.c (built by napi/build.sh).
const path = require("node:path");
const addon = require(path.join(__dirname, "napi", "hello.node"));
const out = [];
out.push(addon.add(2, 40), addon.shout("hi there"), addon.fill(4, 7).toString("hex"), addon.sum(Buffer.from([1, 2, 3, 250])));
out.push(addon.callTwice((x) => x * 3, 5), addon.describe(null), addon.describe(() => 1), addon.describe(10n));
try { addon.throws(); } catch (e) { out.push(e.code, e.message); }
try { addon.sum("nope"); } catch (e) { out.push(e.name, e.code); }
const c = new addon.Counter();
c.add(1.5); out.push(c.add(2), c instanceof addon.Counter, typeof addon.Counter);
const v = addon.version(); out.push(v.major >= 22, v.napi >= 8);
addon.squareAsync(12).then((r) => { out.push(r); const m = { exports: {} }; process.dlopen(m, path.join(__dirname, "napi", "hello.node")); out.push(m.exports.add(1, 1)); console.log(JSON.stringify(out)); });
