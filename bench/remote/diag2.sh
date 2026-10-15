#!/bin/bash
# Per-core split on the server host: RAW hyper vs JS path, stats, and a perf profile of one worker.
cd ~/kb; ulimit -n 65535
P="$P" bash bench/remote/node_a.sh stop >/dev/null 2>&1
start() { PORT=$1 WORKERS=1 "${@:2}" nohup ./kestrel bench/hello_kestrel.ts >/dev/null 2>/tmp/kst.log & for i in $(seq 1 100); do curl -sf -m1 http://127.0.0.1:$1/ >/dev/null 2>&1 && break; sleep 0.1; done; }
W() { wrk -t8 -c$1 -d6s --latency http://127.0.0.1:$2/ | awk '/Requests\/sec/ {r=$2} $1=="50%" {a=$2} $1=="99%" {b=$2} END {print r " req/s  p50 " a "  p99 " b}'; }
echo "=== 1 worker RAW hyper (no JS):"; start 3300 env KESTREL_HTTP_RAW=1; echo "-c256: $(W 256 3300)"; pkill -f hello_kestrel; sleep 1
echo "=== 1 worker JS path, batch cap sweep (-c256):"; for B in 16 64 256; do start 3301 env KESTREL_HTTP_BATCH=$B KESTREL_HTTP_STATS=1; echo "batch=$B: $(W 256 3301)"; pkill -f hello_kestrel; sleep 1; tail -1 /tmp/kst.log; done
echo "=== 1 worker JS path, -c4096 (batch 64):"; start 3302 env KESTREL_HTTP_STATS=1; echo "$(W 4096 3302)"; pkill -f hello_kestrel; sleep 1; tail -1 /tmp/kst.log
echo "=== perf profile of 1 worker under -c256 (dso split, then top symbols):"
start 3303; pid=$(pgrep -f "hello_kestrel" | head -1)
wrk -t8 -c256 -d8s http://127.0.0.1:3303/ >/dev/null 2>&1 & sleep 1
echo "$P" | sudo -S perf record -F 999 -p $pid -o /tmp/perf.data -- sleep 5 >/dev/null 2>&1
wait; pkill -f hello_kestrel
echo "$P" | sudo -S perf report -i /tmp/perf.data --no-children --sort dso --stdio 2>/dev/null | grep -v "^#" | grep -v "^$" | head -6
echo "$P" | sudo -S perf report -i /tmp/perf.data --no-children --sort symbol --stdio 2>/dev/null | grep -v "^#" | grep -v "^$" | cut -c1-110 | head -40
