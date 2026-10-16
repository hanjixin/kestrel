#!/bin/bash
# Worker-count sweep for the current kestrel binary, all at 4096 and 256 connections.
cd ~/kb; ulimit -n 65535
pkill -9 -f hello_ 2>/dev/null; pkill -9 -x kestrel 2>/dev/null; pkill -9 -x bun 2>/dev/null; pkill -9 -x node 2>/dev/null; sleep 1
for W in ${WS:-32 48 64 96 128}; do
  PORT=3310 WORKERS=$W nohup ./kestrel bench/hello_kestrel.ts >/dev/null 2>&1 & sleep 4
  echo -n "workers=$W -c4096: "; wrk -t32 -c4096 -d10s --latency http://127.0.0.1:3310/ | awk '/Requests\/sec/ {r=$2} $1=="99%" {p=$2} /Socket errors/ {e=$0} END {print r " req/s  p99 " p "  " e}'
  echo -n "workers=$W -c256:  "; wrk -t8 -c256 -d10s --latency http://127.0.0.1:3310/ | awk '/Requests\/sec/ {r=$2} $1=="99%" {p=$2} /Socket errors/ {e=$0} END {print r " req/s  p99 " p "  " e}'
  pkill -f hello_kestrel; sleep 1
done
