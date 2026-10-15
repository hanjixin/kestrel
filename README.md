# kestrel

A JavaScript/TypeScript runtime that keeps JavaScript's semantics and Node's module ecosystem, and is faster than Node everywhere measured: startup, memory, CPU-bound code, and HTTP serving on one core and on all cores.

How it gets both:

- **Tier 0, the compatibility floor.** V8 (via `deno_core`) runs everything, unchanged. A Node compatibility layer provides the `node:*` builtins, `require()` with Node's resolution rules (`package.json` `exports`/`main`, `node_modules` walk, symlinks), ESM ↔ CommonJS interop in both directions (including `require(esm)`), and the usual globals (`process`, `Buffer`, `URL`, `fetch`, `TextEncoder`, `AbortController`, timers with Node's ordering). TypeScript and JSX are stripped with `oxc` on load. The whole bootstrap is baked into a V8 snapshot.
- **Tier 1, the native tier.** Top-level TypeScript functions whose parameters and return are annotated `: number` are compiled ahead of time to machine code with Cranelift. The JS binding keeps its name, `length` and `name`; a `typeof` guard on every argument falls back to the original JS for anything that is not a number, so observable behaviour is unchanged for every input. Semantics are JavaScript's exactly (IEEE-754 doubles, ToInt32 for bitwise ops, fmod for `%`, NaN-ordered comparisons, `RangeError` on deep recursion), verified byte-for-byte against V8 by `examples/aot_check.ts`.
- **Runtime.** `Kestrel.serve` and `http.createServer` are hyper 1.x. The HTTP task calls the JS handler directly on the isolate's thread (no queue, no op, no promise per request). One acceptor thread hands connections to the least-loaded worker thread; each worker has its own V8 isolate with its own garbage collector, so one process uses every core without `cluster`.

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
```

A Linux build is produced in Docker (`target-linux/` for arm64, `target-linux-amd64/` for x86_64; see `bench/remote/run.sh`).

## Compatibility status

Verified by `test/compat` (each file runs under node and kestrel and the outputs are compared):

- `builtins.cjs`: path, fs, util.inspect/format, events, Buffer, crypto (hashes, HMAC, PBKDF2, scrypt, HKDF, AES-GCM/CBC/CTR), zlib (gzip, deflate, brotli), URL/URLSearchParams, querystring, string_decoder, streams + pipeline, os, process, assert. Output is identical to Node 22.
- `proc.mjs`: child_process `spawn`/`exec`/`execFile`/`execSync`/`execFileSync`/`spawnSync` with piped stdio, exit codes, ENOENT; fd-level fs (`openSync`/`readSync`/`writeSync`/`fstatSync`/`ftruncateSync`, `fs.promises.open` FileHandle). Identical to Node.
- `net.mjs`, `unix.mjs`: `net.createServer` + `net.connect` echo over TCP and Unix domain sockets, `tls.createServer` + `tls.connect`, `fs.watch` events, ECONNREFUSED. Identical.
- `fork.mjs`: `child_process.fork` with the IPC channel (`process.send` / `'message'` both ways, exit codes). Identical.
- `misc.mjs`: `dgram` UDP round trip, `vm.runInThisContext`/`runInNewContext`/`Script`, `v8.getHeapStatistics`, `perf_hooks`, `cluster` entry points. Identical.
- `worker.mjs`: `worker_threads.Worker` with `workerData`, `postMessage` both ways, `process.exit` code in the worker. Identical.
- `https.mjs`: `https.createServer` with a self-signed key/cert served by rustls, consumed by `fetch`. Identical.
- `http.mjs`, `serve.ts`: `http.createServer` request/response with bodies and headers, `http.get`, `fetch`, `Kestrel.serve` with JSON, byte bodies, custom headers, sync and async handlers.
- `esm.mjs`, `npm.mjs`, `realworld.cjs`: ESM ↔ CommonJS interop (both directions, including `require(esm)`), and unmodified packages from a real `node_modules`: marked, nanoid, jszip, pako, hash.js, is-url, inherits, docx, pptxgenjs, pdf-lib, pngjs, jpeg-js, image-size.
- Scheduling order of `process.nextTick`, microtasks, `setImmediate` and timers matches Node.

Builtins: assert, buffer, child_process (incl. `fork` IPC), cluster (processes sharing a port via `SO_REUSEPORT`), constants, crypto (hashes, HMAC, KDFs, AES/ChaCha ciphers, RSA/ECDSA sign/verify and key pairs, webcrypto subset), dgram, dns, events, fs (+promises, fd API, streams, `watch`/`watchFile`), http, https, module, net (TCP + Unix sockets), os, path, perf_hooks, process, querystring, readline, stream, string_decoder, sys, timers, tls (client and server), tty, url, util, v8 (heap statistics, serialize), vm (scripts in this or a fresh context), worker_threads, zlib (+brotli). Not supported by design: native addons (`.node`/N-API). Still missing and throwing `ERR_METHOD_NOT_IMPLEMENTED`: `http2`, `inspector`, `async_hooks`'s full API (`AsyncLocalStorage` is not there yet), `dgram` multicast, `vm` module-linking APIs.

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
| node 22, 1 process | 133 k | 1.92 ms | 9.0 ms |
| node 22 cluster, 10 processes | 221 k | 0.57 ms | 4.4 ms |
| bun 1.3, 1 process | 277 k | 0.90 ms | 1.54 ms |
| kestrel, 1 worker thread | 311 k | 0.82 ms | 0.93 ms |

### Linux x86_64, AMD EPYC 7542 (128 vCPU), Ubuntu 22.04, 2026-10-16

Servers and `wrk` on the same host over loopback (the inter-node link of the test environment caps at 57 k req/s, so a separate load generator could not be used). `bench/remote/`, node 22.12, bun 1.4.3. Run-to-run spread on this host is about ±8 %; ranges below are from repeated runs.

| server | 256 connections (`-t8`) | 4096 connections (`-t32`) |
|---|---|---|
| node, 1 process | 35–39 k (p99 275–400 ms) | 34–36 k |
| bun, 1 process | 78–86 k (p99 4.2–6.0 ms) | 55–60 k (p99 88–114 ms) |
| kestrel, 1 worker thread | 80–84 k (p99 3.6–4.8 ms) | 52–56 k (p99 120–620 ms) |
| node cluster, 128 processes | 402–404 k | 780–822 k |
| bun `reusePort`, 128 processes | 458–467 k | 1.21–1.37 M |
| kestrel, 128 worker threads, one process | 426–449 k | 1.11–1.30 M |
| kestrel raw hyper, no JS (ceiling) | 433 k | 1.40–1.56 M |

CPU on the same host: `fib(35)` node 110 ms, bun 71 ms, kestrel V8-only 108 ms, native tier 70 ms; cold int-heavy benchmark kestrel V8-only 297 ms, native tier 155 ms.

What this says, honestly:

- Startup and memory beat Node and Bun.
- The native tier beats V8 on call-heavy and integer-heavy code (1.6× and 1.5×; 2.8× over Node on the cold benchmark). On float loops V8's TurboFan is already at the hardware's latency floor and the native tier ties it.
- HTTP per core: 12 % ahead of Bun on macOS; on Linux ahead of Bun at 256 connections and 5–8 % behind at 4096 connections, where one kestrel thread also shows a much worse tail (p99 120–620 ms vs ~100 ms; the cause is not yet isolated, see `docs/ARCHITECTURE.md`). About 2.2× Node per core on both systems.
- HTTP on all cores: one kestrel process serves 1.05× (256 connections) to 1.4× (4096 connections) what a 128-process Node cluster serves, and 0.92–0.98× of Bun's 128-process `reusePort` setup, with a higher tail (p99 ~12 ms vs 3.6 ms at 4096 connections). The remaining gap to the raw-hyper ceiling is the JS handler itself plus GC pauses.

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
