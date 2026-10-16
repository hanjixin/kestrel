#!/bin/bash
# Run the compat suite on the Linux host: kestrel vs node, output + exit code. Usage: compat.sh [env...]
export PATH=$HOME/kb/node/bin:$PATH NODE_TLS_REJECT_UNAUTHORIZED=0
cd ~/kb/test/compat
K=../../kestrel
# Native addon tests: build the C addon against the local node headers, install npm addons once.
( sh napi/build.sh 2>/dev/null ) || echo "napi build failed"
[ -d node_modules/sqlite3 ] || npm install --no-audit --no-fund --silent >/dev/null 2>&1
for t in serve.ts http2.mjs http2_stress.mjs vmmod.mjs http.mjs https.mjs cluster.mjs net.mjs unix.mjs fork.mjs worker.mjs esm.mjs npm.mjs realworld.cjs misc.mjs als.mjs builtins.cjs proc.cjs proc.mjs napi.cjs napi_real.cjs; do
  [ -f $t ] || continue
  PORT=$((5000+RANDOM%40)) timeout 90 $K $t > /tmp/k.txt 2>/tmp/k.err; ke=$?; [ $ke -ne 0 ] && head -3 /tmp/k.err
  if [ $t = serve.ts ]; then echo "$t k=$ke $(tail -c 50 /tmp/k.txt | tr -d '\n')"; continue; fi
  NF=""; [ $t = vmmod.mjs ] && NF="--experimental-vm-modules"
  PORT=$((5000+RANDOM%40)) timeout 90 node $NF $t > /tmp/n.txt 2>/dev/null; ne=$?
  if cmp -s /tmp/k.txt /tmp/n.txt; then echo "$t SAME k=$ke n=$ne"; else echo "$t DIFF k=$ke n=$ne"; diff /tmp/k.txt /tmp/n.txt | head -4 | cut -c1-200; fi
done
echo "--- inspect:"; RUNTIME=$K timeout 40 node inspect.mjs 2>&1 | tail -1; RUNTIME=node timeout 40 node inspect.mjs 2>&1 | tail -1
