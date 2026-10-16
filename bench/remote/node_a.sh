#!/bin/bash
# Runs ON node A. Usage: node_a.sh start <name> <port> | stop
# Servers: kestrel1 (1 worker), kestrelN (all cores), node1, nodeN (cluster), bun1, kestrelraw
cd ~/kb
ulimit -n 65535 2>/dev/null || true
case "$1" in
  start)
    name=$2; port=$3
    if ss -ltn 2>/dev/null | grep -q ":$port "; then echo "PORT $port BUSY: $(ss -ltnp 2>/dev/null | grep ":$port " | head -1)"; exit 1; fi
    case $name in
      kestrel1)   PORT=$port WORKERS=1    nohup ./kestrel bench/hello_kestrel.ts >/tmp/srv.log 2>&1 & ;;
      kestrelN)   PORT=$port WORKERS=auto nohup ./kestrel bench/hello_kestrel.ts >/tmp/srv.log 2>&1 & ;;
      kestrelraw) PORT=$port WORKERS=auto KESTREL_HTTP_RAW=1 nohup ./kestrel bench/hello_kestrel.ts >/tmp/srv.log 2>&1 & ;;
      node1)      PORT=$port nohup ~/kb/node/bin/node bench/hello_node.mjs >/tmp/srv.log 2>&1 & ;;
      nodeN)      PORT=$port nohup ~/kb/node/bin/node bench/hello_node_cluster.mjs >/tmp/srv.log 2>&1 & ;;
      bun1)       PORT=$port nohup ~/kb/bun/bun bench/hello_bun.ts >/tmp/srv.log 2>&1 & ;;
      bunN)       PORT=$port nohup ~/kb/bun/bun bench/hello_bun_cluster.ts >/tmp/srv.log 2>&1 & ;;
    esac
    for i in $(seq 1 300); do curl -sf -m 1 http://127.0.0.1:$port/ >/dev/null 2>&1 && break; sleep 0.1; done
    curl -s -m 2 http://127.0.0.1:$port/ ;;
  stop)
    pkill -f "hello_kestrel" 2>/dev/null; pkill -f "hello_node" 2>/dev/null; pkill -f "hello_bun" 2>/dev/null
    for i in 1 2 3 4 5; do pgrep -f "hello_(kestrel|node|bun)" >/dev/null || break; sleep 0.5; done
    pkill -9 -f "hello_(kestrel|node|bun)" 2>/dev/null
    # Also kill any stray server by exact binary name: a leftover process from an earlier,
    # interrupted run keeps the port and silently collapses the next measurement.
    pkill -9 -x kestrel 2>/dev/null; pkill -9 -x bun 2>/dev/null; pkill -9 -x node 2>/dev/null; sleep 0.5 ;;
esac
