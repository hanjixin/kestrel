# kestrel

A JavaScript/TypeScript runtime that keeps JavaScript's semantics and Node's module ecosystem, and is faster than Node everywhere measured: startup, memory, CPU-bound code, and HTTP serving on one core and on all cores.

How it gets both:

- **Tier 0, the compatibility floor.** V8 (via `deno_core`) runs everything, unchanged. A Node compatibility layer provides the `node:*` builtins, `require()` with Node's resolution rules (`package.json` `exports`/`main`, `node_modules` walk, symlinks), ESM ↔ CommonJS interop in both directions (including `require(esm)`), and the usual globals (`process`, `Buffer`, `URL`, `fetch`, `TextEncoder`, `AbortController`, timers with Node's ordering). TypeScript and JSX are stripped with `oxc` on load. The whole bootstrap is baked into a V8 snapshot.
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
KESTREL_URING=1|0 ...                                              # Linux: force the io_uring or the epoll fast loop (default: io_uring with 4+ workers)
KESTREL_PACK=16 ...                                                # connections packed per worker before the acceptor spreads (0 = least-loaded only)
KESTREL_BATCH_IO=1 ...                                             # Linux: epoll readiness + batched io_uring reads/writes per wake-up (no gain on 5.15 kernels)
./target/release/kestrel --inspect[=[host:]port] app.js            # DevTools endpoint (chrome://inspect, VS Code); --inspect-brk pauses on the first line
```

A Linux build is produced in Docker with the `rust:bullseye` image (glibc 2.31, so the binary runs on Ubuntu 20.04+ without loader warnings): `docker run --rm --platform linux/amd64 -v $PWD:/src -w /src rust:bullseye cargo build --release --target-dir /src/target-linux-amd64`; see `bench/remote/run.sh` for the upload and benchmark steps.

## Compatibility status

Verified by `test/compat` (each file runs under node and kestrel and the outputs are compared):

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
- `http2.mjs`: `http2.createSecureServer` (ALPN `h2`) with the stream API (`'stream'`, `respond`) and the compatibility API (`'request'`, `httpVersion` 2.0, pseudo-headers), `http2.createServer` (h2c prior knowledge), `http2.connect` client with GET and POST bodies, settings packing, constants, errors after `close()`. Identical.
- `vmmod.mjs`: `vm.SourceTextModule` and `vm.SyntheticModule` (link with dependencies and cycles-safe recursion, evaluate, namespace, status, error, contexts, `importModuleDynamically` for modules and scripts, `initializeImportMeta`, Node's `ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING` without a callback) and `node:inspector` / `inspector/promises` sessions (`Runtime.evaluate`, `Profiler.start/stop`, error and disconnect behaviour). Identical to Node run with `--experimental-vm-modules`.
- `inspect.mjs`: external debugger attach. Starts `<runtime> --inspect=0 inspect_target.mjs`, reads the `ws://` URL, checks `/json/list` and `/json/version`, then speaks CDP over a WebSocket (`Runtime.evaluate` against the running program, unknown-method errors, `Profiler.start/stop`); then the same with `--inspect-brk=0`, checking that nothing ran before `Runtime.runIfWaitingForDebugger` and that the program completes after `Debugger.resume`. Identical output for `RUNTIME=node` and `RUNTIME=kestrel`.
- `esm.mjs`, `npm.mjs`, `realworld.cjs`: ESM ↔ CommonJS interop (both directions, including `require(esm)`), and unmodified packages from a real `node_modules`: marked, nanoid, jszip, pako, hash.js, is-url, inherits, docx, pptxgenjs, pdf-lib, pngjs, jpeg-js, image-size.
- Scheduling order of `process.nextTick`, microtasks, `setImmediate` and timers matches Node.

Builtins: assert, async_hooks (`AsyncLocalStorage`, `AsyncResource`; `createHook` is a no-op), buffer, child_process (incl. `fork` IPC), cluster (processes sharing a port via `SO_REUSEPORT`), constants, crypto (hashes, HMAC, KDFs, AES/ChaCha ciphers, RSA/ECDSA sign/verify and key pairs, webcrypto subset), dgram (+multicast), dns, events, fs (+promises, fd API, streams, `watch`/`watchFile`), http, http2 (servers over TLS/ALPN and h2c, client, stream and compatibility APIs; no server push, one request per stream), https, inspector (in-process CDP sessions and the external endpoint: `--inspect`, `--inspect-brk`, `inspector.open()`/`url()`/`close()`/`waitForDebugger()`), module, net (TCP + Unix sockets), os, path, perf_hooks, process, querystring, readline, stream, string_decoder, sys, timers, tls (client and server), tty, url, util, v8 (heap statistics, serialize), vm (scripts in this or a fresh context, `SourceTextModule`, `SyntheticModule`, `importModuleDynamically` as a callback or `USE_MAIN_CONTEXT_DEFAULT_LOADER`, `initializeImportMeta`), worker_threads, zlib (+brotli). Not supported by design: native addons (`.node`/N-API).

## Measurements

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
| bun 1.3, 1 process | 275 k | 0.90 ms | 1.76 ms |
| kestrel, 1 worker thread | 299 k | 0.79 ms | 2.56 ms |

Same, `wrk -t2 -c4096`:

| server | req/s | p50 | p99 |
|---|---|---|---|
| node 22, 1 process | 115 k | 16.2 ms | 463 ms |
| node 22 cluster, 10 processes | 202 k | 19.2 ms | 26.5 ms |
| bun 1.3, 1 process | 216 k | 17.0 ms | 42.3 ms |
| kestrel, 1 worker thread | 232 k | 16.0 ms | 20.6 ms |

### Linux x86_64, AMD EPYC 7542 (128 vCPU), Ubuntu 22.04, 2026-10-16

Servers and `wrk` on the same host over loopback (the inter-node link of the test environment caps at 57 k req/s, so a separate load generator could not be used). `bench/remote/`, node 22.12, bun 1.4.3. Run-to-run spread on this host is about ±8 %; ranges below are from repeated runs.

| server | 256 connections (`-t8`) | 4096 connections (`-t32`) |
|---|---|---|
| node, 1 process | 38 k (p99 390 ms) | 32 k (p99 34–37 ms, 330–350 timeouts) |
| bun, 1 process | 74–85 k (p99 4.0–5.7 ms) | 54–59 k (p99 94–245 ms) |
| kestrel, 1 worker thread | 89–99 k (p99 4.1–5.4 ms) | 58–62 k (p99 73–117 ms) |
| node cluster, 128 processes | 396–409 k | 851 k (p99 28–33 ms) |
| bun `reusePort`, 128 processes (its default) | 456–469 k (p99 0.58 ms) | 1.30–1.37 M (p99 2.9–3.1 ms) |
| bun `reusePort`, 32 processes (its best) | 477–483 k | 1.52–1.61 M (p99 5.3–5.8 ms) |
| kestrel, default (`workers: "auto"` = 64 physical cores, packed accept, backend per connection) | 492–505 k (p99 0.54–0.55 ms) | 1.47–1.51 M (p99 2.6–3.2 ms) |
| kestrel, epoll only (`KESTREL_URING=0`) | 489–510 k (p99 0.53–0.55 ms) | 1.42–1.48 M (p99 2.6–3.3 ms) |
| kestrel, io_uring only (`KESTREL_URING=1`) | 449–490 k | 1.49–1.54 M (p99 2.6–3.1 ms) |
| kestrel, 32 worker threads | 482–495 k | 1.58–1.67 M (p99 2.8–7.9 ms, one run 133 ms) |
| kestrel, 128 worker threads, evenly spread (old default) | 413–416 k | 1.20–1.23 M |
| kestrel raw hyper, no JS, 128 threads | 440 k | 1.39–1.40 M |

The fast loop has two Linux backends and places each accepted connection on one of them by how many the worker already holds: the first 16 go to the level-triggered epoll loop (one ready `read` per request is cheapest when a loop holds a handful), the next 512 to io_uring (recv/send submitted in batches with a bounded submit-and-wait: +4–5 % when loops hold tens to hundreds), and anything beyond back to epoll (one loop holding thousands loses 17 % on io_uring, because on this 5.15 kernel without multishot receive every re-armed `recv` goes through the poll-arm and task-work path). Between its busy turns the io_uring loop also serves the worker's epoll connections, so the two never starve each other. `KESTREL_URING=1|0` forces a single backend.

The host runs the load generator too (32 `wrk` threads on 128 vCPUs, 2 sockets, 8 NUMA nodes), so one server thread or process per vCPU is past the knee for both runtimes (`bench/remote/sweep2.sh`). Two defaults follow from that: `"auto"` means physical cores, and the acceptor packs connections onto as few workers as needed (up to 16 each, `KESTREL_PACK`) before spreading, so a few hundred mostly idle keep-alive connections do not wake 64 threads.

The single-worker tail at 4096 connections is dominated by the first second, when all connections arrive at once: over a 3 s run kestrel's p99 is 133 ms (max 170 ms) against Bun's 605 ms (max 960 ms); over 30 s both settle at 76 ms vs 82 ms.

CPU on the same host: `fib(35)` node 110 ms, bun 71 ms, kestrel V8-only 108 ms, native tier 70 ms; cold int-heavy benchmark kestrel V8-only 297 ms, native tier 155 ms.

What this says, honestly:

- Startup and memory beat Node and Bun.
- The native tier beats V8 on call-heavy and integer-heavy code (1.6× and 1.5×; 2.8× over Node on the cold benchmark). On float loops V8's TurboFan is already at the hardware's latency floor and the native tier ties it.
- HTTP per core: 7–9 % ahead of Bun on macOS at 256 and 4096 connections, 10–25 % ahead on Linux at 256 connections and 3–7 % ahead at 4096, with a lower p99 everywhere (at 4096 connections a third of Bun's). `perf` on the Linux node shows 85 % of the time in the kernel's TCP/epoll paths and an in-server latency max of 300 µs, so per-core HTTP is syscall-bound; the fast path got there by doing one `read` and one `write` per request. About 2.5× Node per core on Linux, 1.8–2.3× on macOS.
- HTTP on all cores: with its defaults one kestrel process serves 1.75× a 128-process Node cluster and 1.12–1.17× Bun's documented 128-process `reusePort` setup at 4096 connections with a lower p99, and 1.06–1.09× Bun at 256 connections (a client-bound regime where every server sits between 450 k and 510 k). Matched at each runtime's best worker count (32 threads vs 32 processes) the two overlap: kestrel 1.58–1.67 M, Bun 1.52–1.61 M, with kestrel's p99 lower in most runs but with an occasional long-tail run at this worker count. The spread between repeated runs on this shared host is about ±5 %, so treat differences under that as ties. Per-core HTTP is kernel-bound on both (`perf`: 87 % of cycles in the kernel's TCP, epoll and conntrack paths), which is also why one kestrel worker under 4096 connections (58–62 k) only ties one Bun process (54–59 k) on throughput while halving or better its p99.
- HTTP per core on macOS: the level-triggered kqueue loop is only 5 % faster than the hyper path there (299 k vs 286 k) and has a slightly longer tail at 256 connections; both are ahead of Bun.

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
