#!/bin/bash
# Diagnostics on the server host: CPU benches, one-worker stats vs connection count, baselines, perf availability.
cd ~/kb; ulimit -n 65535
P="$P" bash bench/remote/node_a.sh stop >/dev/null 2>&1
echo "=== CPU benches"
for f in bench_fib bench_cold; do printf "%s V8:  " $f; KESTREL_AOT=0 ./kestrel examples/$f.ts; printf "%s AOT: " $f; ./kestrel examples/$f.ts; done
printf "node fib: "; node/bin/node --experimental-strip-types examples/bench_fib.ts 2>/dev/null; printf "bun fib:  "; bun/bun examples/bench_fib.ts
echo "=== kestrel 1 worker, in-server stats"
for C in 64 256 4096; do
  PORT=3200 WORKERS=1 KESTREL_HTTP_STATS=1 nohup ./kestrel bench/hello_kestrel.ts >/dev/null 2>/tmp/st-$C.log &
  for i in $(seq 1 100); do curl -sf -m1 http://127.0.0.1:3200/ >/dev/null 2>&1 && break; sleep 0.1; done
  echo "--- -c$C: $(wrk -t8 -c$C -d6s --latency http://127.0.0.1:3200/ | grep -E 'Requests/sec|99%' | tr '\n' ' ')"
  pkill -f hello_kestrel; sleep 1; tail -1 /tmp/st-$C.log
done
echo "=== baselines, 1 process, -c256"
PORT=3201 nohup node/bin/node bench/hello_node.mjs >/dev/null 2>&1 & sleep 1; echo "node: $(wrk -t8 -c256 -d6s http://127.0.0.1:3201/ | grep Requests)"; pkill -f hello_node
PORT=3202 nohup bun/bun bench/hello_bun.ts >/dev/null 2>&1 & sleep 1; echo "bun:  $(wrk -t8 -c256 -d6s http://127.0.0.1:3202/ | grep Requests)"; pkill -f hello_bun
PORT=3203 WORKERS=1 nohup ./kestrel bench/hello_kestrel.ts >/dev/null 2>&1 & sleep 1; echo "kestrel: $(wrk -t8 -c256 -d6s http://127.0.0.1:3203/ | grep Requests)"; pkill -f hello_kestrel
echo "$P" | sudo -S apt-get install -y -qq linux-tools-common linux-tools-$(uname -r) >/dev/null 2>&1; echo "perf: $(which perf || echo missing) kernel $(uname -r)"
