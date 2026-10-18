//! TCP sockets (node:net), TLS acceptor config for HTTPS, and worker_threads ops.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::Arc;

use deno_core::{op2, OpState};
use deno_core::v8;
use deno_error::JsErrorBox;
use serde::Serialize;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

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

// ---------- stream sockets (TCP, Unix, TLS-upgraded) ----------

type BoxRead = Box<dyn tokio::io::AsyncRead + Unpin + Send>;
type BoxWrite = Box<dyn tokio::io::AsyncWrite + Unpin + Send>;

struct Conn {
    /// Unsplit stream, kept until the first read/write so `op_tls_accept` can upgrade it.
    whole: Option<tokio::net::TcpStream>,
    rd: Option<BoxRead>,
    wr: Option<BoxWrite>,
    local: String,
    local_port: u16,
    peer: String,
    peer_port: u16,
    /// Serializes concurrent writes so a second `op_net_write`/`op_net_shutdown` waits for the
    /// first instead of finding the write half taken (Node allows concurrent socket.write; the
    /// IPC channel and some libraries rely on it).
    write_lock: std::rc::Rc<tokio::sync::Mutex<()>>,
}
impl Conn {
    fn ensure_split(&mut self) {
        if let Some(s) = self.whole.take() {
            let (rd, wr) = s.into_split();
            self.rd = Some(Box::new(rd));
            self.wr = Some(Box::new(wr));
        }
    }
}
enum Listener {
    Tcp(tokio::net::TcpListener),
    #[cfg(unix)]
    Unix(tokio::net::UnixListener, String),
}
#[derive(Default)]
struct Net {
    next: u32,
    conns: HashMap<u32, Rc<RefCell<Conn>>>,
    listeners: HashMap<u32, Rc<Listener>>,
    /// Per resource id (connections and listeners share the counter): signalled on close,
    /// so a pending read/accept — which holds its own handle to the socket — returns
    /// instead of keeping the event loop alive after `close()`/`destroy()`.
    closed: HashMap<u32, Rc<tokio::sync::Notify>>,
}
fn closed_of(state: &Rc<RefCell<OpState>>, rid: u32) -> Option<Rc<tokio::sync::Notify>> {
    let mut st = state.borrow_mut();
    net(&mut st).closed.get(&rid).cloned()
}
fn signal_closed(n: &mut Net, rid: u32) {
    if let Some(c) = n.closed.remove(&rid) {
        c.notify_one();
    }
}
fn net(state: &mut OpState) -> &mut Net {
    if state.try_borrow::<Net>().is_none() {
        state.put(Net::default());
    }
    state.borrow_mut::<Net>()
}
fn insert_conn(state: &Rc<RefCell<OpState>>, c: Conn) -> u32 {
    let mut st = state.borrow_mut();
    let n = net(&mut st);
    let rid = n.next;
    n.next += 1;
    n.conns.insert(rid, Rc::new(RefCell::new(c)));
    n.closed.insert(rid, Rc::new(tokio::sync::Notify::new()));
    rid
}
fn add_tcp(state: &Rc<RefCell<OpState>>, s: tokio::net::TcpStream) -> u32 {
    let local = s.local_addr().ok();
    let peer = s.peer_addr().ok();
    let _ = s.set_nodelay(true);
    insert_conn(state, Conn {
        whole: Some(s), rd: None, wr: None,
        local: local.map(|a| a.ip().to_string()).unwrap_or_default(), local_port: local.map(|a| a.port()).unwrap_or(0),
        peer: peer.map(|a| a.ip().to_string()).unwrap_or_default(), peer_port: peer.map(|a| a.port()).unwrap_or(0),
        write_lock: std::rc::Rc::new(tokio::sync::Mutex::new(())),
    })
}
#[cfg(unix)]
fn add_unix(state: &Rc<RefCell<OpState>>, s: tokio::net::UnixStream, path: &str) -> u32 {
    let (rd, wr) = s.into_split();
    insert_conn(state, Conn { whole: None, rd: Some(Box::new(rd)), wr: Some(Box::new(wr)), local: path.to_string(), local_port: 0, peer: path.to_string(), peer_port: 0, write_lock: std::rc::Rc::new(tokio::sync::Mutex::new(())) })
}
fn conn_of(state: &Rc<RefCell<OpState>>, rid: u32) -> Result<Rc<RefCell<Conn>>, JsErrorBox> {
    let mut st = state.borrow_mut();
    net(&mut st).conns.get(&rid).cloned().ok_or_else(|| JsErrorBox::new("Error", "ERR_SOCKET_CLOSED: socket is closed"))
}

#[op2]
pub async fn op_net_connect(state: Rc<RefCell<OpState>>, #[string] host: String, port: u16) -> Result<u32, JsErrorBox> {
    let s = tokio::net::TcpStream::connect((host.as_str(), port)).await.map_err(|e| net_err(e, "connect"))?;
    Ok(add_tcp(&state, s))
}

#[op2]
pub async fn op_net_connect_unix(state: Rc<RefCell<OpState>>, #[string] path: String) -> Result<u32, JsErrorBox> {
    #[cfg(unix)]
    {
        let s = tokio::net::UnixStream::connect(&path).await.map_err(|e| net_err(e, "connect"))?;
        Ok(add_unix(&state, s, &path))
    }
    #[cfg(not(unix))]
    {
        let _ = (state, path);
        Err(JsErrorBox::type_error("unix sockets unsupported"))
    }
}

/// Wrap an inherited unix-socket fd (the fork IPC channel) as a connection.
#[op2(fast)]
pub fn op_net_from_fd(state: &mut OpState, fd: i32) -> Result<u32, JsErrorBox> {
    #[cfg(unix)]
    {
        use std::os::unix::io::FromRawFd;
        let std_s = unsafe { std::os::unix::net::UnixStream::from_raw_fd(fd) };
        std_s.set_nonblocking(true).map_err(|e| net_err(e, "ipc"))?;
        let s = tokio::net::UnixStream::from_std(std_s).map_err(|e| net_err(e, "ipc"))?;
        let (rd, wr) = s.into_split();
        let n = net(state);
        let rid = n.next;
        n.next += 1;
        n.conns.insert(rid, Rc::new(RefCell::new(Conn { whole: None, rd: Some(Box::new(rd)), wr: Some(Box::new(wr)), local: "ipc".into(), local_port: 0, peer: "ipc".into(), peer_port: 0, write_lock: std::rc::Rc::new(tokio::sync::Mutex::new(())) })));
        n.closed.insert(rid, Rc::new(tokio::sync::Notify::new()));
        Ok(rid)
    }
    #[cfg(not(unix))]
    {
        let _ = (state, fd);
        Err(JsErrorBox::type_error("ipc unsupported"))
    }
}

/// Read up to 64 KiB. Empty = EOF.
#[op2]
#[buffer]
pub async fn op_net_read(state: Rc<RefCell<OpState>>, rid: u32) -> Result<Vec<u8>, JsErrorBox> {
    let c = conn_of(&state, rid)?;
    let closed = closed_of(&state, rid);
    let rd = { let mut cc = c.borrow_mut(); cc.ensure_split(); cc.rd.take() };
    let Some(mut rd) = rd else { return Ok(Vec::new()) };
    let mut buf = vec![0u8; 65536];
    let r = match closed {
        Some(closed) => tokio::select! {
            r = rd.read(&mut buf) => r,
            _ = closed.notified() => Ok(0),
        },
        None => rd.read(&mut buf).await,
    };
    c.borrow_mut().rd = Some(rd);
    let n = r.map_err(|e| net_err(e, "read"))?;
    buf.truncate(n);
    Ok(buf)
}

#[op2]
pub async fn op_net_write(state: Rc<RefCell<OpState>>, rid: u32, #[buffer(copy)] data: Vec<u8>) -> Result<(), JsErrorBox> {
    let c = conn_of(&state, rid)?;
    let lock = c.borrow().write_lock.clone();
    let _guard = lock.lock().await; // serialize concurrent writes on this connection
    let wr = { let mut cc = c.borrow_mut(); cc.ensure_split(); cc.wr.take() };
    let Some(mut wr) = wr else { return Err(JsErrorBox::new("Error", "EPIPE: This socket has been ended by the other party")) };
    let r = wr.write_all(&data).await;
    c.borrow_mut().wr = Some(wr);
    r.map_err(|e| net_err(e, "write"))
}

#[op2]
pub async fn op_net_shutdown(state: Rc<RefCell<OpState>>, rid: u32) -> Result<(), JsErrorBox> {
    let c = conn_of(&state, rid)?;
    // A pending write temporarily owns wr. Wait for it (and queued writes)
    // before taking the half, otherwise shutdown silently skips sending EOF.
    let lock = c.borrow().write_lock.clone();
    let _guard = lock.lock().await;
    let wr = { let mut cc = c.borrow_mut(); cc.ensure_split(); cc.wr.take() };
    if let Some(mut wr) = wr {
        let _ = wr.shutdown().await;
    }
    Ok(())
}

#[op2(fast)]
pub fn op_net_close(state: &mut OpState, rid: u32) {
    let n = net(state);
    n.conns.remove(&rid);
    signal_closed(n, rid);
}

/// [localAddress, localPort, remoteAddress, remotePort]
#[op2]
#[serde]
pub fn op_net_addr(state: &mut OpState, rid: u32) -> Option<(String, u16, String, u16)> {
    net(state).conns.get(&rid).map(|c| {
        let c = c.borrow();
        (c.local.clone(), c.local_port, c.peer.clone(), c.peer_port)
    })
}

#[op2(fast)]
pub fn op_net_listen(state: &mut OpState, #[string] host: &str, port: u16) -> Result<u32, JsErrorBox> {
    let addr: std::net::SocketAddr = format!("{host}:{port}").parse().map_err(|e| JsErrorBox::type_error(format!("bad address: {e}")))?;
    let std_l = {
        use socket2::{Domain, Protocol, Socket, Type};
        let sock = Socket::new(Domain::for_address(addr), Type::STREAM, Some(Protocol::TCP)).map_err(|e| net_err(e, "socket"))?;
        let _ = sock.set_reuse_address(true);
        #[cfg(unix)]
        if std::env::var("KESTREL_REUSEPORT").is_ok() { let _ = sock.set_reuse_port(true); }
        sock.bind(&addr.into()).map_err(|e| net_err(e, "bind"))?;
        sock.listen(1024).map_err(|e| net_err(e, "listen"))?;
        sock.set_nonblocking(true).map_err(|e| net_err(e, "listen"))?;
        std::net::TcpListener::from(sock)
    };
    let l = tokio::net::TcpListener::from_std(std_l).map_err(|e| net_err(e, "listen"))?;
    let n = net(state);
    let rid = n.next;
    n.next += 1;
    n.listeners.insert(rid, Rc::new(Listener::Tcp(l)));
    n.closed.insert(rid, Rc::new(tokio::sync::Notify::new()));
    Ok(rid)
}

#[op2(fast)]
pub fn op_net_listen_unix(state: &mut OpState, #[string] path: &str) -> Result<u32, JsErrorBox> {
    #[cfg(unix)]
    {
        if std::path::Path::new(path).exists() {
            let _ = std::fs::remove_file(path);
        }
        let l = tokio::net::UnixListener::bind(path).map_err(|e| net_err(e, "listen"))?;
        let n = net(state);
        let rid = n.next;
        n.next += 1;
        n.listeners.insert(rid, Rc::new(Listener::Unix(l, path.to_string())));
        n.closed.insert(rid, Rc::new(tokio::sync::Notify::new()));
        Ok(rid)
    }
    #[cfg(not(unix))]
    {
        let _ = (state, path);
        Err(JsErrorBox::type_error("unix sockets unsupported"))
    }
}

#[op2]
#[serde]
pub fn op_net_listen_addr(state: &mut OpState, rid: u32) -> Option<(String, u16)> {
    net(state).listeners.get(&rid).and_then(|l| match &**l {
        Listener::Tcp(t) => t.local_addr().ok().map(|a| (a.ip().to_string(), a.port())),
        #[cfg(unix)]
        Listener::Unix(_, p) => Some((p.clone(), 0)),
    })
}

/// Resolves with the new connection's rid, or u32::MAX when the listener was closed.
#[op2]
pub async fn op_net_accept(state: Rc<RefCell<OpState>>, rid: u32) -> Result<u32, JsErrorBox> {
    let l = {
        let mut st = state.borrow_mut();
        net(&mut st).listeners.get(&rid).cloned()
    };
    let Some(l) = l else { return Ok(u32::MAX) };
    let closed = closed_of(&state, rid);
    let closed = async move { match closed { Some(c) => c.notified().await, None => std::future::pending::<()>().await } };
    match &*l {
        Listener::Tcp(t) => {
            let s = tokio::select! {
                r = t.accept() => r.map_err(|e| net_err(e, "accept"))?.0,
                _ = closed => return Ok(u32::MAX),
            };
            Ok(add_tcp(&state, s))
        }
        #[cfg(unix)]
        Listener::Unix(u, p) => {
            let s = tokio::select! {
                r = u.accept() => r.map_err(|e| net_err(e, "accept"))?.0,
                _ = closed => return Ok(u32::MAX),
            };
            Ok(add_unix(&state, s, p))
        }
    }
}

#[op2(fast)]
pub fn op_net_close_listener(state: &mut OpState, rid: u32) {
    signal_closed(net(state), rid);
    if let Some(l) = net(state).listeners.remove(&rid) {
        #[cfg(unix)]
        if let Listener::Unix(_, p) = &*l {
            let _ = std::fs::remove_file(p);
        }
        let _ = l;
    }
}

/// Server-side TLS upgrade of an accepted TCP connection (uses the thread's acceptor config).
#[op2]
pub async fn op_tls_accept(state: Rc<RefCell<OpState>>, rid: u32) -> Result<(), JsErrorBox> {
    let acceptor = TLS_ACCEPTOR.with(|t| t.borrow().clone()).ok_or_else(|| JsErrorBox::type_error("no TLS server config on this thread"))?;
    let c = conn_of(&state, rid)?;
    let whole = c.borrow_mut().whole.take().ok_or_else(|| JsErrorBox::type_error("socket already in use"))?;
    let tls = acceptor.accept(whole).await.map_err(|e| net_err(e, "tls handshake"))?;
    let (rd, wr) = tokio::io::split(tls);
    let mut cc = c.borrow_mut();
    cc.rd = Some(Box::new(rd));
    cc.wr = Some(Box::new(wr));
    Ok(())
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
pub fn op_tls_server_config(#[string] cert_pem: &str, #[string] key_pem: &str, #[string] alpn: &str) -> Result<(), JsErrorBox> {
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
    // Comma-separated ALPN list, most preferred first ("h2,http/1.1"); default HTTP/1.1 only.
    cfg.alpn_protocols = if alpn.is_empty() { vec![b"http/1.1".to_vec()] } else { alpn.split(',').map(|p| p.trim().as_bytes().to_vec()).collect() };
    TLS_ACCEPTOR.with(|t| *t.borrow_mut() = Some(Arc::new(tokio_rustls::TlsAcceptor::from(Arc::new(cfg)))));
    Ok(())
}

/// Servers started on this thread afterwards are plain TCP again.
#[op2(fast)]
pub fn op_tls_server_clear() {
    TLS_ACCEPTOR.with(|t| *t.borrow_mut() = None);
}

/// rustls client config with the WebPKI roots (or no verification when `insecure`) and the
/// given ALPN protocols.
pub(crate) fn tls_client_config(insecure: bool, alpn: &[&str]) -> rustls::ClientConfig {
    install_provider();
    let root = rustls::RootCertStore { roots: webpki_roots::TLS_SERVER_ROOTS.to_vec() };
    let mut cfg = rustls::ClientConfig::builder().with_root_certificates(root).with_no_client_auth();
    if insecure {
        cfg.dangerous().set_certificate_verifier(Arc::new(NoVerify));
    }
    cfg.alpn_protocols = alpn.iter().map(|p| p.as_bytes().to_vec()).collect();
    cfg
}

/// TLS client connection for node:tls / https client fallbacks.
#[op2]
pub async fn op_tls_connect(state: Rc<RefCell<OpState>>, #[string] host: String, port: u16, #[string] servername: String, reject_unauthorized: bool) -> Result<u32, JsErrorBox> {
    install_provider();
    let s = tokio::net::TcpStream::connect((host.as_str(), port)).await.map_err(|e| net_err(e, "connect"))?;
    let _ = s.set_nodelay(true);
    let cfg = tls_client_config(!reject_unauthorized, &[]);
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
    TLS_CLOSED.with(|m| m.borrow_mut().insert(rid, Rc::new(tokio::sync::Notify::new())));
    Ok(rid)
}

type TlsStream = tokio_rustls::client::TlsStream<tokio::net::TcpStream>;
struct TlsConn {
    rd: Option<tokio::io::ReadHalf<TlsStream>>,
    wr: Option<tokio::io::WriteHalf<TlsStream>>,
}
thread_local! {
    static TLS_CONNS: RefCell<HashMap<u32, Rc<RefCell<TlsConn>>>> = RefCell::new(HashMap::new());
    static TLS_CLOSED: RefCell<HashMap<u32, Rc<tokio::sync::Notify>>> = RefCell::new(HashMap::new());
}
fn tls_conn(rid: u32) -> Result<Rc<RefCell<TlsConn>>, JsErrorBox> {
    TLS_CONNS.with(|c| c.borrow().get(&rid).cloned()).ok_or_else(|| JsErrorBox::new("Error", "ERR_SOCKET_CLOSED: socket is closed"))
}

#[op2]
#[buffer]
pub async fn op_tls_read(rid: u32) -> Result<Vec<u8>, JsErrorBox> {
    let c = tls_conn(rid)?;
    let closed = TLS_CLOSED.with(|m| m.borrow().get(&rid).cloned());
    let rd = c.borrow_mut().rd.take();
    let Some(mut rd) = rd else { return Ok(Vec::new()) };
    let mut buf = vec![0u8; 65536];
    let r = match closed {
        Some(closed) => tokio::select! {
            r = rd.read(&mut buf) => r,
            _ = closed.notified() => Ok(0),
        },
        None => rd.read(&mut buf).await,
    };
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
    if let Some(n) = TLS_CLOSED.with(|m| m.borrow_mut().remove(&rid)) {
        n.notify_one();
    }
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

/// Structured messages own their serialized data and transferred backing stores.
use crate::cloneimpl::{self, Message};
pub struct WorkerLink {
    pub to_worker: tokio::sync::mpsc::UnboundedSender<Message>,
    pub from_worker: Arc<std::sync::Mutex<tokio::sync::mpsc::UnboundedReceiver<Message>>>,
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
    pub data: RefCell<Option<Message>>,
    pub to_parent: tokio::sync::mpsc::UnboundedSender<Message>,
    pub from_parent: RefCell<tokio::sync::mpsc::UnboundedReceiver<Message>>,
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
    data: Option<u32>,
}

#[op2]
#[serde]
pub fn op_worker_info(state: &mut OpState) -> WorkerInfo {
    WORKER_SIDE.with(|w| match w.borrow().as_ref() {
        Some(ws) => WorkerInfo { is_main: false, thread_id: ws.id, data: ws.data.borrow_mut().take().map(|m| cloneimpl::store(state, m)) },
        None => WorkerInfo { is_main: true, thread_id: 0, data: None },
    })
}

#[op2(fast)]
pub fn op_worker_spawn(state: &mut OpState, #[string] path: &str, data: u32) -> Result<u32, JsErrorBox> {
    let (to_worker, from_parent) = tokio::sync::mpsc::unbounded_channel::<Message>();
    let (to_parent, from_worker) = tokio::sync::mpsc::unbounded_channel::<Message>();
    let exit = Arc::new(std::sync::Mutex::new(None));
    let isolate = Arc::new(std::sync::Mutex::new(None));
    let notify = Arc::new(tokio::sync::Notify::new());
    let id = THREAD_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let link = WorkerLink { to_worker, from_worker: Arc::new(std::sync::Mutex::new(from_worker)), exit: exit.clone(), isolate: isolate.clone(), notify: notify.clone() };
    let ws = WorkerSide { id, data: RefCell::new(Some(cloneimpl::take(state, data)?)), to_parent, from_parent: RefCell::new(from_parent), exit: exit.clone(), isolate: isolate.clone() };
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
pub fn op_worker_post(state: &mut OpState, id: u32, msg: u32) -> Result<(), JsErrorBox> {
    let msg = cloneimpl::take(state, msg)?;
    let w = workers(state).map.get(&id).ok_or_else(|| JsErrorBox::type_error("worker not found"))?;
    w.to_worker.send(msg).map_err(|_| JsErrorBox::type_error("worker has exited"))
}

/// Next message from the worker, or null once it has exited and the queue is drained.
#[op2]
pub async fn op_worker_recv(state: Rc<RefCell<OpState>>, id: u32) -> Result<Option<u32>, JsErrorBox> {
    let link = { let mut st = state.borrow_mut(); workers(&mut st).map.get(&id).cloned() };
    let Some(link) = link else { return Ok(None) };
    let message = std::future::poll_fn(|cx| link.from_worker.lock().unwrap().poll_recv(cx)).await;
    Ok(message.map(|m| cloneimpl::store(&mut state.borrow_mut(), m)))
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
pub fn op_worker_parent_post(state: &mut OpState, msg: u32) -> Result<(), JsErrorBox> {
    let msg = cloneimpl::take(state, msg)?;
    WORKER_SIDE.with(|w| match w.borrow().as_ref() {
        Some(ws) => ws.to_parent.send(msg).map_err(|_| JsErrorBox::type_error("parent is gone")),
        None => Err(JsErrorBox::type_error("not a worker thread")),
    })
}

#[op2]
pub async fn op_worker_parent_recv(state: Rc<RefCell<OpState>>) -> Result<Option<u32>, JsErrorBox> {
    let ws = WORKER_SIDE.with(|w| w.borrow().clone());
    let Some(ws) = ws else { return Ok(None) };
    let message = std::future::poll_fn(|cx| ws.from_parent.borrow_mut().poll_recv(cx)).await;
    Ok(message.map(|m| cloneimpl::store(&mut state.borrow_mut(), m)))
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

// ---------- dgram (UDP) ----------

#[derive(Default)]
struct Udp {
    next: u32,
    socks: HashMap<u32, Rc<tokio::net::UdpSocket>>,
    /// Signalled on close so a pending `op_udp_recv` (which holds its own socket handle)
    /// returns instead of keeping the event loop alive forever.
    closed: HashMap<u32, Rc<tokio::sync::Notify>>,
}
fn udp(state: &mut OpState) -> &mut Udp {
    if state.try_borrow::<Udp>().is_none() {
        state.put(Udp::default());
    }
    state.borrow_mut::<Udp>()
}

#[op2(fast)]
pub fn op_udp_bind(state: &mut OpState, #[string] host: &str, port: u16, reuse: bool) -> Result<u32, JsErrorBox> {
    let addr: std::net::SocketAddr = format!("{host}:{port}").parse().map_err(|e| JsErrorBox::type_error(format!("bad address: {e}")))?;
    let std_s = {
        use socket2::{Domain, Protocol, Socket, Type};
        let sock = Socket::new(Domain::for_address(addr), Type::DGRAM, Some(Protocol::UDP)).map_err(|e| net_err(e, "socket"))?;
        if reuse { let _ = sock.set_reuse_address(true); #[cfg(unix)] let _ = sock.set_reuse_port(true); }
        let _ = sock.set_broadcast(true);
        sock.bind(&addr.into()).map_err(|e| net_err(e, "bind"))?;
        sock.set_nonblocking(true).map_err(|e| net_err(e, "bind"))?;
        std::net::UdpSocket::from(sock)
    };
    let s = tokio::net::UdpSocket::from_std(std_s).map_err(|e| net_err(e, "bind"))?;
    let u = udp(state);
    let rid = u.next;
    u.next += 1;
    u.socks.insert(rid, Rc::new(s));
    u.closed.insert(rid, Rc::new(tokio::sync::Notify::new()));
    Ok(rid)
}

#[op2]
pub async fn op_udp_send(state: Rc<RefCell<OpState>>, rid: u32, #[string] host: String, port: u16, #[buffer(copy)] data: Vec<u8>) -> Result<u32, JsErrorBox> {
    let s = { let mut st = state.borrow_mut(); udp(&mut st).socks.get(&rid).cloned() }.ok_or_else(|| JsErrorBox::new("Error", "ERR_SOCKET_DGRAM_NOT_RUNNING: Not running"))?;
    let n = s.send_to(&data, (host.as_str(), port)).await.map_err(|e| net_err(e, "send"))?;
    Ok(n as u32)
}

/// [bytes(base64-free: returned as JsBuffer in `data`), address, port]
#[derive(Serialize)]
pub struct Datagram {
    data: deno_core::ToJsBuffer,
    address: String,
    port: u16,
    family: String,
}

#[op2]
#[serde]
pub async fn op_udp_recv(state: Rc<RefCell<OpState>>, rid: u32) -> Result<Option<Datagram>, JsErrorBox> {
    let (s, closed) = { let mut st = state.borrow_mut(); let u = udp(&mut st); (u.socks.get(&rid).cloned(), u.closed.get(&rid).cloned()) };
    let (Some(s), Some(closed)) = (s, closed) else { return Ok(None) };
    let mut buf = vec![0u8; 65536];
    let (n, from) = tokio::select! {
        r = s.recv_from(&mut buf) => r.map_err(|e| net_err(e, "recv"))?,
        _ = closed.notified() => return Ok(None),
    };
    buf.truncate(n);
    Ok(Some(Datagram { data: buf.into(), address: from.ip().to_string(), port: from.port(), family: if from.is_ipv4() { "IPv4".into() } else { "IPv6".into() } }))
}

#[op2]
#[serde]
pub fn op_udp_addr(state: &mut OpState, rid: u32) -> Option<(String, u16)> {
    udp(state).socks.get(&rid).and_then(|s| s.local_addr().ok()).map(|a| (a.ip().to_string(), a.port()))
}

#[op2(fast)]
pub fn op_udp_close(state: &mut OpState, rid: u32) {
    let u = udp(state);
    u.socks.remove(&rid);
    if let Some(n) = u.closed.remove(&rid) {
        n.notify_one();
    }
}

// ---------- v8 / vm ----------

#[derive(Serialize)]
pub struct HeapStats {
    total_heap_size: f64,
    total_heap_size_executable: f64,
    total_physical_size: f64,
    total_available_size: f64,
    used_heap_size: f64,
    heap_size_limit: f64,
    malloced_memory: f64,
    peak_malloced_memory: f64,
    external_memory: f64,
    number_of_native_contexts: f64,
    number_of_detached_contexts: f64,
}

#[op2]
#[serde]
pub fn op_v8_heap_stats(scope: &mut v8::PinScope) -> HeapStats {
    let hs = scope.get_heap_statistics();
    HeapStats {
        total_heap_size: hs.total_heap_size() as f64,
        total_heap_size_executable: hs.total_heap_size_executable() as f64,
        total_physical_size: hs.total_physical_size() as f64,
        total_available_size: hs.total_available_size() as f64,
        used_heap_size: hs.used_heap_size() as f64,
        heap_size_limit: hs.heap_size_limit() as f64,
        malloced_memory: hs.malloced_memory() as f64,
        peak_malloced_memory: hs.peak_malloced_memory() as f64,
        external_memory: hs.external_memory() as f64,
        number_of_native_contexts: hs.number_of_native_contexts() as f64,
        number_of_detached_contexts: hs.number_of_detached_contexts() as f64,
    }
}

macro_rules! tc_err {
    ($tc:expr) => {{
        let msg = $tc.message().map(|m| m.get($tc).to_rust_string_lossy($tc)).unwrap_or_else(|| "script error".to_string());
        let name = if msg.contains("SyntaxError") { "SyntaxError" } else { "Error" };
        JsErrorBox::new(name, msg)
    }};
}

/// Host-defined options for a `node:vm` script or module: `import()` inside it either
/// calls the user's `importModuleDynamically` (deno_core invokes `dyn_cb` with
/// `(specifier, attributes)`), rejects with ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING (Node's
/// default), or, for `USE_MAIN_CONTEXT_DEFAULT_LOADER` (`default_loader`), goes through the
/// main module loader like any other script.
fn vm_host_options<'s>(scope: &mut v8::PinScope<'s, '_>, dyn_cb: Option<v8::Local<v8::Function>>, default_loader: bool) -> Option<v8::Local<'s, v8::Data>> {
    if default_loader {
        return None;
    }
    Some(match dyn_cb {
        Some(f) => {
            let key = deno_core::register_vm_dynamic_import_callback(scope, f);
            deno_core::create_host_defined_options_with_kind_and_key(scope, deno_core::host_defined_options_kind::VM_DYNAMIC_IMPORT_CALLBACK, key)
        }
        None => deno_core::create_host_defined_options_with_kind(scope, deno_core::host_defined_options_kind::VM_DYNAMIC_IMPORT_MISSING),
    })
}

/// vm.runInThisContext: compile `code` as a classic script named `filename` and run it.
#[op2]
pub fn op_vm_run_in_this_context<'a>(scope: &mut v8::PinScope<'a, '_>, #[string] code: &str, #[string] filename: &str, dyn_cb: Option<v8::Local<v8::Function>>, default_loader: bool) -> Result<v8::Local<'a, v8::Value>, JsErrorBox> {
    let hdo = vm_host_options(scope, dyn_cb, default_loader);
    let src = v8::String::new(scope, code).ok_or_else(|| JsErrorBox::generic("source too long"))?;
    let name = v8::String::new(scope, filename).unwrap();
    let origin = v8::ScriptOrigin::new(scope, name.into(), 0, 0, false, 0, None, false, false, false, hdo);
    v8::tc_scope!(let tc, scope);
    let script = v8::Script::compile(tc, src, Some(&origin));
    let Some(script) = script else { return Err(tc_err!(tc)); };
    match script.run(tc) {
        Some(v) => Ok(v),
        None => Err(tc_err!(tc)),
    }
}

/// vm.runInNewContext: a fresh context whose global gets the sandbox's own properties;
/// after the run they are copied back onto the sandbox. Returns the completion value.
#[op2]
pub fn op_vm_run_in_new_context<'a>(scope: &mut v8::PinScope<'a, '_>, #[string] code: &str, sandbox: v8::Local<v8::Object>, #[string] filename: &str, dyn_cb: Option<v8::Local<v8::Function>>, default_loader: bool) -> Result<v8::Local<'a, v8::Value>, JsErrorBox> {
    let hdo = vm_host_options(scope, dyn_cb, default_loader).map(|d| v8::Global::new(scope, d));
    let ctx = v8::Context::new(scope, Default::default());
    let result = {
        let cs = &mut v8::ContextScope::new(scope, ctx);
        let global = ctx.global(cs);
        // Include non-enumerable globals and symbol keys (used by Edge Runtime).
        let names = sandbox.get_own_property_names(cs, v8::GetPropertyNamesArgs {
            property_filter: v8::PropertyFilter::ALL_PROPERTIES,
            key_conversion: v8::KeyConversionMode::ConvertToString,
            ..Default::default()
        }).ok_or_else(|| JsErrorBox::generic("sandbox"))?;
        for i in 0..names.length() {
            if let Some(k) = names.get_index(cs, i) {
                if let Some(v) = sandbox.get(cs, k) {
                    // Keep hidden host hooks hidden: otherwise copy-back invokes their
                    // setters on every evaluation (e.g. Edge Runtime error handlers).
                    if let (Ok(name), Some(attributes)) = (v8::Local::<v8::Name>::try_from(k), sandbox.get_property_attributes(cs, k)) {
                        global.define_own_property(cs, name, v, attributes);
                    }
                }
            }
        }
        let src = v8::String::new(cs, code).ok_or_else(|| JsErrorBox::generic("source too long"))?;
        let name = v8::String::new(cs, filename).unwrap();
        let hdo = hdo.as_ref().map(|g| v8::Local::new(cs, g));
        let origin = v8::ScriptOrigin::new(cs, name.into(), 0, 0, false, 0, None, false, false, false, hdo);
        v8::tc_scope!(let tc, cs);
        let r = match v8::Script::compile(tc, src, Some(&origin)) {
            Some(s) => s.run(tc),
            None => None,
        };
        let r = match r { Some(v) => v, None => return Err(tc_err!(tc)) };
        // Copy the global's own properties back to the sandbox.
        if let Some(gnames) = global.get_own_property_names(tc, Default::default()) {
            for i in 0..gnames.length() {
                if let Some(k) = gnames.get_index(tc, i) {
                    if let Some(v) = global.get(tc, k) {
                        sandbox.set(tc, k, v);
                    }
                }
            }
        }
        v8::Global::new(tc, r)
    };
    Ok(v8::Local::new(scope, result))
}

/// Multicast membership / options for a bound UDP socket.
#[op2(fast)]
pub fn op_udp_multicast(state: &mut OpState, rid: u32, #[string] op: &str, #[string] group: &str, #[string] iface: &str, value: u32) -> Result<(), JsErrorBox> {
    use std::os::fd::AsRawFd;
    let s = udp(state).socks.get(&rid).cloned().ok_or_else(|| JsErrorBox::new("Error", "ERR_SOCKET_DGRAM_NOT_RUNNING: Not running"))?;
    let fd = unsafe { libc::dup(s.as_raw_fd()) };
    if fd < 0 { return Err(JsErrorBox::generic("dup failed")); }
    let sock = unsafe { <socket2::Socket as std::os::fd::FromRawFd>::from_raw_fd(fd) };
    let r = match op {
        "join" | "leave" => {
            let g: std::net::IpAddr = group.parse().map_err(|_| JsErrorBox::type_error("bad multicast group"))?;
            match g {
                std::net::IpAddr::V4(g4) => {
                    let i4: std::net::Ipv4Addr = if iface.is_empty() { std::net::Ipv4Addr::UNSPECIFIED } else { iface.parse().map_err(|_| JsErrorBox::type_error("bad interface"))? };
                    if op == "join" { sock.join_multicast_v4(&g4, &i4) } else { sock.leave_multicast_v4(&g4, &i4) }
                }
                std::net::IpAddr::V6(g6) => { if op == "join" { sock.join_multicast_v6(&g6, value) } else { sock.leave_multicast_v6(&g6, value) } }
            }
        }
        "ttl" => sock.set_ttl(value),
        "mttl" => sock.set_multicast_ttl_v4(value),
        "loop" => sock.set_multicast_loop_v4(value != 0),
        "broadcast" => sock.set_broadcast(value != 0),
        _ => Ok(()),
    };
    drop(sock);
    r.map_err(|e| net_err(e, "setsockopt"))
}

// ---------- vm.SourceTextModule / vm.SyntheticModule ----------

struct VmModule {
    module: v8::Global<v8::Module>,
    context: v8::Global<v8::Context>,
    /// specifier -> module id, filled by `link()`.
    deps: HashMap<String, u32>,
    /// SyntheticModule: the JS evaluate callback run by the evaluation steps.
    synthetic: Option<v8::Global<v8::Function>>,
    /// SourceTextModule `initializeImportMeta(meta)`.
    meta: Option<v8::Global<v8::Function>>,
}
thread_local! {
    static VM_MODULES: RefCell<HashMap<u32, VmModule>> = RefCell::new(HashMap::new());
    /// V8 identity hash -> module id, for the resolve / evaluation-steps callbacks.
    static VM_BY_HASH: RefCell<HashMap<i32, u32>> = RefCell::new(HashMap::new());
    static VM_NEXT: std::cell::Cell<u32> = const { std::cell::Cell::new(1) };
}

fn vm_seed_context<'s>(scope: &mut v8::PinScope<'s, '_>, sandbox: v8::Local<v8::Object>) -> Result<v8::Local<'s, v8::Context>, JsErrorBox> {
    let ctx = v8::Context::new(scope, Default::default());
    let cs = &mut v8::ContextScope::new(scope, ctx);
    let global = ctx.global(cs);
    let names = sandbox.get_own_property_names(cs, Default::default()).ok_or_else(|| JsErrorBox::generic("sandbox"))?;
    for i in 0..names.length() {
        if let Some(k) = names.get_index(cs, i) {
            if let Some(v) = sandbox.get(cs, k) {
                global.set(cs, k, v);
            }
        }
    }
    Ok(ctx)
}

fn vm_register(scope: &mut v8::PinScope, module: v8::Local<v8::Module>, context: v8::Local<v8::Context>) -> u32 {
    let id = VM_NEXT.with(|n| { let v = n.get(); n.set(v + 1); v });
    VM_BY_HASH.with(|h| h.borrow_mut().insert(module.get_identity_hash().get(), id));
    VM_MODULES.with(|m| m.borrow_mut().insert(id, VmModule { module: v8::Global::new(scope, module), context: v8::Global::new(scope, context), deps: HashMap::new(), synthetic: None, meta: None }));
    id
}

fn vm_get(id: u32) -> Result<(v8::Global<v8::Module>, v8::Global<v8::Context>), JsErrorBox> {
    VM_MODULES.with(|m| m.borrow().get(&id).map(|x| (x.module.clone(), x.context.clone()))).ok_or_else(|| JsErrorBox::type_error("unknown vm module"))
}

/// Compile an ES module (in the main context, or a fresh one seeded from `sandbox`).
#[op2(fast)]
pub fn op_vm_module_compile(scope: &mut v8::PinScope, #[string] code: &str, #[string] identifier: &str, sandbox: Option<v8::Local<v8::Object>>, dyn_cb: Option<v8::Local<v8::Function>>, default_loader: bool, meta_cb: Option<v8::Local<v8::Function>>) -> Result<u32, JsErrorBox> {
    let hdo = vm_host_options(scope, dyn_cb, default_loader).map(|d| v8::Global::new(scope, d));
    let meta_cb = meta_cb.map(|f| v8::Global::new(scope, f));
    // import.meta for modules outside deno_core's module map (ours): per-isolate callback
    // that looks the module up by identity.
    deno_core::register_external_module_import_meta_cb(scope, vm_import_meta);
    let ctx = match sandbox {
        Some(sb) => vm_seed_context(scope, sb)?,
        None => scope.get_current_context(),
    };
    let module = {
        let cs = &mut v8::ContextScope::new(scope, ctx);
        let src = v8::String::new(cs, code).ok_or_else(|| JsErrorBox::generic("source too long"))?;
        let name = v8::String::new(cs, identifier).unwrap();
        let hdo = hdo.as_ref().map(|g| v8::Local::new(cs, g));
        let origin = v8::ScriptOrigin::new(cs, name.into(), 0, 0, false, 0, None, false, false, true, hdo);
        let mut source = v8::script_compiler::Source::new(src, Some(&origin));
        v8::tc_scope!(let tc, cs);
        let Some(m) = v8::script_compiler::compile_module(tc, &mut source) else { return Err(tc_err!(tc)) };
        v8::Global::new(tc, m)
    };
    let m = v8::Local::new(scope, &module);
    let id = vm_register(scope, m, ctx);
    VM_MODULES.with(|m| { if let Some(e) = m.borrow_mut().get_mut(&id) { e.meta = meta_cb; } });
    Ok(id)
}

fn vm_import_meta<'s, 'i, 'm, 'o>(scope: &mut v8::PinScope<'s, 'i>, module: v8::Local<'m, v8::Module>, meta: v8::Local<'o, v8::Object>) {
    let id = VM_BY_HASH.with(|h| h.borrow().get(&module.get_identity_hash().get()).copied());
    let cb = id.and_then(|id| VM_MODULES.with(|m| m.borrow().get(&id).and_then(|x| x.meta.clone())));
    if let Some(cb) = cb {
        let f = v8::Local::new(scope, &cb);
        let recv = v8::undefined(scope);
        let _ = f.call(scope, recv.into(), &[meta.into()]);
    }
}

#[op2]
#[serde]
pub fn op_vm_module_requests(scope: &mut v8::PinScope, id: u32) -> Result<Vec<String>, JsErrorBox> {
    let (m, _) = vm_get(id)?;
    let m = v8::Local::new(scope, &m);
    let reqs = m.get_module_requests();
    let mut out = Vec::new();
    for i in 0..reqs.length() {
        if let Some(d) = reqs.get(scope, i) {
            if let Ok(r) = v8::Local::<v8::ModuleRequest>::try_from(d) {
                out.push(r.get_specifier().to_rust_string_lossy(scope));
            }
        }
    }
    Ok(out)
}

#[op2]
pub fn op_vm_module_link(id: u32, #[serde] deps: Vec<(String, u32)>) -> Result<(), JsErrorBox> {
    VM_MODULES.with(|m| {
        let mut m = m.borrow_mut();
        let e = m.get_mut(&id).ok_or_else(|| JsErrorBox::type_error("unknown vm module"))?;
        for (s, d) in deps { e.deps.insert(s, d); }
        Ok(())
    })
}

fn vm_resolve<'s>(context: v8::Local<'s, v8::Context>, specifier: v8::Local<'s, v8::String>, _attrs: v8::Local<'s, v8::FixedArray>, referrer: v8::Local<'s, v8::Module>) -> Option<v8::Local<'s, v8::Module>> {
    // SAFETY: `CallbackScope` can be safely constructed from `Local<Context>`
    v8::callback_scope!(unsafe scope, context);
    let spec = specifier.to_rust_string_lossy(scope);
    let rid = VM_BY_HASH.with(|h| h.borrow().get(&referrer.get_identity_hash().get()).copied());
    let dep = rid.and_then(|rid| VM_MODULES.with(|m| { let m = m.borrow(); let r = m.get(&rid)?; let d = *r.deps.get(&spec)?; m.get(&d).map(|x| x.module.clone()) }));
    match dep {
        Some(g) => Some(v8::Local::new(scope, &g)),
        None => {
            let msg = v8::String::new(scope, &format!("Cannot find module '{spec}'. Linked modules must be returned by the linker")).unwrap();
            let e = v8::Exception::error(scope, msg);
            scope.throw_exception(e);
            None
        }
    }
}

#[op2(fast)]
pub fn op_vm_module_instantiate(scope: &mut v8::PinScope, id: u32) -> Result<(), JsErrorBox> {
    let (m, ctx) = vm_get(id)?;
    let ctx = v8::Local::new(scope, &ctx);
    let cs = &mut v8::ContextScope::new(scope, ctx);
    let m = v8::Local::new(cs, &m);
    v8::tc_scope!(let tc, cs);
    match m.instantiate_module(tc, vm_resolve) {
        Some(true) => Ok(()),
        _ => Err(tc_err!(tc)),
    }
}

/// Evaluate; returns the promise V8 produces (top-level await is on).
#[op2]
pub fn op_vm_module_evaluate<'a>(scope: &mut v8::PinScope<'a, '_>, id: u32) -> Result<v8::Local<'a, v8::Value>, JsErrorBox> {
    let (m, ctx) = vm_get(id)?;
    let ctx = v8::Local::new(scope, &ctx);
    let result = {
        let cs = &mut v8::ContextScope::new(scope, ctx);
        let m = v8::Local::new(cs, &m);
        v8::tc_scope!(let tc, cs);
        match m.evaluate(tc) {
            Some(v) => v8::Global::new(tc, v),
            None => return Err(tc_err!(tc)),
        }
    };
    Ok(v8::Local::new(scope, result))
}

#[op2]
#[string]
pub fn op_vm_module_status(scope: &mut v8::PinScope, id: u32) -> Result<String, JsErrorBox> {
    let (m, _) = vm_get(id)?;
    let m = v8::Local::new(scope, &m);
    Ok(match m.get_status() {
        v8::ModuleStatus::Uninstantiated => "uninstantiated",
        v8::ModuleStatus::Instantiating => "instantiating",
        v8::ModuleStatus::Instantiated => "linked",
        v8::ModuleStatus::Evaluating => "evaluating",
        v8::ModuleStatus::Evaluated => "evaluated",
        v8::ModuleStatus::Errored => "errored",
    }
    .to_string())
}

#[op2]
pub fn op_vm_module_namespace<'a>(scope: &mut v8::PinScope<'a, '_>, id: u32) -> Result<v8::Local<'a, v8::Value>, JsErrorBox> {
    let (m, _) = vm_get(id)?;
    let m = v8::Local::new(scope, &m);
    Ok(m.get_module_namespace())
}

#[op2]
pub fn op_vm_module_error<'a>(scope: &mut v8::PinScope<'a, '_>, id: u32) -> Result<v8::Local<'a, v8::Value>, JsErrorBox> {
    let (m, _) = vm_get(id)?;
    let m = v8::Local::new(scope, &m);
    Ok(m.get_exception())
}

fn vm_synthetic_steps<'s>(context: v8::Local<'s, v8::Context>, module: v8::Local<'s, v8::Module>) -> Option<v8::Local<'s, v8::Value>> {
    // SAFETY: `CallbackScope` can be safely constructed from `Local<Context>`
    v8::callback_scope!(unsafe scope, context);
    v8::tc_scope!(let tc, scope);
    let id = VM_BY_HASH.with(|h| h.borrow().get(&module.get_identity_hash().get()).copied());
    let cb = id.and_then(|id| VM_MODULES.with(|m| m.borrow().get(&id).and_then(|x| x.synthetic.clone())));
    if let Some(cb) = cb {
        let f = v8::Local::new(tc, &cb);
        let recv = v8::undefined(tc);
        if f.call(tc, recv.into(), &[]).is_none() {
            return None; // exception propagates
        }
    }
    let resolver = v8::PromiseResolver::new(tc).unwrap();
    let undefined = v8::undefined(tc);
    resolver.resolve(tc, undefined.into());
    Some(resolver.get_promise(tc).into())
}

#[op2]
pub fn op_vm_synthetic_create(scope: &mut v8::PinScope, #[string] identifier: &str, #[serde] export_names: Vec<String>, sandbox: Option<v8::Local<v8::Object>>, callback: v8::Local<v8::Function>) -> Result<u32, JsErrorBox> {
    let ctx = match sandbox {
        Some(sb) => vm_seed_context(scope, sb)?,
        None => scope.get_current_context(),
    };
    let module = {
        let cs = &mut v8::ContextScope::new(scope, ctx);
        let name = v8::String::new(cs, identifier).unwrap();
        let names: Vec<v8::Local<v8::String>> = export_names.iter().map(|n| v8::String::new(cs, n).unwrap()).collect();
        let m = v8::Module::create_synthetic_module(cs, name, &names, vm_synthetic_steps);
        v8::Global::new(cs, m)
    };
    let m = v8::Local::new(scope, &module);
    let id = vm_register(scope, m, ctx);
    let cb = v8::Global::new(scope, callback);
    VM_MODULES.with(|m| { if let Some(e) = m.borrow_mut().get_mut(&id) { e.synthetic = Some(cb); } });
    Ok(id)
}

#[op2(fast)]
pub fn op_vm_synthetic_set_export<'a>(scope: &mut v8::PinScope<'a, '_>, id: u32, #[string] name: &str, value: v8::Local<'a, v8::Value>) -> Result<(), JsErrorBox> {
    let (m, _) = vm_get(id)?;
    let m = v8::Local::new(scope, &m);
    let n = v8::String::new(scope, name).unwrap();
    v8::tc_scope!(let tc, scope);
    match m.set_synthetic_module_export(tc, n, value) {
        Some(true) => Ok(()),
        _ => Err(tc_err!(tc)),
    }
}

// ---------- node:inspector (in-process sessions over deno_core's local inspector session) ----------

/// Put into OpState by the runtime so ops can open sessions on this isolate's inspector.
pub struct InspectorHandle(pub Rc<deno_core::JsRuntimeInspector>);

struct InspSession {
    session: deno_core::LocalInspectorSession,
    queue: Rc<RefCell<std::collections::VecDeque<String>>>,
    notify: Rc<tokio::sync::Notify>,
}
thread_local! {
    static INSP: RefCell<HashMap<u32, InspSession>> = RefCell::new(HashMap::new());
    static INSP_NEXT: std::cell::Cell<u32> = const { std::cell::Cell::new(1) };
}

#[op2(fast)]
pub fn op_inspector_connect(state: &mut OpState) -> Result<u32, JsErrorBox> {
    let h = state.try_borrow::<InspectorHandle>().map(|h| h.0.clone()).ok_or_else(|| JsErrorBox::new("Error", "ERR_INSPECTOR_NOT_AVAILABLE: Inspector is not available"))?;
    let queue = Rc::new(RefCell::new(std::collections::VecDeque::new()));
    let notify = Rc::new(tokio::sync::Notify::new());
    let (q2, n2) = (queue.clone(), notify.clone());
    let cb: deno_core::InspectorSessionSend = Box::new(move |msg: deno_core::InspectorMsg| {
        q2.borrow_mut().push_back(msg.content);
        n2.notify_one();
    });
    let session = deno_core::JsRuntimeInspector::create_local_session(h, cb, deno_core::InspectorSessionKind::NonBlocking { wait_for_disconnect: false });
    let id = INSP_NEXT.with(|n| { let v = n.get(); n.set(v + 1); v });
    INSP.with(|s| s.borrow_mut().insert(id, InspSession { session, queue, notify }));
    Ok(id)
}

#[op2(fast)]
pub fn op_inspector_post(id: u32, #[string] msg: &str) -> Result<(), JsErrorBox> {
    // Take the session out while dispatching: the response callback runs synchronously and
    // must not find the map borrowed.
    let taken = INSP.with(|s| s.borrow_mut().remove(&id));
    let Some(mut sess) = taken else { return Err(JsErrorBox::new("Error", "ERR_INSPECTOR_NOT_CONNECTED: Session is not connected")) };
    sess.session.dispatch(msg.to_string());
    INSP.with(|s| s.borrow_mut().insert(id, sess));
    Ok(())
}

fn insp_drain(id: u32) -> Option<Vec<String>> {
    INSP.with(|s| s.borrow().get(&id).map(|x| x.queue.borrow_mut().drain(..).collect()))
}

/// Messages already queued (responses arrive synchronously from `dispatch`).
#[op2]
#[serde]
pub fn op_inspector_take(id: u32) -> Vec<String> {
    insp_drain(id).unwrap_or_default()
}

/// Wait for further messages (notifications); empty when the session is gone.
#[op2]
#[serde]
pub async fn op_inspector_recv(id: u32) -> Vec<String> {
    loop {
        match insp_drain(id) {
            None => return Vec::new(),
            Some(v) if !v.is_empty() => return v,
            Some(_) => {}
        }
        let n = INSP.with(|s| s.borrow().get(&id).map(|x| x.notify.clone()));
        let Some(n) = n else { return Vec::new() };
        n.notified().await;
    }
}

/// `inspector.open(port, host)`: start the DevTools endpoint; returns the bound port.
#[op2(fast)]
pub fn op_inspector_open(state: &mut OpState, port: u16, #[string] host: &str) -> Result<u16, JsErrorBox> {
    let h = state.try_borrow::<InspectorHandle>().map(|h| h.0.clone()).ok_or_else(|| JsErrorBox::new("Error", "ERR_INSPECTOR_NOT_AVAILABLE: Inspector is not available"))?;
    let main = crate::httpimpl::MAIN.get().map(|(p, _)| p.to_string_lossy().to_string()).unwrap_or_default();
    crate::inspect_server::open(h, if host.is_empty() { "127.0.0.1" } else { host }, port, &main).map_err(|e| JsErrorBox::new("Error", format!("ERR_INSPECTOR_ALREADY_ACTIVATED: {e}")))
}

/// `inspector.waitForDebugger()`: block until a client connects and sends
/// Runtime.runIfWaitingForDebugger (the inspector pumps sessions while blocked).
#[op2(fast)]
pub fn op_inspector_wait(state: &mut OpState) -> Result<(), JsErrorBox> {
    let h = state.try_borrow::<InspectorHandle>().map(|h| h.0.clone()).ok_or_else(|| JsErrorBox::new("Error", "ERR_INSPECTOR_NOT_AVAILABLE: Inspector is not available"))?;
    h.wait_for_session_and_break_on_next_statement();
    Ok(())
}

#[op2]
#[string]
pub fn op_inspector_url() -> Option<String> {
    crate::inspect_server::url()
}

#[op2(fast)]
pub fn op_inspector_close() {
    crate::inspect_server::close();
}

#[op2(fast)]
pub fn op_inspector_disconnect(id: u32) {
    if let Some(s) = INSP.with(|s| s.borrow_mut().remove(&id)) {
        s.notify.notify_one();
        drop(s);
    }
}
