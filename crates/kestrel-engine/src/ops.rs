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

macro_rules! call_op {
    ($name:ident, $bridge:ident $(, $arg:ident)*) => {
        #[op2(fast)]
        pub fn $name(idx: u32 $(, $arg: f64)*) -> Result<f64, deno_error::JsErrorBox> {
            let r = super::bridge::$bridge(idx $(, $arg)*);
            if super::bridge::take_overflow() {
                return Err(deno_error::JsErrorBox::new("RangeError", "Maximum call stack size exceeded"));
            }
            Ok(r)
        }
    };
}
call_op!(op_kestrel_call0, call0);
call_op!(op_kestrel_call1, call1, a);
call_op!(op_kestrel_call2, call2, a, b);
call_op!(op_kestrel_call3, call3, a, b, c);
call_op!(op_kestrel_call4, call4, a, b, c, d);
call_op!(op_kestrel_call5, call5, a, b, c, d, e);
call_op!(op_kestrel_call6, call6, a, b, c, d, e, f);

deno_core::extension!(
    kestrel,
    ops = [
        op_kestrel_exit, op_kestrel_cwd, op_kestrel_v8_version,
        op_kestrel_call0, op_kestrel_call1, op_kestrel_call2, op_kestrel_call3,
        op_kestrel_call4, op_kestrel_call5, op_kestrel_call6,
    ],
    esm_entry_point = "ext:kestrel/bootstrap.js",
    esm = [dir "src/js", "bootstrap.js"],
);
