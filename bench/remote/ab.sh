#!/bin/bash
# A/B two kestrel binaries (~/kb/kestrel and ~/kb/kestrel-old) on all cores, alternating.
cd ~/kb; ulimit -n 65535
pkill -f hello_ 2>/dev/null; sleep 0.5
CONC=${CONC:-4096}; THREADS=${THREADS:-32}
for rep in 1 2; do
for B in kestrel kestrel-old; do
  PORT=3310 WORKERS=auto nohup ./$B bench/hello_kestrel.ts >/dev/null 2>&1 & sleep 4
  echo -n "$B -c$CONC: "; wrk -t$THREADS -c$CONC -d10s --latency http://127.0.0.1:3310/ | awk '/Requests\/sec/ {r=$2} $1=="99%" {p=$2} /Socket errors/ {e=$0} END {print r " req/s  p99 " p "  " e}'
  pkill -f hello_kestrel; sleep 1
done
done
