#!/bin/bash
# Connection-burst check: accept-queue overflow counters and first-second latency, kestrel vs bun.
cd ~/kb; ulimit -n 65535
pkill -f hello_ 2>/dev/null; sleep 0.5
sysctl net.core.somaxconn net.ipv4.tcp_max_syn_backlog net.ipv4.tcp_syncookies 2>/dev/null
snap() { nstat -az 2>/dev/null | awk '/ListenOverflows|ListenDrops|TCPReqQFullDoCookies|TCPReqQFullDrop|TcpRetransSegs/ {printf "%s=%s ", $1, $2}'; echo; }
for S in kestrel bun; do
  if [ $S = kestrel ]; then PORT=3310 WORKERS=1 nohup ./kestrel bench/hello_kestrel.ts >/dev/null 2>&1 & else PORT=3310 nohup ./bun/bun bench/hello_bun.ts >/dev/null 2>&1 & fi
  sleep 1
  echo "--- $S before: $(snap)"
  wrk -t32 -c4096 -d3s --timeout 10s --latency http://127.0.0.1:3310/ | grep -E "Latency  |99%|Requests/sec|Socket errors"
  echo "--- $S after:  $(snap)"
  ss -ltn "( sport = :3310 )" | tail -1
  pkill -f hello_$S; sleep 1
done
