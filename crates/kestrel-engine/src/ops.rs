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

// ---------- HTTP / workers (implementation in httpimpl.rs; stubbed in build.rs) ----------
use std::cell::RefCell;
use std::rc::Rc;
use deno_core::OpState;
use deno_core::v8;

#[op2(fast)]
pub fn op_kestrel_http_listen(state: &mut OpState, #[string] host: &str, port: u16, expected_workers: u32) -> Result<u32, deno_error::JsErrorBox> {
    super::httpimpl::listen(state, host, port, expected_workers)
}

#[op2]
#[buffer]
pub async fn op_kestrel_http_accept(state: Rc<RefCell<OpState>>, rid: u32) -> Result<Vec<u32>, deno_error::JsErrorBox> {
    super::httpimpl::accept(state, rid).await
}

#[op2(fast)]
pub fn op_kestrel_http_set_handler(scope: &mut v8::PinScope, state: Rc<RefCell<OpState>>, f: v8::Local<v8::Function>) {
    super::httpimpl::set_handler(scope, state, f)
}

#[op2]
#[string]
pub fn op_kestrel_http_method(state: &mut OpState, id: u32) -> String {
    super::httpimpl::method(state, id)
}

#[op2]
#[string]
pub fn op_kestrel_http_url(state: &mut OpState, id: u32) -> String {
    super::httpimpl::url(state, id)
}

#[op2(fast)]
pub fn op_kestrel_http_respond(
    state: &mut OpState,
    id: u32,
    status: u16,
    #[string] headers: &str,
    #[string] body: &str,
) -> Result<(), deno_error::JsErrorBox> {
    super::httpimpl::respond(state, id, status, headers, bytes::Bytes::copy_from_slice(body.as_bytes()))
}

#[op2(fast)]
pub fn op_kestrel_http_respond_bytes(
    state: &mut OpState,
    id: u32,
    status: u16,
    #[string] headers: &str,
    #[buffer] body: &[u8],
) -> Result<(), deno_error::JsErrorBox> {
    super::httpimpl::respond(state, id, status, headers, bytes::Bytes::copy_from_slice(body))
}

#[op2]
#[buffer]
pub async fn op_kestrel_http_body(state: Rc<RefCell<OpState>>, id: u32) -> Result<Vec<u8>, deno_error::JsErrorBox> {
    super::httpimpl::body(state, id).await
}

#[op2]
#[serde]
pub async fn op_kestrel_fetch(
    state: Rc<RefCell<OpState>>,
    #[string] url: String,
    #[string] method: String,
    #[serde] headers: Vec<(String, String)>,
    #[buffer(copy)] body: Vec<u8>,
    has_body: bool,
    follow: bool,
) -> Result<super::fetchimpl::FetchResp, deno_error::JsErrorBox> {
    super::fetchimpl::fetch(state, url, method, headers, if has_body { Some(body) } else { None }, follow).await
}

#[op2]
#[string]
pub fn op_kestrel_http_headers(state: &mut OpState, id: u32) -> String {
    super::httpimpl::headers(state, id)
}

#[op2(fast)]
pub fn op_kestrel_spawn_workers(n: u32) -> Result<(), deno_error::JsErrorBox> {
    super::httpimpl::spawn_workers(n)
}

#[op2(fast)]
pub fn op_kestrel_worker_id() -> u32 {
    super::httpimpl::worker_id()
}

#[op2(fast)]
pub fn op_kestrel_cpus() -> u32 {
    std::thread::available_parallelism().map(|n| n.get() as u32).unwrap_or(1)
}

deno_core::extension!(
    kestrel,
    ops = [
        op_kestrel_exit, op_kestrel_cwd, op_kestrel_v8_version,
        op_kestrel_http_listen, op_kestrel_http_accept, op_kestrel_http_respond, op_kestrel_http_respond_bytes,
        op_kestrel_http_body, op_kestrel_http_headers, op_kestrel_http_method, op_kestrel_http_url, op_kestrel_http_set_handler, op_kestrel_fetch,
        op_kestrel_spawn_workers, op_kestrel_worker_id, op_kestrel_cpus,
        super::nodeimpl::op_k_fs_read_text, super::nodeimpl::op_k_fs_read_bytes, super::nodeimpl::op_k_fs_write_bytes,
        super::nodeimpl::op_k_fs_write_text, super::nodeimpl::op_k_fs_stat, super::nodeimpl::op_k_fs_exists,
        super::nodeimpl::op_k_fs_readdir, super::nodeimpl::op_k_fs_mkdir, super::nodeimpl::op_k_fs_remove,
        super::nodeimpl::op_k_fs_rename, super::nodeimpl::op_k_fs_copy, super::nodeimpl::op_k_fs_realpath,
        super::nodeimpl::op_k_fs_readlink, super::nodeimpl::op_k_fs_chmod, super::nodeimpl::op_k_fs_symlink,
        super::nodeimpl::op_k_fs_utimes, super::nodeimpl::op_k_fs_mkdtemp,
        super::nodeimpl::op_k_utf8_decode, super::nodeimpl::op_k_utf8_encode, super::nodeimpl::op_k_base64_encode,
        super::nodeimpl::op_k_base64_decode, super::nodeimpl::op_k_hex_encode, super::nodeimpl::op_k_hex_decode,
        super::nodeimpl::op_k_latin1_encode, super::nodeimpl::op_k_latin1_decode,
        super::nodeimpl::op_k_url_parse, super::nodeimpl::op_k_url_to_path, super::nodeimpl::op_k_path_to_url,
        super::nodeimpl::op_k_random_bytes, super::nodeimpl::op_k_random_uuid, super::nodeimpl::op_k_hash, super::nodeimpl::op_k_hmac,
        super::nodeimpl::op_k_zlib, super::nodeimpl::op_k_os_info, super::nodeimpl::op_k_now_ms, super::nodeimpl::op_k_chdir,
        super::nodeimpl::op_k_setenv, super::nodeimpl::op_k_sleep_ms, super::nodeimpl::op_k_read_stdin_line,
        super::nodeimpl::op_k_read_stdin_all, super::nodeimpl::op_k_isatty, super::nodeimpl::op_k_write_fd,
        super::nodeimpl::op_k_resolve, super::nodeimpl::op_k_transpile, super::nodeimpl::op_k_is_builtin,
        super::nodeimpl::op_k_module_format, super::nodeimpl::op_k_esm_to_cjs,
        op_kestrel_call0, op_kestrel_call1, op_kestrel_call2, op_kestrel_call3,
        op_kestrel_call4, op_kestrel_call5, op_kestrel_call6,
    ],
    esm_entry_point = "ext:kestrel/bootstrap.js",
    esm = [dir "src/js", "bootstrap.js", "globals.js", "internal.js",
        "node/assert.js", "node/buffer.js", "node/child_process.js", "node/crypto.js", "node/events.js",
        "node/fs.js", "node/fs_promises.js", "node/http.js", "node/https.js", "node/module.js", "node/net.js",
        "node/os.js", "node/path.js", "node/path_posix.js", "node/process.js", "node/querystring.js",
        "node/readline.js", "node/stream.js", "node/string_decoder.js", "node/timers.js", "node/timers_promises.js",
        "node/tty.js", "node/url.js", "node/util.js", "node/util_types.js", "node/worker_threads.js", "node/zlib.js"],
);
