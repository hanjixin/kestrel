#!/bin/bash
# Tail-latency source check at 4096 connections: 10 s vs 30 s runs, kestrel fast path vs bun.
cd ~/kb; ulimit -n 65535
P="$P" bash bench/remote/node_a.sh stop >/dev/null 2>&1
pkill -f hello_ 2>/dev/null; sleep 0.5
show() { grep -E "Requests/sec|Latency  |50%|90%|99%|99.9|Socket errors"; }
for D in 10 30; do
  PORT=3310 WORKERS=1 nohup ./kestrel bench/hello_kestrel.ts >/dev/null 2>&1 & sleep 1
  echo "--- kestrel fast -c4096 -d${D}s"; wrk -t32 -c4096 -d${D}s --timeout 10s --latency http://127.0.0.1:3310/ | show
  pkill -f hello_kestrel; sleep 1
  PORT=3310 nohup ./bun/bun bench/hello_bun.ts >/dev/null 2>&1 & sleep 1
  echo "--- bun -c4096 -d${D}s"; wrk -t32 -c4096 -d${D}s --timeout 10s --latency http://127.0.0.1:3310/ | show
  pkill -f hello_bun; sleep 1
done
