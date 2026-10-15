#!/bin/bash
# Single worker under 4096 keep-alive connections: in-server latency + perf profile.
cd ~/kb; ulimit -n 65535
P="$P" bash bench/remote/node_a.sh stop >/dev/null 2>&1
PORT=3300 WORKERS=1 KESTREL_HTTP_STATS=1 nohup ./kestrel bench/hello_kestrel.ts >/dev/null 2>/tmp/kst.log &
pid=$!
for i in $(seq 1 100); do curl -sf -m1 http://127.0.0.1:3300/ >/dev/null 2>&1 && break; sleep 0.1; done
wrk -t32 -c4096 -d10s --latency http://127.0.0.1:3300/ > /tmp/w.txt 2>&1 &
wpid=$!
sleep 2
echo "$P" | sudo -S perf record -F 999 -g -p $pid -o /tmp/perf.data -- sleep 5 >/dev/null 2>&1
wait $wpid
grep -E "Requests/sec|50%|99%" /tmp/w.txt
echo "--- in-server latency (2s windows):"; tail -3 /tmp/kst.log
echo "--- threads:"; ps -L -o tid,pcpu,comm -p $pid | head -8
kill $pid; sleep 0.5
echo "--- perf by dso:"; echo "$P" | sudo -S perf report -i /tmp/perf.data --no-children --sort dso --stdio 2>/dev/null | grep -v "^#" | grep -v "^$" | head -8
echo "--- top symbols (self):"; echo "$P" | sudo -S perf report -i /tmp/perf.data --no-children --sort symbol --stdio 2>/dev/null | grep -v "^#" | grep -v "^$" | grep "%" | cut -c1-120 | head -45
