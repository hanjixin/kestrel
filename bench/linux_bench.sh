#!/bin/sh
# Runs inside a Debian container with the Linux build mounted at /src.
set -u
apt-get update -qq >/dev/null 2>&1; apt-get install -y -qq wrk curl procps >/dev/null 2>&1
cd /src
run() {
  name="$1"; port="$2"; workers="$3"
  PORT=$port WORKERS=$workers ./target-linux/release/kestrel bench/hello_kestrel.ts >/dev/null 2>&1 &
  pid=$!
  i=0; while [ $i -lt 300 ]; do curl -sf -m 1 "http://127.0.0.1:$port/" >/dev/null 2>&1 && break; i=$((i+1)); done
  out=$(wrk -t2 -c256 -d5s --latency "http://127.0.0.1:$port/" 2>/dev/null)
  rps=$(echo "$out" | awk '/Requests\/sec/ {print $2}'); p99=$(echo "$out" | awk '$1=="99%" {print $2}')
  cpu=$(ps -o %cpu= -p $pid | tr -d ' ')
  printf "%-28s %10s req/s   p99 %-8s server-cpu %s%%\n" "$name" "$rps" "$p99" "$cpu"
  kill $pid 2>/dev/null; wait $pid 2>/dev/null
}
echo "Linux $(uname -m) in Docker ($(nproc) cpus), wrk -t2 -c256 5s, client+server share the VM"
run "kestrel (1 worker)" 3401 1
run "kestrel (2 workers)" 3402 2
run "kestrel (4 workers)" 3404 4
run "kestrel (all cores)" 3410 auto
