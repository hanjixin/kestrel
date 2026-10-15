#!/bin/zsh
# Same servers, measured with wrk (2 threads), which costs far less client CPU than oha.
set -u
cd "$(dirname "$0")/.."
DUR=${DUR:-5}; CONC=${CONC:-256}; T=${T:-2}
run() {
  local name="$1"; shift; local port="$1"; shift
  "$@" >/dev/null 2>&1 &
  local pid=$!
  for i in {1..300}; do curl -sf -m 1 "http://127.0.0.1:$port/" >/dev/null && break; done
  local out; out=$(wrk -t$T -c$CONC -d${DUR}s --latency "http://127.0.0.1:$port/" 2>/dev/null)
  local rps; rps=$(echo "$out" | awk '/Requests\/sec/ {print $2}')
  local p50; p50=$(echo "$out" | awk '$1=="50%" {print $2}')
  local p99; p99=$(echo "$out" | awk '$1=="99%" {print $2}')
  local cpu; cpu=$(ps -o %cpu= -p $pid | tr -d ' ')
  printf "%-26s %10s req/s   p50 %-8s p99 %-8s server-cpu %s%%\n" "$name" "$rps" "$p50" "$p99" "$cpu"
  pkill -P $pid 2>/dev/null; kill $pid 2>/dev/null
  for i in {1..100}; do curl -sf -m 1 "http://127.0.0.1:$port/" >/dev/null 2>&1 || break; done
}
echo "hello-world HTTP, wrk -t$T -c$CONC ${DUR}s, same machine (M4 10 cores)"
run "node 22 (1 process)"      3201 env PORT=3201 node bench/hello_node.mjs
run "node 22 cluster (all)"    3205 env PORT=3205 node bench/hello_node_cluster.mjs
run "bun 1.3 (1 process)"      3202 env PORT=3202 bun bench/hello_bun.ts
run "kestrel (1 worker)"       3203 env PORT=3203 WORKERS=1 ./target/release/kestrel bench/hello_kestrel.ts
run "kestrel (all cores)"      3204 env PORT=3204 WORKERS=auto ./target/release/kestrel bench/hello_kestrel.ts
pkill -f "bench/hello_" 2>/dev/null
