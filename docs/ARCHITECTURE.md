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

Not yet present: `node:*` built-ins, CommonJS, `node_modules` resolution, `fetch`, streams, workers API, `fs`. These are the compatibility backlog and are pure engineering; none conflicts with the design.

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
- Requests cross into JS as `"id\0METHOD\0uri"` through an async op; headers are fetched lazily; the handler's `Response` goes back through a sync op into a oneshot. Handlers that return promises do not block the accept loop.
- One blocking acceptor thread per bound address distributes connections round-robin to worker runtimes. macOS `SO_REUSEPORT` does not balance across sockets, which is why per-thread listeners were replaced with the hub. `workers: "auto"` spawns one isolate per core; `Kestrel.workerId` identifies them.

Backlog: request bodies, response byte bodies and arbitrary headers, HTTP/2, TLS, `fetch` client, graceful shutdown.

## Roadmap, in order of payoff

1. **int32 lattice in the native tier.** Infer integer-ness of locals (int literal init, int-preserving updates with overflow checks that branch to a float clone of the loop). This is where V8 currently wins on integer loops and the remaining large CPU gap.
2. **Typed arrays and `ArrayBuffer`** as raw pointers from V8 backing stores: zero-copy numeric kernels, the common case for real CPU-bound JS.
3. **Objects with stable shapes** as structs, speculated from annotations (`interface`) and guarded at the boundary.
4. **Node compatibility layer**: `node:` builtins, CJS, `node_modules` resolution, `fetch`. Reuse existing Rust implementations where licences allow.
5. **`kestrel build`**: emit a single binary with a V8 code cache plus the native tier linked in via `cranelift-object`.
6. **Per-isolate native state** (stack limit, overflow flag, dispatch table) so the native tier is safe under worker threads; today those are process globals used from the JS thread only.
