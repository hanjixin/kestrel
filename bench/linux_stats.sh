#!/bin/sh
set -u
apt-get update -qq >/dev/null 2>&1; apt-get install -y -qq wrk curl procps >/dev/null 2>&1
cd /src
for C in 64 256; do
  PORT=38$C WORKERS=1 KESTREL_HTTP_STATS=1 ./target-linux/release/kestrel bench/hello_kestrel.ts 2>/tmp/stats-$C.log >/dev/null &
  pid=$!
  i=0; while [ $i -lt 300 ]; do curl -sf -m 1 http://127.0.0.1:38$C/ >/dev/null 2>&1 && break; i=$((i+1)); done
  echo "=== -c$C"; wrk -t2 -c$C -d6s --latency http://127.0.0.1:38$C/ | grep -E "Requests/sec|50%|99%"
  kill $pid; wait $pid 2>/dev/null
  echo "--- server stats (2s windows):"; tail -3 /tmp/stats-$C.log
done
