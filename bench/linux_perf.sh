#!/bin/sh
set -u
apt-get update -qq >/dev/null 2>&1; apt-get install -y -qq wrk curl procps linux-perf >/dev/null 2>&1
cd /src
PORT=3701 WORKERS=1 ./target-linux/release/kestrel bench/hello_kestrel.ts >/dev/null 2>&1 &
pid=$!
i=0; while [ $i -lt 300 ]; do curl -sf -m 1 http://127.0.0.1:3701/ >/dev/null 2>&1 && break; i=$((i+1)); done
wrk -t2 -c256 -d8s http://127.0.0.1:3701/ > /tmp/wrk.txt 2>&1 &
sleep 2
perf record -F 999 -g -p $pid -o /tmp/perf.data -- sleep 4 >/dev/null 2>&1
wait %1 2>/dev/null
grep "Requests/sec" /tmp/wrk.txt
echo "--- top symbols (self):"
perf report -i /tmp/perf.data --no-children --sort symbol --stdio 2>/dev/null | grep -v "^#" | grep -v "^$" | head -45
kill $pid 2>/dev/null
