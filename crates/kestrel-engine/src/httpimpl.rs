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

pub struct Outgoing {
    pub status: u16,
    pub content_type: String,
    pub body: Bytes,
}

pub struct IncomingReq {
    pub method: String,
    pub uri: String,
    pub headers: hyper::HeaderMap,
    pub respond: oneshot::Sender<Outgoing>,
}

struct Pending {
    headers: hyper::HeaderMap,
    respond: oneshot::Sender<Outgoing>,
}

pub struct HttpServer {
    rx: mpsc::Receiver<IncomingReq>,
}

#[derive(Default)]
pub struct HttpState {
    servers: HashMap<u32, Rc<RefCell<HttpServer>>>,
    next_rid: u32,
    next_req: u32,
    pending: HashMap<u32, Pending>,
}

fn state_mut(state: &mut OpState) -> &mut HttpState {
    if state.try_borrow::<HttpState>().is_none() {
        state.put(HttpState::default());
    }
    state.borrow_mut::<HttpState>()
}

/// One blocking acceptor thread per bound address hands connections to worker
/// runtimes round-robin. (macOS SO_REUSEPORT does not balance across sockets,
/// so per-thread listeners would leave all but one worker idle.)
struct Hub {
    senders: Vec<mpsc::UnboundedSender<std::net::TcpStream>>,
    next: usize,
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

fn join_hub(addr: SocketAddr) -> std::io::Result<mpsc::UnboundedReceiver<std::net::TcpStream>> {
    let (ctx, crx) = mpsc::unbounded_channel::<std::net::TcpStream>();
    let mut hubs = HUBS.lock().unwrap();
    let hubs = hubs.get_or_insert_with(HashMap::new);
    if let Some(hub) = hubs.get(&addr) {
        hub.lock().unwrap().senders.push(ctx);
        return Ok(crx);
    }
    let listener = bind_listener(addr)?;
    let hub = std::sync::Arc::new(std::sync::Mutex::new(Hub { senders: vec![ctx], next: 0 }));
    hubs.insert(addr, hub.clone());
    std::thread::Builder::new()
        .name(format!("kestrel-accept-{}", addr.port()))
        .spawn(move || loop {
            let Ok((stream, _)) = listener.accept() else { continue };
            let _ = stream.set_nodelay(true);
            let mut h = hub.lock().unwrap();
            let n = h.senders.len();
            if n == 0 {
                continue;
            }
            let mut stream = Some(stream);
            for _ in 0..n {
                let i = h.next % h.senders.len();
                h.next = h.next.wrapping_add(1);
                match h.senders[i].send(stream.take().unwrap()) {
                    Ok(()) => break,
                    Err(e) => {
                        // Worker is gone; drop it and try the next one.
                        h.senders.remove(i);
                        if h.senders.is_empty() {
                            break;
                        }
                        stream = Some(e.0);
                    }
                }
            }
        })?;
    Ok(crx)
}

pub fn listen(state: &mut OpState, host: &str, port: u16) -> Result<u32, JsErrorBox> {
    let addr: SocketAddr = format!("{host}:{port}")
        .parse()
        .map_err(|e| JsErrorBox::type_error(format!("bad address {host}:{port}: {e}")))?;
    let mut conns = join_hub(addr).map_err(|e| JsErrorBox::generic(format!("listen {addr}: {e}")))?;

    let (tx, rx) = mpsc::channel::<IncomingReq>(1024);
    tokio::spawn(async move {
        while let Some(std_stream) = conns.recv().await {
            if std_stream.set_nonblocking(true).is_err() {
                continue;
            }
            let Ok(stream) = tokio::net::TcpStream::from_std(std_stream) else { continue };
            let tx = tx.clone();
            tokio::spawn(async move {
                let io = TokioIo::new(stream);
                let svc = service_fn(move |req: Request<IncomingBody>| {
                    let tx = tx.clone();
                    async move {
                        let (parts, _body) = req.into_parts();
                        let (rtx, rrx) = oneshot::channel();
                        let msg = IncomingReq {
                            method: parts.method.as_str().to_string(),
                            uri: parts.uri.to_string(),
                            headers: parts.headers,
                            respond: rtx,
                        };
                        if tx.send(msg).await.is_err() {
                            return Ok::<_, hyper::Error>(Response::builder().status(503).body(Full::new(Bytes::new())).unwrap());
                        }
                        match rrx.await {
                            Ok(out) => {
                                let mut resp = Response::new(Full::new(out.body));
                                *resp.status_mut() = hyper::StatusCode::from_u16(out.status).unwrap_or(hyper::StatusCode::INTERNAL_SERVER_ERROR);
                                if let Ok(v) = HeaderValue::from_str(&out.content_type) {
                                    resp.headers_mut().insert(CONTENT_TYPE, v);
                                }
                                Ok(resp)
                            }
                            Err(_) => Ok(Response::builder().status(500).body(Full::new(Bytes::new())).unwrap()),
                        }
                    }
                });
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
    Ok(rid)
}

/// Wait for the next request. Returns "id\0METHOD\0uri".
pub async fn accept(state: Rc<RefCell<OpState>>, rid: u32) -> Result<String, JsErrorBox> {
    let server = {
        let mut st = state.borrow_mut();
        let hs = state_mut(&mut st);
        hs.servers.get(&rid).cloned().ok_or_else(|| JsErrorBox::type_error("bad server id"))?
    };
    let req = {
        // Only one accept loop per server, so this borrow never contends.
        let mut s = server.borrow_mut();
        s.rx.recv().await
    };
    let req = req.ok_or_else(|| JsErrorBox::generic("server closed"))?;
    let mut st = state.borrow_mut();
    let hs = state_mut(&mut st);
    let id = hs.next_req;
    hs.next_req = hs.next_req.wrapping_add(1);
    hs.pending.insert(id, Pending { headers: req.headers, respond: req.respond });
    let mut out = String::with_capacity(16 + req.method.len() + req.uri.len());
    use std::fmt::Write;
    let _ = write!(out, "{id}\0{}\0{}", req.method, req.uri);
    Ok(out)
}

pub fn respond(state: &mut OpState, id: u32, status: u16, content_type: &str, body: &str) -> Result<(), JsErrorBox> {
    let hs = state_mut(state);
    let p = hs.pending.remove(&id).ok_or_else(|| JsErrorBox::type_error("response already sent"))?;
    let _ = p.respond.send(Outgoing { status, content_type: content_type.to_string(), body: Bytes::copy_from_slice(body.as_bytes()) });
    Ok(())
}

/// Headers of a pending request as "k\0v\0k\0v…".
pub fn headers(state: &mut OpState, id: u32) -> String {
    let hs = state_mut(state);
    let Some(p) = hs.pending.get(&id) else { return String::new() };
    let mut out = String::new();
    for (k, v) in p.headers.iter() {
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
