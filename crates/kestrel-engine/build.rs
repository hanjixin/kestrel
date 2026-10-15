// Bakes the bootstrap JS into a V8 startup snapshot so `kestrel run` skips
// parsing/evaluating runtime code on every launch.
#[path = "src/ops.rs"]
mod ops;

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
}
