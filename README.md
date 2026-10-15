# kestrel

A JavaScript/TypeScript runtime that keeps JavaScript's semantics and Node's module ecosystem, and is faster than Node where it matters: startup, memory, call-heavy and integer-heavy CPU code, and HTTP serving.

How it gets both:

- **Tier 0, the compatibility floor.** V8 (via `deno_core`) runs everything, unchanged. A Node compatibility layer provides the `node:*` builtins, `require()` with Node's resolution rules (`package.json` `exports`/`main`, `node_modules` walk, symlinks), ESM ↔ CommonJS interop in both directions (including `require(esm)`), and the usual globals (`process`, `Buffer`, `URL`, `fetch`, `TextEncoder`, `AbortController`, timers with Node's ordering). TypeScript and JSX are stripped with `oxc` on load. The whole bootstrap is baked into a V8 snapshot.
- **Tier 1, the native tier.** Top-level TypeScript functions whose parameters and return are annotated `: number` are compiled ahead of time to machine code with Cranelift. The JS binding keeps its name, `length` and `name`; a `typeof` guard on every argument falls back to the original JS for anything that is not a number, so observable behaviour is unchanged for every input. Semantics are JavaScript's exactly (IEEE-754 doubles, ToInt32 for bitwise ops, fmod for `%`, NaN-ordered comparisons, `RangeError` on deep recursion), verified byte-for-byte against V8 by `examples/aot_check.ts`.
- **Runtime.** `Kestrel.serve` and `http.createServer` are hyper 1.x. An acceptor thread hands connections round-robin to worker threads, each with its own V8 isolate and Tokio runtime, so one process uses every core without `cluster`.

The name is a placeholder.

## Build and run

```sh
rustup update stable            # needs rustc >= 1.97
cargo build --release
./target/release/kestrel app.ts            # or .js / .mjs / .cjs
KESTREL_AOT_LOG=1 ./target/release/kestrel examples/aot_check.ts   # show what went native
KESTREL_AOT=0     ./target/release/kestrel examples/aot_check.ts   # V8 only
KESTREL_REQUIRE_LOG=1 ...                                          # trace require()
```

## Compatibility status

Verified by `test/compat` (run with node and kestrel, outputs compared):

- `builtins.cjs`: path, fs, util.inspect/format, events, Buffer, crypto hashes/HMAC, zlib, URL/URLSearchParams, querystring, string_decoder, streams + pipeline, os, process, assert. Output is identical to Node 22.
- `esm.mjs`: ESM importing builtins, JSON, CommonJS (default + named), `createRequire`, top-level await, `timers/promises`, `events.once`.
- `npm.mjs`, `realworld.cjs`: unmodified packages from a real `node_modules`: marked (ESM-only, also via `require`), nanoid, jszip, pako, hash.js, is-url, inherits, docx, pptxgenjs, pdf-lib, pngjs, jpeg-js, image-size.
- `http.mjs`, `serve.ts`: `http.createServer` request/response with bodies and headers, `http.get`, `fetch` (rustls), `Kestrel.serve` with JSON, byte bodies and custom headers.
- Scheduling order of `process.nextTick`, microtasks, `setImmediate` and timers matches Node.

Builtins present: assert, buffer, crypto (hashes, HMAC, random; no ciphers/sign yet), events, fs (sync, callback, promises, read/write streams; no fd-level API or watch yet), http (server + client), https (client), module, os, path, process, querystring, readline (basic), stream, string_decoder, timers, tty, url, util, zlib (gzip/deflate; no brotli). Stubs that throw a clear error: child_process, net sockets, worker_threads.Worker, https server. Native addons (`.node`) are not supported.

## Measurements

Apple M4 (10 cores), 2026-10-16, release build. Startup, `console.log("hello")` (hyperfine, 20 runs):

| runtime | wall | peak RSS |
|---|---|---|
| node 22.22 | 15.9 ms | 38.7 MiB |
| bun 1.3.11 | 5.7 ms | 20.2 MiB |
| kestrel | 4.7 ms | 16.9 MiB |

CPU, in-program timers (`examples/bench_*.ts`):

| benchmark | node | bun | kestrel V8-only | kestrel native tier |
|---|---|---|---|---|
| `fib(35)` recursive | 49 ms | 58 ms | 48 ms | 30 ms |
| cold collatz + Leibniz (int-heavy, run once) | 235 ms | 239 ms | 127 ms | 85 ms |
| mandelbrot 1200×800×200 (float loops) | 85 ms | 103 ms | 84 ms | 91 ms |

HTTP hello world on macOS, `wrk -t2 -c256`, 5 s, client and server on the same machine (`bench/http_wrk.sh`):

| server | req/s | p50 | p99 |
|---|---|---|---|
| node 22, 1 process | 131 k | 1.94 ms | 49.6 ms |
| node 22 cluster, 10 processes | 223 k | 0.57 ms | 6.05 ms |
| bun 1.3, 1 process | 276 k | 0.91 ms | 1.16 ms |
| kestrel, 1 worker thread | 298 k | 0.86 ms | 1.06 ms |

HTTP hello world on Linux arm64 (Docker, 10 vCPU, `wrk -t2 -c256`, 5 s; `bench/linux_bench.sh`, `bench/linux_baseline.sh`):

| server | req/s |
|---|---|
| node 22.23, 1 process | 145 k |
| node cluster, all cores | 380 k |
| bun 1.4, 1 process | 505 k |
| kestrel, 1 worker (256 conns) | 123 k |
| kestrel, 1 worker (64 conns) | 219 k |
| kestrel, 2 workers | 222 k |
| kestrel, 4 workers | 252 k |
| kestrel, all cores | 261 k |

What this says, honestly:

- Startup and memory beat Node and Bun.
- The native tier beats V8 on call-heavy and integer-heavy code (1.6× and 1.5×; 2.8× over Node on the cold benchmark). On float loops V8's TurboFan is already at the hardware's latency floor and the native tier ties it.
- On macOS a single kestrel thread serves more requests than Bun and 2.3× Node. On Linux kestrel beats Node per core but is well behind Bun, and its throughput drops as the number of concurrent connections grows (p99 rises to ~100 ms at 256 connections). Worker threads scale (1.8× at 2 workers) until the on-box load generator saturates. The Linux connection-count degradation is the top open performance issue; see `docs/ARCHITECTURE.md`.

## Layout

```
crates/kestrel-cli      the `kestrel` binary
crates/kestrel-engine   V8 host: Node resolution + loaders, TS stripping, ESM->CJS, snapshot, ops, HTTP/fetch backends
  src/js/               bootstrap, globals, node/*.js builtins (all in the snapshot)
crates/kestrel-aot      native tier: candidate selection, Cranelift codegen, dispatch table
examples/               native-tier correctness suite and CPU benchmarks
test/compat/            Node compatibility tests (compare with `node`)
bench/                  hello servers and benchmark scripts (macOS and Linux/Docker)
docs/ARCHITECTURE.md    design, invariants, roadmap
```
