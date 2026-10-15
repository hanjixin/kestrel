#!/bin/bash
# perf profile of kestrel at 32 workers under -c4096 and 1 worker under -c256 (user-space hot spots).
cd ~/kb; ulimit -n 65535; pkill -f hello_ 2>/dev/null; sleep 0.5
echo "paranoid=$(cat /proc/sys/kernel/perf_event_paranoid)"
for CFG in "32 4096 32" "1 256 8"; do
  set -- $CFG; W=$1; C=$2; T=$3
  PORT=3310 WORKERS=$W nohup ./kestrel bench/hello_kestrel.ts >/dev/null 2>&1 & pid=$!; sleep 3
  wrk -t$T -c$C -d9s http://127.0.0.1:3310/ >/tmp/wrk.out 2>&1 & wpid=$!
  sleep 2
  echo "$P" | sudo -S perf record -F 999 -g -p $pid -o /tmp/perf$W.data -- sleep 5 >/dev/null 2>&1
  wait $wpid; grep Requests /tmp/wrk.out
  echo "=== workers=$W -c$C: top self symbols"
  echo "$P" | sudo -S perf report -i /tmp/perf$W.data --no-children --sort dso,symbol --stdio 2>/dev/null | grep -v "^#" | grep -v "^$" | grep "%" | head -45
  echo "=== by dso"
  echo "$P" | sudo -S perf report -i /tmp/perf$W.data --no-children --sort dso --stdio 2>/dev/null | grep -v "^#" | grep "%" | head -8
  kill $pid; sleep 1
done
