# Linux Kestrel / Bun / Node comparison — 2026-10-18

Kestrel does **not yet consistently outperform Bun on Linux**. Its native HTTP median is 4.1% higher, but identical-source node:http throughput is 2.8% lower. Worker transfers and cached file reads favor Kestrel. Native HTTP also uses more RSS than Bun, and both HTTP fixtures have higher median p99 latency.

## Environment and method

Remote Ubuntu Linux x86_64, kernel 5.15.0-191-generic, dual AMD EPYC 7542, 128 logical CPUs, approximately 125 GiB RAM. Bun 1.4.3 and Node.js v22.12.0. These are different runtime versions and hardware from the macOS comparison; compare runtimes within this run only. Full machine metadata is in environment.txt.

Kestrel release was built using Rust 1.98.0 in linux/amd64 rust:bullseye (glibc 2.31). Binary SHA-256: `c0a89ad9c3a4ac49813e91d963ea4df88aaf02850ee494125d1163b6fc49e95d`.

Six rounds, alternating two-runtime order for native HTTP and all six permutations for node:http. One service process / one Kestrel worker, loopback wrk with 2 threads, 64 connections, 1 second warmup and 5 seconds measurement. No builds or compatibility tests ran alongside performance measurements. No CPU affinity was imposed. Every sample is retained in http.json and io.json; all 30 HTTP samples completed without reported socket/non-2xx errors and all 36 I/O samples exited successfully.

## HTTP medians

| Workload | Kestrel req/s | Bun req/s | Node req/s |
|---|---:|---:|---:|
| Native HTTP API | 75,264 | 72,305 | — |
| Identical node:http source | 56,628 | 58,258 | 37,661 |

Kestrel won 5/6 native HTTP pairs and 1/6 node:http pairs against Bun. Its node:http throughput is 50.4% higher than Node. The native API fixture has no separate Node equivalent; Node is included through the identical node:http fixture.

| Workload / metric | Kestrel | Bun | Node |
|---|---:|---:|---:|
| Native HTTP RSS MiB | 46.6 | 32.5 | — |
| Native HTTP p99 ms | 2.000 | 1.700 | — |
| node:http RSS MiB | 55.4 | 58.4 | 76.8 |
| node:http p99 ms | 2.860 | 2.335 | 3.205 |

RSS is sampled after measurement, not peak memory. Latencies are medians of per-sample wrk p99 values. There is appreciable run-to-run variation; a small median throughput advantage does not establish a stable production advantage.

## I/O medians (lower is better)

| Workload | Kestrel | Bun | Node |
|---|---:|---:|---:|
| Worker: 200 round trips, 1 MiB transferable ArrayBuffer | 18 ms | 91 ms | 38 ms |
| Cached reads: 16 × 32 MiB | 158 ms | 297 ms | 564.5 ms |

Worker timing includes startup and validates returned type/size. File timing uses the warm OS cache and does not measure storage throughput. Timers progressed on all runtimes.

## Linux validation

- Final default differential suite passed 33/33 (compat-final.log). The first run passed 32; Express was absent for both Node and Kestrel. After copying the local Express dependency tree into the isolated remote test directory, the complete suite passed. The initial failure is retained in compat.log.
- Extended cases passed: serve, vm modules, cluster, custom N-API addon, real native addons, inspector (extended.log also includes the repaired Express case).
- Forced io_uring, batch I/O, and Hyper-only modes each passed all 8 HTTP metadata/body/stream/close cases.
- All three modes passed real-socket backpressure: the producer stalled, then delivered the full 64 MiB. Kestrel stalled at 2880 KiB for io_uring and batch I/O, 3328 KiB for Hyper; Node at 2752 KiB.
- uring-activation.log confirms `io_uring loop started`, rather than an epoll fallback.
- Benchmark driver gate self-tests passed locally (5 tests); git diff whitespace checks passed.

Tests ran in an isolated remote directory. Existing server installations were not modified. npm dependency resolution initially stalled; that attempt was stopped and the Express JavaScript dependency tree was copied from the local validated fixture. Existing Linux native modules were preserved.

## Reproduction and remaining work

With runtimes and wrk on PATH:

```sh
python3 bench/compare_bun.py --kestrel /path/to/linux/kestrel --include-node --rounds 6 --duration 5 --output-dir /tmp/kestrel-linux-results
```

The performance target remains open for Linux node:http throughput, HTTP tail latency, and native HTTP memory. This run does not validate multicore scaling, larger payloads, framework throughput, sustained production workloads, or complete Node compatibility. Previously documented Worker/fs/IPC limitations remain.
