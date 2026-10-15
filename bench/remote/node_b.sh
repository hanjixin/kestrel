#!/bin/bash
# Drives hello servers with wrk. Usage: node_b.sh <serverHost> [remote|local]
# remote: servers on <serverHost> (via ssh), wrk here.  local: servers and wrk on this host.
A=$1; MODE=${2:-remote}; cd ~/kb
ulimit -n 65535 2>/dev/null || true
CONC=${CONC:-4096}; THREADS=${THREADS:-32}
if [ "$MODE" = local ]; then
  TARGET=127.0.0.1
  ssha() { P="$P" bash ~/kb/bench/remote/node_a.sh "$@"; }
else
  TARGET=$A
  ssha() { sshpass -p "$P" ssh -o StrictHostKeyChecking=accept-new ubuntu@$A "P='$P' bash ~/kb/bench/remote/node_a.sh $*"; }
fi
ssha stop >/dev/null 2>&1
echo "mode=$MODE  server host: $(nproc) cpus $(uname -m)$(grep -m1 'model name' /proc/cpuinfo | cut -d: -f2)  rtt=$(ping -c 3 -q $TARGET 2>/dev/null | awk -F/ '/rtt|round-trip/ {print $5 " ms"}')"
echo "load: wrk -t$THREADS -c$CONC 10s per server"
ALL=("node1:node 22 (1 process)" "nodeN:node 22 cluster (all cores)" "bun1:bun (1 process)" "bunN:bun reusePort x cores" "kestrel1:kestrel (1 worker)" "kestrelN:kestrel (all cores)" "kestrelraw:kestrel raw hyper (no JS, all cores)")
if [ -n "${SPECS:-}" ]; then SEL=(); for s in "${ALL[@]}"; do case " $SPECS " in *" ${s%%:*} "*) SEL+=("$s");; esac; done; else SEL=("${ALL[@]}"); fi
for rep in $(seq 1 ${REPS:-1}); do
for spec in "${SEL[@]}"; do
  name=${spec%%:*}; label=${spec#*:}
  body=$(ssha start $name 3100)
  if [ "$body" != "Hello, World!" ]; then printf "%-40s not reachable (%s)\n" "$label" "$body"; ssha stop >/dev/null 2>&1; continue; fi
  out=$(wrk -t$THREADS -c$CONC -d10s --latency http://$TARGET:3100/ 2>/dev/null)
  rps=$(echo "$out" | awk '/Requests\/sec/ {print $2}'); p50=$(echo "$out" | awk '$1=="50%" {print $2}'); p99=$(echo "$out" | awk '$1=="99%" {print $2}')
  errs=$(echo "$out" | awk '/Socket errors/ {print "  errors:" $0}' | sed 's/Socket errors: //')
  printf "%-40s %10s req/s   p50 %-8s p99 %-8s%s\n" "$label" "$rps" "$p50" "$p99" "$errs"
  ssha stop >/dev/null 2>&1
done
done
