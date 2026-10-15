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
        let mut js = JsRuntime::new(RuntimeOptions {
            module_loader: Some(Rc::new(KestrelModuleLoader)),
            extensions: vec![ops::kestrel::init()],
            startup_snapshot: Some(SNAPSHOT),
            ..Default::default()
        });
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
        let script = format!(
            "globalThis.__kestrel_init({argv_json}, {env_json}, {platform:?}, {pid});",
            platform = std::env::consts::OS,
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

/// Process-wide V8 setup. Every worker thread runs its own isolate, so GC must not be
/// funnelled through V8's shared background worker pool. KESTREL_V8_FLAGS overrides.
fn init_v8_once() {
    V8_INIT.call_once(|| {
        let flags = std::env::var("KESTREL_V8_FLAGS").unwrap_or_else(|_| "--single-threaded-gc --max-semi-space-size=32".to_string());
        if !flags.trim().is_empty() {
            deno_core::v8::V8::set_flags_from_string(&flags);
        }
        deno_core::JsRuntime::init_platform(None);
    });
}

pub fn run_file(path: &Path, argv: &[String]) -> Result<i32> {
    init_v8_once();
    let _ = crate::httpimpl::MAIN.set((path.to_path_buf(), argv.to_vec()));
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    rt.block_on(async {
        let mut r = Runtime::new();
        r.run_main(path, argv).await
    })
}
