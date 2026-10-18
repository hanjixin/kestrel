# Final Kestrel versus Bun results — 2026-10-18

Same-host macOS arm64 comparison with installed Bun 1.3.11. All four measured workload medians favor Kestrel. This is a bounded local microbenchmark result, not a claim about every application or Linux.

## Changes

- Read Node request method, original target and headers in one native operation. Previously each getter rebuilt hyper request parts, then Web Headers and URL parsing rebuilt the data again. Original targets and Cookie merging now match the added Node differential cases.
- Return already-completed bodyless responses synchronously, avoiding a Promise and native pending-request bookkeeping. Requests with bodies and streamed responses retain the asynchronous handoff.
- Drain synchronous response microtasks only after copying headers/body into native-owned memory, preserving callback buffer ownership and avoiding queued stream-event accumulation.
- Set an initial old-space budget of 32 MiB to collect dead external buffers earlier. The maximum heap limit is unchanged, and explicit user initial heap/old-space flags take precedence.

## HTTP

Five alternating pairs per workload, one service process / one Kestrel worker, wrk 2 threads, 64 connections, 1 second warmup and 5 seconds measurement per sample. Same body and, for node:http, identical source. No build or other test suite ran alongside the performance samples. Median results:

| Workload | Kestrel req/s | Bun req/s | Kestrel throughput advantage | Kestrel RSS MiB | Bun RSS MiB |
|---|---:|---:|---:|---:|---:|
| native-http | 309669 | 264015 | +17.3% | 33.4 | 34.4 |
| node-http | 213213 | 175453 | +21.5% | 45.8 | 118.0 |

RSS is sampled after measurement, not peak memory. Median p99 latency: native HTTP 0.593 ms versus Bun 0.638 ms; node:http 0.771 ms versus Bun 1.160 ms. All five final node:http pairs favored Kestrel.

## I/O

Five alternating pairs, median elapsed time (lower is better):

| Workload | Kestrel | Bun |
|---|---:|---:|
| Worker: 200 round trips of a 1 MiB transferable ArrayBuffer | 11 ms | 24 ms |
| Cached file reads: 16 × 32 MiB | 60 ms | 67 ms |

Worker includes startup and validates returned type/size. File reads use the warm OS cache and are not disk-throughput measurements. The first final Kestrel file sample was slower (72 vs 66 ms); all samples are retained. Timers made progress on both runtimes.

## Checks and experiments

- Final release build succeeded. Node differential compatibility gate: 33/33 passed (compatibility.log).
- Hyper-only request metadata/body handoff/streaming/lifecycle/buffer tests: 5/5 passed.
- Backpressure: Node stalled at 960 KiB, Kestrel at 1088 KiB; both delivered 64 MiB after the client resumed.
- Existing Next.js 15.5.28 standalone production output: identity and gzip responses returned 200 with expected page content.
- Initial heap flag override checks passed; heap limit remained 1,568,669,696 bytes in the local experiment.
- A separate three-pair before/after HTTP comparison of the initial-heap adjustment measured native +1.50%, node:http -0.04%, with similar RSS (gc-http-check.json).
- Initial-size experiments reduced file-read peak RSS from approximately 629 MB to 294 MB. These figures are diagnostic experiments, distinct from the HTTP RSS column.
- Rejected synchronous prototype had growing microtask queues, increased RSS and a POST body-read exit timeout. Both were fixed before final measurements; the new body-read test passes.
- An earlier intermediate native-HTTP benchmark aborted on one timeout. Its log is preserved at ../2026-10-18-bun-optimized/initial-timeout.log. The intermediate rerun and all 20 final HTTP samples completed without socket/non-2xx errors. The isolated timeout root cause was not determined.

## Scope and reproducibility

Results do not cover Linux io_uring/batched I/O, multicore scaling, larger HTTP payloads, framework throughput, sustained production workloads, or complete Node compatibility. HTTP clients/request bodies remain buffered; the previously documented Worker/fs/advanced IPC limits remain.

Re-run with `python3 bench/compare_bun.py --output-dir /tmp/kestrel-bun-comparison`. Full wrk output and every sample are in http.json and io.json. Earlier comparisons and rejected experiments are retained rather than overwritten.

Final binary SHA-256: `95b843e9fce9becbdd3ffe748f8dba18bd42eb08fce1edbb4f3b2c7a146733f2`.
