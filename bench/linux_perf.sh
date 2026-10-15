#!/bin/sh
# Profile one worker under wrk load (run with: docker run --privileged ...). Also measures RAW mode.
set -u
apt-get update -qq >/dev/null 2>&1; apt-get install -y -qq wrk curl procps linux-perf >/dev/null 2>&1
cd /src
echo "kernel.perf_event_paranoid=$(cat /proc/sys/kernel/perf_event_paranoid 2>/dev/null)"
for MODE in raw js; do
  if [ $MODE = raw ]; then export KESTREL_HTTP_RAW=1; else unset KESTREL_HTTP_RAW; fi
  PORT=3901 WORKERS=1 ./target-linux/release/kestrel bench/hello_kestrel.ts >/dev/null 2>&1 &
  pid=$!
  i=0; while [ $i -lt 300 ]; do curl -sf -m 1 http://127.0.0.1:3901/ >/dev/null 2>&1 && break; i=$((i+1)); done
  for C in 64 256; do echo "=== $MODE -c$C: $(wrk -t2 -c$C -d4s http://127.0.0.1:3901/ | grep -E 'Requests/sec')"; done
  if [ $MODE = js ]; then
    wrk -t2 -c256 -d8s http://127.0.0.1:3901/ >/dev/null 2>&1 &
    wpid=$!
    sleep 1
    perf record -F 499 -g -p $pid -o /tmp/perf.data -- sleep 5 2>&1 | tail -2
    wait $wpid
    echo "--- perf report (self, top 40):"
    perf report -i /tmp/perf.data --no-children --sort symbol --stdio 2>&1 | grep -v "^#" | grep -v "^$" | head -40
  fi
  kill $pid; wait $pid 2>/dev/null
done
