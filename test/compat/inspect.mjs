// External debugger attach: starts `<runtime> --inspect=0 inspect_target.mjs`, reads the
// ws URL, speaks CDP over a WebSocket. Run with node; RUNTIME=node|kestrel selects the target.
import { spawn } from "node:child_process";
const rt = process.env.RUNTIME || "node";
const child = spawn(rt, ["--inspect=0", new URL("./inspect_target.mjs", import.meta.url).pathname], { stdio: ["ignore", "pipe", "pipe"] });
let err = "";
const wsUrl = await new Promise((resolve, reject) => {
  child.stderr.on("data", (d) => { err += d; const m = /ws:\/\/[^\s]+/.exec(err); if (m) resolve(m[0]); });
  child.on("exit", () => reject(new Error("exited: " + err)));
});
const base = wsUrl.replace(/^ws:\/\//, "http://").replace(/\/[^/]+$/, "");
const list = await (await fetch(base + "/json/list")).json();
const version = await (await fetch(base + "/json/version")).json();
const ws = new WebSocket(wsUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const post = (method, params) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const out = [];
out.push(list.length, list[0].type, typeof list[0].id, list[0].webSocketDebuggerUrl === wsUrl, version["Protocol-Version"]);
out.push((await post("Runtime.enable")).result !== undefined);
out.push((await post("Runtime.evaluate", { expression: "answer * 2", returnByValue: true })).result.result.value);
out.push((await post("Runtime.evaluate", { expression: "typeof process.version", returnByValue: true })).result.result.value);
out.push(typeof (await post("Nope.nothing")).error.message);
out.push((await post("Profiler.enable")).result !== undefined, (await post("Profiler.start")).result !== undefined);
const prof = await post("Profiler.stop");
out.push(Array.isArray(prof.result.profile.nodes));
ws.close();
child.kill();

// --inspect-brk: the program must not have run before Runtime.runIfWaitingForDebugger.
const brk = spawn(rt, ["--inspect-brk=0", new URL("./inspect_target.mjs", import.meta.url).pathname], { stdio: ["ignore", "pipe", "pipe"] });
let err2 = "";
const wsUrl2 = await new Promise((resolve, reject) => {
  brk.stderr.on("data", (d) => { err2 += d; const m = /ws:\/\/[^\s]+/.exec(err2); if (m) resolve(m[0]); });
  brk.on("exit", () => reject(new Error("exited: " + err2)));
});
await new Promise((r) => setTimeout(r, 300));
const ws2 = new WebSocket(wsUrl2);
await new Promise((r, j) => { ws2.onopen = r; ws2.onerror = j; });
const pending2 = new Map(); let id2 = 0;
ws2.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending2.has(m.id)) { pending2.get(m.id)(m); pending2.delete(m.id); } };
const post2 = (method, params) => new Promise((r) => { const i = ++id2; pending2.set(i, r); ws2.send(JSON.stringify({ id: i, method, params })); });
await post2("Runtime.enable"); await post2("Debugger.enable");
const before = (await post2("Runtime.evaluate", { expression: "globalThis.answer", returnByValue: true })).result.result;
out.push(before.type);
await post2("Debugger.resume").catch(() => {});
await post2("Runtime.runIfWaitingForDebugger");
let after;
// The first statement pauses (Debugger enabled); resume until the program has run.
for (let i = 0; i < 40; i++) { await post2("Debugger.resume"); after = (await post2("Runtime.evaluate", { expression: "globalThis.answer", returnByValue: true })).result.result; if (after.value === 42) break; await new Promise((r) => setTimeout(r, 50)); }
out.push(after.value);
ws2.close(); brk.kill();
console.log(JSON.stringify(out));
