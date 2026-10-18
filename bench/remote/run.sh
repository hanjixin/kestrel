#!/bin/zsh
# Usage: ZGP_DEPLOY_PASSWORD=... bench/remote/run.sh [upload|bench|all]
# Uploads target-linux-amd64/release/kestrel + bench files to the jump host, pushes them to both
# GPU nodes, runs servers on node A and wrk on node B, prints a table.
set -eu
cd "$(dirname "$0")/../.."
JUMP=${BENCH_JUMP:?set BENCH_JUMP to the jump host}; PORT=${BENCH_JUMP_PORT:-22}; USER=${BENCH_JUMP_USER:-ubuntu}
A=${BENCH_NODE_A:?set BENCH_NODE_A}; B=${BENCH_NODE_B:?set BENCH_NODE_B}
ASK="${BENCH_ASKPASS:?set BENCH_ASKPASS to a script that prints the SSH password}"
P="${ZGP_DEPLOY_PASSWORD:?set ZGP_DEPLOY_PASSWORD}"
export ZGP_DEPLOY_PASSWORD="$P"
OPTS=(-o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 -o ServerAliveInterval=30)
rsh() { SSH_ASKPASS="$ASK" SSH_ASKPASS_REQUIRE=force DISPLAY=x ssh "${OPTS[@]}" -p $PORT $USER@$JUMP "$@"; }
rcp() { SSH_ASKPASS="$ASK" SSH_ASKPASS_REQUIRE=force DISPLAY=x scp "${OPTS[@]}" -P $PORT "$@" $USER@$JUMP:/tmp/kb/; }
step=${1:-all}
if [[ $step == upload || $step == all ]]; then
  ls -la target-linux-amd64/release/kestrel
  tar czf /tmp/kb-bench.tgz bench/hello_kestrel.ts bench/hello_node.mjs bench/hello_node_cluster.mjs bench/hello_bun.ts bench/hello_bun_cluster.ts bench/remote/node_a.sh bench/remote/node_b.sh
  gzip -c target-linux-amd64/release/kestrel > /tmp/kestrel-amd64.gz
  ls -la /tmp/kestrel-amd64.gz
  rsh "mkdir -p /tmp/kb"
  rcp /tmp/kb-bench.tgz /tmp/kestrel-amd64.gz
  rsh "cd /tmp/kb && for h in $A $B; do sshpass -p '$P' scp -o StrictHostKeyChecking=accept-new kb-bench.tgz kestrel-amd64.gz ubuntu@\$h:/tmp/ && sshpass -p '$P' ssh ubuntu@\$h 'mkdir -p ~/kb && cd ~/kb && tar xzf /tmp/kb-bench.tgz && gunzip -c /tmp/kestrel-amd64.gz > kestrel && chmod +x kestrel && ./kestrel --version 2>/dev/null; nproc; uname -m'; done"
fi
if [[ $step == scripts ]]; then
  tar --exclude='test/compat/node_modules' --exclude='test/compat/napi/hello.node' --exclude='__pycache__' -czf /tmp/kb-scripts.tgz bench/remote/node_a.sh bench/remote/node_b.sh bench/remote/diag.sh bench/remote/diag2.sh bench/remote/diag3.sh bench/remote/diag4.sh bench/remote/diag5.sh bench/remote/diag6.sh bench/remote/ab.sh bench/remote/sweep.sh bench/remote/sweep2.sh bench/remote/perf32.sh bench/remote/compat.sh bench/hello_bun_cluster.ts bench/hello_kestrel.ts examples/bench_fib.ts examples/bench_cold.ts examples/aot_check.ts test/compat test/fixtures test/stream_backpressure.py test/test_compat_gate.py
  rsh "mkdir -p /tmp/kb"; rcp /tmp/kb-scripts.tgz
  rsh "cd /tmp/kb && for h in $A $B; do sshpass -p '$P' scp kb-scripts.tgz ubuntu@\$h:/tmp/ && sshpass -p '$P' ssh ubuntu@\$h 'cd ~/kb && tar xzf /tmp/kb-scripts.tgz'; done; sshpass -p '$P' ssh ubuntu@$A \"echo '$P' | sudo -S apt-get install -y -qq wrk >/dev/null 2>&1; which wrk\""
fi
if [[ $step == bench || $step == all ]]; then
  rsh "sshpass -p '$P' ssh ubuntu@$B 'P=$P bash ~/kb/bench/remote/node_b.sh $A remote' 2>&1"
fi
if [[ $step == local ]]; then
  rsh "sshpass -p '$P' ssh ubuntu@$A 'P=$P bash ~/kb/bench/remote/node_b.sh 127.0.0.1 local' 2>&1"
fi
