#!/bin/bash
# Run the compat suite on the Linux host: kestrel vs node, output + exit code. Usage: compat.sh [env...]
export PATH=$HOME/kb/node/bin:$PATH NODE_TLS_REJECT_UNAUTHORIZED=0
cd ~/kb/test/compat
K=../../kestrel
for t in serve.ts http2.mjs vmmod.mjs http.mjs https.mjs cluster.mjs net.mjs unix.mjs fork.mjs worker.mjs esm.mjs misc.mjs als.mjs builtins.cjs proc.mjs; do
  PORT=$((5000+RANDOM%40)) timeout 90 $K $t > /tmp/k.txt 2>/tmp/k.err; ke=$?; [ $ke -ne 0 ] && head -3 /tmp/k.err
  if [ $t = serve.ts ]; then echo "$t k=$ke $(tail -c 50 /tmp/k.txt | tr -d '\n')"; continue; fi
  NF=""; [ $t = vmmod.mjs ] && NF="--experimental-vm-modules"
  PORT=$((5000+RANDOM%40)) timeout 90 node $NF $t > /tmp/n.txt 2>/dev/null; ne=$?
  if cmp -s /tmp/k.txt /tmp/n.txt; then echo "$t SAME k=$ke n=$ne"; else echo "$t DIFF k=$ke n=$ne"; diff /tmp/k.txt /tmp/n.txt | head -4 | cut -c1-200; fi
done
echo "--- inspect:"; RUNTIME=$K timeout 40 node inspect.mjs 2>&1 | tail -1; RUNTIME=node timeout 40 node inspect.mjs 2>&1 | tail -1
