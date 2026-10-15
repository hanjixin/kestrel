#!/bin/sh
set -u
apt-get update -qq >/dev/null 2>&1; apt-get install -y -qq wrk curl procps iproute2 >/dev/null 2>&1
cd /src
PORT=3601 WORKERS=1 ./target-linux/release/kestrel bench/hello_kestrel.ts >/dev/null 2>&1 &
pid=$!
i=0; while [ $i -lt 300 ]; do curl -sf -m 1 http://127.0.0.1:3601/ >/dev/null 2>&1 && break; i=$((i+1)); done
echo "--- response headers:"; curl -si http://127.0.0.1:3601/ | head -6
echo "--- sockets before:"; ss -s | grep -i "tcp:" | head -2
wrk -t2 -c64 -d3s --latency http://127.0.0.1:3601/ | grep -E "Requests/sec|99%|Socket errors"
echo "--- sockets after (TIME-WAIT means connections were not reused):"; ss -s | grep -i "tcp:" | head -2
echo "--- threads/cpu:"; ps -L -o pid,tid,pcpu,comm -p $pid | head -12
kill $pid
