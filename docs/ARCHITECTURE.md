# Architecture

## Goal and the constraint it imposes

Two requirements at once: run existing JavaScript unchanged, and be faster than Node and Bun. The second cannot be bought by inventing a language, because the first forbids changing semantics. So the design is **speculative ahead-of-time compilation with guards**: whatever can be proven to have fixed types is compiled to native code, everything else runs on V8, and the boundary between the two is a guard that preserves observable behaviour for every input.

This is the same bet a JIT makes, moved to load time. The difference from V8's own JIT is where the wins come from:

1. **No warm-up.** Native code is fast on the first call; V8 interprets, then baseline-compiles, then optimises. Short-lived processes and cold code paths benefit.
2. **No deoptimisation cliffs.** Native code never bails to the interpreter; a guard failure routes one call to the JS version and nothing else changes.
3. **Engine-free startup.** The bootstrap is a V8 snapshot, and the native tier adds nothing at startup beyond the Cranelift compile of accepted functions, which is sub-millisecond for typical modules.
4. **Threads, not processes.** The I/O runtime is Rust; workers are threads with separate isolates in one process, sharing the listener.

## Tier 0: V8 host (`kestrel-engine`)

- `JsRuntime` from `deno_core` with a startup snapshot built in `build.rs` (`src/js/bootstrap.js` plus all ops). Extension JS is only reachable through the snapshot, so ops referenced by the bootstrap must exist at snapshot time; `build.rs` includes `src/ops.rs` with stub `bridge` and `httpimpl` modules for that reason.
- `loader.rs` resolves `file://` ESM with extension probing and strips TS/JSX via `transpile.rs` (`oxc_parser` → `oxc_semantic` → `oxc_transformer` → `oxc_codegen`, type erasure only).
- Bootstrap provides `console` (Node-style inspection), timers on deno_core's timer wheel, `performance`, a minimal `process`, `Headers`/`Request`/`Response`, and `Kestrel.serve`.

### Node compatibility layer

- **Resolution** (`resolve.rs`, shared by the ESM loader and `require`): builtins, relative/absolute paths with extension probing, directories via `package.json`, bare specifiers by walking `node_modules` with `exports` (conditions `node`/`import`|`require`/`default`, subpath patterns) then `module`/`main`. Resolved files are canonicalised so symlinked packages and `./a/../a` spellings share one cache entry.
- **Formats**: `.mjs`/`.cjs` by extension, `.js` by the nearest `package.json` `type`, with an ESM-syntax sniff for loose files. ESM imports a CommonJS file through a generated shim (`default` = `module.exports`, named exports detected by a small lexer). `require()` of an ES module rewrites it to CommonJS with `esm2cjs.rs` (imports → `require`, exports → live getters, `import.meta` → object), matching Node 22's `require(esm)`.
- **Builtins** are ES modules in the snapshot (`src/js/node/*.js`). User code resolves `node:fs` to the `node:fs` specifier and `load()` emits `export * from "ext:kestrel/node/fs.js"`, because deno_core refuses `ext:` imports from user modules. `require("fs")` gets the same module object through a registry filled by the bootstrap.
- **Globals** (`globals.js`, evaluated before any builtin): `process` (argv/env/exit/nextTick/hrtime/stdio/...), `console`, timers (`setImmediate` and `nextTick` ride deno_core's own queues, so ordering matches Node), `performance`, `TextEncoder`/`TextDecoder`, `URL`, `Event`/`EventTarget`/`AbortController`, `structuredClone`; then `Buffer`, `fetch`/`Headers`/`Request`/`Response`/`FormData`, `crypto`, `require`.
- **Snapshot rule**: anything computed while the bootstrap evaluates is frozen into the snapshot. Environment, TTY state, time origin, cwd and the worker id are therefore read lazily or filled in by `__kestrel_init` right before the main module runs.
- **Legacy patterns**: `EventEmitter` and the stream classes are function constructors with prototype methods so `EventEmitter.call(this)` + `util.inherits` code works.

- **Processes, sockets, threads** (`procimpl.rs`, `netimpl.rs`): child processes on `tokio::process` with piped stdio read by async ops (sync variants use `std::process` with drain threads); TCP sockets as split read/write halves in a per-isolate table (the half in use is taken out of the table across the await, so reads and writes never contend); TLS clients via rustls; `worker_threads.Worker` is a second `Runtime` on its own thread whose isolate handle the parent keeps for `terminate()`, with a JSON message channel (typed arrays, Map/Set/Date/Error encoded) and worker-side `process.exit` implemented as `terminate_execution` on its own isolate. `https.createServer` and `Kestrel.serve({ tls })` terminate TLS in the connection task with `tokio-rustls` before hyper sees the stream.

- **Later additions** (`procimpl.rs`, `netimpl.rs`, `watchimpl.rs`): `fs.watch` on the `notify` crate (inotify/FSEvents); Unix-domain sockets and `tls.createServer` through the same boxed-halves socket table (`op_tls_accept` upgrades an accepted TCP connection); `fork` passes one end of a unix socketpair as `KESTREL_IPC_FD` and both sides speak JSON lines (`process.send`/`'message'`); `dgram` on `tokio::net::UdpSocket`; `vm.runInThisContext`/`runInNewContext` compile real V8 scripts (a fresh `v8::Context` seeded from the sandbox object, properties copied back afterwards); `v8.getHeapStatistics` from the isolate; `cluster` forks processes that bind with `SO_REUSEPORT` (`KESTREL_REUSEPORT`); RSA/ECDSA via the `rsa`/`p256` crates.

Not supported by design: native addons (N-API). Backlog: `http2`, `inspector`, `AsyncLocalStorage`, dgram multicast, vm module-linking APIs.

## Tier 1: native tier (`kestrel-aot`)

Pipeline per TypeScript module, run inside the module loader before stripping:

1. **Parse** with `oxc` (types intact).
2. **Select candidates**: top-level `function` declarations (exported or not) where every parameter and the return are annotated `: number`, no rest/optional/default params, body ends on a return on every path, and the binding is never reassigned anywhere in the module.
3. **Compile** with Cranelift. Supported today: numeric literals, locals (`let`/`const`), arithmetic, comparisons, bitwise and shift operators, `&&`/`||`/`!` on booleans, ternary, compound assignment, `++`/`--`, `if`/`while`/`do`/`for`/`break`/`continue`, calls to other accepted functions (including mutual recursion), and `Math.{floor,ceil,trunc,round,abs,sqrt,min,max,pow,sin,cos,tan,atan,atan2,exp,log,log2,log10}`. Anything else rejects the function.
4. **Fixpoint**: a function that calls a rejected function is itself rejected; compilation repeats on the reduced set until a round has no failures. Rejections are reported with reasons under `KESTREL_AOT_LOG=1`.
5. **Rewrite** the source: the original is renamed to `__kestrel_js_<name>`; a wrapper with the original name and `export` status is appended:

   ```js
   function fib(n) {
     if (typeof n === "number") return __kestrel_ops.op_kestrel_call1(0, n);
     return __kestrel_js_fib(n);
   }
   ```

   Wrappers are hoisted function declarations, so hoisting semantics are preserved. The ops binding is prepended as the module's first statement (after a shebang).

### Semantic invariants the codegen keeps

- Every `number` is an f64; arithmetic is IEEE-754, identical to V8.
- Comparisons use ordered float conditions (NaN compares false), `!=`/`!==` is unordered-or-not-equal.
- Bitwise operators go through ECMAScript ToInt32: inline `fcvt_to_sint_sat`+`ireduce` when |x| < 2^63, a helper for the modular case beyond that. `>>>` yields ToUint32.
- `%` uses an inline integer fast path (both operands integral, |x| < 2^53, divisor non-zero) with the dividend's sign copied onto the result so `-4 % 2` is `-0`; otherwise `fmod`.
- `x / 2^k` is strength-reduced to `x * 2^-k` (exact).
- Truthiness of a number in boolean position is `x != 0` ordered, so NaN is falsy.
- Native recursion depth: every function prologue compares SP with a per-thread stack limit. On failure it sets an overflow flag, pins the limit to `usize::MAX` so every frame above bails in O(depth), and returns NaN; the op then throws `RangeError: Maximum call stack size exceeded`, like V8.

### Dispatch

Native code is reached through `#[op2(fast)]` ops `op_kestrel_call0..6` that index a thread-local table of function pointers. V8 inlines fast-API ops in optimised code, so the boundary costs tens of nanoseconds. Accepted functions call each other directly, never through JS.

## Runtime: `Kestrel.serve`

- hyper 1.x HTTP/1.1 with keep-alive, on each worker's own current-thread Tokio runtime.
- **Direct mode.** The hyper task calls the JS handler synchronously: at startup the runtime hands the HTTP backend a copy of its `v8::Isolate` handle, the main context and the op state; `Kestrel.serve` registers a JS trampoline `(id) => [status, headersFlat, body] | undefined`. For each request the task stores the request parts in a per-thread table, opens a handle scope on the isolate (it runs on the isolate's thread, between polls of the event loop, so no other scope is active), calls the trampoline, and builds the response from the returned array. There is no queue, no op dispatch and no promise per request on this path. A handler that returns a promise gets `undefined` back from the trampoline; the task then arms a oneshot and the `respond` op completes it. Handlers that settle inside the trampoline's microtask checkpoint are caught by an `answered`/`early` pair of flags on the pending slot. `Request.url`/`method`/`headers` are read from the native table on first access, so a handler that ignores them pays nothing.
- **Fast path (`fastpath.rs`).** `perf` on the Linux node showed 85 % of a worker's time in the kernel and an in-server latency p99 of 3 µs: per-core HTTP is bound by syscalls per request. hyper on Tokio's edge-triggered readiness costs `read`, `writev`, then a `read` that returns EAGAIN, per request. Each worker therefore runs its own level-triggered `epoll`/`kqueue` loop (the `polling` crate, driven from Tokio through an `AsyncFd` on the poller's fd): one `read`, parse with `httparse`, call the JS trampoline, one `write`. Pipelining and keep-alive are handled; partial writes arm writable interest. Requests with a body, `Expect`, `Upgrade`, `CONNECT`, or on TLS connections, are handed to hyper together with the bytes already read (a small prefixed-stream wrapper), so semantics are unchanged. Request parts are materialised from the raw header block only when the handler reads `url`/`method`/`headers`. `KESTREL_FASTPATH=0` disables it.
- **io_uring backend (`uring.rs`, Linux; default with 4+ workers, `KESTREL_URING=1|0` forces).** Same request handling, but reads and writes are `recv`/`send` SQEs submitted together, one `io_uring_enter` per batch; the ring fd sits in Tokio's epoll with read interest so the worker's runtime keeps driving timers and channels. Invariants: an SQE only points into a connection's `rbuf` or `sending` (heap, never resized while in flight) and a connection is freed only with nothing in flight; a pending send defers a hyper hand-over. On a 5.15 kernel (no multishot receive) each re-armed `recv` on an idle socket costs a poll-arm plus task-work completion, which is why it wins only when many workers each hold few connections; with multishot receive (6.0+) the re-arm disappears and the balance should tip.
- **External debugger (`inspect_server.rs`).** `--inspect[-brk]` and `inspector.open()` start a thread with a plain TCP listener: `/json/list` and `/json/version` for discovery, and a WebSocket (minimal RFC 6455) per client bridged onto `deno_core`'s inspector session proxy, so Debugger pauses work (the inspector pumps the proxy channels inside V8's pause loop). `Protocol-Version` is reported as Node does ("1.1").
- **Node-API (`crates/kestrel-napi`).** deno_napi 0.190.0 vendored (same deno_core version), with `deno_permissions`/`denort_helper` removed and the Node version constant inlined. The CLI's build script passes the platform's symbol export list to the linker so `.node` files resolve `napi_*`/`uv_*` from the `kestrel` binary; `node:module` routes `.node` to `op_napi_open` with Buffer construction, `uncaughtException` reporting and no-op async_hooks callbacks. CommonJS modules are compiled as scripts whose origin is the real file (not a `Function` with a `sourceURL` comment), because `bindings` and friends read file names from `Error.prepareStackTrace` call sites. `KESTREL_NAPI_LOG=1` traces N-API and uv entry points, reference lookups and thrown errors; that is how the node-sqlite3 case was found (its own `inherits` copies `EventEmitter.prototype` with `for…in`, so the methods must be enumerable, as Node's are).
- **One handler per server.** Every `Kestrel.serve`/`createServer` call gets a server id; the acceptor channel, the fast loop's connections (`Conn.rid`), hyper's service closure and the JS trampoline are all keyed by it, so several servers in one process (or one thread) dispatch to their own handlers. Port 0 is bound once per `(ip, n-th ephemeral listen)` and worker threads join that listener.
- **macOS.** Registering the kqueue fd in Tokio's kqueue with the default read+write interest fails with `EINVAL`; the loop registers with read interest only. A failed start must not leave the thread-local set, or later `start()` calls report success and adopted connections are never served.
- **Scheduling inside the fast loop.** Two things went wrong in the first version and both showed up only as tail latency. (1) A level-triggered set of thousands of keep-alive connections is never empty under load, so a loop that "drains until the poller is empty" never returns to Tokio: timers, async-handler completions and newly accepted connections starved. The loop now serves at most two batches (`DRAIN_BUDGET`) per turn and yields. (2) Accepted connections used to arrive through a separate task woken from the acceptor thread; such a wake lands on Tokio's inject queue, which the current-thread scheduler consults only every 31 ticks (`global_queue_interval`), and with the fast task always in the local queue that meant up to a second before a new connection was registered. The loop now owns the connection receivers (`Fast::rxs`) and drains them itself on every turn. Before these fixes a 4096-connection `wrk` run served only ~500 connections (the rest never got registered within the run), which made its p50 look excellent and produced the timeouts; Little's law (concurrency = throughput × latency) is the quick check for this class of bug.
- **Workers.** `workers: "auto"` spawns one isolate per core; `Kestrel.workerId` identifies them. One blocking acceptor thread per bound address waits (up to 3 s) for the expected workers to join, then assigns each accepted connection to the worker with the fewest live connections (round-robin pinned all early connections to whichever worker booted first, and macOS `SO_REUSEPORT` does not balance at all).
- **GC sizing per isolate.** The main isolate gets a 32 MB semi-space young generation (fewer scavenges and a lower tail under thousands of connections); worker isolates get 8 MB, because 128 isolates each touching 32 MB semi-spaces thrash caches and memory bandwidth (measured on the 128-core node: 1.02 M → 1.30 M req/s). Set through `v8::CreateParams::set_max_young_generation_size_in_bytes`, overridable with `KESTREL_YOUNG_MB`; raw flags via `KESTREL_V8_FLAGS`.
- `http.createServer` is an adapter over the same backend (`IncomingMessage`/`ServerResponse` on top of the stream classes); `http.request`, `https.request` and `fetch` share a reqwest client with rustls.

**Measurement notes.** Linux numbers taken inside Docker Desktop's VM were invalid: `perf` showed 75 % of CPU in the kernel's page-fault and zram-swap paths (the 8 GB VM was swapping). Real Linux measurements are taken on the the test nodes (`bench/remote/`: 128-vCPU EPYC 7542; the inter-node link caps at ~57 k req/s, so servers and `wrk` share one node over loopback). `KESTREL_HTTP_RAW=1` makes hyper answer without entering JS and isolates the hand-off cost; `KESTREL_HTTP_STATS=1` prints in-server latency percentiles per worker. hyper's `pipeline_flush` was removed: it defers flushing until the read side is idle, which cost milliseconds per request for non-pipelined clients.

**Where the remaining time goes.** On 128 cores kestrel lands within 0.92–0.98× of Bun's 128-process `reusePort` cluster and 1.05–1.4× of a Node cluster, with a higher p99 (~12 ms vs 3.6 ms). The raw-hyper ceiling is ~10–20 % above; the rest is the JS handler itself (object allocation per request) and GC. **Open:** one worker under 4096 keep-alive connections shows a p99 between 120 and 620 ms run to run (Bun ~100 ms); `--min/max-semi-space-size` experiments moved it but not consistently, so the cause (GC vs. Tokio scheduling fairness with thousands of ready tasks) is still to be isolated with `perf` on the test node (`bench/remote/diag2.sh`).

Backlog: HTTP/2, TLS termination, graceful shutdown, streaming bodies.

## Roadmap, in order of payoff

1. **int32 lattice in the native tier.** Infer integer-ness of locals (int literal init, int-preserving updates with overflow checks that branch to a float clone of the loop). This is where V8 currently wins on integer loops and the remaining large CPU gap.
2. **Typed arrays and `ArrayBuffer`** as raw pointers from V8 backing stores: zero-copy numeric kernels, the common case for real CPU-bound JS.
3. **Objects with stable shapes** as structs, speculated from annotations (`interface`) and guarded at the boundary.
4. **HTTP tail latency**: per-request allocation in the JS path (reuse Request/Response shells), GC tuning per worker, and a dedicated load-generator host for the test environment.
5. **`kestrel build`**: emit a single binary with a V8 code cache plus the native tier linked in via `cranelift-object`.
6. **Per-isolate native state** (stack limit, overflow flag, dispatch table) so the native tier is safe under worker threads; today those are process globals used from the JS thread only.
