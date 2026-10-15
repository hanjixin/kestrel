// Bakes the bootstrap JS into a V8 startup snapshot so `kestrel run` skips
// parsing/evaluating runtime code on every launch.
#[path = "src/ops.rs"]
mod ops;
#[path = "src/nodeimpl.rs"]
mod nodeimpl;
#[path = "src/resolve.rs"]
mod resolve;
#[path = "src/transpile.rs"]
mod transpile;
#[path = "src/esm2cjs.rs"]
mod esm2cjs;

/// Snapshot-time stub; the real client lives in src/fetchimpl.rs.
#[allow(dead_code)]
mod fetchimpl {
    #[derive(serde::Serialize)]
    pub struct FetchResp { pub status: u16 }
    pub async fn fetch(_: std::rc::Rc<std::cell::RefCell<deno_core::OpState>>, _: String, _: String, _: Vec<(String, String)>, _: Option<Vec<u8>>, _: bool) -> Result<FetchResp, deno_error::JsErrorBox> { unreachable!() }
}

/// Snapshot-time stubs; real implementations live in src/httpimpl.rs.
#[allow(dead_code)]
mod httpimpl {
    use std::cell::RefCell;
    use std::rc::Rc;
    use deno_core::OpState;
    use deno_error::JsErrorBox;
    pub fn listen(_: &mut OpState, _: &str, _: u16, _: u32) -> Result<u32, JsErrorBox> { unreachable!() }
    pub async fn accept(_: Rc<RefCell<OpState>>, _: u32) -> Result<Vec<u32>, JsErrorBox> { unreachable!() }
    pub fn method(_: &mut OpState, _: u32) -> String { unreachable!() }
    pub fn set_handler(_: &mut deno_core::v8::PinScope, _: Rc<RefCell<OpState>>, _: deno_core::v8::Local<deno_core::v8::Function>) { unreachable!() }
    pub fn url(_: &mut OpState, _: u32) -> String { unreachable!() }
    pub fn respond(_: &mut OpState, _: u32, _: u16, _: &str, _: bytes::Bytes) -> Result<(), JsErrorBox> { unreachable!() }
    pub async fn body(_: Rc<RefCell<OpState>>, _: u32) -> Result<Vec<u8>, JsErrorBox> { unreachable!() }
    pub fn headers(_: &mut OpState, _: u32) -> String { unreachable!() }
    pub fn spawn_workers(_: u32) -> Result<(), JsErrorBox> { unreachable!() }
    pub fn worker_id() -> u32 { 0 }
}

/// Stub for snapshot time; the real table lives in kestrel-aot.
#[allow(dead_code)]
mod bridge {
    pub fn take_overflow() -> bool { false }
    pub fn call0(_: u32) -> f64 { unreachable!() }
    pub fn call1(_: u32, _: f64) -> f64 { unreachable!() }
    pub fn call2(_: u32, _: f64, _: f64) -> f64 { unreachable!() }
    pub fn call3(_: u32, _: f64, _: f64, _: f64) -> f64 { unreachable!() }
    pub fn call4(_: u32, _: f64, _: f64, _: f64, _: f64) -> f64 { unreachable!() }
    pub fn call5(_: u32, _: f64, _: f64, _: f64, _: f64, _: f64) -> f64 { unreachable!() }
    pub fn call6(_: u32, _: f64, _: f64, _: f64, _: f64, _: f64, _: f64) -> f64 { unreachable!() }
}

fn main() {
    let out_dir = std::path::PathBuf::from(std::env::var_os("OUT_DIR").unwrap());
    let snapshot_path = out_dir.join("KESTREL_SNAPSHOT.bin");

    let output = deno_core::snapshot::create_snapshot(
        deno_core::snapshot::CreateSnapshotOptions {
            cargo_manifest_dir: env!("CARGO_MANIFEST_DIR"),
            startup_snapshot: None,
            skip_op_registration: false,
            extensions: vec![ops::kestrel::init()],
            extension_transpiler: None,
            with_runtime_cb: None,
        },
        None,
    )
    .expect("snapshot creation failed");

    std::fs::write(&snapshot_path, output.output).unwrap();
    for path in output.files_loaded_during_snapshot {
        println!("cargo:rerun-if-changed={}", path.display());
    }
    println!("cargo:rerun-if-changed=src/ops.rs");
    println!("cargo:rerun-if-changed=src/js/bootstrap.js");
    println!("cargo:rerun-if-changed=src/js");
    println!("cargo:rerun-if-changed=src/nodeimpl.rs");
}
