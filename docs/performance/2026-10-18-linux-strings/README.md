# Immutable HTTP string responses — 2026-10-18

The change removes intermediate UTF-8 Buffer allocation and concatenation for completed string responses. Mutable Buffer responses still take an owned snapshot; streaming strings are encoded before Writable queue accounting. Invalid encodings are rejected before Writable state changes, so applications can recover with a fallback response.

## Evidence and validation

The baseline Inspector profile showed Buffer constructors, UTF-8 conversion and concatenation among the largest JavaScript/native-op hotspots. Those allocation/encoding frames disappear from the leading samples after the change (before.cpuprofile, after.cpuprofile, profile-summary.json). These profiles locate costs; their profiled throughput is not used as benchmark evidence.

- macOS and Linux final differential compatibility suites: **34/34 passed** each.
- New test covers ASCII, Unicode, unpaired surrogates, alternate encodings, empty strings, streamed strings, end callbacks and invalid-encoding recovery. Existing mutable-buffer ownership tests still pass.
- Forced io_uring, batched I/O and Hyper each passed all five targeted HTTP cases and real-socket 64 MiB backpressure tests.
- A review caught invalid encoding throwing after queue mutation in the initial candidate. The real intermediate binary timed out on the new recovery test; the final binaries pass. The rejected intermediate log is retained.
- Independent review rechecked recovery in both corked and uncorked source harness cases and found no further concrete issues in this change.
- Benchmark gate self-tests: 5 passed. Whitespace checks passed.

## Linux controlled comparison

Same remote EPYC 7542 / 128 logical CPU host, Ubuntu kernel 5.15.0-191, Bun 1.4.3, Node 22.12.0. One HTTP process / one Kestrel worker; wrk 2 threads, 64 connections, 1 second warmup and 5 seconds measurement. No other builds/tests ran on this host during measurement.

An initial three-pair run without CPU affinity measured node:http +4.15% but native HTTP -19.02%, although this change does not affect the native HTTP fixture. This prompted a controlled check: all HTTP server processes and their threads pinned to CPU 2, wrk pinned to CPUs 4 and 6 (different physical cores in the same NUMA node). All runtimes receive the same CPU budget. The pinned-bin wrappers are retained. I/O fixtures do **not** use affinity.

Three alternating before/after pairs under this controlled setup:

| Workload | Before req/s | After req/s | Change |
|---|---:|---:|---:|
| Native HTTP | 81,796 | 83,102 | +1.6% |
| node:http | 56,978 | 63,775 | **+11.9%** |

All initial and controlled samples are retained in results-opt/before-after.json and results-opt/pinned-before-after.json. CPU placement materially affects this host's measurements; do not discard the uncontrolled result or compare pinned values directly against the earlier report's unpinned values.

Six-round controlled comparison against Bun and Node, median requests/second:

| Workload | Kestrel | Bun | Node | Kestrel vs Bun |
|---|---:|---:|---:|---:|
| Native HTTP | 81,882 | 75,013 | — | +9.2% |
| Identical node:http source | 63,408 | 56,542 | 39,710 | **+12.1%** |

Kestrel won all six pairs against Bun in both HTTP fixtures; node:http throughput exceeded Node by 59.7%. Runtime order alternates for native HTTP and uses all six permutations for node:http. All 30 HTTP samples completed without reported socket/non-2xx errors.

| Workload / metric | Kestrel | Bun | Node |
|---|---:|---:|---:|
| Native RSS MiB | 48.5 | 31.3 | — |
| Native p99 ms | 1.615 | 1.650 | — |
| node:http RSS MiB | 54.0 | 56.0 | 75.7 |
| node:http p99 ms | 2.185 | 7.995 | 3.185 |

RSS is sampled after measurement, not peak memory. p99 entries are medians of per-sample p99. Affinity constrains background runtime threads as well, so tail latency values describe this single-CPU budget and must not be generalized to unrestricted scheduling. Native HTTP still uses more memory than Bun.

Six-round I/O medians, lower is better (all 36 samples exited successfully):

| Workload | Kestrel | Bun | Node |
|---|---:|---:|---:|
| Worker, 200 × 1 MiB transfer round trips | 17 ms | 86 ms | 36 ms |
| Cached reads, 16 × 32 MiB | 121.5 ms | 240 ms | 446.5 ms |

These workloads are unchanged by this patch. Worker timing includes startup; file reads use the warm OS cache and do not measure disk throughput.

## Linux unrestricted-scheduling confirmation

A separate full six-round run used ordinary scheduler placement (no affinity for any process), with the same versions, workloads, warmup, measurement duration and order rotation. This addresses whether the improvement depends on pinning. All 30 HTTP and 36 I/O samples completed successfully.

| Workload | Kestrel req/s | Bun req/s | Node req/s | Kestrel vs Bun |
|---|---:|---:|---:|---:|
| Native HTTP | 74,121 | 72,375 | — | +2.4% |
| Identical node:http source | 64,400 | 55,964 | 35,789 | **+15.1%** |

Kestrel won 4/6 native HTTP pairs and 5/6 node:http pairs against Bun. node:http throughput exceeded Node by 79.9%. Results vary substantially with scheduler placement; these samples support the median throughput result, not a guarantee of winning every run.

| Workload / metric | Kestrel | Bun | Node |
|---|---:|---:|---:|
| Native RSS MiB | 46.4 | 32.5 | — |
| Native p99 ms | 1.955 | 1.850 | — |
| node:http RSS MiB | 53.8 | 58.4 | 76.5 |
| node:http p99 ms | 2.500 | 2.265 | 3.135 |

**Unrestricted p99 still trails Bun in both HTTP fixtures.** Native HTTP memory also remains higher. These are remaining optimization targets; the pinned tail-latency advantage does not carry over to unrestricted scheduling.

Unrestricted-run I/O medians: Worker transfers 17.5 / 91.5 / 38 ms and cached reads 164 / 301 / 508 ms for Kestrel / Bun / Node respectively. Full samples are in results-opt/unpinned/.

## macOS cross-check

Three rounds, 3-second measurements, same concurrency/warmup; macOS arm64, Bun 1.3.11 and Node 25.6.1. No CPU affinity. Raw data is in macos/.

| Workload | Kestrel req/s | Bun req/s | Node req/s |
|---|---:|---:|---:|
| Native HTTP | 340,157 | 273,014 | — |
| node:http | 254,768 | 185,148 | 142,523 |

Do not compare absolute numbers across operating systems, hardware or runtime versions. This macOS check is a current three-runtime comparison, not a controlled before/after measurement of the patch.

## Reproduction and limits

Run `bench/compare.py` with preserved before/after binaries. For the final comparison run `python3 bench/compare_bun.py --kestrel /path/to/kestrel --include-node --rounds 6 --duration 5 --output-dir /tmp/results`. For the controlled variant use equivalent affinity wrappers with all servers on CPU 2 and wrk on 4,6; keep I/O unrestricted.

Linux final SHA-256: `4c501d2d663ffa5de3f6af41d17480764d3ce823df533f1d02a08239fbd5cee1`.
macOS final SHA-256: `1c8f129b01cea512f9e553adf633089e476c9cba9d6254ec6e5f24c55e433388`.
Baseline Linux SHA-256: `c0a89ad9c3a4ac49813e91d963ea4df88aaf02850ee494125d1163b6fc49e95d`.

This establishes a measured single-worker HTTP improvement, not universal superiority over Bun. Multicore scaling, sustained production workloads, larger bodies and framework throughput remain outside this round. Previously documented compatibility limits remain.

Published copies redact machine usernames, hostnames and local workspace paths. Numerical samples and outcomes are unchanged.
