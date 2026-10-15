#!/bin/sh
set -u
apt-get update -qq >/dev/null 2>&1; apt-get install -y -qq wrk curl procps linux-perf >/dev/null 2>&1
cd /src
echo "=== CPU benches on Linux (kestrel V8-only vs native tier)"
for f in bench_fib bench_cold; do echo -n "$f V8:  "; KESTREL_AOT=0 ./target-linux/release/kestrel examples/$f.ts; echo -n "$f AOT: "; ./target-linux/release/kestrel examples/$f.ts; done
echo "=== startup"; for i in 1 2 3; do /usr/bin/time -f "%e s %M KB" ./target-linux/release/kestrel bench/../examples/aot_check.ts >/dev/null; done 2>&1 | tail -3
PORT=3902 WORKERS=1 ./target-linux/release/kestrel bench/hello_kestrel.ts >/dev/null 2>&1 &
pid=$!
i=0; while [ $i -lt 300 ]; do curl -sf -m 1 http://127.0.0.1:3902/ >/dev/null 2>&1 && break; i=$((i+1)); done
wrk -t2 -c256 -d8s http://127.0.0.1:3902/ >/tmp/w.txt 2>&1 &
wpid=$!
sleep 1
perf record -F 999 -p $pid -o /tmp/perf.data -- sleep 5 2>&1 | tail -1
wait $wpid; grep "Requests/sec" /tmp/w.txt
echo "--- perf by dso:"; perf report -i /tmp/perf.data --no-children --sort dso --stdio 2>/dev/null | grep -v "^#" | grep -v "^$" | head -8
echo "--- perf by symbol (top 45):"; perf report -i /tmp/perf.data --no-children --sort symbol --stdio 2>/dev/null | grep -v "^#" | grep -v "^$" | head -45
kill $pid
