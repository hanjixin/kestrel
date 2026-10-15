//! `Kestrel.serve` backend: hyper 1.x HTTP/1.1 on the thread's own Tokio runtime,
//! one SO_REUSEPORT listener per worker thread. Requests cross into JS through
//! a channel polled by an async op; responses come back through a oneshot.

use std::cell::RefCell;
use std::collections::HashMap;
use std::net::SocketAddr;
use std::rc::Rc;

use bytes::Bytes;
use deno_core::OpState;
use deno_error::JsErrorBox;
use http_body_util::Full;
use hyper::body::Incoming as IncomingBody;
use hyper::header::{HeaderValue, CONTENT_TYPE};
use hyper::service::service_fn;
use hyper::{Request, Response};
use hyper_util::rt::TokioIo;
use tokio::sync::{mpsc, oneshot};
use deno_core::v8;

/// Everything needed to call the JS request handler from a hyper task on this thread.
struct Direct {
    isolate: *mut v8::Isolate,
    context: v8::Global<v8::Context>,
    trampoline: v8::Global<v8::Function>,
    state: Rc<RefCell<OpState>>,
}
struct IsolateInfo {
    /// A bitwise copy of the runtime's `v8::Isolate` handle (an 8-byte pointer wrapper),
    /// boxed so its address is stable for the life of the thread.
    isolate: Box<std::cell::UnsafeCell<v8::Isolate>>,
    context: v8::Global<v8::Context>,
    state: Rc<RefCell<OpState>>,
}
thread_local! {
    static ISOLATE: RefCell<Option<IsolateInfo>> = const { RefCell::new(None) };
    static DIRECT: RefCell<Option<Rc<Direct>>> = const { RefCell::new(None) };
}

/// Called by the runtime right after it creates the isolate on this thread.
pub fn init_thread_isolate(isolate: &v8::Isolate, context: v8::Global<v8::Context>, state: Rc<RefCell<OpState>>) {
    // SAFETY: `v8::Isolate` is a transparent wrapper around the C++ isolate pointer; copying
    // the bits gives a second handle to the same isolate (it owns nothing).
    let copy: v8::Isolate = unsafe { std::ptr::read(isolate as *const v8::Isolate) };
    ISOLATE.with(|i| *i.borrow_mut() = Some(IsolateInfo { isolate: Box::new(std::cell::UnsafeCell::new(copy)), context, state }));
}

/// Registers the JS trampoline `(id) => [status, headers, body] | undefined`.
pub fn set_handler(scope: &mut v8::PinScope, _state: Rc<RefCell<OpState>>, f: v8::Local<v8::Function>) {
    let trampoline = v8::Global::new(scope, f);
    ISOLATE.with(|i| {
        let i = i.borrow();
        let Some(info) = i.as_ref() else { return };
        DIRECT.with(|d| *d.borrow_mut() = Some(Rc::new(Direct { isolate: info.isolate.get(), context: info.context.clone(), trampoline, state: info.state.clone() })));
    });
}

/// Call the trampoline for request `id`. `Some(outgoing)` when the handler answered
/// synchronously; `None` when it returned a promise (the `respond` op will finish it).
///
/// SAFETY: runs on the isolate's own thread, between polls of the runtime's event loop,
/// so no other scope is active on the isolate.
unsafe fn call_js(d: &Direct, id: u32) -> Option<Outgoing> {
    let isolate = unsafe { &mut *d.isolate };
    v8::scope!(let scope, isolate);
    let context = v8::Local::new(scope, &d.context);
    let scope = &mut v8::ContextScope::new(scope, context);
    v8::tc_scope!(let scope, scope);
    let f = v8::Local::new(scope, &d.trampoline);
    let recv: v8::Local<v8::Value> = v8::undefined(scope).into();
    let arg: v8::Local<v8::Value> = v8::Number::new(scope, id as f64).into();
    let err = || Outgoing { status: 500, headers: String::new(), body: Bytes::from_static(b"Internal Server Error") };
    let Some(r) = f.call(scope, recv, &[arg]) else { return Some(err()) };
    if !r.is_array() {
        // Promise-returning handler: give already-settled promises a chance to run now.
        scope.perform_microtask_checkpoint();
        return None;
    }
    let arr: v8::Local<v8::Array> = r.try_into().ok()?;
    let status = arr.get_index(scope, 0).and_then(|v| v.number_value(scope)).unwrap_or(500.0) as u16;
    let headers = match arr.get_index(scope, 1) {
        Some(h) if h.is_string() => h.to_rust_string_lossy(scope),
        _ => String::new(),
    };
    let body = match arr.get_index(scope, 2) {
        Some(b) if b.is_string() => Bytes::from(b.to_rust_string_lossy(scope)),
        Some(b) if b.is_uint8_array() => {
            let u: v8::Local<v8::Uint8Array> = b.try_into().ok()?;
            let mut v = vec![0u8; u.byte_length()];
            u.copy_contents(&mut v);
            Bytes::from(v)
        }
        _ => Bytes::new(),
    };
    Some(Outgoing { status, headers, body })
}

pub struct Outgoing {
    pub status: u16,
    /// Flattened "k\0v\0k\0v"; empty means text/plain.
    pub headers: String,
    pub body: Bytes,
}

pub struct IncomingReq {
    pub parts: hyper::http::request::Parts,
    pub body: IncomingBody,
    pub respond: oneshot::Sender<Outgoing>,
    pub t0: Option<std::time::Instant>,
}

struct Pending {
    parts: hyper::http::request::Parts,
    body: Option<IncomingBody>,
    respond: Option<oneshot::Sender<Outgoing>>,
    /// Response produced before the hyper task armed `respond` (handler settled during the
    /// trampoline's microtask checkpoint); the task picks it up.
    early: Option<Outgoing>,
    /// The handler has produced its response (sent or parked in `early`).
    answered: bool,
    t0: Option<std::time::Instant>,
}

fn build_response(out: Outgoing) -> Response<Full<Bytes>> {
    let mut resp = Response::new(Full::new(out.body));
    *resp.status_mut() = hyper::StatusCode::from_u16(out.status).unwrap_or(hyper::StatusCode::INTERNAL_SERVER_ERROR);
    if out.headers.is_empty() {
        resp.headers_mut().insert(CONTENT_TYPE, HeaderValue::from_static("text/plain;charset=UTF-8"));
    } else {
        let mut it = out.headers.split('\0');
        while let (Some(k), Some(v)) = (it.next(), it.next()) {
            if let (Ok(name), Ok(val)) = (hyper::header::HeaderName::from_bytes(k.as_bytes()), HeaderValue::from_str(v)) {
                resp.headers_mut().append(name, val);
            }
        }
    }
    resp
}

/// Optional per-worker counters (KESTREL_HTTP_STATS=1): batches, requests, in-server latency.
#[derive(Default)]
pub struct Stats {
    batches: u64,
    reqs: u64,
    lat_us: Vec<u32>,
    main_polls: u64,
}
thread_local! {
    pub static STATS: RefCell<Option<Stats>> = const { RefCell::new(None) };
}
/// KESTREL_HTTP_RAW=1: hyper answers directly (benchmark harness only).
fn raw_mode() -> bool {
    static ON: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ON.get_or_init(|| std::env::var("KESTREL_HTTP_RAW").is_ok())
}
/// Max requests handed to JS per accept call. Smaller batches keep hyper's writes interleaved with
/// JS work (pipelining); larger ones amortise the op. KESTREL_HTTP_BATCH overrides.
fn batch_cap() -> usize {
    static CAP: std::sync::OnceLock<usize> = std::sync::OnceLock::new();
    *CAP.get_or_init(|| std::env::var("KESTREL_HTTP_BATCH").ok().and_then(|v| v.parse().ok()).unwrap_or(64))
}
fn stats_enabled() -> bool {
    static ON: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ON.get_or_init(|| std::env::var("KESTREL_HTTP_STATS").is_ok())
}
fn stats_report() {
    STATS.with(|s| {
        let mut s = s.borrow_mut();
        let Some(st) = s.as_mut() else { return };
        if st.reqs == 0 { return; }
        st.lat_us.sort_unstable();
        let pct = |p: f64| st.lat_us[((st.lat_us.len() as f64 - 1.0) * p) as usize];
        eprintln!(
            "[http-stats w{}] batches={} reqs={} avg_batch={:.1} in-server latency us: p50={} p90={} p99={} max={}",
            worker_id(), st.batches, st.reqs, st.reqs as f64 / st.batches.max(1) as f64, pct(0.5), pct(0.9), pct(0.99), st.lat_us.last().copied().unwrap_or(0)
        );
        *st = Stats::default();
    });
}

pub struct HttpServer {
    rx: mpsc::Receiver<IncomingReq>,
}

pub struct HttpState {
    servers: HashMap<u32, Rc<RefCell<HttpServer>>>,
    next_rid: u32,
    next_req: u32,
    pending: HashMap<u32, Pending>,
}

fn state_mut(state: &mut OpState) -> &mut HttpState {
    if state.try_borrow::<HttpState>().is_none() {
        state.put(HttpState { servers: HashMap::new(), next_rid: 0, next_req: 0, pending: HashMap::with_capacity(8192) });
    }
    state.borrow_mut::<HttpState>()
}

/// One blocking acceptor thread per bound address hands connections to worker
/// runtimes round-robin. (macOS SO_REUSEPORT does not balance across sockets,
/// so per-thread listeners would leave all but one worker idle.)
struct Hub {
    /// One entry per worker runtime: its connection channel and its live-connection count.
    senders: Vec<(mpsc::UnboundedSender<(std::net::TcpStream, std::sync::Arc<std::sync::atomic::AtomicUsize>)>, std::sync::Arc<std::sync::atomic::AtomicUsize>)>,
    /// Workers expected to join before the acceptor starts handing out connections.
    expected: usize,
}
static HUBS: std::sync::Mutex<Option<HashMap<SocketAddr, std::sync::Arc<std::sync::Mutex<Hub>>>>> = std::sync::Mutex::new(None);

fn bind_listener(addr: SocketAddr) -> std::io::Result<std::net::TcpListener> {
    use socket2::{Domain, Protocol, Socket, Type};
    let sock = Socket::new(Domain::for_address(addr), Type::STREAM, Some(Protocol::TCP))?;
    sock.set_reuse_address(true)?;
    sock.set_nodelay(true)?;
    sock.bind(&addr.into())?;
    sock.listen(4096)?;
    Ok(sock.into())
}

type ConnRx = mpsc::UnboundedReceiver<(std::net::TcpStream, std::sync::Arc<std::sync::atomic::AtomicUsize>)>;

/// Join (or create) the acceptor for `addr`. Connections go to the worker with the fewest
/// live connections, so long-lived clients spread evenly across runtimes.
fn join_hub(addr: SocketAddr, expected: usize) -> std::io::Result<ConnRx> {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let (ctx, crx) = mpsc::unbounded_channel();
    let count = std::sync::Arc::new(AtomicUsize::new(0));
    let mut hubs = HUBS.lock().unwrap();
    let hubs = hubs.get_or_insert_with(HashMap::new);
    if let Some(hub) = hubs.get(&addr) {
        hub.lock().unwrap().senders.push((ctx, count));
        return Ok(crx);
    }
    let listener = bind_listener(addr)?;
    let hub = std::sync::Arc::new(std::sync::Mutex::new(Hub { senders: vec![(ctx, count)], expected }));
    hubs.insert(addr, hub.clone());
    std::thread::Builder::new()
        .name(format!("kestrel-accept-{}", addr.port()))
        .spawn(move || {
            // Give the worker runtimes a moment to boot and join, so the first connections
            // are not all pinned to whichever worker happened to be up first.
            let t0 = std::time::Instant::now();
            while t0.elapsed() < std::time::Duration::from_secs(3) {
                let h = hub.lock().unwrap();
                if h.senders.len() >= h.expected {
                    break;
                }
                drop(h);
                std::thread::sleep(std::time::Duration::from_millis(2));
            }
            loop {
                let Ok((stream, _)) = listener.accept() else { continue };
                let _ = stream.set_nodelay(true);
                let mut h = hub.lock().unwrap();
                let mut stream = Some(stream);
                while !h.senders.is_empty() {
                    // Least-loaded worker.
                    let (i, _) = h.senders.iter().enumerate().min_by_key(|(_, (_, c))| c.load(Ordering::Relaxed)).unwrap();
                    let (tx, c) = &h.senders[i];
                    c.fetch_add(1, Ordering::Relaxed);
                    match tx.send((stream.take().unwrap(), c.clone())) {
                        Ok(()) => break,
                        Err(e) => {
                            // Worker is gone; drop it and try the next one.
                            h.senders.remove(i);
                            stream = Some(e.0 .0);
                        }
                    }
                }
            }
        })?;
    Ok(crx)
}

pub fn listen(state: &mut OpState, host: &str, port: u16, expected_workers: u32) -> Result<u32, JsErrorBox> {
    let addr: SocketAddr = format!("{host}:{port}")
        .parse()
        .map_err(|e| JsErrorBox::type_error(format!("bad address {host}:{port}: {e}")))?;
    let mut conns = join_hub(addr, expected_workers.max(1) as usize).map_err(|e| JsErrorBox::generic(format!("listen {addr}: {e}")))?;

    let (tx, rx) = mpsc::channel::<IncomingReq>(16384);
    tokio::spawn(async move {
        while let Some((std_stream, live)) = conns.recv().await {
            if std_stream.set_nonblocking(true).is_err() {
                live.fetch_sub(1, std::sync::atomic::Ordering::Relaxed);
                continue;
            }
            let Ok(stream) = tokio::net::TcpStream::from_std(std_stream) else { live.fetch_sub(1, std::sync::atomic::Ordering::Relaxed); continue };
            let tx = tx.clone();
            tokio::spawn(async move {
                struct Dec(std::sync::Arc<std::sync::atomic::AtomicUsize>);
                impl Drop for Dec { fn drop(&mut self) { self.0.fetch_sub(1, std::sync::atomic::Ordering::Relaxed); } }
                let _dec = Dec(live);
                let io = TokioIo::new(stream);
                let raw = raw_mode();
                let svc = service_fn(move |req: Request<IncomingBody>| {
                    let tx = tx.clone();
                    async move {
                        if raw {
                            let mut resp = Response::new(Full::new(Bytes::from_static(b"Hello, World!")));
                            resp.headers_mut().insert(CONTENT_TYPE, HeaderValue::from_static("text/plain;charset=UTF-8"));
                            return Ok::<_, hyper::Error>(resp);
                        }
                        let (parts, body) = req.into_parts();
                        let t0 = if stats_enabled() { Some(std::time::Instant::now()) } else { None };
                        // Decide synchronously (no `Rc<Direct>` may live across an await).
                        enum Step { Done(Outgoing), Pending(oneshot::Receiver<Outgoing>), Queue(IncomingReq, oneshot::Receiver<Outgoing>) }
                        let step = {
                            let direct = DIRECT.with(|d| d.borrow().clone());
                            match direct {
                                Some(d) => {
                                    let id = {
                                        let mut st = d.state.borrow_mut();
                                        let hs = state_mut(&mut st);
                                        let id = hs.next_req;
                                        hs.next_req = hs.next_req.wrapping_add(1);
                                        hs.pending.insert(id, Pending { parts, body: Some(body), respond: None, early: None, answered: false, t0 });
                                        id
                                    };
                                    // SAFETY: see call_js.
                                    match unsafe { call_js(&d, id) } {
                                        Some(out) => {
                                            let mut st = d.state.borrow_mut();
                                            let hs = state_mut(&mut st);
                                            if let Some(p) = hs.pending.remove(&id) {
                                                if let Some(t0) = p.t0 {
                                                    let us = t0.elapsed().as_micros() as u32;
                                                    STATS.with(|s| { if let Some(st) = s.borrow_mut().as_mut() { st.lat_us.push(us); st.reqs += 1; st.batches += 1; } });
                                                }
                                            }
                                            Step::Done(out)
                                        }
                                        None => {
                                            // Handler went async: now we need a completion channel.
                                            let (rtx, rrx) = oneshot::channel();
                                            let mut st = d.state.borrow_mut();
                                            let hs = state_mut(&mut st);
                                            match hs.pending.get_mut(&id) {
                                                Some(p) => {
                                                    if let Some(out) = p.early.take() { hs.pending.remove(&id); Step::Done(out) }
                                                    else { p.respond = Some(rtx); Step::Pending(rrx) }
                                                }
                                                // Already answered through the respond op during the microtask checkpoint.
                                                None => Step::Pending(rrx),
                                            }
                                        }
                                    }
                                }
                                None => {
                                    let (rtx, rrx) = oneshot::channel();
                                    Step::Queue(IncomingReq { parts, body, respond: rtx, t0 }, rrx)
                                }
                            }
                        };
                        let rrx = match step {
                            Step::Done(out) => return Ok::<_, hyper::Error>(build_response(out)),
                            Step::Pending(rrx) => rrx,
                            Step::Queue(msg, rrx) => {
                                if tx.send(msg).await.is_err() {
                                    return Ok::<_, hyper::Error>(Response::builder().status(503).body(Full::new(Bytes::new())).unwrap());
                                }
                                rrx
                            }
                        };
                        match rrx.await {
                            Ok(out) => Ok(build_response(out)),
                            Err(_) => Ok(Response::builder().status(500).body(Full::new(Bytes::new())).unwrap()),
                        }
                    }
                });
                // No pipeline_flush: it delays flushing a response until the read side goes
                // idle, which adds milliseconds of latency to non-pipelined clients.
                let _ = hyper::server::conn::http1::Builder::new()
                    .keep_alive(true)
                    .serve_connection(io, svc)
                    .await;
            });
        }
    });

    let hs = state_mut(state);
    let rid = hs.next_rid;
    hs.next_rid += 1;
    hs.servers.insert(rid, Rc::new(RefCell::new(HttpServer { rx })));
    if stats_enabled() {
        STATS.with(|s| *s.borrow_mut() = Some(Stats::default()));
        tokio::spawn(async {
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                stats_report();
            }
        });
    }
    Ok(rid)
}

/// Wait for the next request(s). Returns the ids of every request queued so far
/// (one async op per batch); method/url/headers are fetched lazily by id.
pub async fn accept(state: Rc<RefCell<OpState>>, rid: u32) -> Result<Vec<u32>, JsErrorBox> {
    let server = {
        let mut st = state.borrow_mut();
        let hs = state_mut(&mut st);
        hs.servers.get(&rid).cloned().ok_or_else(|| JsErrorBox::type_error("bad server id"))?
    };
    let mut batch: Vec<IncomingReq> = Vec::with_capacity(64);
    {
        // Only one accept loop per server, so this borrow never contends.
        let mut s = server.borrow_mut();
        let first = s.rx.recv().await.ok_or_else(|| JsErrorBox::generic("server closed"))?;
        batch.push(first);
        let cap = batch_cap();
        while batch.len() < cap {
            match s.rx.try_recv() {
                Ok(r) => batch.push(r),
                Err(_) => break,
            }
        }
    }
    if stats_enabled() {
        STATS.with(|s| { if let Some(st) = s.borrow_mut().as_mut() { st.batches += 1; st.reqs += batch.len() as u64; } });
    }
    let mut st = state.borrow_mut();
    let hs = state_mut(&mut st);
    let mut ids = Vec::with_capacity(batch.len());
    for req in batch {
        let id = hs.next_req;
        hs.next_req = hs.next_req.wrapping_add(1);
        hs.pending.insert(id, Pending { parts: req.parts, body: Some(req.body), respond: Some(req.respond), early: None, answered: false, t0: req.t0 });
        ids.push(id);
    }
    Ok(ids)
}

pub fn method(state: &mut OpState, id: u32) -> String {
    let hs = state_mut(state);
    hs.pending.get(&id).map(|p| p.parts.method.as_str().to_string()).unwrap_or_default()
}

pub fn url(state: &mut OpState, id: u32) -> String {
    let hs = state_mut(state);
    hs.pending.get(&id).map(|p| p.parts.uri.to_string()).unwrap_or_default()
}

pub fn respond(state: &mut OpState, id: u32, status: u16, headers: &str, body: Bytes) -> Result<(), JsErrorBox> {
    let hs = state_mut(state);
    let p = hs.pending.get_mut(&id).ok_or_else(|| JsErrorBox::type_error("response already sent"))?;
    if p.answered {
        return Err(JsErrorBox::type_error("response already sent"));
    }
    p.answered = true;
    let Some(tx) = p.respond.take() else {
        // Answered during the trampoline's microtask checkpoint, before the hyper task armed
        // its channel: park the result; the task picks it up when it arms.
        p.early = Some(Outgoing { status, headers: headers.to_string(), body });
        return Ok(());
    };
    if let Some(t0) = p.t0 {
        let us = t0.elapsed().as_micros() as u32;
        STATS.with(|s| { if let Some(st) = s.borrow_mut().as_mut() { st.lat_us.push(us); } });
    }
    let _ = tx.send(Outgoing { status, headers: headers.to_string(), body });
    // The handler is done with this request; an unread body is dropped with the slot.
    hs.pending.remove(&id);
    Ok(())
}

/// Read the whole request body. The pending slot is freed once both body and response are done.
pub async fn body(state: Rc<RefCell<OpState>>, id: u32) -> Result<Vec<u8>, JsErrorBox> {
    let body = {
        let mut st = state.borrow_mut();
        let hs = state_mut(&mut st);
        let p = hs.pending.get_mut(&id).ok_or_else(|| JsErrorBox::type_error("request body already consumed"))?;
        p.body.take()
    };
    let out = match body {
        Some(b) => {
            use http_body_util::BodyExt;
            b.collect().await.map(|c| c.to_bytes().to_vec()).map_err(|e| JsErrorBox::type_error(format!("body: {e}")))?
        }
        None => Vec::new(),
    };
    let mut st = state.borrow_mut();
    let hs = state_mut(&mut st);
    if let Some(p) = hs.pending.get(&id) {
        // Only the sent-and-done case is ours to clean up; a parked early response is
        // removed by the hyper task when it collects it.
        if p.answered && p.early.is_none() {
            hs.pending.remove(&id);
        }
    }
    Ok(out)
}

/// Headers of a pending request as "k\0v\0k\0v…".
pub fn headers(state: &mut OpState, id: u32) -> String {
    let hs = state_mut(state);
    let Some(p) = hs.pending.get(&id) else { return String::new() };
    let mut out = String::new();
    for (k, v) in p.parts.headers.iter() {
        out.push_str(k.as_str());
        out.push('\0');
        out.push_str(v.to_str().unwrap_or(""));
        out.push('\0');
    }
    out
}

// ---------- worker threads ----------

thread_local! {
    static WORKER_ID: std::cell::Cell<u32> = const { std::cell::Cell::new(0) };
}
pub static MAIN: std::sync::OnceLock<(std::path::PathBuf, Vec<String>)> = std::sync::OnceLock::new();

pub fn worker_id() -> u32 {
    WORKER_ID.with(|w| w.get())
}

pub fn set_worker_id(id: u32) {
    WORKER_ID.with(|w| w.set(id));
}

/// Spawn `n` additional runtime threads that re-run the main module.
pub fn spawn_workers(n: u32) -> Result<(), JsErrorBox> {
    let (path, argv) = MAIN.get().cloned().ok_or_else(|| JsErrorBox::generic("main module unknown"))?;
    for i in 1..=n {
        let path = path.clone();
        let argv = argv.clone();
        std::thread::Builder::new()
            .name(format!("kestrel-worker-{i}"))
            .stack_size(8 << 20)
            .spawn(move || {
                set_worker_id(i);
                if let Err(e) = crate::runtime::run_file(&path, &argv) {
                    eprintln!("worker {i}: {e}");
                }
            })
            .map_err(|e| JsErrorBox::generic(e.to_string()))?;
    }
    Ok(())
}
