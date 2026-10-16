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
console.log(JSON.stringify(out));
