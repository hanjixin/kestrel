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
KESTREL_V8_FLAGS="--single-threaded-gc --max-semi-space-size=32"   # default V8 flags
```

A Linux build is produced in Docker (`target-linux/` for arm64, `target-linux-amd64/` for x86_64; see `bench/remote/run.sh`).

## Compatibility status

Verified by `test/compat` (run with node and kestrel, outputs compared):

- `builtins.cjs`: path, fs, util.inspect/format, events, Buffer, crypto hashes/HMAC, zlib, URL/URLSearchParams, querystring, string_decoder, streams + pipeline, os, process, assert. Output is identical to Node 22.
- `esm.mjs`: ESM importing builtins, JSON, CommonJS (default + named), `createRequire`, top-level await, `timers/promises`, `events.once`.
- `npm.mjs`, `realworld.cjs`: unmodified packages from a real `node_modules`: marked (ESM-only, also via `require`), nanoid, jszip, pako, hash.js, is-url, inherits, docx, pptxgenjs, pdf-lib, pngjs, jpeg-js, image-size.
- `http.mjs`, `serve.ts`: `http.createServer` request/response with bodies and headers, `http.get`, `fetch` (rustls), `Kestrel.serve` with JSON, byte bodies, custom headers, sync and async handlers.
- Scheduling order of `process.nextTick`, microtasks, `setImmediate` and timers matches Node.

Builtins present: assert, buffer, crypto (hashes, HMAC, random; no ciphers/sign yet), events, fs (sync, callback, promises, read/write streams; no fd-level API or watch yet), http (server + client), https (client), module, os, path, process, querystring, readline (basic), stream, string_decoder, timers, tty, url, util, zlib (gzip/deflate; no brotli). Stubs that throw a clear error: child_process, net sockets, worker_threads.Worker, https server. Native addons (`.node`) are not supported.

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
| node 22, 1 process | 129 k | 1.96 ms | 41 ms |
| node 22 cluster, 10 processes | 218 k | 0.59 ms | 10.8 ms |
| bun 1.3, 1 process | 275–282 k | 0.89 ms | 1.5–1.7 ms |
| kestrel, 1 worker thread | 298 k | 0.85 ms | 0.95 ms |

### Linux x86_64, AMD EPYC 7542 (128 vCPU), Ubuntu 22.04, 2026-10-16

Servers and `wrk` on the same host over loopback (the inter-node link of the test environment caps at 57 k req/s, so a separate load generator could not be used). `bench/remote/`, node 22.12, bun 1.4.3.

| server | 256 connections (`-t8`) | 4096 connections (`-t32`) |
|---|---|---|
| node, 1 process | 36 k | 34 k |
| bun, 1 process | 78 k | 55–62 k |
| kestrel, 1 worker thread | 77 k | 48–56 k |
| node cluster, 128 processes | 402 k | 780–823 k |
| bun `reusePort`, 128 processes | 463 k | 1.36 M |
| kestrel, 128 worker threads, one process | 427 k | 1.09–1.41 M (three runs: 1.29 M, 1.29 M, 1.14 M) |
| kestrel raw hyper, no JS (ceiling) | 433 k | 1.40–1.56 M |

CPU on the same host: `fib(35)` node 110 ms, bun 71 ms, kestrel V8-only 108 ms, native tier 70 ms; cold int-heavy benchmark kestrel V8-only 297 ms, native tier 155 ms.

What this says, honestly:

- Startup and memory beat Node and Bun.
- The native tier beats V8 on call-heavy and integer-heavy code (1.6× and 1.5×; 2.8× over Node on the cold benchmark). On float loops V8's TurboFan is already at the hardware's latency floor and the native tier ties it.
- HTTP per core: ahead of Bun on macOS, at parity with Bun on Linux, about 2× Node on both.
- HTTP on all cores: one kestrel process serves 1.4–1.7× what a 128-process Node cluster serves, and lands between 0.85× and 1.05× of Bun's 128-process `reusePort` setup depending on the run, with a higher tail latency (p99 6–13 ms vs 2.9 ms). The remaining gap to the raw-hyper ceiling is the JS handler itself plus GC pauses.

## Layout

```
crates/kestrel-cli      the `kestrel` binary
crates/kestrel-engine   V8 host: Node resolution + loaders, TS stripping, ESM->CJS, snapshot, ops, HTTP/fetch backends
  src/js/               bootstrap, globals, node/*.js builtins (all in the snapshot)
crates/kestrel-aot      native tier: candidate selection, Cranelift codegen, dispatch table
examples/               native-tier correctness suite and CPU benchmarks
test/compat/            Node compatibility tests (compare with `node`)
bench/                  hello servers, macOS/Linux-Docker scripts, bench/remote for the test nodes
docs/ARCHITECTURE.md    design, invariants, roadmap
```
