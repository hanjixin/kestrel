//! Native ops exposed to the bootstrap JS as `Deno.core.ops.op_kestrel_*`.

use deno_core::op2;

#[op2(fast)]
pub fn op_kestrel_exit(code: i32) {
    std::process::exit(code);
}

#[op2]
#[string]
pub fn op_kestrel_cwd() -> String {
    std::env::current_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default()
}

#[op2]
#[string]
pub fn op_kestrel_v8_version() -> String {
    deno_core::v8::VERSION_STRING.to_string()
}

deno_core::extension!(
    kestrel,
    ops = [op_kestrel_exit, op_kestrel_cwd, op_kestrel_v8_version],
    esm_entry_point = "ext:kestrel/bootstrap.js",
    esm = [dir "src/js", "bootstrap.js"],
);
