#!/bin/bash
# Process/worker-count sweep: kestrel (threads) and bun reusePort (processes), 4096 and 256 connections.
cd ~/kb; ulimit -n 65535
pkill -f hello_ 2>/dev/null; sleep 0.5
m() { awk '/Requests\/sec/ {r=$2} $1=="99%" {p=$2} /Socket errors/ {e=$0} END {print r " req/s  p99 " p "  " e}'; }
for W in ${KWS:-16 24 32 40}; do
  PORT=3310 WORKERS=$W nohup ./kestrel bench/hello_kestrel.ts >/dev/null 2>&1 & sleep 4
  echo -n "kestrel workers=$W -c4096: "; wrk -t32 -c4096 -d10s --latency http://127.0.0.1:3310/ | m
  echo -n "kestrel workers=$W -c256:  "; wrk -t8 -c256 -d10s --latency http://127.0.0.1:3310/ | m
  pkill -f hello_kestrel; sleep 1
done
for W in ${BWS:-32 48 64 128}; do
  PORT=3310 WORKERS=$W nohup ./bun/bun bench/hello_bun_cluster.ts >/dev/null 2>&1 & sleep 4
  echo -n "bun procs=$W -c4096: "; wrk -t32 -c4096 -d10s --latency http://127.0.0.1:3310/ | m
  echo -n "bun procs=$W -c256:  "; wrk -t8 -c256 -d10s --latency http://127.0.0.1:3310/ | m
  pkill -f hello_bun; sleep 2
done
