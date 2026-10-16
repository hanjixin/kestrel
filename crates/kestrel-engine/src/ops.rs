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
pub fn op_kestrel_http_set_handler(scope: &mut v8::PinScope, state: Rc<RefCell<OpState>>, rid: u32, f: v8::Local<v8::Function>) {
    super::httpimpl::set_handler(scope, state, rid, f)
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

#[op2]
#[serde]
pub async fn op_kestrel_fetch_h2(
    state: Rc<RefCell<OpState>>,
    #[string] url: String,
    #[string] method: String,
    #[serde] headers: Vec<(String, String)>,
    #[buffer(copy)] body: Vec<u8>,
    has_body: bool,
    insecure: bool,
) -> Result<super::fetchimpl::FetchResp, deno_error::JsErrorBox> {
    super::fetchimpl::fetch_opts(state, url, method, headers, if has_body { Some(body) } else { None }, true, true, insecure).await
}

#[op2(fast)]
pub fn op_kestrel_http_port(state: &mut OpState, rid: u32) -> u16 {
    super::httpimpl::port(state, rid)
}

/// 10, 11, 2 or 3 for HTTP/1.0, 1.1, 2, 3.
#[op2(fast)]
pub fn op_kestrel_http_version(state: &mut OpState, id: u32) -> u32 {
    super::httpimpl::version(state, id)
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
    physical_cpus()
}

/// Physical cores, not SMT threads: `workers: "auto"` uses this. A worker per SMT thread
/// is past the knee on big hosts (128-vCPU EPYC: 64 workers served 1.47 M req/s at 4096
/// connections, 128 workers 1.20 M), because two pollers on sibling threads share one
/// core's cache and the kernel's TCP work for a socket runs on one of them anyway.
pub fn physical_cpus() -> u32 {
    let logical = std::thread::available_parallelism().map(|n| n.get() as u32).unwrap_or(1);
    #[cfg(target_os = "linux")]
    {
        if let Ok(info) = std::fs::read_to_string("/proc/cpuinfo") {
            let mut cores = std::collections::HashSet::new();
            let (mut phys, mut core) = (None, None);
            for line in info.lines() {
                if let Some(v) = line.strip_prefix("physical id") { phys = v.split(':').nth(1).map(|x| x.trim().to_string()); }
                else if let Some(v) = line.strip_prefix("core id") { core = v.split(':').nth(1).map(|x| x.trim().to_string()); }
                else if line.is_empty() {
                    if let (Some(p), Some(c)) = (phys.take(), core.take()) { cores.insert((p, c)); }
                }
            }
            if let (Some(p), Some(c)) = (phys, core) { cores.insert((p, c)); }
            if !cores.is_empty() && (cores.len() as u32) <= logical { return cores.len() as u32; }
        }
    }
    #[cfg(target_os = "macos")]
    {
        let mut n: i32 = 0;
        let mut len = std::mem::size_of::<i32>();
        let name = c"hw.physicalcpu";
        // SAFETY: sysctlbyname writes at most `len` bytes into `n`.
        let r = unsafe { libc::sysctlbyname(name.as_ptr(), &mut n as *mut i32 as *mut libc::c_void, &mut len, std::ptr::null_mut(), 0) };
        if r == 0 && n > 0 && (n as u32) <= logical { return n as u32; }
    }
    logical
}

deno_core::extension!(
    kestrel,
    ops = [
        op_kestrel_exit, op_kestrel_cwd, op_kestrel_v8_version,
        op_kestrel_http_listen, op_kestrel_http_accept, op_kestrel_http_respond, op_kestrel_http_respond_bytes,
        op_kestrel_http_body, op_kestrel_http_headers, op_kestrel_http_method, op_kestrel_http_url, op_kestrel_http_set_handler, op_kestrel_fetch, op_kestrel_fetch_h2, op_kestrel_http_version, op_kestrel_http_port,
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
        super::procimpl::op_cp_spawn, super::procimpl::op_cp_read, super::procimpl::op_cp_write, super::procimpl::op_cp_close_stdin,
        super::procimpl::op_cp_wait, super::procimpl::op_cp_kill, super::procimpl::op_kill_pid, super::procimpl::op_cp_spawn_sync,
        super::procimpl::op_fd_open, super::procimpl::op_fd_close, super::procimpl::op_fd_read, super::procimpl::op_fd_write,
        super::procimpl::op_fd_stat, super::procimpl::op_fd_sync, super::procimpl::op_fd_truncate,
        super::procimpl::op_brotli, super::procimpl::op_pbkdf2, super::procimpl::op_scrypt, super::procimpl::op_hkdf, super::procimpl::op_cipher,
        super::procimpl::op_keygen, super::procimpl::op_key_info, super::procimpl::op_sign, super::procimpl::op_verify,
        super::netimpl::op_net_connect, super::netimpl::op_net_read, super::netimpl::op_net_write, super::netimpl::op_net_shutdown,
        super::netimpl::op_net_close, super::netimpl::op_net_addr, super::netimpl::op_net_listen, super::netimpl::op_net_listen_addr,
        super::netimpl::op_net_accept, super::netimpl::op_net_close_listener, super::netimpl::op_tls_server_config, super::netimpl::op_tls_server_clear,
        super::netimpl::op_tls_connect, super::netimpl::op_tls_read, super::netimpl::op_tls_write, super::netimpl::op_tls_shutdown, super::netimpl::op_tls_close,
        super::netimpl::op_worker_info, super::netimpl::op_worker_spawn, super::netimpl::op_worker_post, super::netimpl::op_worker_recv,
        super::netimpl::op_worker_exit_code, super::netimpl::op_worker_terminate, super::netimpl::op_worker_parent_post,
        super::netimpl::op_worker_parent_recv, super::netimpl::op_worker_self_exit, super::netimpl::op_dns_lookup,
        super::netimpl::op_net_connect_unix, super::netimpl::op_net_from_fd, super::netimpl::op_net_listen_unix, super::netimpl::op_tls_accept,
        super::watchimpl::op_fs_watch, super::watchimpl::op_fs_watch_next, super::watchimpl::op_fs_unwatch,
        super::netimpl::op_udp_bind, super::netimpl::op_udp_send, super::netimpl::op_udp_recv, super::netimpl::op_udp_addr, super::netimpl::op_udp_close, super::netimpl::op_udp_multicast,
        super::netimpl::op_v8_heap_stats, super::netimpl::op_vm_run_in_this_context, super::netimpl::op_vm_run_in_new_context,
        super::netimpl::op_vm_module_compile, super::netimpl::op_vm_module_requests, super::netimpl::op_vm_module_link, super::netimpl::op_vm_module_instantiate,
        super::netimpl::op_vm_module_evaluate, super::netimpl::op_vm_module_status, super::netimpl::op_vm_module_namespace, super::netimpl::op_vm_module_error,
        super::netimpl::op_vm_synthetic_create, super::netimpl::op_vm_synthetic_set_export,
        super::netimpl::op_inspector_connect, super::netimpl::op_inspector_post, super::netimpl::op_inspector_take, super::netimpl::op_inspector_recv, super::netimpl::op_inspector_disconnect, super::netimpl::op_inspector_open, super::netimpl::op_inspector_wait, super::netimpl::op_inspector_url, super::netimpl::op_inspector_close,
        super::h2impl::op_h2_listen, super::h2impl::op_h2_accept, super::h2impl::op_h2_close_listener, super::h2impl::op_h2_listener_port,
        super::h2impl::op_h2_read, super::h2impl::op_h2_respond, super::h2impl::op_h2_write, super::h2impl::op_h2_end, super::h2impl::op_h2_rst, super::h2impl::op_h2_release,
        super::h2impl::op_h2_push, super::h2impl::op_h2_ping, super::h2impl::op_h2_conn_close, super::h2impl::op_h2_connect, super::h2impl::op_h2_request,
        super::h2impl::op_h2_response, super::h2impl::op_h2_push_promise, super::h2impl::op_h2_conn_info,
        op_kestrel_call0, op_kestrel_call1, op_kestrel_call2, op_kestrel_call3,
        op_kestrel_call4, op_kestrel_call5, op_kestrel_call6,
    ],
    esm_entry_point = "ext:kestrel/bootstrap.js",
    esm = [dir "src/js", "bootstrap.js", "globals.js", "internal.js",
        "node/assert.js", "node/buffer.js", "node/child_process.js", "node/crypto.js", "node/events.js",
        "node/fs.js", "node/fs_promises.js", "node/http.js", "node/https.js", "node/module.js", "node/net.js",
        "node/os.js", "node/path.js", "node/path_posix.js", "node/process.js", "node/querystring.js",
        "node/readline.js", "node/stream.js", "node/string_decoder.js", "node/timers.js", "node/timers_promises.js",
        "node/tty.js", "node/url.js", "node/util.js", "node/util_types.js", "node/worker_threads.js", "node/zlib.js", "node/tls.js", "node/dns.js", "node/dns_promises.js", "node/dgram.js", "node/perf_hooks.js", "node/v8.js", "node/vm.js", "node/cluster.js", "node/constants.js", "node/sys.js", "node/async_hooks.js", "node/inspector.js", "node/inspector_promises.js", "node/http2.js"],
);
