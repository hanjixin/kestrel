# Next.js production build comparison — 2026-10-18

All three runtimes completed the same Next.js production build, including compilation, static generation, build tracing and standalone packaging. Each resulting standalone server successfully served the expected page and all five referenced script assets using the same runtime that built it. Observed process commands confirm Bun and Kestrel also ran their own jest-worker child processes; they did not fall back to Node.

## Environment and workload

- Apple M4, macOS 26.3, arm64.
- Next.js 15.5.28; React / React DOM 18.3.1, identical package lock and installed dependency copies.
- Node v25.6.1; Bun 1.3.11; Kestrel SHA-256 `1c8f129b01cea512f9e553adf633089e476c9cba9d6254ec6e5f24c55e433388`.
- Minimal App Router project: one page with a heading and a rendered list; `output: "standalone"`. The fixture is in `bench/next_app`.
- Commands directly invoke `node_modules/next/dist/bin/next build` with each runtime; Bun uses `--bun`.
- Three isolated app copies, identical dependency lock, no installation time included. `.next` is deleted before every build. OS filesystem cache and dependencies are retained.
- Three rounds, ordered Node/Bun/Kestrel, Bun/Kestrel/Node, Kestrel/Node/Bun. Builds are sequential with no concurrent benchmark or build. Telemetry disabled; `NODE_ENV=production`, `CI=1` for all.
- Build duration is wall-clock time around the subprocess. Artifact startup and HTTP validation are excluded.

## Results

Medians of three builds:

| Runtime | Build time | Sampled process-group peak RSS | Successful builds | Successful artifact checks |
|---|---:|---:|---:|---:|
| kestrel | 8.628 s | 867.28 MiB | 3/3 | 3/3 |
| bun | 9.086 s | 1398.84 MiB | 3/3 | 3/3 |
| node | 9.708 s | 1303.81 MiB | 3/3 | 3/3 |

Kestrel's median elapsed time is 5.0% lower than Bun and 11.1% lower than Node in this workload. Peak process-group RSS is 38.0% lower than Bun and 33.5% lower than Node. RSS is summed across the build process group approximately every 100 ms, includes child processes and the small time wrapper, can double-count shared pages, and can miss brief peaks. It is not unique physical memory. Raw `/usr/bin/time -l` statistics are also retained in each log and in results.json.

Every sample:

| Runtime | Round | Build time | Sampled process-group peak RSS |
|---|---:|---:|---:|
| node | 1 | 15.249 s | 1303.81 MiB |
| bun | 1 | 13.259 s | 1417.14 MiB |
| kestrel | 1 | 12.816 s | 884.08 MiB |
| bun | 2 | 8.472 s | 1398.84 MiB |
| kestrel | 2 | 8.333 s | 867.28 MiB |
| node | 2 | 9.704 s | 1308.92 MiB |
| kestrel | 3 | 8.628 s | 855.25 MiB |
| node | 3 | 9.708 s | 1269.58 MiB |
| bun | 3 | 9.086 s | 1358.58 MiB |

The first build for every runtime was noticeably slower. Clearing `.next` does not clear OS caches. Kestrel completed faster than Bun and Node in each numbered round, but three rounds on a tiny project do not establish a statistically robust advantage or predict large application builds.

Build logs show the same page and not-found routes and approximately 103 kB shared first-load JavaScript. Standalone output is approximately 47.7 MiB on all three runtimes. Build identifiers and embedded paths differ, so byte-for-byte artifact equality was not required. Validation covers HTTP page content and script availability, not browser hydration, dynamic server routes or a large application's full behavior. This does not compare webpack versus Turbopack versus another bundler; it compares the three runtimes executing the same Next.js build configuration.

## Reproduction

Prepare three copies of `bench/next_app` with dependencies installed from its package-lock.json, named `node`, `bun`, `kestrel` inside one workspace directory. Dependency installation is outside the timer. Then run:

```sh
python3 bench/next_build.py \
  --workspace /absolute/path/to/prepared-apps \
  --kestrel /absolute/path/to/kestrel \
  --output /tmp/next-build-comparison \
  --rounds 3 --timeout 120
```

The runner currently targets macOS (`/usr/bin/time -l`, process-group RSS in KiB). It stops and kills its own process group on timeout; failed builds are excluded from timing medians. The report records commands, runtime versions, the lockfile hash, every sample, build logs and server logs. The original Next fixture and preexisting build output were left intact.
