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
use hyper::body::{Incoming as IncomingBody, Body, Frame, SizeHint};
use std::sync::{Arc, atomic::{AtomicBool, Ordering}};
use std::{pin::Pin, task::{Context, Poll}};
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
/// The request currently being handled synchronously by the trampoline. Lazy accessors
/// (`url`, `method`, `headers`) look here first; it is moved into the pending table only
/// when the handler goes async.
/// A request as parsed by the fast path: materialised into `Parts` only on access.
pub struct RawReq {
    /// Request line + header block as received; method and path are ranges into it
    /// (one allocation per request instead of three).
    pub headers: Vec<u8>,
    pub method: std::ops::Range<usize>,
    pub path: std::ops::Range<usize>,
}
impl RawReq {
    pub fn method(&self) -> &str {
        std::str::from_utf8(&self.headers[self.method.clone()]).unwrap_or("GET")
    }
    pub fn path(&self) -> &str {
        std::str::from_utf8(&self.headers[self.path.clone()]).unwrap_or("/")
    }
    fn to_parts(&self) -> hyper::http::request::Parts {
        let mut b = hyper::Request::builder().method(self.method()).uri(self.path());
        let mut hdrs = [httparse::EMPTY_HEADER; 48];
        let mut req = httparse::Request::new(&mut hdrs);
        if req.parse(&self.headers).is_ok() {
            for h in req.headers.iter() {
                if h.name.is_empty() { break; }
                b = b.header(h.name, h.value);
            }
        }
        match b.body(()) {
            Ok(r) => r.into_parts().0,
            Err(_) => hyper::Request::new(()).into_parts().0,
        }
    }
}
pub enum CurrentReq {
    Parts(hyper::http::request::Parts),
    Raw(RawReq),
}
struct Current {
    id: u32,
    req: CurrentReq,
    /// Served over TLS (for the scheme of `Request.url`).
    tls: bool,
}
thread_local! {
    static ISOLATE: RefCell<Option<IsolateInfo>> = const { RefCell::new(None) };
    /// Per server id: each `Kestrel.serve` / `http.createServer` on this thread has its own handler.
    static DIRECT: RefCell<HashMap<u32, Rc<Direct>>> = RefCell::new(HashMap::new());
    static CURRENT: RefCell<Option<Current>> = const { RefCell::new(None) };
    /// Wakes this worker's `run_event_loop` after a handler defers its response, so timers,
    /// `setImmediate` and async-op completions scheduled during direct dispatch are serviced
    /// (direct dispatch calls the handler outside the event-loop poll, which is otherwise
    /// parked with nothing to wake it).
    static LOOP_WAKER: RefCell<Option<deno_core::V8CrossThreadTaskSpawner>> = const { RefCell::new(None) };
    /// Server id -> served over TLS.
    static SERVER_TLS: RefCell<HashMap<u32, bool>> = RefCell::new(HashMap::new());
}

/// Called by the runtime right after it creates the isolate on this thread.
pub fn init_thread_isolate(isolate: &v8::Isolate, context: v8::Global<v8::Context>, state: Rc<RefCell<OpState>>) {
    // SAFETY: `v8::Isolate` is a transparent wrapper around the C++ isolate pointer; copying
    // the bits gives a second handle to the same isolate (it owns nothing).
    let copy: v8::Isolate = unsafe { std::ptr::read(isolate as *const v8::Isolate) };
    if let Some(spawner) = state.borrow().try_borrow::<deno_core::V8CrossThreadTaskSpawner>().cloned() {
        LOOP_WAKER.with(|w| *w.borrow_mut() = Some(spawner));
    }
    ISOLATE.with(|i| *i.borrow_mut() = Some(IsolateInfo { isolate: Box::new(std::cell::UnsafeCell::new(copy)), context, state }));
}

/// Wake this worker's event loop so deferred work (timers/immediates/async ops scheduled by a
/// handler during direct dispatch) is processed.
pub(crate) fn wake_event_loop() {
    LOOP_WAKER.with(|w| { if let Some(s) = w.borrow().as_ref() { s.spawn(|_| {}); } });
}

/// Registers the JS trampoline `(id) => [status, headers, body] | undefined`.
pub fn set_handler(scope: &mut v8::PinScope, _state: Rc<RefCell<OpState>>, rid: u32, f: v8::Local<v8::Function>) {
    let trampoline = v8::Global::new(scope, f);
    ISOLATE.with(|i| {
        let i = i.borrow();
        let Some(info) = i.as_ref() else { return };
        DIRECT.with(|d| d.borrow_mut().insert(rid, Rc::new(Direct { isolate: info.isolate.get(), context: info.context.clone(), trampoline, state: info.state.clone() })));
    });
}

/// `KESTREL_FAST_LOG=1`: trace connection hand-off and dispatch (debugging aid).
pub(crate) fn fast_log() -> bool {
    static ON: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ON.get_or_init(|| std::env::var("KESTREL_FAST_LOG").is_ok())
}

pub enum Step {
    Done(Outgoing),
    Pending(oneshot::Receiver<Outgoing>),
    Queue(IncomingReq, oneshot::Receiver<Outgoing>),
}

/// Run the JS handler for one request on this thread. Shared by the hyper path and the
/// fast path. `body` is `None` for requests that cannot carry one.
pub(crate) fn dispatch(rid: u32, req: CurrentReq, body: Option<IncomingBody>, t0: Option<std::time::Instant>) -> Step {
    let direct = DIRECT.with(|d| d.borrow().get(&rid).cloned());
    if fast_log() { eprintln!("[dispatch w{}] rid={rid} handler={}", worker_id(), direct.is_some()); }
    let Some(d) = direct else {
        let (rtx, rrx) = oneshot::channel();
        let parts = match req { CurrentReq::Parts(p) => p, CurrentReq::Raw(r) => r.to_parts() };
        let Some(body) = body else {
            // No handler on this thread and no hyper body to queue: answer 503.
            return Step::Done(Outgoing { status: 503, headers: String::new(), body: Bytes::from_static(b"Service Unavailable"), stream: None });
        };
        let tls = SERVER_TLS.with(|t| t.borrow().get(&rid).copied().unwrap_or(false));
        return Step::Queue(IncomingReq { parts, body, respond: rtx, t0, tls }, rrx);
    };
    let id = {
        let mut st = d.state.borrow_mut();
        let hs = state_mut(&mut st);
        let id = hs.next_req;
        hs.next_req = hs.next_req.wrapping_add(1);
        id
    };
    let has_body = body.is_some();
    let mut body = body;
    let tls = SERVER_TLS.with(|t| t.borrow().get(&rid).copied().unwrap_or(false));
    CURRENT.with(|c| *c.borrow_mut() = Some(Current { id, req, tls }));
    // SAFETY: see call_js.
    let r = unsafe { call_js(&d, id) };
    let cur = CURRENT.with(|c| c.borrow_mut().take());
    let cur_tls = tls;
    // The handler may have scheduled timers/immediates/async ops; make sure the loop wakes.
    if r.is_none() { wake_event_loop(); }
    match r {
        Some(out) => {
            if let Some(t0) = t0 {
                let us = t0.elapsed().as_micros() as u32;
                STATS.with(|s| { if let Some(st) = s.borrow_mut().as_mut() { st.lat_us.push(us); st.reqs += 1; st.batches += 1; } });
            }
            Step::Done(out)
        }
        None => {
            let (rtx, rrx) = oneshot::channel();
            let mut st = d.state.borrow_mut();
            let hs = state_mut(&mut st);
            match hs.pending.get_mut(&id) {
                Some(p) => {
                    if p.body.is_none() { p.body = body.take(); }
                    p.has_body = has_body;
                    if let Some(out) = p.early.take() {
                        if !p.has_body || out.stream.as_ref().is_none_or(|s| s.complete.load(Ordering::Relaxed)) { hs.pending.remove(&id); }
                        Step::Done(out)
                    }
                    else { p.respond = Some(rtx); Step::Pending(rrx) }
                }
                None => {
                    let parts = match cur.map(|c| c.req) { Some(CurrentReq::Parts(p)) => p, Some(CurrentReq::Raw(r)) => r.to_parts(), None => hyper::Request::new(()).into_parts().0 };
                    hs.pending.insert(id, Pending { tls: cur_tls, parts, has_body, body: body.take(), respond: Some(rtx), early: None, answered: false, t0 });
                    Step::Pending(rrx)
                }
            }
        }
    }
}

/// Fast-path entry: a header-only request parsed by the worker's event loop.
pub(crate) fn dispatch_raw(rid: u32, raw: RawReq) -> Step {
    let t0 = if stats_enabled() { Some(std::time::Instant::now()) } else { None };
    dispatch(rid, CurrentReq::Raw(raw), None, t0)
}

/// Body bytes of a V8 string: Latin-1 strings are copied byte-for-byte (valid UTF-8 when
/// ASCII, which is the overwhelmingly common case for text bodies); others go through UTF-8.
fn v8_string_bytes(scope: &mut v8::PinScope, s: v8::Local<v8::String>) -> Bytes {
    if s.is_onebyte() && s.contains_only_onebyte() {
        let len = s.length();
        let mut v: Vec<u8> = Vec::with_capacity(len);
        s.write_one_byte_uninit_v2(scope, 0, &mut v.spare_capacity_mut()[..len], v8::WriteFlags::empty());
        // SAFETY: V8 filled exactly `len` bytes (one byte per Latin-1 code unit).
        unsafe { v.set_len(len) };
        if v.iter().all(|b| *b < 0x80) {
            return Bytes::from(v);
        }
    }
    Bytes::from(s.to_rust_string_lossy(scope))
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
    let err = || Outgoing { status: 500, headers: String::new(), body: Bytes::from_static(b"Internal Server Error"), stream: None };
    let Some(r) = f.call(scope, recv, &[arg]) else { return Some(err()) };
    if r.is_string() {
        // Fast path: 200 text/plain with a string body.
        let sv: v8::Local<v8::String> = r.try_into().ok()?;
        return Some(Outgoing { status: 200, headers: String::new(), body: v8_string_bytes(scope, sv), stream: None });
    }
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
        Some(b) if b.is_string() => { let sv: v8::Local<v8::String> = b.try_into().ok()?; v8_string_bytes(scope, sv) }
        Some(b) if b.is_uint8_array() => {
            let u: v8::Local<v8::Uint8Array> = b.try_into().ok()?;
            let mut v = vec![0u8; u.byte_length()];
            u.copy_contents(&mut v);
            Bytes::from(v)
        }
        _ => Bytes::new(),
    };
    // Synchronous Node responses schedule readable-end/write/close callbacks.
    // Drain them as for the promise route, after taking an owned body snapshot.
    scope.perform_microtask_checkpoint();
    Some(Outgoing { status, headers, body, stream: None })
}

pub struct ResponseStream {
    rx: mpsc::Receiver<Bytes>,
    pub suppress: bool,
    closed: Arc<AtomicBool>,
    notify: Arc<tokio::sync::Notify>,
    complete: Arc<AtomicBool>,
}
impl Drop for ResponseStream {
    fn drop(&mut self) { self.closed.store(true, Ordering::Relaxed); self.notify.notify_waiters(); }
}
struct StreamSender { tx: mpsc::Sender<Bytes>, complete: Arc<AtomicBool>, closed: Arc<AtomicBool>, notify: Arc<tokio::sync::Notify>, request: u32, suppress: bool }
#[derive(Default)]
struct Streams { next: u32, senders: HashMap<u32, StreamSender> }
fn streams(state: &mut OpState) -> &mut Streams {
    if state.try_borrow::<Streams>().is_none() { state.put(Streams::default()); }
    state.borrow_mut::<Streams>()
}
enum ResponseBody { Full(Full<Bytes>), Stream(Box<ResponseStream>) }
impl Body for ResponseBody {
    type Data = Bytes;
    type Error = std::io::Error;
    fn poll_frame(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Result<Frame<Bytes>, Self::Error>>> {
        match &mut *self {
            Self::Full(body) => Pin::new(body).poll_frame(cx).map(|r| r.map(|r| r.map_err(|never| match never {}))),
            Self::Stream(body) => match body.rx.poll_recv(cx) {
                Poll::Ready(Some(bytes)) => Poll::Ready(Some(Ok(Frame::data(bytes)))),
                Poll::Ready(None) if body.complete.load(Ordering::Relaxed) => Poll::Ready(None),
                Poll::Ready(None) => Poll::Ready(Some(Err(std::io::Error::other("response stream aborted")))),
                Poll::Pending => Poll::Pending,
            },
        }
    }
    fn is_end_stream(&self) -> bool { match self { Self::Full(body) => body.is_end_stream(), Self::Stream(_) => false } }
    fn size_hint(&self) -> SizeHint { match self { Self::Full(body) => body.size_hint(), Self::Stream(_) => SizeHint::default() } }
}

pub struct Outgoing {
    pub status: u16,
    /// Flattened "k\0v\0k\0v"; empty means text/plain.
    pub headers: String,
    pub body: Bytes,
    pub stream: Option<Box<ResponseStream>>,
}

pub struct IncomingReq {
    pub tls: bool,
    pub parts: hyper::http::request::Parts,
    pub body: IncomingBody,
    pub respond: oneshot::Sender<Outgoing>,
    pub t0: Option<std::time::Instant>,
}

struct Pending {
    tls: bool,
    parts: hyper::http::request::Parts,
    /// False for fast-path requests, which never carry a body.
    has_body: bool,
    body: Option<IncomingBody>,
    respond: Option<oneshot::Sender<Outgoing>>,
    /// Response produced before the hyper task armed `respond` (handler settled during the
    /// trampoline's microtask checkpoint); the task picks it up.
    early: Option<Outgoing>,
    /// The handler has produced its response (sent or parked in `early`).
    answered: bool,
    t0: Option<std::time::Instant>,
}

mod io_alias {
    pub trait AsyncReadWriteUnpin: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send {}
    impl<T: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send> AsyncReadWriteUnpin for T {}
}

fn build_response(out: Outgoing) -> Response<ResponseBody> {
    let mut resp = Response::new(match out.stream { Some(stream) => ResponseBody::Stream(stream), None => ResponseBody::Full(Full::new(out.body)) });
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

thread_local! {
    /// Per server id: queue for requests arriving before the handler is registered.
    static CONTROLS: RefCell<HashMap<u32, ServerControl>> = RefCell::new(HashMap::new());
    static HYPER_TX: RefCell<HashMap<u32, mpsc::Sender<IncomingReq>>> = RefCell::new(HashMap::new());
}

/// AsyncRead/AsyncWrite that first yields bytes already read by the fast path.
struct Prefixed<T> {
    inner: T,
    prefix: Vec<u8>,
    pos: usize,
}
impl<T: tokio::io::AsyncRead + Unpin> tokio::io::AsyncRead for Prefixed<T> {
    fn poll_read(mut self: std::pin::Pin<&mut Self>, cx: &mut std::task::Context<'_>, buf: &mut tokio::io::ReadBuf<'_>) -> std::task::Poll<std::io::Result<()>> {
        if self.pos < self.prefix.len() {
            let n = std::cmp::min(buf.remaining(), self.prefix.len() - self.pos);
            let start = self.pos;
            buf.put_slice(&self.prefix[start..start + n]);
            self.pos += n;
            return std::task::Poll::Ready(Ok(()));
        }
        std::pin::Pin::new(&mut self.inner).poll_read(cx, buf)
    }
}
impl<T: tokio::io::AsyncWrite + Unpin> tokio::io::AsyncWrite for Prefixed<T> {
    fn poll_write(mut self: std::pin::Pin<&mut Self>, cx: &mut std::task::Context<'_>, buf: &[u8]) -> std::task::Poll<std::io::Result<usize>> { std::pin::Pin::new(&mut self.inner).poll_write(cx, buf) }
    fn poll_flush(mut self: std::pin::Pin<&mut Self>, cx: &mut std::task::Context<'_>) -> std::task::Poll<std::io::Result<()>> { std::pin::Pin::new(&mut self.inner).poll_flush(cx) }
    fn poll_shutdown(mut self: std::pin::Pin<&mut Self>, cx: &mut std::task::Context<'_>) -> std::task::Poll<std::io::Result<()>> { std::pin::Pin::new(&mut self.inner).poll_shutdown(cx) }
    fn poll_write_vectored(mut self: std::pin::Pin<&mut Self>, cx: &mut std::task::Context<'_>, bufs: &[std::io::IoSlice<'_>]) -> std::task::Poll<std::io::Result<usize>> { std::pin::Pin::new(&mut self.inner).poll_write_vectored(cx, bufs) }
    fn is_write_vectored(&self) -> bool { self.inner.is_write_vectored() }
}

/// One request on the hyper path.
async fn serve_one(rid: u32, req: Request<IncomingBody>, tx: mpsc::Sender<IncomingReq>) -> Result<Response<ResponseBody>, hyper::Error> {
    if raw_mode() {
        let mut resp = Response::new(ResponseBody::Full(Full::new(Bytes::from_static(b"Hello, World!"))));
        resp.headers_mut().insert(CONTENT_TYPE, HeaderValue::from_static("text/plain;charset=UTF-8"));
        return Ok(resp);
    }
    let (parts, body) = req.into_parts();
    let t0 = if stats_enabled() { Some(std::time::Instant::now()) } else { None };
    // Decide synchronously (no `Rc<Direct>` may live across an await).
    let step = dispatch(rid, CurrentReq::Parts(parts), Some(body), t0);
    let rrx = match step {
        Step::Done(out) => return Ok(build_response(out)),
        Step::Pending(rrx) => rrx,
        Step::Queue(msg, rrx) => {
            if tx.send(msg).await.is_err() {
                return Ok(Response::builder().status(503).body(ResponseBody::Full(Full::new(Bytes::new()))).unwrap());
            }
            rrx
        }
    };
    match rrx.await {
        Ok(out) => Ok(build_response(out)),
        Err(_) => Ok(Response::builder().status(500).body(ResponseBody::Full(Full::new(Bytes::new()))).unwrap()),
    }
}

/// The fast path met a request it does not handle: continue the connection on hyper.
pub(crate) fn hyper_takeover(rid: u32, std_stream: std::net::TcpStream, prefix: Vec<u8>, live: Option<std::sync::Arc<std::sync::atomic::AtomicUsize>>) {
    let live = LiveConnection(live);
    let Some(mut shutdown) = CONTROLS.with(|c| c.borrow().get(&rid).map(|c| c.shutdown.subscribe())) else { return };
    let Ok(stream) = tokio::net::TcpStream::from_std(std_stream) else { return };
    let tx = HYPER_TX.with(|h| h.borrow().get(&rid).cloned());
    let Some(tx) = tx else { return };
    let io = TokioIo::new(Prefixed { inner: stream, prefix, pos: 0 });
    tokio::spawn(async move {
        let _live = live;
        let svc = service_fn(move |req: Request<IncomingBody>| {
            let tx = tx.clone();
            async move { serve_one(rid, req, tx).await }
        });
        let mut b = hyper_util::server::conn::auto::Builder::new(hyper_util::rt::TokioExecutor::new());
        b.http1().keep_alive(true);
        let connection = b.serve_connection(io, svc);
        tokio::pin!(connection);
        if *shutdown.borrow() { connection.as_mut().graceful_shutdown(); }
        tokio::select! {
            _ = &mut connection => {},
            _ = shutdown.changed() => { connection.as_mut().graceful_shutdown(); let _ = connection.await; }
        }
    });
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
    /// Bound port, for `address()` after listening on port 0.
    port: u16,
    rx: mpsc::Receiver<IncomingReq>,
}

struct ServerControl {
    addr: SocketAddr,
    live: std::sync::Arc<std::sync::atomic::AtomicUsize>,
    shutdown: tokio::sync::watch::Sender<bool>,
}
struct LiveConnection(Option<std::sync::Arc<std::sync::atomic::AtomicUsize>>);
impl Drop for LiveConnection {
    fn drop(&mut self) {
        if let Some(live) = &self.0 { live.fetch_sub(1, std::sync::atomic::Ordering::Relaxed); }
    }
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
    stopped: bool,
    task: Option<std::thread::JoinHandle<()>>,
}
static HUBS: std::sync::Mutex<Option<HashMap<SocketAddr, std::sync::Arc<std::sync::Mutex<Hub>>>>> = std::sync::Mutex::new(None);
/// Bound address of the n-th port-0 listen of each thread, keyed by (ip, n).
static EPHEMERAL: std::sync::LazyLock<std::sync::Mutex<HashMap<(std::net::IpAddr, u32), SocketAddr>>> = std::sync::LazyLock::new(|| std::sync::Mutex::new(HashMap::new()));
thread_local! { static EPHEMERAL_SEQ: std::cell::Cell<u32> = const { std::cell::Cell::new(0) }; }

fn bind_listener(addr: SocketAddr) -> std::io::Result<std::net::TcpListener> {
    use socket2::{Domain, Protocol, Socket, Type};
    let sock = Socket::new(Domain::for_address(addr), Type::STREAM, Some(Protocol::TCP))?;
    sock.set_reuse_address(true)?;
    // cluster workers (separate processes) share the port through the kernel.
    #[cfg(unix)]
    if std::env::var("KESTREL_REUSEPORT").is_ok() {
        sock.set_reuse_port(true)?;
    }
    sock.set_nodelay(true)?;
    sock.bind(&addr.into())?;
    sock.listen(4096)?;
    Ok(sock.into())
}

/// Connections a worker takes before the acceptor starts filling the next one
/// (`KESTREL_PACK`, default 16; 0 = plain least-loaded).
fn pack_limit() -> usize {
    static PACK: std::sync::OnceLock<usize> = std::sync::OnceLock::new();
    *PACK.get_or_init(|| std::env::var("KESTREL_PACK").ok().and_then(|v| v.parse().ok()).unwrap_or(16))
}

pub type ConnRx = mpsc::UnboundedReceiver<(std::net::TcpStream, std::sync::Arc<std::sync::atomic::AtomicUsize>)>;

/// Join (or create) the acceptor for `addr`. Connections go to the worker with the fewest
/// live connections, so long-lived clients spread evenly across runtimes.
fn join_hub(addr: SocketAddr, expected: usize) -> std::io::Result<(ConnRx, SocketAddr, std::sync::Arc<std::sync::atomic::AtomicUsize>)> {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let (ctx, crx) = mpsc::unbounded_channel();
    let count = std::sync::Arc::new(AtomicUsize::new(0));
    let mut hubs = HUBS.lock().unwrap();
    let hubs = hubs.get_or_insert_with(HashMap::new);
    // Port 0: every worker thread runs the same module, so its n-th ephemeral listen must
    // join the hub the first thread bound for its own n-th. Key by (ip, n) and remember the
    // bound address; HUBS is held while binding, so exactly one thread binds.
    let mut pre_bound = None;
    let addr = if addr.port() == 0 {
        let seq = EPHEMERAL_SEQ.with(|c| { let v = c.get() + 1; c.set(v); v });
        let mut eph = EPHEMERAL.lock().unwrap();
        match eph.get(&(addr.ip(), seq)) {
            Some(a) => *a,
            None => {
                let l = bind_listener(addr)?;
                let bound = l.local_addr()?;
                eph.insert((addr.ip(), seq), bound);
                pre_bound = Some(l);
                bound
            }
        }
    } else {
        addr
    };
    if let Some(hub) = hubs.get(&addr) {
        let mut h = hub.lock().unwrap();
        h.senders.push((ctx, count.clone()));
        return Ok((crx, addr, count));
    }
    let listener = match pre_bound { Some(l) => l, None => bind_listener(addr)? };
    let hub = std::sync::Arc::new(std::sync::Mutex::new(Hub { senders: vec![(ctx, count.clone())], expected, stopped: false, task: None }));
    hubs.insert(addr, hub.clone());
    let thread_hub = hub.clone();
    let task = std::thread::Builder::new()
        .name(format!("kestrel-accept-{}", addr.port()))
        .spawn(move || {
            let hub = thread_hub;
            // Give the worker runtimes a moment to boot and join, so the first connections
            // are not all pinned to whichever worker happened to be up first.
            let t0 = std::time::Instant::now();
            while t0.elapsed() < std::time::Duration::from_secs(3) {
                let h = hub.lock().unwrap();
                if h.stopped { return; }
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
                if h.stopped { break; }
                let mut stream = Some(stream);
                while !h.senders.is_empty() {
                    // Pack connections onto as few workers as needed (up to `pack` per worker,
                    // fullest-first), then least-loaded. A worker with 2–4 mostly idle
                    // keep-alive connections spends its time sleeping and waking in epoll_wait;
                    // measured on a 128-vCPU host at 256 connections: 16 workers 492 k req/s,
                    // 64 workers 430 k. With thousands of connections every worker fills up
                    // and the policy degenerates to least-loaded.
                    let pack = pack_limit();
                    let i = h
                        .senders
                        .iter()
                        .enumerate()
                        .map(|(i, (_, c))| (i, c.load(Ordering::Relaxed)))
                        .filter(|&(_, n)| n < pack)
                        .max_by_key(|&(_, n)| n)
                        .map(|(i, _)| i)
                        .unwrap_or_else(|| h.senders.iter().enumerate().min_by_key(|(_, (_, c))| c.load(Ordering::Relaxed)).unwrap().0);
                    let (tx, c) = &h.senders[i];
                    if fast_log() { eprintln!("[hub :{}] -> sender {i} of {}", addr.port(), h.senders.len()); }
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
    hub.lock().unwrap().task = Some(task);
    Ok((crx, addr, count))
}

/// Stop accepting on this worker, then drain its existing responses.
pub(crate) fn is_closing(rid: u32) -> bool {
    CONTROLS.with(|c| !c.borrow().contains_key(&rid))
}

pub async fn close(state: Rc<RefCell<OpState>>, rid: u32) {
    let control = CONTROLS.with(|c| c.borrow_mut().remove(&rid));
    let Some(control) = control else { return };
    let task = {
        let mut hubs = HUBS.lock().unwrap();
        let hubs = hubs.as_mut().unwrap();
        let mut task = None;
        if let Some(hub) = hubs.get(&control.addr).cloned() {
            let mut hub = hub.lock().unwrap();
            hub.senders.retain(|(_, live)| !std::sync::Arc::ptr_eq(live, &control.live));
            if hub.senders.is_empty() {
                hub.stopped = true;
                task = hub.task.take();
                hubs.remove(&control.addr);
                EPHEMERAL.lock().unwrap().retain(|_, addr| *addr != control.addr);
            }
        }
        task
    };
    if let Some(task) = task {
        // Wake the blocking acceptor so it drops the listening socket before close resolves.
        let mut addr = control.addr;
        if addr.ip().is_unspecified() {
            addr.set_ip(if addr.is_ipv4() { std::net::Ipv4Addr::LOCALHOST.into() } else { std::net::Ipv6Addr::LOCALHOST.into() });
        }
        let _ = std::net::TcpStream::connect_timeout(&addr, std::time::Duration::from_secs(1));
        let _ = task.join();
    }
    let _ = control.shutdown.send(true);
    crate::fastpath::close_server(rid);
    while control.live.load(std::sync::atomic::Ordering::Relaxed) > 0 {
        tokio::time::sleep(std::time::Duration::from_millis(1)).await;
    }
    HYPER_TX.with(|h| h.borrow_mut().remove(&rid));
    DIRECT.with(|d| d.borrow_mut().remove(&rid));
    SERVER_TLS.with(|t| t.borrow_mut().remove(&rid));
    state_mut(&mut state.borrow_mut()).servers.remove(&rid);
}

pub fn listen(state: &mut OpState, host: &str, port: u16, expected_workers: u32) -> Result<u32, JsErrorBox> {
    let addr: SocketAddr = format!("{host}:{port}")
        .parse()
        .map_err(|e| JsErrorBox::type_error(format!("bad address {host}:{port}: {e}")))?;
    let (conns, bound_addr, live) = join_hub(addr, expected_workers.max(1) as usize).map_err(|e| JsErrorBox::generic(format!("listen {addr}: {e}")))?;
    let bound_port = bound_addr.port();
    let mut conns = Some(conns);

    let (tx, rx) = mpsc::channel::<IncomingReq>(16384);
    // Allocate the server id first: connections and handlers are keyed by it.
    let rid = {
        let hs = state_mut(state);
        let rid = hs.next_rid;
        hs.next_rid += 1;
        rid
    };
    let (shutdown, shutdown_rx) = tokio::sync::watch::channel(false);
    CONTROLS.with(|c| c.borrow_mut().insert(rid, ServerControl { addr: bound_addr, live, shutdown }));
    HYPER_TX.with(|h| h.borrow_mut().insert(rid, tx.clone()));
    SERVER_TLS.with(|t| t.borrow_mut().insert(rid, crate::netimpl::TLS_ACCEPTOR.with(|a| a.borrow().is_some())));
    let use_fast = crate::fastpath::enabled() && crate::netimpl::TLS_ACCEPTOR.with(|t| t.borrow().is_none()) && !raw_mode() && crate::fastpath::start_for(expected_workers.max(1));
    // The fast loop drains the receiver itself (see fastpath::Fast::rxs); it owns each
    // connection and decrements the live count when it closes.
    if use_fast {
        if let Some(rx) = conns.take() {
            if !crate::fastpath::adopt(rid, rx) {
                // Loop not running after all: nothing to serve this receiver; fall back is
                // impossible once the receiver is moved, so this branch must not happen.
                unreachable!("fast loop started but refused the receiver");
            }
        }
    }
    // Captured once: the thread-local config belongs to this server, not to later ones.
    let tls_cfg = crate::netimpl::TLS_ACCEPTOR.with(|t| t.borrow().clone());
    tokio::spawn(async move {
        let Some(mut conns) = conns else { return };
        while let Some((std_stream, live)) = conns.recv().await {
            if *shutdown_rx.borrow() { live.fetch_sub(1, std::sync::atomic::Ordering::Relaxed); continue; }
            if std_stream.set_nonblocking(true).is_err() {
                live.fetch_sub(1, std::sync::atomic::Ordering::Relaxed);
                continue;
            }
            let Ok(stream) = tokio::net::TcpStream::from_std(std_stream) else { live.fetch_sub(1, std::sync::atomic::Ordering::Relaxed); continue };
            let tx = tx.clone();
            let tls = tls_cfg.clone();
            let mut shutdown = shutdown_rx.clone();
            tokio::spawn(async move {
                let _live = LiveConnection(Some(live));
                // Plain TCP or TLS-terminated: both end up as a boxed AsyncRead+AsyncWrite.
                let io: Box<dyn io_alias::AsyncReadWriteUnpin> = match tls {
                    Some(acceptor) => match acceptor.accept(stream).await {
                        Ok(s) => Box::new(s),
                        Err(_) => return,
                    },
                    None => Box::new(stream),
                };
                let io = TokioIo::new(io);
                let svc = service_fn(move |req: Request<IncomingBody>| {
                    let tx = tx.clone();
                    async move { serve_one(rid, req, tx).await }
                });
                // No pipeline_flush: it delays flushing a response until the read side goes
                // idle, which adds milliseconds of latency to non-pipelined clients.
                // HTTP/1.1 or HTTP/2 (ALPN "h2", or the h2c preface), decided per connection.
                let mut b = hyper_util::server::conn::auto::Builder::new(hyper_util::rt::TokioExecutor::new());
                b.http1().keep_alive(true);
                let connection = b.serve_connection(io, svc);
                tokio::pin!(connection);
                if *shutdown.borrow() { connection.as_mut().graceful_shutdown(); }
                tokio::select! {
                    _ = &mut connection => {},
                    _ = shutdown.changed() => { connection.as_mut().graceful_shutdown(); let _ = connection.await; }
                }
            });
        }
    });

    let hs = state_mut(state);
    hs.servers.insert(rid, Rc::new(RefCell::new(HttpServer { rx, port: bound_port })));
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
    let mut shutdown = CONTROLS.with(|c| c.borrow().get(&rid).map(|c| c.shutdown.subscribe()))
        .ok_or_else(|| JsErrorBox::generic("server closed"))?;
    let mut batch: Vec<IncomingReq> = Vec::with_capacity(64);
    {
        // Only one accept loop per server, so this borrow never contends.
        let mut s = server.borrow_mut();
        let first = tokio::select! {
            r = s.rx.recv() => r.ok_or_else(|| JsErrorBox::generic("server closed"))?,
            _ = shutdown.changed() => return Err(JsErrorBox::generic("server closed")),
        };
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
        hs.pending.insert(id, Pending { tls: req.tls, parts: req.parts, has_body: true, body: Some(req.body), respond: Some(req.respond), early: None, answered: false, t0: req.t0 });
        ids.push(id);
    }
    Ok(ids)
}

fn with_parts<R>(state: &mut OpState, id: u32, f: impl FnOnce(&hyper::http::request::Parts) -> R) -> Option<R> {
    let mut f = Some(f);
    if let Some(r) = CURRENT.with(|c| {
        c.borrow().as_ref().filter(|c| c.id == id).map(|c| match &c.req {
            CurrentReq::Parts(p) => (f.take().unwrap())(p),
            CurrentReq::Raw(r) => { let p = r.to_parts(); (f.take().unwrap())(&p) }
        })
    }) {
        return Some(r);
    }
    let hs = state_mut(state);
    hs.pending.get(&id).map(|p| (f.take().unwrap())(&p.parts))
}

/// Move the synchronously-handled request into the pending table (called by ops that need a
/// durable slot while the trampoline is still on the stack).
fn park_current(hs: &mut HttpState, id: u32) {
    let cur = CURRENT.with(|c| { let mut c = c.borrow_mut(); if c.as_ref().is_some_and(|c| c.id == id) { c.take() } else { None } });
    if let Some(c) = cur {
        let tls = c.tls;
        let (parts, has_body) = match c.req { CurrentReq::Parts(p) => (p, true), CurrentReq::Raw(r) => (r.to_parts(), false) };
        hs.pending.entry(id).or_insert(Pending { tls, parts, has_body, body: None, respond: None, early: None, answered: false, t0: None });
    }
}

pub fn method(state: &mut OpState, id: u32) -> String {
    with_parts(state, id, |p| p.method.as_str().to_string()).unwrap_or_default()
}

/// Node needs the original request target, not a WHATWG-normalized URL. Read all
/// metadata in one operation, without repeatedly materializing RawReq as Parts.
pub fn node_request(state: &mut OpState, id: u32) -> String {
    fn parts(p: &hyper::http::request::Parts) -> String {
        let mut out = format!("{}\0{}\0", p.method, p.uri);
        for (k, v) in &p.headers {
            out.push_str(k.as_str()); out.push('\0');
            out.push_str(v.to_str().unwrap_or("")); out.push('\0');
        }
        out
    }
    if let Some(out) = CURRENT.with(|c| {
        c.borrow().as_ref().filter(|c| c.id == id).map(|c| match &c.req {
            CurrentReq::Parts(p) => parts(p),
            CurrentReq::Raw(r) => {
                let mut out = String::with_capacity(r.headers.len());
                out.push_str(r.method()); out.push('\0');
                out.push_str(r.path()); out.push('\0');
                // The fast parser already validated this header block.
                let block = String::from_utf8_lossy(&r.headers);
                for line in block.split('\n').skip(1) {
                    let line = line.trim_end_matches('\r');
                    if line.is_empty() { break; }
                    if let Some((name, value)) = line.split_once(':') {
                        out.push_str(name); out.push('\0');
                        out.push_str(value.trim_matches([' ', '\t'])); out.push('\0');
                    }
                }
                out
            }
        })
    }) { return out; }
    state_mut(state).pending.get(&id).map(|p| parts(&p.parts)).unwrap_or_default()
}

pub fn port(state: &mut OpState, rid: u32) -> u16 {
    let hs = state_mut(state);
    hs.servers.get(&rid).map(|s| s.borrow().port).unwrap_or(0)
}

pub fn version(state: &mut OpState, id: u32) -> u32 {
    with_parts(state, id, |p| match p.version {
        hyper::Version::HTTP_10 => 10,
        hyper::Version::HTTP_2 => 2,
        hyper::Version::HTTP_3 => 3,
        _ => 11,
    })
    .unwrap_or(11)
}

/// Absolute URL, as `Request.url` is in Node/WHATWG: HTTP/1 requests carry only the path,
/// so the scheme comes from the server and the authority from the Host header.
pub fn url(state: &mut OpState, id: u32) -> String {
    let tls = with_tls(state, id);
    with_parts(state, id, |p| {
        if p.uri.scheme().is_some() {
            return p.uri.to_string();
        }
        let host = p.headers.get(hyper::header::HOST).and_then(|h| h.to_str().ok()).unwrap_or("localhost");
        let path = p.uri.path_and_query().map(|pq| pq.as_str()).unwrap_or("/");
        format!("{}://{}{}", if tls { "https" } else { "http" }, host, path)
    })
    .unwrap_or_default()
}

fn with_tls(state: &mut OpState, id: u32) -> bool {
    if let Some(t) = CURRENT.with(|c| c.borrow().as_ref().filter(|c| c.id == id).map(|c| c.tls)) {
        return t;
    }
    state_mut(state).pending.get(&id).map(|p| p.tls).unwrap_or(false)
}

pub fn respond(state: &mut OpState, id: u32, status: u16, headers: &str, body: Bytes) -> Result<(), JsErrorBox> {
    respond_out(state, id, Outgoing { status, headers: headers.to_string(), body, stream: None })
}
fn respond_out(state: &mut OpState, id: u32, out: Outgoing) -> Result<(), JsErrorBox> {
    let hs = state_mut(state);
    park_current(hs, id);
    let p = hs.pending.get_mut(&id).ok_or_else(|| JsErrorBox::type_error("response already sent"))?;
    if p.answered {
        return Err(JsErrorBox::type_error("response already sent"));
    }
    p.answered = true;
    let Some(tx) = p.respond.take() else {
        // Answered during the trampoline's microtask checkpoint, before the hyper task armed
        // its channel: park the result; the task picks it up when it arms.
        p.early = Some(out);
        return Ok(());
    };
    if let Some(t0) = p.t0 {
        let us = t0.elapsed().as_micros() as u32;
        STATS.with(|s| { if let Some(st) = s.borrow_mut().as_mut() { st.lat_us.push(us); } });
    }
    let keep_body = out.stream.is_some() && p.has_body;
    let _ = tx.send(out);
    // The handler is done with this request; an unread body is dropped with the slot.
    if !keep_body { hs.pending.remove(&id); }
    Ok(())
}

/// Read the whole request body. The pending slot is freed once both body and response are done.
pub async fn body(state: Rc<RefCell<OpState>>, id: u32) -> Result<Vec<u8>, JsErrorBox> {
    // If the handler asks for the body while the trampoline is still running, the body is
    // still owned by the hyper task; the task hands it over once the handler goes async.
    // We therefore wait (yielding) until the slot has a body or the task has finished.
    let body = loop {
        {
            let mut st = state.borrow_mut();
            let hs = state_mut(&mut st);
            park_current(hs, id);
            // Slot gone: the request already completed; treat the body as empty rather than
            // erroring (a consumer may read after the response is done).
            let Some(p) = hs.pending.get_mut(&id) else { break None };
            if let Some(b) = p.body.take() { break Some(b); }
            // A streamed header may be committed during the trampoline's
            // microtask checkpoint, before hyper has attached the request body.
            let early_stream = p.early.as_ref().is_some_and(|out| out.stream.is_some());
            if !p.has_body || (p.answered && !early_stream) { break None; }
        }
        BODY_WAIT.with(|w| w.set(true));
        tokio::task::yield_now().await;
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
    with_parts(state, id, |p| {
        let mut out = String::new();
        for (k, v) in p.headers.iter() {
            out.push_str(k.as_str());
            out.push('\0');
            out.push_str(v.to_str().unwrap_or(""));
            out.push('\0');
        }
        out
    })
    .unwrap_or_default()
}
thread_local! { static BODY_WAIT: std::cell::Cell<bool> = const { std::cell::Cell::new(false) }; }

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

/// Commit headers immediately. Each stream buffers at most one 64 KiB chunk in
/// addition to the transport's current write and the JS Writable high-water mark.
pub fn stream_start(state: &mut OpState, id: u32, status: u16, headers: &str) -> Result<u32, JsErrorBox> {
    let suppress = method(state, id) == "HEAD" || status == 204 || status == 304 || status < 200;
    let (tx, rx) = mpsc::channel(1);
    let complete = Arc::new(AtomicBool::new(false));
    let closed = Arc::new(AtomicBool::new(false));
    let notify = Arc::new(tokio::sync::Notify::new());
    let response = Outgoing { status, headers: headers.to_string(), body: Bytes::new(), stream: Some(Box::new(ResponseStream { rx, suppress, complete: complete.clone(), closed: closed.clone(), notify: notify.clone() })) };
    respond_out(state, id, response)?;
    let streams = streams(state); let stream_id = streams.next; streams.next += 1;
    streams.senders.insert(stream_id, StreamSender { tx, complete, closed, notify, request: id, suppress });
    Ok(stream_id)
}
pub async fn stream_write(state: Rc<RefCell<OpState>>, id: u32, bytes: Vec<u8>) -> Result<(), JsErrorBox> {
    let (tx, suppress) = streams(&mut state.borrow_mut()).senders.get(&id).map(|s| (s.tx.clone(), s.suppress)).ok_or_else(|| JsErrorBox::generic("response stream closed"))?;
    if suppress { return Ok(()); }
    let bytes = Bytes::from(bytes);
    for chunk in (0..bytes.len()).step_by(65536) {
        tx.send(bytes.slice(chunk..(chunk + 65536).min(bytes.len()))).await.map_err(|_| JsErrorBox::generic("client disconnected"))?;
    }
    Ok(())
}
pub fn stream_end(state: &mut OpState, id: u32, abort: bool) {
    if let Some(stream) = streams(state).senders.remove(&id) {
        stream.complete.store(!abort, Ordering::Relaxed);
        let hs = state_mut(state);
        if hs.pending.get(&stream.request).is_some_and(|p| p.early.is_none()) { hs.pending.remove(&stream.request); }
    }
}

/// Only connections that actually stream leave the fast loop. Their current
/// response is written with backpressure, then keepalive/pipelined requests go
/// through hyper. The live guard remains owned until the whole connection ends.
pub(crate) fn streaming_takeover(rid: u32, socket: std::net::TcpStream, mut prefix: Vec<u8>, previous: Vec<u8>, mut out: Outgoing, close: bool, live: Option<Arc<std::sync::atomic::AtomicUsize>>) {
    let mut guard = LiveConnection(live);
    let Ok(mut socket) = tokio::net::TcpStream::from_std(socket) else { return };
    let mut headers = previous;
    crate::fastpath::write_response(&mut headers, &out, close);
    let mut stream = out.stream.take().unwrap();
    let chunked = !stream.suppress && !out.headers.split('\0').step_by(2).any(|k| k.eq_ignore_ascii_case("content-length"));
    tokio::spawn(async move {
        use tokio::io::{AsyncWriteExt, AsyncReadExt};
        let result: std::io::Result<()> = async {
            socket.write_all(&headers).await?;
            let mut inbound = [0u8; 4096];
            loop {
                let chunk = tokio::select! {
                    chunk = stream.rx.recv() => match chunk { Some(chunk) => chunk, None => break },
                    received = socket.read(&mut inbound), if prefix.len() < 65536 => {
                        let n = received?;
                        if n == 0 { return Err(std::io::Error::other("client disconnected")); }
                        prefix.extend_from_slice(&inbound[..n]);
                        continue;
                    }
                };
                if chunk.is_empty() || stream.suppress { continue; }
                if chunked { socket.write_all(format!("{:x}\r\n", chunk.len()).as_bytes()).await?; }
                socket.write_all(&chunk).await?;
                if chunked { socket.write_all(b"\r\n").await?; }
            }
            if !stream.complete.load(Ordering::Relaxed) { return Err(std::io::Error::other("aborted response")); }
            if chunked { socket.write_all(b"0\r\n\r\n").await?; }
            Ok(())
        }.await;
        if result.is_ok() && !close && !is_closing(rid) {
            if let Ok(socket) = socket.into_std() { hyper_takeover(rid, socket, prefix, guard.0.take()); }
        }
    });
}

pub async fn stream_closed(state: Rc<RefCell<OpState>>, id: u32) -> bool {
    let signals = streams(&mut state.borrow_mut()).senders.get(&id).map(|s| (s.closed.clone(), s.notify.clone(), s.complete.clone(), s.suppress));
    let Some((closed, notify, complete, suppress)) = signals else { return false };
    loop {
        let notified = notify.notified();
        if closed.load(Ordering::Relaxed) { return !suppress && !complete.load(Ordering::Relaxed); }
        notified.await;
    }
}
