# Kestrel versus Bun — 2026-10-18

Historical pre-optimization comparison. See [final results](../2026-10-18-bun-final/README.md) for the updated implementation.

Environment: macOS-26.3-arm64-arm-64bit-Mach-O; Bun 1.3.11. Same machine, sequential alternating order. No builds or other benchmark suites ran concurrently.

## HTTP

Five alternating pairs, one service process and one Kestrel worker, wrk 2 threads / 64 connections, 1 second warmup and 5 seconds measurement per sample. Native compares Kestrel.serve with Bun.serve; node:http runs the identical source on both. Response body checked before load; no socket errors or non-2xx responses were reported. Values below are medians.

| Workload | Kestrel req/s | Bun req/s | Kestrel relative throughput | Kestrel RSS MiB | Bun RSS MiB |
|---|---:|---:|---:|---:|---:|
| native-http | 331711 | 269911 | +22.9% | 33.3 | 34.4 |
| node-http | 148195 | 181783 | -18.5% | 48.1 | 114.3 |

RSS is sampled after each run, not peak RSS. Native HTTP p99 medians: Kestrel 402 us, Bun 539 us. node:http p99 medians: Kestrel 1.18 ms, Bun 0.801 ms.

## Worker and file reads

Five alternating pairs, median elapsed time; lower is better.

| Workload | Kestrel | Bun |
|---|---:|---:|
| Worker: 200 round trips, 1 MiB transferable buffer | 11 ms | 25 ms |
| Cached fs.promises.readFile: 16 × 32 MiB | 69 ms | 66 ms |

Worker measurement includes startup and verifies returned ArrayBuffer type/size. An initial fixture allowed execution after process.exit in Bun and sent an extra shutdown message, causing a nonzero exit after timing output. The fixture now explicitly returns; all final Worker samples exit 0. Initial failed samples remain in io.json for transparency and are excluded from results. Final samples are in worker-final.json.

File reads are warm cache measurements, not disk throughput; timers made progress on both runtimes.

## Interpretation

Kestrel wins the native HTTP and transferable-message microbenchmarks here. Bun wins the node:http throughput/latency comparison and is slightly faster for cached file reads. Kestrel node:http uses less sampled RSS. This does not establish overall runtime superiority, framework performance, multicore scaling, Linux results, or production tail latency.

## Reproduce

Run `python3 bench/compare_bun.py` from this checkout with Bun and wrk available. Raw HTTP output and every measured sample are retained in http.json, io.json, and worker-final.json.

Kestrel SHA-256: `575c73aded3f3af5a59f95e610c3b0b14bb823bd47de27b61590e318542463dc`.
