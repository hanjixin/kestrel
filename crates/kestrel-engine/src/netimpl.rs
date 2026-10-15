//! TCP sockets (node:net), TLS acceptor config for HTTPS, and worker_threads ops.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::Arc;

use deno_core::{op2, OpState};
use deno_error::JsErrorBox;
use serde::Serialize;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::tcp::{OwnedReadHalf, OwnedWriteHalf};

fn io_code(e: &std::io::Error) -> &'static str {
    match e.kind() {
        std::io::ErrorKind::ConnectionRefused => "ECONNREFUSED",
        std::io::ErrorKind::ConnectionReset => "ECONNRESET",
        std::io::ErrorKind::ConnectionAborted => "ECONNABORTED",
        std::io::ErrorKind::NotConnected => "ENOTCONN",
        std::io::ErrorKind::AddrInUse => "EADDRINUSE",
        std::io::ErrorKind::AddrNotAvailable => "EADDRNOTAVAIL",
        std::io::ErrorKind::TimedOut => "ETIMEDOUT",
        std::io::ErrorKind::BrokenPipe => "EPIPE",
        std::io::ErrorKind::PermissionDenied => "EACCES",
        _ => "EIO",
    }
}
fn net_err(e: std::io::Error, syscall: &str) -> JsErrorBox {
    JsErrorBox::new("Error", format!("{}: {} ({syscall})", io_code(&e), e))
}

// ---------- TCP ----------

struct Conn {
    rd: Option<OwnedReadHalf>,
    wr: Option<OwnedWriteHalf>,
    local: std::net::SocketAddr,
    peer: std::net::SocketAddr,
}
#[derive(Default)]
struct Net {
    next: u32,
    conns: HashMap<u32, Rc<RefCell<Conn>>>,
    listeners: HashMap<u32, Rc<tokio::net::TcpListener>>,
}
fn net(state: &mut OpState) -> &mut Net {
    if state.try_borrow::<Net>().is_none() {
        state.put(Net::default());
    }
    state.borrow_mut::<Net>()
}
fn add_conn(state: &Rc<RefCell<OpState>>, s: tokio::net::TcpStream) -> u32 {
    let local = s.local_addr().unwrap_or_else(|_| "0.0.0.0:0".parse().unwrap());
    let peer = s.peer_addr().unwrap_or_else(|_| "0.0.0.0:0".parse().unwrap());
    let _ = s.set_nodelay(true);
    let (rd, wr) = s.into_split();
    let mut st = state.borrow_mut();
    let n = net(&mut st);
    let rid = n.next;
    n.next += 1;
    n.conns.insert(rid, Rc::new(RefCell::new(Conn { rd: Some(rd), wr: Some(wr), local, peer })));
    rid
}
fn conn_of(state: &Rc<RefCell<OpState>>, rid: u32) -> Result<Rc<RefCell<Conn>>, JsErrorBox> {
    let mut st = state.borrow_mut();
    net(&mut st).conns.get(&rid).cloned().ok_or_else(|| JsErrorBox::new("Error", "ERR_SOCKET_CLOSED: socket is closed"))
}

#[op2]
pub async fn op_net_connect(state: Rc<RefCell<OpState>>, #[string] host: String, port: u16) -> Result<u32, JsErrorBox> {
    let s = tokio::net::TcpStream::connect((host.as_str(), port)).await.map_err(|e| net_err(e, "connect"))?;
    Ok(add_conn(&state, s))
}

/// Read up to 64 KiB. Empty = EOF.
#[op2]
#[buffer]
pub async fn op_net_read(state: Rc<RefCell<OpState>>, rid: u32) -> Result<Vec<u8>, JsErrorBox> {
    let c = conn_of(&state, rid)?;
    let rd = c.borrow_mut().rd.take();
    let Some(mut rd) = rd else { return Ok(Vec::new()) };
    let mut buf = vec![0u8; 65536];
    let r = rd.read(&mut buf).await;
    c.borrow_mut().rd = Some(rd);
    let n = r.map_err(|e| net_err(e, "read"))?;
    buf.truncate(n);
    Ok(buf)
}

#[op2]
pub async fn op_net_write(state: Rc<RefCell<OpState>>, rid: u32, #[buffer(copy)] data: Vec<u8>) -> Result<(), JsErrorBox> {
    let c = conn_of(&state, rid)?;
    let wr = c.borrow_mut().wr.take();
    let Some(mut wr) = wr else { return Err(JsErrorBox::new("Error", "EPIPE: This socket has been ended by the other party")) };
    let r = wr.write_all(&data).await;
    c.borrow_mut().wr = Some(wr);
    r.map_err(|e| net_err(e, "write"))
}

#[op2]
pub async fn op_net_shutdown(state: Rc<RefCell<OpState>>, rid: u32) -> Result<(), JsErrorBox> {
    let c = conn_of(&state, rid)?;
    let wr = c.borrow_mut().wr.take();
    if let Some(mut wr) = wr {
        let _ = wr.shutdown().await;
    }
    Ok(())
}

#[op2(fast)]
pub fn op_net_close(state: &mut OpState, rid: u32) {
    net(state).conns.remove(&rid);
}

/// [localAddress, localPort, remoteAddress, remotePort]
#[op2]
#[serde]
pub fn op_net_addr(state: &mut OpState, rid: u32) -> Option<(String, u16, String, u16)> {
    net(state).conns.get(&rid).map(|c| {
        let c = c.borrow();
        (c.local.ip().to_string(), c.local.port(), c.peer.ip().to_string(), c.peer.port())
    })
}

#[op2(fast)]
pub fn op_net_listen(state: &mut OpState, #[string] host: &str, port: u16) -> Result<u32, JsErrorBox> {
    let addr: std::net::SocketAddr = format!("{host}:{port}").parse().map_err(|e| JsErrorBox::type_error(format!("bad address: {e}")))?;
    let std_l = {
        use socket2::{Domain, Protocol, Socket, Type};
        let sock = Socket::new(Domain::for_address(addr), Type::STREAM, Some(Protocol::TCP)).map_err(|e| net_err(e, "socket"))?;
        let _ = sock.set_reuse_address(true);
        sock.bind(&addr.into()).map_err(|e| net_err(e, "bind"))?;
        sock.listen(1024).map_err(|e| net_err(e, "listen"))?;
        sock.set_nonblocking(true).map_err(|e| net_err(e, "listen"))?;
        std::net::TcpListener::from(sock)
    };
    let l = tokio::net::TcpListener::from_std(std_l).map_err(|e| net_err(e, "listen"))?;
    let n = net(state);
    let rid = n.next;
    n.next += 1;
    n.listeners.insert(rid, Rc::new(l));
    Ok(rid)
}

#[op2]
#[serde]
pub fn op_net_listen_addr(state: &mut OpState, rid: u32) -> Option<(String, u16)> {
    net(state).listeners.get(&rid).and_then(|l| l.local_addr().ok()).map(|a| (a.ip().to_string(), a.port()))
}

/// Resolves with the new connection's rid, or u32::MAX when the listener was closed.
#[op2]
pub async fn op_net_accept(state: Rc<RefCell<OpState>>, rid: u32) -> Result<u32, JsErrorBox> {
    let l = {
        let mut st = state.borrow_mut();
        net(&mut st).listeners.get(&rid).cloned()
    };
    let Some(l) = l else { return Ok(u32::MAX) };
    let (s, _) = l.accept().await.map_err(|e| net_err(e, "accept"))?;
    Ok(add_conn(&state, s))
}

#[op2(fast)]
pub fn op_net_close_listener(state: &mut OpState, rid: u32) {
    net(state).listeners.remove(&rid);
}

// ---------- TLS (server side, used by the HTTP backend) ----------

thread_local! {
    pub static TLS_ACCEPTOR: RefCell<Option<Arc<tokio_rustls::TlsAcceptor>>> = const { RefCell::new(None) };
}

fn install_provider() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}

/// Configure TLS for servers started on this thread afterwards.
#[op2(fast)]
pub fn op_tls_server_config(#[string] cert_pem: &str, #[string] key_pem: &str) -> Result<(), JsErrorBox> {
    install_provider();
    let certs: Vec<_> = rustls_pemfile::certs(&mut cert_pem.as_bytes())
        .collect::<Result<_, _>>()
        .map_err(|e| JsErrorBox::type_error(format!("bad certificate: {e}")))?;
    let key = rustls_pemfile::private_key(&mut key_pem.as_bytes())
        .map_err(|e| JsErrorBox::type_error(format!("bad key: {e}")))?
        .ok_or_else(|| JsErrorBox::type_error("no private key found in PEM"))?;
    let mut cfg = rustls::ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(certs, key)
        .map_err(|e| JsErrorBox::type_error(format!("tls config: {e}")))?;
    cfg.alpn_protocols = vec![b"http/1.1".to_vec()];
    TLS_ACCEPTOR.with(|t| *t.borrow_mut() = Some(Arc::new(tokio_rustls::TlsAcceptor::from(Arc::new(cfg)))));
    Ok(())
}

/// TLS client connection for node:tls / https client fallbacks.
#[op2]
pub async fn op_tls_connect(state: Rc<RefCell<OpState>>, #[string] host: String, port: u16, #[string] servername: String, reject_unauthorized: bool) -> Result<u32, JsErrorBox> {
    install_provider();
    let s = tokio::net::TcpStream::connect((host.as_str(), port)).await.map_err(|e| net_err(e, "connect"))?;
    let _ = s.set_nodelay(true);
    let root = rustls::RootCertStore { roots: webpki_roots::TLS_SERVER_ROOTS.to_vec() };
    let mut cfg = rustls::ClientConfig::builder().with_root_certificates(root).with_no_client_auth();
    if !reject_unauthorized {
        cfg.dangerous().set_certificate_verifier(Arc::new(NoVerify));
    }
    let connector = tokio_rustls::TlsConnector::from(Arc::new(cfg));
    let name = rustls::pki_types::ServerName::try_from(if servername.is_empty() { host.clone() } else { servername })
        .map_err(|e| JsErrorBox::type_error(format!("bad servername: {e}")))?;
    let tls = connector.connect(name, s).await.map_err(|e| net_err(e, "tls handshake"))?;
    let (rd, wr) = tokio::io::split(tls);
    let mut st = state.borrow_mut();
    let n = net(&mut st);
    let rid = n.next;
    n.next += 1;
    TLS_CONNS.with(|c| c.borrow_mut().insert(rid, Rc::new(RefCell::new(TlsConn { rd: Some(rd), wr: Some(wr) }))));
    Ok(rid)
}

type TlsStream = tokio_rustls::client::TlsStream<tokio::net::TcpStream>;
struct TlsConn {
    rd: Option<tokio::io::ReadHalf<TlsStream>>,
    wr: Option<tokio::io::WriteHalf<TlsStream>>,
}
thread_local! {
    static TLS_CONNS: RefCell<HashMap<u32, Rc<RefCell<TlsConn>>>> = RefCell::new(HashMap::new());
}
fn tls_conn(rid: u32) -> Result<Rc<RefCell<TlsConn>>, JsErrorBox> {
    TLS_CONNS.with(|c| c.borrow().get(&rid).cloned()).ok_or_else(|| JsErrorBox::new("Error", "ERR_SOCKET_CLOSED: socket is closed"))
}

#[op2]
#[buffer]
pub async fn op_tls_read(rid: u32) -> Result<Vec<u8>, JsErrorBox> {
    let c = tls_conn(rid)?;
    let rd = c.borrow_mut().rd.take();
    let Some(mut rd) = rd else { return Ok(Vec::new()) };
    let mut buf = vec![0u8; 65536];
    let r = rd.read(&mut buf).await;
    c.borrow_mut().rd = Some(rd);
    let n = r.map_err(|e| net_err(e, "read"))?;
    buf.truncate(n);
    Ok(buf)
}

#[op2]
pub async fn op_tls_write(rid: u32, #[buffer(copy)] data: Vec<u8>) -> Result<(), JsErrorBox> {
    let c = tls_conn(rid)?;
    let wr = c.borrow_mut().wr.take();
    let Some(mut wr) = wr else { return Err(JsErrorBox::new("Error", "EPIPE: socket has been ended")) };
    let r = wr.write_all(&data).await;
    c.borrow_mut().wr = Some(wr);
    r.map_err(|e| net_err(e, "write"))
}

#[op2]
pub async fn op_tls_shutdown(rid: u32) -> Result<(), JsErrorBox> {
    let c = tls_conn(rid)?;
    let wr = c.borrow_mut().wr.take();
    if let Some(mut wr) = wr {
        let _ = wr.shutdown().await;
    }
    Ok(())
}

#[op2(fast)]
pub fn op_tls_close(rid: u32) {
    TLS_CONNS.with(|c| c.borrow_mut().remove(&rid));
}

#[derive(Debug)]
struct NoVerify;
impl rustls::client::danger::ServerCertVerifier for NoVerify {
    fn verify_server_cert(&self, _: &rustls::pki_types::CertificateDer<'_>, _: &[rustls::pki_types::CertificateDer<'_>], _: &rustls::pki_types::ServerName<'_>, _: &[u8], _: rustls::pki_types::UnixTime) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        Ok(rustls::client::danger::ServerCertVerified::assertion())
    }
    fn verify_tls12_signature(&self, _: &[u8], _: &rustls::pki_types::CertificateDer<'_>, _: &rustls::DigitallySignedStruct) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        Ok(rustls::client::danger::HandshakeSignatureValid::assertion())
    }
    fn verify_tls13_signature(&self, _: &[u8], _: &rustls::pki_types::CertificateDer<'_>, _: &rustls::DigitallySignedStruct) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        Ok(rustls::client::danger::HandshakeSignatureValid::assertion())
    }
    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        rustls::crypto::ring::default_provider().signature_verification_algorithms.supported_schemes()
    }
}

// ---------- worker_threads ----------

/// Messages are JSON strings produced by the JS side (typed arrays encoded by it).
pub struct WorkerLink {
    pub to_worker: tokio::sync::mpsc::UnboundedSender<String>,
    pub from_worker: Arc<std::sync::Mutex<tokio::sync::mpsc::UnboundedReceiver<String>>>,
    pub exit: Arc<std::sync::Mutex<Option<i32>>>,
    pub isolate: Arc<std::sync::Mutex<Option<deno_core::v8::IsolateHandle>>>,
    pub notify: Arc<tokio::sync::Notify>,
}
#[derive(Default)]
struct Workers {
    next: u32,
    map: HashMap<u32, Rc<WorkerLink>>,
}
fn workers(state: &mut OpState) -> &mut Workers {
    if state.try_borrow::<Workers>().is_none() {
        state.put(Workers::default());
    }
    state.borrow_mut::<Workers>()
}

/// Set on worker threads before their main module runs.
pub struct WorkerSide {
    pub id: u32,
    pub data: String,
    pub to_parent: tokio::sync::mpsc::UnboundedSender<String>,
    pub from_parent: RefCell<tokio::sync::mpsc::UnboundedReceiver<String>>,
    pub exit: Arc<std::sync::Mutex<Option<i32>>>,
    pub isolate: Arc<std::sync::Mutex<Option<deno_core::v8::IsolateHandle>>>,
}
thread_local! {
    pub static WORKER_SIDE: RefCell<Option<Rc<WorkerSide>>> = const { RefCell::new(None) };
    static NEXT_THREAD_ID: std::cell::Cell<u32> = const { std::cell::Cell::new(0) };
}
static THREAD_COUNTER: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(1);

#[derive(Serialize)]
pub struct WorkerInfo {
    is_main: bool,
    thread_id: u32,
    data: Option<String>,
}

#[op2]
#[serde]
pub fn op_worker_info() -> WorkerInfo {
    WORKER_SIDE.with(|w| match w.borrow().as_ref() {
        Some(ws) => WorkerInfo { is_main: false, thread_id: ws.id, data: Some(ws.data.clone()) },
        None => WorkerInfo { is_main: true, thread_id: 0, data: None },
    })
}

#[op2(fast)]
pub fn op_worker_spawn(state: &mut OpState, #[string] path: &str, #[string] data: &str) -> Result<u32, JsErrorBox> {
    let (to_worker, from_parent) = tokio::sync::mpsc::unbounded_channel::<String>();
    let (to_parent, from_worker) = tokio::sync::mpsc::unbounded_channel::<String>();
    let exit = Arc::new(std::sync::Mutex::new(None));
    let isolate = Arc::new(std::sync::Mutex::new(None));
    let notify = Arc::new(tokio::sync::Notify::new());
    let id = THREAD_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let link = WorkerLink { to_worker, from_worker: Arc::new(std::sync::Mutex::new(from_worker)), exit: exit.clone(), isolate: isolate.clone(), notify: notify.clone() };
    let ws = WorkerSide { id, data: data.to_string(), to_parent, from_parent: RefCell::new(from_parent), exit: exit.clone(), isolate: isolate.clone() };
    let path = std::path::PathBuf::from(path);
    let argv = crate::httpimpl::MAIN.get().map(|m| m.1.clone()).unwrap_or_default();
    std::thread::Builder::new()
        .name(format!("kestrel-worker-thread-{id}"))
        .stack_size(8 << 20)
        .spawn(move || {
            WORKER_SIDE.with(|w| *w.borrow_mut() = Some(Rc::new(ws)));
            let code = crate::runtime::run_file_with_isolate_handle(&path, &argv, isolate).unwrap_or(1);
            let mut e = exit.lock().unwrap();
            if e.is_none() {
                *e = Some(code);
            }
            drop(e);
            notify.notify_waiters();
        })
        .map_err(|e| JsErrorBox::generic(e.to_string()))?;
    let w = workers(state);
    w.map.insert(id, Rc::new(link));
    w.next = id;
    Ok(id)
}

#[op2(fast)]
pub fn op_worker_post(state: &mut OpState, id: u32, #[string] msg: &str) -> Result<(), JsErrorBox> {
    let w = workers(state).map.get(&id).ok_or_else(|| JsErrorBox::type_error("worker not found"))?;
    w.to_worker.send(msg.to_string()).map_err(|_| JsErrorBox::type_error("worker has exited"))
}

/// Next message from the worker, or null once it has exited and the queue is drained.
#[op2]
#[string]
pub async fn op_worker_recv(state: Rc<RefCell<OpState>>, id: u32) -> Result<Option<String>, JsErrorBox> {
    let link = { let mut st = state.borrow_mut(); workers(&mut st).map.get(&id).cloned() };
    let Some(link) = link else { return Ok(None) };
    loop {
        let m = link.from_worker.lock().unwrap().try_recv();
        match m {
            Ok(s) => return Ok(Some(s)),
            Err(tokio::sync::mpsc::error::TryRecvError::Disconnected) => return Ok(None),
            Err(_) => {}
        }
        if link.exit.lock().unwrap().is_some() {
            // Drain anything the worker sent right before exiting.
            return Ok(link.from_worker.lock().unwrap().try_recv().ok());
        }
        tokio::select! {
            _ = link.notify.notified() => {}
            _ = tokio::time::sleep(std::time::Duration::from_millis(5)) => {}
        }
    }
}

#[op2]
pub async fn op_worker_exit_code(state: Rc<RefCell<OpState>>, id: u32) -> Result<i32, JsErrorBox> {
    let link = { let mut st = state.borrow_mut(); workers(&mut st).map.get(&id).cloned() };
    let Some(link) = link else { return Ok(0) };
    loop {
        if let Some(c) = *link.exit.lock().unwrap() {
            let mut st = state.borrow_mut();
            workers(&mut st).map.remove(&id);
            return Ok(c);
        }
        tokio::select! {
            _ = link.notify.notified() => {}
            _ = tokio::time::sleep(std::time::Duration::from_millis(10)) => {}
        }
    }
}

#[op2(fast)]
pub fn op_worker_terminate(state: &mut OpState, id: u32) {
    if let Some(w) = workers(state).map.get(&id) {
        *w.exit.lock().unwrap() = Some(1);
        if let Some(h) = w.isolate.lock().unwrap().as_ref() {
            h.terminate_execution();
        }
        w.notify.notify_waiters();
    }
}

// worker side
#[op2(fast)]
pub fn op_worker_parent_post(#[string] msg: &str) -> Result<(), JsErrorBox> {
    WORKER_SIDE.with(|w| match w.borrow().as_ref() {
        Some(ws) => ws.to_parent.send(msg.to_string()).map_err(|_| JsErrorBox::type_error("parent is gone")),
        None => Err(JsErrorBox::type_error("not a worker thread")),
    })
}

#[op2]
#[string]
pub async fn op_worker_parent_recv() -> Result<Option<String>, JsErrorBox> {
    let ws = WORKER_SIDE.with(|w| w.borrow().clone());
    let Some(ws) = ws else { return Ok(None) };
    loop {
        let m = ws.from_parent.borrow_mut().try_recv();
        match m {
            Ok(s) => return Ok(Some(s)),
            Err(tokio::sync::mpsc::error::TryRecvError::Disconnected) => return Ok(None),
            Err(_) => tokio::time::sleep(std::time::Duration::from_millis(2)).await,
        }
    }
}

/// Worker-side process.exit: record the code and terminate this isolate's execution
/// (uncatchable from JS, like Node's worker exit).
#[op2(fast)]
pub fn op_worker_self_exit(code: i32) -> bool {
    WORKER_SIDE.with(|w| match w.borrow().as_ref() {
        Some(ws) => {
            *ws.exit.lock().unwrap() = Some(code);
            if let Some(h) = ws.isolate.lock().unwrap().as_ref() {
                h.terminate_execution();
            }
            true
        }
        None => false,
    })
}

// ---------- dns ----------

/// [address, family] pairs from the system resolver.
#[op2]
#[serde]
pub async fn op_dns_lookup(#[string] host: String) -> Result<Vec<(String, u8)>, JsErrorBox> {
    let addrs = tokio::net::lookup_host((host.as_str(), 0)).await.map_err(|e| net_err(e, "getaddrinfo"))?;
    let mut out: Vec<(String, u8)> = addrs.map(|a| (a.ip().to_string(), if a.is_ipv4() { 4 } else { 6 })).collect();
    out.dedup();
    Ok(out)
}
