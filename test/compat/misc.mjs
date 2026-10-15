import dgram from "node:dgram";
import vm from "node:vm";
import v8 from "node:v8";
import { performance, PerformanceObserver } from "node:perf_hooks";
import cluster from "node:cluster";
import { once } from "node:events";
const out = [];
const srv = dgram.createSocket("udp4");
srv.bind(0, "127.0.0.1"); await once(srv, "listening");
const cli = dgram.createSocket("udp4");
cli.send("ping", srv.address().port, "127.0.0.1");
const [msg, rinfo] = await once(srv, "message");
out.push(msg.toString(), rinfo.family, typeof rinfo.port);
srv.close(); cli.close();
out.push(vm.runInThisContext("1 + 2"), vm.runInNewContext("x * 2 + y", { x: 20, y: 2 }), new vm.Script("a = 5; a + 1").runInNewContext({}), vm.isContext(vm.createContext({})));
try { vm.runInThisContext("syntax error here"); } catch (e) { out.push(e.name); }
const hs = v8.getHeapStatistics();
out.push(hs.used_heap_size > 0 && hs.heap_size_limit > hs.used_heap_size, typeof performance.now(), typeof PerformanceObserver, cluster.isPrimary, typeof cluster.fork);
console.log(JSON.stringify(out));
{
  const m = dgram.createSocket({ type: "udp4", reuseAddr: true });
  m.bind(0, "127.0.0.1"); await once(m, "listening");
  let ok = true; try { m.addMembership("224.0.0.251"); m.setMulticastTTL(2); m.dropMembership("224.0.0.251"); } catch (e) { ok = e.code || e.message; }
  m.close();
  const insp = await import("node:inspector");
  console.log(JSON.stringify([ok, typeof insp.Session, insp.url()]));
}
