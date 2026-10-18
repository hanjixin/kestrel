# Compatibility and performance verification — 2026-10-18

Measured locally on macOS arm64. Baseline is the preserved binary from immediately before this compatibility round; the checkout includes earlier uncommitted lifecycle fixes. These are same-host microbenchmarks, not a guarantee for all workloads or Linux.

## HTTP

One server worker, wrk 2 threads / 64 connections, 1 second warmup then 5 seconds measurement, five alternating before/after pairs per fixture. All samples retained in `http-5-rounds.json`; the earlier three-pair run is also retained. No compilation or other test suite ran concurrently.

| Workload | Before req/s | After req/s | Change | Before RSS MiB | After RSS MiB |
|---|---:|---:|---:|---:|---:|
| bench/hello_kestrel.ts | 325883 | 332111 | +1.91% | 33.3 | 33.4 |
| bench/hello_node.mjs | 151303 | 151553 | +0.17% | 45.5 | 46.0 |

Values are medians. The earlier three-pair run measured +2.57% for Kestrel.serve and -1.37% for node:http. Short-run variation is visible, so these results support no material regression in these fixtures, not a universal speedup. RSS is a post-run sample, not peak memory. The intermediate node:http RSS regression (~115 MiB) was eliminated by moving per-response methods onto prototypes.

## Worker and filesystem

- Worker: 200 round trips of a 1 MiB ArrayBuffer, including worker startup; three samples. Payload type and size are checked. Median before 2136 ms, after 11 ms, Node 14 ms. The baseline uses serialization/copying; the new implementation transfers backing-store ownership and avoids periodic receive polling.
- Cached file reads: sixteen sequential 32 MiB reads (512 MiB total), three samples. Median before 64 ms, after 57 ms, Node 56 ms. Timer ticks were 0 before and 26–29 after, showing the isolate can make progress during reads. These are warm filesystem/cache measurements, not disk throughput.

## Correctness

- Release build succeeded; default differential gate: 31/31 passed.
- Gate failure-behavior self-tests: 5/5 passed.
- Hyper-only HTTP streaming/lifecycle/end-buffer checks: 3/3 passed.
- Backpressure: paused client stalled Node at 960 KiB and Kestrel at 1088 KiB; both delivered the full 64 MiB after reading resumed.
- Existing Next.js 15.5.28 production standalone output served identity and gzip requests successfully (200, expected content).
- `git diff --check` passed.

## Remaining scope

Linux io_uring/batched paths were not executed. Advanced IPC is verified Kestrel-to-Kestrel; current Node 25 rejects the embedded V8 serialization version, so use JSON across runtimes. Worker eval/MessagePort transfer/BroadcastChannel, filesystem watch/glob and less common options, and streaming HTTP client/request bodies remain incomplete.

## Binary identity

- before SHA-256: `21e9112cce638fd6c552a98f2ccddb950466ac3d8389674b54b77819419a2a98`
- after SHA-256: `575c73aded3f3af5a59f95e610c3b0b14bb823bd47de27b61590e318542463dc`
- Node: v25.6.1
