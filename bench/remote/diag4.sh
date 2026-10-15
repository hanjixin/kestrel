#!/bin/bash
cd ~/kb; ulimit -n 65535
P="$P" bash bench/remote/node_a.sh stop >/dev/null 2>&1
for MODE in fast hyper; do
  if [ $MODE = fast ]; then unset KESTREL_FASTPATH; else export KESTREL_FASTPATH=0; fi
  PORT=3310 WORKERS=1 KESTREL_HTTP_STATS=1 nohup ./kestrel bench/hello_kestrel.ts >/dev/null 2>/tmp/kst-$MODE.log &
  sleep 1
  echo "--- $MODE -c256 --timeout 10s:"; wrk -t8 -c256 -d8s --timeout 10s --latency http://127.0.0.1:3310/ | grep -E "Requests/sec|50%|99%|Socket errors|Latency  "
  echo "--- $MODE -c4096 --timeout 10s:"; wrk -t32 -c4096 -d8s --timeout 10s --latency http://127.0.0.1:3310/ | grep -E "Requests/sec|50%|99%|Socket errors|Latency  "
  echo "--- in-server latency:"; tail -2 /tmp/kst-$MODE.log
  pkill -f hello_kestrel; sleep 1
done
