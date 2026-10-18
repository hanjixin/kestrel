//! Tier 0: full-compatibility execution on V8 (via deno_core).

use std::path::Path;
use std::rc::Rc;

use anyhow::{Context, Result};
use deno_core::{resolve_path, JsRuntime, PollEventLoopOptions, RuntimeOptions};

use crate::loader::KestrelModuleLoader;
use crate::ops;

static SNAPSHOT: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/KESTREL_SNAPSHOT.bin"));

pub struct Runtime {
    js: JsRuntime,
}

impl Runtime {
    pub fn new() -> Self {
        kestrel_aot::registry::init_thread();
        // Young generation per isolate: the main isolate gets a large one (fewer scavenges,
        // lower tail latency under thousands of connections); worker isolates get a small,
        // cache-resident one, because 128 of them sharing 32 MB semi-spaces thrash memory
        // (measured: 1.02 M -> 1.30 M req/s on a 128-core host).
        let mb = 1024 * 1024;
        let young = if crate::httpimpl::worker_id() == 0 { 3 * 32 * mb } else { 3 * 8 * mb };
        let young = std::env::var("KESTREL_YOUNG_MB").ok().and_then(|v| v.parse::<usize>().ok()).map(|m| 3 * m * mb).unwrap_or(young);
        let params = deno_core::v8::CreateParams::default().set_max_young_generation_size_in_bytes(young);
        let mut js = JsRuntime::new(RuntimeOptions {
            module_loader: Some(Rc::new(KestrelModuleLoader)),
            extensions: vec![ops::kestrel::init(), kestrel_napi::deno_napi::init()],
            startup_snapshot: Some(SNAPSHOT),
            create_params: Some(params),
            // In-process `node:inspector` sessions (CDP over deno_core's local session).
            inspector: true,
            is_main: crate::httpimpl::worker_id() == 0,
            ..Default::default()
        });
        js.op_state().borrow_mut().put(crate::netimpl::InspectorHandle(js.inspector()));
        // Let the HTTP backend call into this isolate directly from its tasks.
        let context = js.main_context();
        let state = js.op_state();
        {
            let iso: &deno_core::v8::Isolate = js.v8_isolate();
            crate::httpimpl::init_thread_isolate(iso, context, state);
        }
        Self { js }
    }

    fn init_process(&mut self, argv: &[String]) -> Result<()> {
        let env: Vec<(String, String)> = std::env::vars().collect();
        let argv_json = serde_json::to_string(argv)?;
        let env_json = serde_json::to_string(&env.into_iter().collect::<std::collections::HashMap<_, _>>())?;
        // deno_core needs Deno while restoring the snapshot; hide it only after
        // initialization, before any user module can detect it as a Deno runtime.
        let script = format!(
            "delete globalThis.Deno; globalThis.__kestrel_init({argv_json}, {env_json}, {platform:?}, {pid});",
            platform = crate::nodeimpl::node_platform(),
            pid = std::process::id(),
        );
        self.js.execute_script("ext:kestrel/init", script)?;
        Ok(())
    }

    /// Load and run `path` as the main ES module, then drain the event loop.
    pub async fn run_main(&mut self, path: &Path, argv: &[String]) -> Result<i32> {
        self.init_process(argv)?;
        let cwd = std::env::current_dir().context("cwd")?;
        let spec = resolve_path(&path.to_string_lossy(), &cwd)?;
        let id = self.js.load_main_es_module(&spec).await?;
        let evaluated = self.js.mod_evaluate(id);
        self.js
            .run_event_loop(PollEventLoopOptions::default())
            .await?;
        evaluated.await?;

        // Read process.exitCode.
        let code = {
            let v = self.js.execute_script("ext:kestrel/exit", "globalThis.process.exitCode | 0")?;
            deno_core::scope!(scope, &mut self.js);
            let local = deno_core::v8::Local::new(scope, v);
            local.int32_value(scope).unwrap_or(0)
        };
        Ok(code)
    }
}

impl Default for Runtime {
    fn default() -> Self {
        Self::new()
    }
}

/// Convenience: run a file to completion on a fresh current-thread Tokio runtime.
static V8_INIT: std::sync::Once = std::sync::Once::new();

/// Process-wide V8 setup. Young-generation sizing is per isolate (see `Runtime::new`);
/// KESTREL_V8_FLAGS adds raw V8 flags.
fn init_v8_once() {
    V8_INIT.call_once(|| {
        // Start external-memory collection before short I/O jobs accumulate
        // hundreds of MiB of dead ArrayBuffers. This sets the initial collection
        // budget, not the maximum heap size; V8 still grows with the live set.
        // Respect either user-specified initial-size flag: V8 prioritizes the
        // old-space flag over initial-heap-size regardless of argument order.
        let user_flags = std::env::var("KESTREL_V8_FLAGS").unwrap_or_default();
        let initial_size_set = user_flags.split_whitespace().any(|flag| matches!(
            flag.split('=').next(),
            Some("--initial-old-space-size" | "--initial_old_space_size" | "--initial-heap-size" | "--initial_heap_size")
        ));
        let flags = if initial_size_set { user_flags } else { format!("--initial-old-space-size=32 {user_flags}") };
        deno_core::v8::V8::set_flags_from_string(&flags);
        deno_core::JsRuntime::init_platform(None);
    });
}

/// Like `run_file`, but publishes the isolate's thread-safe handle (so a parent thread can
/// terminate a worker) before running the module.
pub fn run_file_with_isolate_handle(path: &Path, argv: &[String], handle: std::sync::Arc<std::sync::Mutex<Option<deno_core::v8::IsolateHandle>>>) -> Result<i32> {
    init_v8_once();
    let _ = crate::httpimpl::MAIN.set((path.to_path_buf(), argv.to_vec()));
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .max_io_events_per_tick(8192)
        .event_interval(255)
        .build()?;
    rt.block_on(async {
        let mut r = Runtime::new();
        *handle.lock().unwrap() = Some(r.js.v8_isolate().thread_safe_handle());
        let code = r.run_main(path, argv).await;
        match code {
            Ok(c) => Ok(c),
            // Termination requested by the parent (or worker-side exit): not an error to report.
            Err(e) if e.to_string().contains("execution terminated") || e.to_string().contains("Uncaught (in promise) Error: execution terminated") => Ok(0),
            Err(e) => {
                eprintln!("{e}");
                Ok(1)
            }
        }
    })
}

pub fn run_file(path: &Path, argv: &[String]) -> Result<i32> {
    init_v8_once();
    let _ = crate::httpimpl::MAIN.set((path.to_path_buf(), argv.to_vec()));
    // `--inspect[-brk]=[host:]port` from the CLI.
    let inspect = std::env::var("KESTREL_INSPECT").ok();
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .max_io_events_per_tick(8192)
        .event_interval(255)
        .build()?;
    rt.block_on(async {
        let mut r = Runtime::new();
        if let Some(spec) = inspect {
            let (brk, addr) = match spec.strip_prefix("brk,") { Some(a) => (true, a), None => (false, spec.as_str()) };
            let (host, port) = match addr.rsplit_once(':') { Some((h, p)) => (h.to_string(), p.parse().unwrap_or(9229)), None => ("127.0.0.1".to_string(), addr.parse().unwrap_or(9229)) };
            let main = std::fs::canonicalize(path).unwrap_or(path.to_path_buf()).to_string_lossy().to_string();
            match crate::inspect_server::open(r.js.inspector(), if host.is_empty() { "127.0.0.1" } else { &host }, port, &main) {
                Ok(_) => {
                    if brk {
                        r.js.inspector().wait_for_session_and_break_on_next_statement();
                    }
                }
                Err(e) => eprintln!("Starting inspector on {host}:{port} failed: {e}"),
            }
        }
        r.run_main(path, argv).await
    })
}
