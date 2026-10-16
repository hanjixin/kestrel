// vm.SourceTextModule / vm.SyntheticModule (node needs --experimental-vm-modules) and
// node:inspector in-process sessions.
import vm from "node:vm";
import inspector from "node:inspector";
import { Session as PSession } from "node:inspector/promises";
const out = [];

const dep = new vm.SyntheticModule(["answer", "default"], function () { this.setExport("answer", 42); this.setExport("default", "dflt"); }, { identifier: "synthetic:dep" });
const mod = new vm.SourceTextModule(`import d, { answer } from "dep"; import { twice } from "./lib.mjs"; export const result = twice(answer) + ":" + d; export default result.length;`, { identifier: "main.mjs" });
const lib = new vm.SourceTextModule(`export const twice = (x) => x * 2;`, { identifier: "lib.mjs" });
out.push(mod.status, mod.identifier, mod.dependencySpecifiers);
await mod.link((spec) => (spec === "dep" ? dep : lib));
out.push(mod.status, lib.status, dep.status);
await mod.evaluate();
out.push(mod.status, mod.namespace.result, mod.namespace.default, Object.keys(mod.namespace).sort(), lib.namespace.twice(4));

const bad = new vm.SourceTextModule(`throw new TypeError("boom")`, { identifier: "bad.mjs" });
await bad.link(() => { throw new Error("no deps"); });
try { await bad.evaluate(); } catch (e) { out.push(e.name + ":" + e.message); }
out.push(bad.status, bad.error.message);

let linkErr; try { await mod.link(() => dep); } catch (e) { linkErr = e.code; }
out.push(linkErr);
const unl = new vm.SourceTextModule(`export const x = 1;`);
try { unl.namespace; } catch (e) { out.push(e.code); }
try { await unl.evaluate(); } catch (e) { out.push(e.code); }
const missing = new vm.SourceTextModule(`import "nope"; export const x = 1;`);
try { await missing.link(() => 5); } catch (e) { out.push(e.code); }
out.push(mod instanceof vm.Module, dep instanceof vm.Module, typeof vm.Module);

const ctx = vm.createContext({ base: 10 });
const inCtx = new vm.SourceTextModule(`export const v = base + 1; export const g = typeof globalThis.process;`, { context: ctx });
await inCtx.link(() => { throw new Error("unexpected"); });
await inCtx.evaluate();
out.push(inCtx.namespace.v, inCtx.namespace.g);

// Dynamic import inside vm code: callback, default-loader constant, and missing callback.
const dynDep = new vm.SyntheticModule(["v"], function () { this.setExport("v", "dyn!"); }, { identifier: "dyn:dep" });
const dynMod = new vm.SourceTextModule(`export const got = (await import("dep")).v; export const meta = import.meta.marker;`, {
  identifier: "dynmain.mjs",
  importModuleDynamically: async (spec, ref) => { out.push(spec, ref === dynMod); await dynDep.link(() => { throw new Error("none"); }); await dynDep.evaluate(); return dynDep; },
  initializeImportMeta(meta, mod) { meta.marker = "meta:" + mod.identifier; },
});
await dynMod.link(() => { throw new Error("no static deps"); });
await dynMod.evaluate();
out.push(dynMod.namespace.got, dynMod.namespace.meta);
const scriptDyn = new vm.Script(`import("x").then((ns) => ns.v)`, { importModuleDynamically: () => dynDep });
out.push(await scriptDyn.runInThisContext());
try { await vm.runInThisContext(`import("nothing")`); } catch (e) { out.push(e.code); }
try { await new vm.SourceTextModule(`await import("nothing")`).link(() => {}).then((m) => m); } catch (e) { out.push("link:" + typeof e); }
const s = new inspector.Session();
s.connect();
let evalResult;
s.post("Runtime.evaluate", { expression: "6 * 7" }, (err, r) => { evalResult = err ? "err:" + err.message : r.result.value; });
out.push(evalResult);
let errCode;
s.post("Nope.nothing", (err) => { errCode = err ? typeof err.message : "ok"; });
out.push(errCode);
const ps = new PSession();
ps.connect();
const r = await ps.post("Runtime.evaluate", { expression: "'a'.repeat(3)", returnByValue: true });
out.push(r.result.value);
await ps.post("Profiler.enable");
await ps.post("Profiler.start");
for (let i = 0; i < 1e5; i++) Math.sqrt(i);
const prof = await ps.post("Profiler.stop");
out.push(typeof prof.profile, Array.isArray(prof.profile.nodes), prof.profile.nodes.length > 0);
ps.disconnect(); s.disconnect();
let after; try { s.post("Runtime.evaluate", { expression: "1" }, () => {}); } catch (e) { after = e.code; }
out.push(after, inspector.url());
console.log(JSON.stringify(out));
