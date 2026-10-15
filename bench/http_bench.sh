#!/bin/zsh
# Runs each hello-world server alone and measures it with LOADGENS parallel oha
# processes (several generators are needed to saturate a multi-core server).
set -u
cd "$(dirname "$0")/.."
DUR=${DUR:-5s}; CONC=${CONC:-96}; LOADGENS=${LOADGENS:-3}
OUT=$(mktemp -d)
run() {
  local name="$1"; shift
  local port="$1"; shift
  "$@" >/dev/null 2>&1 &
  local pid=$!
  for i in {1..300}; do curl -sf -m 1 "http://127.0.0.1:$port/" >/dev/null && break; done
  local body; body=$(curl -s "http://127.0.0.1:$port/")
  local files=() gens=()
  for k in $(seq 1 $LOADGENS); do
    oha -z "$DUR" -c "$CONC" --no-tui --output-format json "http://127.0.0.1:$port/" > "$OUT/$port-$k.json" 2>/dev/null &
    gens+=($!)
    files+=("$OUT/$port-$k.json")
  done
  wait ${gens[@]}
  printf "%-26s %s   body=%s\n" "$name" "$(python3 bench/oha_summary.py "${files[@]}")" "$body"
  pkill -P $pid 2>/dev/null; kill $pid 2>/dev/null
  for i in {1..100}; do curl -sf -m 1 "http://127.0.0.1:$port/" >/dev/null 2>&1 || break; done
}
echo "hello-world HTTP, $LOADGENS x oha -c $CONC for $DUR each, same machine"
run "node 22 (1 process)"      3101 env PORT=3101 node bench/hello_node.mjs
run "node 22 cluster (all)"    3105 env PORT=3105 node bench/hello_node_cluster.mjs
run "bun 1.3 (1 process)"      3102 env PORT=3102 bun bench/hello_bun.ts
run "kestrel (1 worker)"       3103 env PORT=3103 WORKERS=1 ./target/release/kestrel bench/hello_kestrel.ts
run "kestrel (all cores)"      3104 env PORT=3104 WORKERS=auto ./target/release/kestrel bench/hello_kestrel.ts
pkill -f "bench/hello_" 2>/dev/null
