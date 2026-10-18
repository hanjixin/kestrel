#!/bin/bash
# Linux remote gate: fail on setup errors, missing cases, timeouts or differences.
set -euo pipefail
export PATH="$HOME/kb/node/bin:$PATH" NODE_TLS_REJECT_UNAUTHORIZED=0
cd "$HOME/kb/test/compat"
sh napi/build.sh
if [ ! -d node_modules/sqlite3 ]; then
  npm install --no-audit --no-fund --silent
fi
python3 run.py --kestrel ../../kestrel
python3 run.py --kestrel ../../kestrel serve.ts vmmod.mjs cluster.mjs napi.cjs napi_real.cjs inspect.mjs
python3 ../test_compat_gate.py
python3 ../stream_backpressure.py node "$PWD/../../kestrel"
KESTREL_FASTPATH=0 python3 run.py --kestrel ../../kestrel http_streaming.mjs http_stream_lifecycle.mjs server_close_active.mjs
KESTREL_URING=1 python3 run.py --kestrel ../../kestrel http_streaming.mjs http_stream_lifecycle.mjs server_close_active.mjs
KESTREL_BATCH_IO=1 python3 run.py --kestrel ../../kestrel http_streaming.mjs http_stream_lifecycle.mjs server_close_active.mjs
