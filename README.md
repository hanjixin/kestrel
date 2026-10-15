# kestrel

A JavaScript/TypeScript runtime with two execution tiers:

- **Tier 0 — compatibility floor.** V8 (via `deno_core`) runs everything. TypeScript and JSX are stripped with `oxc` on load. The runtime bootstrap is baked into a V8 snapshot, so a process starts in a few milliseconds.
- **Tier 1 — native tier.** Top-level TypeScript functions whose parameters and return are annotated `: number` are compiled ahead of time to machine code with Cranelift. The JS binding keeps its name, `length` and `name`; a guard checks `typeof` on every argument and falls back to the original JS for anything that is not a number. Semantics are JavaScript's (IEEE-754 doubles, ToInt32 for bitwise ops, fmod for `%`, NaN-ordered comparisons, `RangeError` on deep recursion), verified byte-for-byte against V8 in `examples/aot_check.ts`.
- **Runtime.** `Kestrel.serve` is hyper 1.x. One acceptor thread per port hands connections round-robin to worker threads, each with its own V8 isolate and Tokio runtime, so a single process uses every core without `cluster` or `reusePort`.

The name is a placeholder.

## Build and run

```sh
rustup update stable            # needs rustc >= 1.97
cargo build --release
./target/release/kestrel examples/bench_fib.ts
KESTREL_AOT_LOG=1 ./target/release/kestrel examples/aot_check.ts   # show what went native
KESTREL_AOT=0     ./target/release/kestrel examples/aot_check.ts   # V8 only
```

Globals today: `console`, timers, `performance`, a minimal `process`, `Headers`/`Request`/`Response`, `Kestrel.serve({ port, hostname, workers, fetch })`.

## Measurements (Apple M4, 10 cores, 2026-10-15)

Startup, `console.log("hello")` (hyperfine, 40 runs):

| runtime | wall | peak RSS |
|---|---|---|
| node 22.22 | 16.0 ms | 38.7 MiB |
| bun 1.3.11 | 5.8 ms | 20.2 MiB |
| kestrel | 3.7 ms | 13.6 MiB |

CPU, in-program timers (`examples/bench_*.ts`):

| benchmark | node | bun | kestrel V8-only | kestrel AOT |
|---|---|---|---|---|
| `fib(35)` recursive | 49 ms | 58 ms | 50 ms | 30 ms |
| mandelbrot 1200×800×200 (float loops) | 85 ms | 103 ms | 84 ms | 91 ms |
| cold collatz + Leibniz (int-heavy, run once) | 235 ms | 239 ms | 127 ms | 209 ms |

HTTP hello world, three `oha -c 96` load generators on the same machine for 5 s (client and server share the 10 cores, so absolute numbers are client-bound; `bench/http_bench.sh`):

| server | req/s | p50 | p99 |
|---|---|---|---|
| node 22, 1 process | 133 k | 2.08 ms | 4.12 ms |
| node 22 cluster, 10 processes | 197 k | 0.64 ms | 20.3 ms |
| bun 1.3, 1 process | 243 k | 1.12 ms | 2.32 ms |
| kestrel, 1 worker thread | 193 k | 1.42 ms | 2.13 ms |
| kestrel, 10 worker threads | 213 k | 1.05 ms | 10.6 ms |

What this says, honestly:

- Startup and memory beat both Node and Bun today.
- The native tier beats V8 where V8's JIT is weakest for AOT to exploit: call-heavy code (`fib`). On float loops V8's TurboFan is already at the hardware's latency floor and the native tier ties it. On integer-heavy loops the native tier is currently *slower* than V8, because every value is still an f64 while V8 uses int32 arithmetic; see roadmap.
- HTTP single-thread throughput is on par with Bun and about 1.45× Node. Multi-core scaling cannot be demonstrated on one machine with on-box load generators; a separate load box is needed.

## Layout

```
crates/kestrel-cli      the `kestrel` binary
crates/kestrel-engine   V8 host: module loader, TS stripping, bootstrap JS + snapshot, ops, HTTP backend
crates/kestrel-aot      native tier: candidate selection, Cranelift codegen, dispatch table
examples/               correctness suite and CPU benchmarks
bench/                  hello servers for node / bun / kestrel and the HTTP benchmark script
docs/ARCHITECTURE.md    design, invariants, roadmap
```
