# Linux HTTP tail-latency investigation — 2026-10-18

This experiment compares the current source baseline with a candidate that defaults to epoll rather than assigning connections to epoll/io_uring based on the worker's connection count. `KESTREL_URING=1` still opts into io_uring, with epoll fallback if initialization fails. The release tag v0.0.1 predates this optimization and is unchanged.

## Method

AMD EPYC 7542, Linux 5.15, x86_64; Bun 1.4.3 and Node 22.12.0. One server worker, loopback, unrestricted CPU scheduling, same host for server and load generator. `wrk -t2`, one second of warmup before every measured sample. Variant order rotates and reverses between rounds. Every sample checks the response at startup and rejects reported socket errors or non-2xx responses. These are closed-loop saturated HTTP microbenchmarks, not production service SLO measurements. The host is shared and results vary between runs.

The reported p99 is the **median of each round's wrk p99**, not a percentile pooled across all requests. Lower is better: p99 is the response time within which approximately 99% of sampled requests complete. Throughput is median requests per second; higher is better. Do not compare numbers from different experiment directories as if their load and timing were identical.

Reproduce from the repository root with `python3 bench/tail_latency.py --variants variants.json --out results --rounds 6 --duration 10 --connections 64`. The supplied variant files record the executable paths used on the test host; adjust paths for another host. `samples.json` retains the complete wrk text and Linux scheduler counters for every round. `host.txt` records the environment.

## Binaries

Built with `cargo build --release --locked --target-dir target-linux-amd64` in the `rust:bullseye` Docker image (`linux/amd64`). SHA-256 matched after upload.

| Binary | SHA-256 | Meaning |
|---|---|---|
| baseline | `864c3ba824e841b02dcacf380cd9813f21057a62d19e99c50689d958d7f383ad` | Local source b8a1d6c; includes the fixes published as public bb4d551 in v0.0.1 |
| shortwait | `d54fd44f8a9bd3d41cbc539a7afca33cdaa7de56b698426d55530b16bffe56f1` | Rejected experiment: io_uring busy wait 200µs → 20µs |
| final epoll candidate | `1aea0a48055ef371c5ce9a1d659c26b17513d785b2c26320deaa9eb4686eb63c` | Default epoll; io_uring remains opt-in |

## Diagnostic experiments

- `diagnostic-historical`: previous binary, three 5-second rounds, 64 connections. Useful for forming a hypothesis only; this is not the current-source before/after comparison.
- `current-diagnostic-v2`: current baseline, three 5-second rounds, 64 connections. Default / epoll / io_uring p99 was 2.75 / 1.83 / 1.34ms. Reducing the young generation to 8MiB did not materially improve default p99 (2.71ms).
- `confirm-c64`: six 5-second rounds. Default / shorter wait / epoll p99 was 2.565 / 2.555 / 1.880ms, with 60,345 / 60,651 / 63,546 req/s. The shorter-wait change was reverted because it provided negligible benefit. Epoll was selected for further verification.
- `native-check`: three 5-second rounds, 64 connections, each runtime's native HTTP API. Default / epoll / Bun p99 was 1.82 / 1.35 / 1.46ms; throughput 84,049 / 89,230 / 83,185 req/s. This diagnostic forces epoll on the baseline binary.
- `c256-check`: three 5-second rounds, 256 connections. Epoll increased throughput (55,406 → 58,724 req/s), but p99 regressed (6.59 → 7.05ms). This unfavorable result is retained and prompted the longer, six-round verification below.

An initial current-binary diagnostic was aborted when Node could not bind a port. The harness was corrected to reserve an IPv6 dual-stack port; that incomplete run is excluded. The v2 and subsequent runs completed without that failure.

## Final binary: six rounds of 10 seconds

`bench/hello_node.mjs`, one worker, one second warmup per sample. All 48 measured samples completed without reported HTTP/socket errors.

| Connections | Runtime | req/s | p99 (ms) |
|---|---|---:|---:|
| 64 | Kestrel before | 62,446 | 2.515 |
| 64 | Kestrel default epoll | 58,855 | 1.635 |
| 64 | Bun 1.4.3 | 51,836 | 2.365 |
| 64 | Node 22.12.0 | 36,967 | 3.065 |
| 256 | Kestrel before | 63,011 | 6.410 |
| 256 | Kestrel default epoll | 59,600 | 5.800 |
| 256 | Bun 1.4.3 | 53,533 | 8.790 |
| 256 | Node 22.12.0 | 37,571 | 10.515 |

At 64 connections, default epoll reduces p99 by **35.0%** versus the baseline and **30.9%** versus Bun. At 256 connections the reductions are **9.5%** and **34.0%**. Throughput remains above Bun by **13.5% / 11.3%**, but is **5.8% / 5.4% below the baseline** in this longer run. The earlier six-round 5-second confirmation had a 5.3% throughput increase instead. This is a measured tail-latency improvement with variable throughput, not evidence of a throughput improvement over the old default. The short 256-connection diagnostic regressed p99; retain that caveat when interpreting the longer run.

## Additional 256-connection backend check

Four 10-second rounds immediately after the four-way runs (`backends-c256`):

| Backend | req/s | p99 (ms) |
|---|---:|---:|
| Original mixed default | 75,563 | 4.495 |
| Default epoll candidate | 73,193 | 6.180 |
| Explicit `KESTREL_URING=1` | 75,135 | 3.795 |

This run **does not confirm a default-epoll improvement at 256 connections**: its p99 is 37.5% worse than the original default. The separate six-round four-way run improved p99 by 9.5%, while the earlier short diagnostic regressed it by 7.0%. High-concurrency benefit is therefore inconsistent; the default change is supported most clearly by the repeated 64-connection results. For the 256-connection workload, explicit io_uring lowered p99 by 15.6% with throughput within 0.6% of the original default in this backend check. It remains opt-in because these results do not establish one backend as best for all workloads, native APIs or higher connection counts. Do not compare this run's absolute throughput with the earlier Bun samples.

## Throughput versus low tail latency

`choice-c64` and `choice-native` each use three 5-second rounds at 64 connections, including Bun in the same rotated run.

| Workload | Variant | req/s | p99 (ms) |
|---|---|---:|---:|
| Node HTTP | Original mixed default | 61,490 | 2.510 |
| Node HTTP | epoll | 67,267 | 1.800 |
| Node HTTP | io_uring | 65,830 | 1.120 |
| Node HTTP | Bun | 59,579 | 2.210 |
| Native HTTP | Original mixed default | 83,485 | 1.670 |
| Native HTTP | epoll | 89,595 | 1.380 |
| Native HTTP | io_uring | 80,012 | 0.990 |
| Native HTTP | Bun | 78,436 | 1.480 |

Pure io_uring is useful for latency-sensitive workloads: Node HTTP p99 falls 55.4% versus the old default and 49.3% versus Bun in this run, with throughput above both. For native HTTP it lowers p99 further than epoll, but throughput is 10.7% lower than epoll and 4.2% lower than the original default. Keep the explicit override rather than silently applying this tradeoff to every Linux application.

## Correctness checks

The final epoll-default binary passes the Linux default differential gate (42 cases), plus VM modules, real npm native addons and the native serve API (3 cases). Explicit io_uring, batched I/O and Hyper-only modes each pass 10 HTTP lifecycle/metadata/streaming cases. All four modes pass the real-socket stalled-reader backpressure test, pausing production and delivering all 64MiB. Raw output is in `validation/`. The compatibility launcher change only enables Node 22's TypeScript stripping for `.ts` fixtures; it does not skip a case or relax stdout/exit checks.

## Concurrency boundaries

At 8 connections (three 5-second rounds), the original default and new default both select epoll. Their p99 medians were 0.235 and 0.240ms, and throughput was 65,875 and 60,950 req/s. This unchanged backend path illustrates the host/run variability; it does not establish a low-concurrency performance gain. Explicit io_uring measured 0.193ms / 60,502 req/s.

The first 4096-connection diagnostic exceeded the test shell's file-descriptor limit and was rejected for connect errors. The rerun uses `ulimit -n 65536` for the benchmark shell and its children only.

The valid 4096-connection rerun (three 5-second rounds) gives:

| Backend | req/s | p99 (ms) |
|---|---:|---:|
| Original mixed default | 64,206 | 102.15 |
| Default epoll | 65,957 | 65.50 |
| Explicit io_uring | 50,711 | 111.39 |

Default epoll reduces p99 by **35.9%** and raises throughput by **2.7%** versus the original default here. Pure io_uring loses substantial throughput at this connection count, supporting keeping it opt-in. The final choice is default epoll for the repeated 64-connection tail improvement, native HTTP throughput, and 4096-connection behavior, with an explicit io_uring option for workloads such as the 256-connection case where it wins. It is not a universal performance guarantee.

The final Linux binary also produces identical output for `aot_check.ts` with the native tier enabled and `KESTREL_AOT=0`; both outputs are retained in `validation/`. The local compatibility-gate self-tests pass (5 tests), and the benchmark helper passes Python syntax/CLI checks.
