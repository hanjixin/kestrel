# kestrel

A JavaScript/TypeScript runtime combining V8, a growing Node compatibility layer, an optimized HTTP server, and an ahead-of-time tier for annotated numeric functions. Performance depends on the workload; measured results and compatibility limits are listed below.

How it gets both:

- **Tier 0, the compatibility floor.** V8 (via `deno_core`) runs everything, unchanged. A Node compatibility layer provides the `node:*` builtins, Node-API for native addons, `require()` with Node's resolution rules (`package.json` `exports`/`main`, `node_modules` walk, symlinks), ESM ↔ CommonJS interop in both directions (including `require(esm)`), and the usual globals (`process`, `Buffer`, `URL`, `fetch`, `TextEncoder`, `AbortController`, timers with Node's ordering). TypeScript and JSX are stripped with `oxc` on load. The whole bootstrap is baked into a V8 snapshot.
- **Tier 1, the native tier.** Top-level TypeScript functions whose parameters and return are annotated `: number` are compiled ahead of time to machine code with Cranelift. The JS binding keeps its name, `length` and `name`; a `typeof` guard on every argument falls back to the original JS for anything that is not a number, so observable behaviour is unchanged for every input. Semantics are JavaScript's exactly (IEEE-754 doubles, ToInt32 for bitwise ops, fmod for `%`, NaN-ordered comparisons, `RangeError` on deep recursion), verified byte-for-byte against V8 by `examples/aot_check.ts`.
- **Runtime.** `Kestrel.serve` and `http.createServer` serve plain keep-alive requests from a per-worker level-triggered `epoll`/`kqueue` loop: one `read`, `httparse`, the JS handler called directly on the isolate's thread (no queue, no op, no promise per request), one `write`. Requests with bodies, upgrades or TLS go through hyper 1.x with identical semantics. One acceptor thread hands connections to the least-loaded worker thread; each worker has its own V8 isolate with its own garbage collector, so one process uses every core without `cluster`.

The name is a placeholder.

## Build and run

```sh
rustup update stable            # needs rustc >= 1.97
cargo build --release
./target/release/kestrel app.ts            # or .js / .mjs / .cjs
KESTREL_AOT_LOG=1 ./target/release/kestrel examples/aot_check.ts   # show what went native
KESTREL_AOT=0     ./target/release/kestrel examples/aot_check.ts   # V8 only
KESTREL_REQUIRE_LOG=1 ...                                          # trace require()
KESTREL_YOUNG_MB=32 ...                                            # young-generation semi-space per isolate (default 32 main / 8 workers)
KESTREL_V8_FLAGS="..." ...                                         # extra raw V8 flags
KESTREL_FASTPATH=0 ...                                             # serve everything through hyper (no level-triggered fast loop)
KESTREL_URING=1|0 ...                                              # Linux: opt into io_uring or force epoll (default: epoll)
KESTREL_PACK=16 ...                                                # connections packed per worker before the acceptor spreads (0 = least-loaded only)
KESTREL_BATCH_IO=1 ...                                             # Linux: epoll readiness + batched io_uring reads/writes per wake-up (no gain on 5.15 kernels)
./target/release/kestrel --inspect[=[host:]port] app.js            # DevTools endpoint (chrome://inspect, VS Code); --inspect-brk pauses on the first line
```

A Linux build is produced in Docker with the `rust:bullseye` image (glibc 2.31, so the binary runs on Ubuntu 20.04+ without loader warnings): `docker run --rm --platform linux/amd64 -v $PWD:/src -w /src rust:bullseye cargo build --release --target-dir /src/target-linux-amd64`; see `bench/remote/run.sh` for the upload and benchmark steps.

## Compatibility status

The default differential gate passes **42/42 cases on both macOS and Linux**, including process events, Web Crypto globals, BYOB streams, VM sandbox properties and runtime/AOT initialization regressions. Linux also passes three extra VM/native-addon/native-HTTP cases; the launcher enables experimental type stripping for TypeScript fixtures on Node 22. Each case must exit successfully under both Node and Kestrel with identical stdout. The latest Linux run also validates io_uring, batched I/O and Hyper-only HTTP modes, including real-socket backpressure.

Coverage in `test/compat` includes:

- `http_end_strings.mjs`, `http_end_buffer.mjs`: response encodings, Unicode, streamed strings, end callbacks, invalid-encoding recovery and mutable-buffer ownership.
- `http_request_metadata.mjs`, `http_early_body_read.mjs`: original request targets, duplicate headers and request-body handoff.
- `webcrypto_globals.mjs`: Web Crypto global constructor identity, illegal construction and AES-GCM round trips.
- `process_events.mjs`, `process_events_ipc.mjs`: process EventEmitter semantics, raw/once listener identity, reentrant dispatch, listener validation and prepended once-only IPC delivery. This fixes the missing `process.prependOnceListener` that prevented Next 16 build initialization.
- `worker_clone.mjs`, `fork_advanced.mjs`: structured clone, transferable ArrayBuffers and advanced child-process IPC.
- `fs_async.mjs`, `fs_handles.mjs`, `builtin_subpaths.mjs`: asynchronous filesystem progress, file handles and builtin subpath imports.

- `fs_streams.mjs`: file-stream reads/writes through direct constructors, calls without `new`, legacy `util.inherits` subclasses, ES subclasses, and factory functions; checks range reads, byte counts, and constructor options.
- `fork_disconnect.mjs`: disconnecting an IPC channel with writes larger than the socket buffer must let the child terminate without hanging.
- `http_implicit_headers.mjs`: the implicit response-header hook used by compression middleware invokes `writeHead` and commits headers once.
- `http_async_close.mjs`: a request with `Connection: close` must receive its asynchronous response before the connection closes.

- `server_close.mjs`, `server_close_active.mjs`, `server_close_idle.mjs`: listener/port release for HTTP and HTTP/2, graceful GET/POST response completion, idle keep-alive closure, independent servers, and reopening a listener. These tests exit naturally, without `process.exit()`. The HTTP cases also run with `KESTREL_FASTPATH=0` to cover hyper.
- `builtins.cjs`: path, fs, util.inspect/format, events, Buffer, crypto (hashes, HMAC, PBKDF2, scrypt, HKDF, AES-GCM/CBC/CTR), zlib (gzip, deflate, brotli), URL/URLSearchParams, querystring, string_decoder, streams + pipeline, os, process, assert. Output is identical to Node 22.
- `proc.mjs`: child_process `spawn`/`exec`/`execFile`/`execSync`/`execFileSync`/`spawnSync` with piped stdio, exit codes, ENOENT; fd-level fs (`openSync`/`readSync`/`writeSync`/`fstatSync`/`ftruncateSync`, `fs.promises.open` FileHandle). Identical to Node.
- `net.mjs`, `unix.mjs`: `net.createServer` + `net.connect` echo over TCP and Unix domain sockets, `tls.createServer` + `tls.connect`, `fs.watch` events, ECONNREFUSED. Identical.
- `fork.mjs`: `child_process.fork` with the IPC channel (`process.send` / `'message'` both ways, exit codes). Identical.
- `misc.mjs`: `dgram` UDP round trip and multicast options, `vm.runInThisContext`/`runInNewContext`/`Script`, `v8.getHeapStatistics`, `perf_hooks`, `cluster` entry points, `inspector`. Identical.
- Every test also exits on its own with Node's exit code (closing a socket or listener cancels its pending read/accept).
- `cluster.mjs`: primary forks two workers that share one port, both answer, signals on kill. Identical.
- `als.mjs`: `AsyncLocalStorage` across `await`, timers, `setImmediate`, `nextTick`, nested `run`/`exit`, concurrent stores, `AsyncResource.bind`. Identical.
- `worker.mjs`: `worker_threads.Worker` with `workerData`, `postMessage` both ways, `process.exit` code in the worker. Identical.
- `https.mjs`: `https.createServer` with a self-signed key/cert served by rustls, consumed by `fetch`. Identical.
- `http.mjs`, `serve.ts`: `http.createServer` request/response with bodies and headers, `http.get`, `fetch`, `Kestrel.serve` with JSON, byte bodies, custom headers, sync and async handlers.
- `http2.mjs`: `http2.createSecureServer` (ALPN `h2`) and `http2.createServer` (h2c) with the stream API (`'stream'`, `respond`), the compatibility API (`'request'`, `httpVersion` 2.0, pseudo-headers), server push (`pushStream` answered and consumed by the client's `'stream'`/`'push'`), `ping`, settings packing and constants, `http2.connect` with GET and POST bodies, and errors after `close()`. Identical.
- `http2_stress.mjs`: 40 concurrent HTTP/2 streams, request and response bodies up to 1 MB (far past the 64 KiB flow-control window, so `WINDOW_UPDATE` runs in both directions), each verified by length and checksum. Identical, and the uploaded/returned checksums all match.
- `vmmod.mjs`: `vm.SourceTextModule` and `vm.SyntheticModule` (link with dependencies and cycles-safe recursion, evaluate, namespace, status, error, contexts, `importModuleDynamically` for modules and scripts, `initializeImportMeta`, Node's `ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING` without a callback) and `node:inspector` / `inspector/promises` sessions (`Runtime.evaluate`, `Profiler.start/stop`, error and disconnect behaviour). Identical to Node run with `--experimental-vm-modules`.
- `napi.cjs`: a C Node-API addon (`test/compat/napi/hello.c`, built against the local Node headers by `napi/build.sh`) loaded with `require()` and `process.dlopen`: numbers, strings, buffers, callbacks, exceptions and error codes, `napi_wrap` classes, references held across async work, handle stability across hundreds of allocations, the ObjectWrap constructor sequence, versions. Identical.
- `napi_real.cjs`: prebuilt addons from npm as shipped: `sqlite3` (node-sqlite3, N-API over node-addon-api with async work, classes and EventEmitter mixins) and `bcrypt` (thread-pool work). Identical.
- `inspect.mjs`: external debugger attach. Starts `<runtime> --inspect=0 inspect_target.mjs`, reads the `ws://` URL, checks `/json/list` and `/json/version`, then speaks CDP over a WebSocket (`Runtime.evaluate` against the running program, unknown-method errors, `Profiler.start/stop`); then the same with `--inspect-brk=0`, checking that nothing ran before `Runtime.runIfWaitingForDebugger` and that the program completes after `Debugger.resume`. Identical output for `RUNTIME=node` and `RUNTIME=kestrel`.
- `esm.mjs`, `npm.mjs`, `realworld.cjs`: ESM ↔ CommonJS interop (both directions, including `require(esm)`), and unmodified packages from a real `node_modules`: marked, nanoid, jszip, pako, hash.js, is-url, inherits, docx, pptxgenjs, pdf-lib, pngjs, jpeg-js, image-size.
- Scheduling order of `process.nextTick`, microtasks, `setImmediate` and timers matches Node.

Builtins: assert, async_hooks (`AsyncLocalStorage`, `AsyncResource`; `createHook` is a no-op), buffer, child_process (incl. `fork` IPC), cluster (processes sharing a port via `SO_REUSEPORT`), constants, crypto (hashes, HMAC, KDFs, AES/ChaCha ciphers, RSA/ECDSA sign/verify and key pairs, webcrypto subset), dgram (+multicast), dns, events, fs (+promises, fd API, streams, `watch`/`watchFile`), http, http2 (servers over TLS/ALPN and h2c, client, stream and compatibility APIs, server push, ping, flow control; over the `h2` crate), https, inspector (in-process CDP sessions and the external endpoint: `--inspect`, `--inspect-brk`, `inspector.open()`/`url()`/`close()`/`waitForDebugger()`), module, net (TCP + Unix sockets), os, path, perf_hooks, process, querystring, readline, stream, string_decoder, sys, timers, tls (client and server), tty, url, util, v8 (heap statistics, serialize), vm (scripts in this or a fresh context, `SourceTextModule`, `SyntheticModule`, `importModuleDynamically` as a callback or `USE_MAIN_CONTEXT_DEFAULT_LOADER`, `initializeImportMeta`), worker_threads, zlib (+brotli). Native addons: Node-API (N-API) modules load through `require()`/`process.dlopen` (the `napi_*` and `uv_*` symbols are exported from the binary, `process.versions.napi` is 10); the implementation is `crates/kestrel-napi`, a vendored copy of deno_napi 0.190.0 (MIT) matching the embedded deno_core, minus Deno's permission and embedded-loader hooks. Addons built against the legacy V8/`nan` API (for example better-sqlite3) are not supported, as in Deno and Bun.

## Linux p99 improvements — v0.0.2

The Linux fast path now defaults to epoll; `KESTREL_URING=1` retains the io_uring option. Six rounds of 10-second, single-worker Node HTTP tests on the same EPYC/Linux 5.15 host gave:

| Connections | Kestrel before p99 | Kestrel now p99 | Bun p99 | Native Node p99 | Kestrel now req/s |
|---|---:|---:|---:|---:|---:|
| 64 | 2.515 ms | **1.635 ms** | 2.365 ms | 3.065 ms | 58,855 |
| 256 | 6.410 ms | **5.800 ms** | 8.790 ms | 10.515 ms | 59,600 |

These p99 values are medians of per-round percentiles. Kestrel's p99 falls 35.0% / 9.5% versus the previous default and 30.9% / 34.0% versus Bun. Throughput is 13.5% / 11.3% above Bun, but 5.8% / 5.4% below the previous default in this run. A shorter confirmation instead showed a throughput increase. Two additional 256-connection checks regressed epoll p99, so its high-concurrency benefit is not consistent; explicit `KESTREL_URING=1` performed better in the backend comparison (3.795 ms versus the original 4.495 ms). The clearest default improvement is at 64 connections. [Raw results, rejected experiments and methodology](docs/performance/2026-10-18-linux-p99/README.md). This source change ships in **v0.0.2**; v0.0.1 retains the previous behavior.

At 4096 connections, a separate three-round check gives **102.15 → 65.50 ms p99** (−35.9%) and **64,206 → 65,957 req/s** (+2.7%) for the default change. Pure io_uring instead measured 111.39 ms / 50,711 req/s, so it remains opt-in.

For latency-sensitive Linux deployments, test `KESTREL_URING=1 ./kestrel app.ts` against the default on your workload. A separate three-round 64-connection comparison measured Node HTTP p99 at **1.120 ms** with io_uring, versus 2.510 ms before and 2.210 ms in Bun; throughput was 65,830 / 61,490 / 59,579 req/s respectively. For native HTTP, io_uring reached 0.990 ms p99 versus epoll's 1.380 ms, but delivered 80,012 versus 89,595 req/s. It is an explicit tradeoff, not a universal winner.

## Latest measured performance — 2026-10-18

Same-host, single-worker HTTP comparisons using `wrk -t2 -c64`, with 1 second warmup per sample. Linux uses six rounds of 5 seconds with unrestricted CPU scheduling; macOS uses three rounds of 3 seconds. Values are median requests/second. Runtime order is rotated between rounds.

| Platform / workload | Kestrel | Bun | Native Node | Kestrel vs Bun |
|---|---:|---:|---:|---:|
| Linux x86_64, native HTTP API | 74,121 | 72,375 | — | +2.4% |
| Linux x86_64, identical `node:http` source | 64,400 | 55,964 | 35,789 | **+15.1%** |
| macOS arm64, native HTTP API | 340,157 | 273,014 | — | +24.6% |
| macOS arm64, identical `node:http` source | 254,768 | 185,148 | 142,523 | **+37.6%** |

Linux: AMD EPYC 7542, Bun 1.4.3, Node 22.12.0. macOS: Apple M4, Bun 1.3.11, Node 25.6.1. Compare runtimes within each row; different platforms and runtime versions are not directly comparable. Node is compared through its native `node:http` API using the same source on all three runtimes.

Linux I/O medians (lower is better):

| Workload | Kestrel | Bun | Node |
|---|---:|---:|---:|
| Worker: 200 × 1 MiB transfer round trips | 17.5 ms | 91.5 ms | 38 ms |
| Cached reads: 16 × 32 MiB | 164 ms | 301 ms | 508 ms |

The latest optimization preserves immutable UTF-8 response strings until native serialization, avoiding intermediate Buffer allocations and copies. Mutable Buffer responses retain an owned snapshot; streaming responses retain backpressure. A controlled Linux before/after comparison with fixed CPU placement measured **11.9% higher `node:http` throughput**. The runtime also uses a 32 MiB initial old-space budget, without lowering its maximum heap limit; explicit initial heap flags in `KESTREL_V8_FLAGS` take precedence.

**Limits:** these are microbenchmarks, not universal performance guarantees. With unrestricted scheduling, Linux `node:http` p99 remains slightly higher than Bun (2.500 vs 2.265 ms), and native HTTP RSS is higher (46.4 vs 32.5 MiB). Kestrel won 5/6 `node:http` pairs and 4/6 native HTTP pairs in that run. Cached file reads do not measure disk throughput. Multicore scaling and framework throughput were not remeasured in this round.

See the [full report, raw samples, CPU profiles and validation logs](docs/performance/2026-10-18-linux-strings/README.md), including fixed-CPU and unrestricted runs and rejected intermediate results.

```sh
python3 test/compat/run.py
python3 test/test_compat_gate.py
python3 test/stream_backpressure.py
python3 bench/compare_bun.py --include-node --rounds 6 --duration 5 --output-dir /tmp/kestrel-comparison
```

## Historical measurements — 2026-10-16

The following results use earlier revisions, different concurrency settings and shorter historical test coverage. They are retained for context; use the report above for the current revision.


### Apple M4 (10 cores), macOS, 2026-10-16

Startup, `console.log("hello")` (hyperfine):

| runtime | wall | peak RSS |
|---|---|---|
| node 22.22 | 15.9 ms | 38.7 MiB |
| bun 1.3.11 | 5.7 ms | 20.2 MiB |
| kestrel | 4.7 ms | 16.9 MiB |

CPU, in-program timers (`examples/bench_*.ts`):

| benchmark | node | bun | kestrel V8-only | kestrel native tier |
|---|---|---|---|---|
| `fib(35)` recursive | 49 ms | 58 ms | 48 ms | 29 ms |
| cold collatz + Leibniz (int-heavy, run once) | 235 ms | 239 ms | 127 ms | 87 ms |
| mandelbrot 1200×800×200 (float loops) | 85 ms | 103 ms | 84 ms | 91 ms |

HTTP hello world, `wrk -t2 -c256`, client and server on the same machine (`bench/http_wrk.sh`):

| server | req/s | p50 | p99 |
|---|---|---|---|
| node 22, 1 process | 132 k | 1.94 ms | 7.0 ms |
| node 22 cluster, 10 processes | 229 k | 0.58 ms | 4.7 ms |
| bun 1.3, 1 process | 276 k | 0.89 ms | 1.76 ms |
| kestrel, 1 worker thread | 352 k | 0.70 ms | 1.38 ms |

Same, `wrk -t2 -c4096`:

| server | req/s | p50 | p99 |
|---|---|---|---|
| node 22, 1 process | 115 k | 16.2 ms | 463 ms |
| node 22 cluster, 10 processes | 202 k | 19.2 ms | 26.5 ms |
| bun 1.3, 1 process | 225 k | 17.2 ms | 23.2 ms |
| kestrel, 1 worker thread | 306 k | 13.1 ms | 15.2 ms |

### Linux x86_64, AMD EPYC 7542 (128 vCPU), Ubuntu 22.04, 2026-10-16

Servers and `wrk` on the same host over loopback (the inter-node link of the test environment caps at 57 k req/s, so a separate load generator could not be used). `bench/remote/`, node 22.12, bun 1.4.3. Run-to-run spread on this host is about ±8 %; ranges below are from repeated runs.

| server | 256 connections (`-t8`) | 4096 connections (`-t32`) |
|---|---|---|
| node, 1 process | 38 k (p99 390 ms) | 32 k (p99 34–37 ms, 330–350 timeouts) |
| bun, 1 process | 74–85 k (p99 4.4–5.7 ms) | 55–58 k (p99 119–257 ms) |
| kestrel, 1 worker thread | 88–94 k (p99 4.0–4.1 ms) | 64–67 k (p99 105–110 ms) |
| node cluster, 128 processes | 396–409 k | 851 k (p99 28–33 ms) |
| bun `reusePort`, 128 processes (its default) | 456–469 k (p99 0.58 ms) | 1.30–1.37 M (p99 2.9–3.1 ms) |
| bun `reusePort`, 32 processes (its best) | 477–483 k | 1.57–1.61 M (p99 5.3–5.5 ms) |
| kestrel, default (`workers: "auto"` = 64 physical cores, packed accept, backend per connection) | 498–511 k (p99 0.53–0.56 ms) | 1.47–1.49 M (p99 2.9 ms; one run 9.9 ms) |
| kestrel, epoll only (`KESTREL_URING=0`) | 489–510 k (p99 0.53–0.55 ms) | 1.42–1.48 M (p99 2.6–3.3 ms) |
| kestrel, io_uring only (`KESTREL_URING=1`) | 449–490 k | 1.49–1.54 M (p99 2.6–3.1 ms) |
| kestrel, 32 worker threads | 482–495 k | 1.63–1.65 M (p99 3.1–3.8 ms) |
| kestrel, 128 worker threads, evenly spread (old default) | 413–416 k | 1.20–1.23 M |
| kestrel raw hyper, no JS, 128 threads | 440 k | 1.39–1.40 M |

The historical configuration above selected between two Linux backends by how many connections the worker already held: the first 16 go to the level-triggered epoll loop (one ready `read` per request is cheapest when a loop holds a handful), the next 512 to io_uring (recv/send submitted in batches with a bounded submit-and-wait: +4–5 % when loops hold tens to hundreds), and anything beyond back to epoll (one loop holding thousands loses 17 % on io_uring, because on this 5.15 kernel without multishot receive every re-armed `recv` goes through the poll-arm and task-work path). Between its busy turns the io_uring loop also serves the worker's epoll connections, so the two never starve each other. The current default uses epoll for all fast-loop connections; `KESTREL_URING=1` opts into io_uring. See the [2026-10-18 tail-latency investigation](docs/performance/2026-10-18-linux-p99/README.md) for the new measurements and limitations.

The host runs the load generator too (32 `wrk` threads on 128 vCPUs, 2 sockets, 8 NUMA nodes), so one server thread or process per vCPU is past the knee for both runtimes (`bench/remote/sweep2.sh`). Two defaults follow from that: `"auto"` means physical cores, and the acceptor packs connections onto as few workers as needed (up to 16 each, `KESTREL_PACK`) before spreading, so a few hundred mostly idle keep-alive connections do not wake 64 threads.

The single-worker tail at 4096 connections is dominated by the first second, when all connections arrive at once: over a 3 s run kestrel's p99 is 133 ms (max 170 ms) against Bun's 605 ms (max 960 ms); over 30 s both settle at 76 ms vs 82 ms.

CPU on the same host: `fib(35)` node 110 ms, bun 71 ms, kestrel V8-only 108 ms, native tier 70 ms; cold int-heavy benchmark kestrel V8-only 297 ms, native tier 155 ms.

These historical measurements cover specific startup, CPU and HTTP configurations. They do not establish a general latency or memory advantage for the current revision.

## Layout

```
crates/kestrel-cli      the `kestrel` binary
crates/kestrel-engine   V8 host: Node resolution + loaders, TS stripping, ESM->CJS, snapshot, ops,
                        HTTP/fetch/TLS backends, child processes, sockets, worker threads
  src/js/               bootstrap, globals, node/*.js builtins (all in the snapshot)
crates/kestrel-aot      native tier: candidate selection, Cranelift codegen, dispatch table
examples/               native-tier correctness suite and CPU benchmarks
test/compat/            Node compatibility tests (compare with `node`)
bench/                  hello servers, macOS/Linux-Docker scripts, bench/remote for the test nodes
docs/ARCHITECTURE.md    design, invariants, roadmap
```

### Compatibility regression gate

Run `python3 test/compat/run.py` after `cargo build --release`. Each case must exit
successfully on both Node and Kestrel and produce identical stdout. Missing tests,
nonzero exits, output differences and process-group timeouts fail the command.
`python3 test/test_compat_gate.py` verifies the gate's failure behavior.
`python3 test/stream_backpressure.py` uses a real socket client that stops reading,
then verifies that the bounded producer resumes and delivers the complete body.

The new coverage includes builtin `assert/strict` and `stream/promises` imports,
nonblocking filesystem reads (FIFO progress), incremental file streams, streamed
HTTP responses, POST bodies after flushing headers, client disconnects, Worker
cyclic graphs and ArrayBuffer transfer, and advanced fork IPC. Complete HTTP
responses still use the fast path; a connection moves to the streaming transport
only when it sends a streaming response. Transferable Worker ArrayBuffers move
backing-store ownership without copying their contents.

This remains a compatibility implementation, not a complete Node replacement.
Web Streams include BYOB readers, byte controllers, buffer transfer and pipeline
backpressure through the vendored MIT-licensed web-streams-polyfill 4.3.0. Next 16
Edge Runtime initialization and a complete reportify-fe `next build --webpack`
run now pass, including 99/99 generated pages and a production health check.
The validation reused build caches with a 6 GB heap and two page workers; it is
not a fresh three-runtime performance comparison. See the
[reportify-fe validation notes](docs/performance/2026-10-18-reportify-build/README.md).
HTTP clients and request bodies still buffer complete bodies. Worker `eval`,
transferring MessagePorts, BroadcastChannel, fs promises watch/glob and some
less common filesystem options remain incomplete. Advanced IPC uses the embedded
V8 wire format: Kestrel-to-Kestrel is covered, but the current Node 25 runtime
rejects Kestrel's newer serialization version. Use JSON for cross-runtime IPC.
Linux io_uring, batched I/O and Hyper-only modes passed the focused HTTP and
real-socket backpressure checks; see the [Linux validation and three-runtime comparison](docs/performance/2026-10-18-linux/README.md).
Use `python3 bench/compare.py --before /path/to/baseline-kestrel` for alternating
same-host throughput/RSS comparisons; `bench/worker_transfer.mjs` and
`bench/fs_read.mjs` measure message transfers and file reads separately.

Earlier reports are retained for traceability: [compatibility-round verification](docs/performance/2026-10-18/README.md), [macOS Bun comparison](docs/performance/2026-10-18-bun-final/README.md), and [Linux baseline before the string-response optimization](docs/performance/2026-10-18-linux/README.md). The latest results are summarized above and in the [current report](docs/performance/2026-10-18-linux-strings/README.md).
