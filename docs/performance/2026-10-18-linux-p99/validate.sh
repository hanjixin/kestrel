#!/bin/sh
set -eu
cd /home/ubuntu/kestrel-p99-20261018
while [ ! -f backends-c256/summary.json ]; do sleep 10; done
mkdir -p validation
python3 test/compat/run.py --kestrel ./kestrel-final --node /home/ubuntu/kb/node/bin/node > validation/default.log 2>&1
python3 test/compat/run.py --kestrel ./kestrel-final --node /home/ubuntu/kb/node/bin/node vmmod.mjs napi_real.cjs serve.ts > validation/extra.log 2>&1
for mode in uring batch hyper; do
 case "$mode" in
 uring) settings=KESTREL_URING=1;;
 batch) settings=KESTREL_BATCH_IO=1;;
 hyper) settings=KESTREL_FASTPATH=0;;
 esac
 env "$settings" python3 test/compat/run.py --kestrel ./kestrel-final --node /home/ubuntu/kb/node/bin/node http_end_strings.mjs http_end_buffer.mjs http_request_metadata.mjs http_early_body_read.mjs http_streaming.mjs http_stream_lifecycle.mjs http_async_close.mjs server_close.mjs server_close_active.mjs server_close_idle.mjs > "validation/$mode.log" 2>&1
 env "$settings" python3 test/stream_backpressure.py ./kestrel-final > "validation/$mode-backpressure.log" 2>&1
done
python3 test/stream_backpressure.py ./kestrel-final > validation/default-backpressure.log 2>&1
printf 'validation passed\n'
