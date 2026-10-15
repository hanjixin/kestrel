#!/bin/sh
# node / bun hello servers on Linux, same wrk settings as linux_bench.sh
set -u
apt-get update -qq >/dev/null 2>&1; apt-get install -y -qq wrk curl procps >/dev/null 2>&1
cd /src
run() {
  name="$1"; port="$2"; shift 2
  PORT=$port "$@" >/dev/null 2>&1 &
  pid=$!
  i=0; while [ $i -lt 300 ]; do curl -sf -m 1 "http://127.0.0.1:$port/" >/dev/null 2>&1 && break; i=$((i+1)); done
  out=$(wrk -t2 -c256 -d5s --latency "http://127.0.0.1:$port/" 2>/dev/null)
  rps=$(echo "$out" | awk '/Requests\/sec/ {print $2}'); p99=$(echo "$out" | awk '$1=="99%" {print $2}')
  printf "%-28s %10s req/s   p99 %-8s\n" "$name" "$rps" "$p99"
  pkill -P $pid 2>/dev/null; kill $pid 2>/dev/null; wait $pid 2>/dev/null
}
if command -v node >/dev/null; then run "node $(node -v) (1 process)" 3501 node bench/hello_node.mjs; run "node cluster (all cores)" 3502 node bench/hello_node_cluster.mjs; fi
if command -v bun >/dev/null; then run "bun $(bun -v) (1 process)" 3503 bun bench/hello_bun.ts; fi
