//! HTTP/2 for `node:http2`, over the `h2` crate directly (hyper does not expose server push).
//! Servers accept connections themselves (TLS with ALPN `h2`, or h2c), hand each stream to
//! JS as a stream id, and JS drives it with the ops below: read request data, send the
//! response head, body and trailers, push promised streams, reset. Clients connect the same
//! way and additionally receive push promises. Everything lives in a thread-local table and
//! the async ops poll the `h2` handles in place, so no `!Send` value crosses an await.

use std::cell::RefCell;
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::rc::Rc;
use std::sync::Arc;
use std::task::Poll;

use bytes::Bytes;
use deno_core::{op2, OpState};
use deno_error::JsErrorBox;
use hyper::http::{self, HeaderName, HeaderValue, Request, Response};
use serde::Serialize;

type SendStream = h2::SendStream<Bytes>;

struct Stream {
    wakers: [Option<std::task::Waker>; 4],
    cid: u32,
    recv: Option<h2::RecvStream>,
    respond: Option<h2::server::SendResponse<Bytes>>,
    pushed: Option<h2::server::SendPushedResponse<Bytes>>,
    resp_fut: Option<h2::client::ResponseFuture>,
    pushed_fut: Option<h2::client::PushedResponseFuture>,
    pushes: Option<h2::client::PushPromises>,
    send: Option<SendStream>,
}

impl Drop for Stream {
    fn drop(&mut self) {
        // The async ops poll handles stored here, not handles they own. Removing
        // a stream must wake those ops so they observe its removal and finish.
        for waker in self.wakers.iter_mut().filter_map(Option::take) { waker.wake(); }
    }
}

struct Conn {
    ping: Option<Rc<RefCell<Option<h2::PingPong>>>>,
    remote: String,
    remote_port: u16,
    local_port: u16,
    encrypted: bool,
    client: Option<h2::client::SendRequest<Bytes>>,
    task: Option<tokio::task::AbortHandle>,
}

#[derive(Serialize)]
pub struct Accepted {
    cid: u32,
    sid: u32,
    headers: Vec<(String, String)>,
    has_body: bool,
    first: bool,
    remote: String,
    remote_port: u16,
    local_port: u16,
    encrypted: bool,
}

struct Listener {
    rx: tokio::sync::mpsc::UnboundedReceiver<Accepted>,
    port: u16,
    task: tokio::task::JoinHandle<()>,
    accept_waker: Option<std::task::Waker>,
}

#[derive(Default)]
struct H2 {
    next: u32,
    streams: HashMap<u32, Stream>,
    conns: HashMap<u32, Conn>,
    listeners: HashMap<u32, Listener>,
}

thread_local! {
    static H2S: RefCell<H2> = RefCell::new(H2::default());
}

/// `KESTREL_FAST_LOG=1` also traces the HTTP/2 layer.
fn h2_log() -> bool {
    static ON: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ON.get_or_init(|| std::env::var("KESTREL_FAST_LOG").is_ok())
}

fn with<R>(f: impl FnOnce(&mut H2) -> R) -> R {
    H2S.with(|h| f(&mut h.borrow_mut()))
}

fn next_id(h: &mut H2) -> u32 {
    h.next += 1;
    h.next
}

fn h2_err(e: h2::Error) -> JsErrorBox {
    let code = e.reason().map(|r| format!("{r:?}")).unwrap_or_else(|| "ERR_HTTP2_ERROR".into());
    JsErrorBox::new("Error", format!("{code}: {e}"))
}

fn stream_err() -> JsErrorBox {
    JsErrorBox::new("Error", "ERR_HTTP2_INVALID_STREAM: The stream has been destroyed")
}

/// Pseudo-headers plus regular headers, as `node:http2` presents them.
fn request_headers(parts: &http::request::Parts, tls: bool) -> Vec<(String, String)> {
    let mut out = Vec::with_capacity(parts.headers.len() + 4);
    out.push((":method".into(), parts.method.as_str().to_string()));
    out.push((":path".into(), parts.uri.path_and_query().map(|p| p.as_str().to_string()).unwrap_or_else(|| "/".into())));
    out.push((":scheme".into(), parts.uri.scheme_str().map(|s| s.to_string()).unwrap_or_else(|| if tls { "https".into() } else { "http".into() })));
    if let Some(a) = parts.uri.authority() {
        out.push((":authority".into(), a.as_str().to_string()));
    } else if let Some(h) = parts.headers.get(http::header::HOST) {
        out.push((":authority".into(), h.to_str().unwrap_or("").to_string()));
    }
    for (k, v) in parts.headers.iter() {
        if k == http::header::HOST { continue; }
        out.push((k.as_str().to_string(), v.to_str().unwrap_or("").to_string()));
    }
    out
}

fn response_headers(parts: &http::response::Parts) -> Vec<(String, String)> {
    let mut out = Vec::with_capacity(parts.headers.len() + 1);
    out.push((":status".into(), parts.status.as_u16().to_string()));
    for (k, v) in parts.headers.iter() {
        out.push((k.as_str().to_string(), v.to_str().unwrap_or("").to_string()));
    }
    out
}

fn apply_flat_headers(map: &mut http::HeaderMap, flat: &str) {
    let mut it = flat.split('\0');
    while let (Some(k), Some(v)) = (it.next(), it.next()) {
        if k.is_empty() || k.starts_with(':') { continue; }
        if let (Ok(n), Ok(val)) = (HeaderName::from_bytes(k.as_bytes()), HeaderValue::from_str(v)) {
            map.append(n, val);
        }
    }
}

// ---------- server ----------

/// Bind and start accepting HTTP/2 connections (TLS when `tls`: the thread's server config,
/// which must offer ALPN `h2`; otherwise h2c with prior knowledge). Returns `[rid, port]`.
#[op2]
#[serde]
pub fn op_h2_listen(#[string] host: &str, port: u16, tls: bool) -> Result<(u32, u16), JsErrorBox> {
    let addr: std::net::SocketAddr = format!("{}:{}", if host == "localhost" { "127.0.0.1" } else { host }, port).parse().map_err(|e| JsErrorBox::type_error(format!("bad address: {e}")))?;
    let std_l = std::net::TcpListener::bind(addr).map_err(|e| JsErrorBox::new("Error", format!("EADDRINUSE: {e}")))?;
    std_l.set_nonblocking(true).map_err(|e| JsErrorBox::generic(e.to_string()))?;
    let bound = std_l.local_addr().map(|a| a.port()).unwrap_or(port);
    let listener = tokio::net::TcpListener::from_std(std_l).map_err(|e| JsErrorBox::generic(e.to_string()))?;
    let acceptor = if tls { crate::netimpl::TLS_ACCEPTOR.with(|t| t.borrow().clone()) } else { None };
    if tls && acceptor.is_none() {
        return Err(JsErrorBox::type_error("ERR_MISSING_ARGS: TLS key and certificate are required"));
    }
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<Accepted>();
    let task = tokio::spawn(async move {
        loop {
            let Ok((stream, peer)) = listener.accept().await else { break };
            let _ = stream.set_nodelay(true);
            let local_port = stream.local_addr().map(|a| a.port()).unwrap_or(0);
            let tx = tx.clone();
            let acceptor = acceptor.clone();
            tokio::spawn(async move {
                let encrypted = acceptor.is_some();
                let conn_info = (peer.ip().to_string(), peer.port(), local_port, encrypted);
                match acceptor {
                    Some(acc) => {
                        let Ok(tls) = acc.accept(stream).await else { return };
                        serve_conn(tls, conn_info, tx).await;
                    }
                    None => serve_conn(stream, conn_info, tx).await,
                }
            });
        }
    });
    let rid = with(|h| {
        let rid = next_id(h);
        h.listeners.insert(rid, Listener { rx, port: bound, task, accept_waker: None });
        rid
    });
    Ok((rid, bound))
}

async fn serve_conn<T>(io: T, (remote, remote_port, local_port, encrypted): (String, u16, u16, bool), tx: tokio::sync::mpsc::UnboundedSender<Accepted>)
where
    T: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let Ok(mut conn) = h2::server::Builder::new().handshake::<_, Bytes>(io).await else { return };
    let ping = Rc::new(RefCell::new(conn.ping_pong()));
    let cid = with(|h| {
        let cid = next_id(h);
        h.conns.insert(cid, Conn { ping: Some(ping), remote: remote.clone(), remote_port, local_port, encrypted, client: None, task: None });
        cid
    });
    let mut first = true;
    while let Some(next) = conn.accept().await {
        let Ok((req, respond)) = next else { break };
        let (parts, body) = req.into_parts();
        let headers = request_headers(&parts, encrypted);
        let has_body = !body.is_end_stream();
        let sid = with(|h| {
            let sid = next_id(h);
            h.streams.insert(sid, Stream { wakers: Default::default(), cid, recv: Some(body), respond: Some(respond), pushed: None, resp_fut: None, pushed_fut: None, pushes: None, send: None });
            sid
        });
        if h2_log() { eprintln!("[h2] accepted cid={cid} sid={sid} {:?} body={has_body}", parts.uri); }
        if tx.send(Accepted { cid, sid, headers, has_body, first, remote: remote.clone(), remote_port, local_port, encrypted }).is_err() {
            break;
        }
        first = false;
    }
    with(|h| {
        h.conns.remove(&cid);
    });
}

/// Next request on a listener; `null` once the listener is closed.
#[op2]
#[serde]
pub async fn op_h2_accept(rid: u32) -> Option<Accepted> {
    std::future::poll_fn(|cx| with(|h| match h.listeners.get_mut(&rid) {
        Some(l) => { l.accept_waker = Some(cx.waker().clone()); l.rx.poll_recv(cx) },
        None => Poll::Ready(None),
    })).await
}

#[op2]
pub async fn op_h2_close_listener(rid: u32) {
    let listener = with(|h| h.listeners.remove(&rid));
    if let Some(l) = listener {
        if let Some(waker) = l.accept_waker { waker.wake(); }
        l.task.abort();
        let _ = l.task.await;
    }
}

#[op2(fast)]
pub fn op_h2_listener_port(rid: u32) -> u16 {
    with(|h| h.listeners.get(&rid).map(|l| l.port).unwrap_or(0))
}

// ---------- streams (both sides) ----------

/// Next chunk of the stream's incoming data; `null` at end of stream.
#[op2]
#[buffer]
pub async fn op_h2_read(sid: u32) -> Result<Option<Vec<u8>>, JsErrorBox> {
    let r = std::future::poll_fn(|cx| {
        with(|h| {
            let Some(s) = h.streams.get_mut(&sid) else { return Poll::Ready(None) };
            s.wakers[0] = Some(cx.waker().clone());
            let Some(recv) = s.recv.as_mut() else { return Poll::Ready(None) };
            match recv.poll_data(cx) {
                Poll::Ready(Some(Ok(b))) => {
                    let _ = recv.flow_control().release_capacity(b.len());
                    Poll::Ready(Some(Ok(b)))
                }
                Poll::Ready(Some(Err(e))) => Poll::Ready(Some(Err(e))),
                Poll::Ready(None) => Poll::Ready(None),
                Poll::Pending => Poll::Pending,
            }
        })
    })
    .await;
    match r {
        None => Ok(None),
        Some(Ok(b)) => Ok(Some(b.to_vec())),
        Some(Err(e)) => Err(h2_err(e)),
    }
}

/// Server side: send the response head (`end` closes the stream without a body).
#[op2(fast)]
pub fn op_h2_respond(sid: u32, status: u16, #[string] headers: &str, end: bool) -> Result<(), JsErrorBox> {
    let mut resp = Response::new(());
    *resp.status_mut() = http::StatusCode::from_u16(status).map_err(|_| JsErrorBox::new("RangeError", format!("ERR_HTTP2_STATUS_INVALID: Invalid status code: {status}")))?;
    apply_flat_headers(resp.headers_mut(), headers);
    with(|h| {
        let s = h.streams.get_mut(&sid).ok_or_else(stream_err)?;
        if h2_log() { eprintln!("[h2] respond sid={sid} status={status} end={end} has_respond={} has_pushed={} has_send={} headers={:?}", s.respond.is_some(), s.pushed.is_some(), s.send.is_some(), resp.headers()); }
        let send = if let Some(r) = s.respond.as_mut() {
            r.send_response(resp, end).map_err(|e| { if h2_log() { eprintln!("[h2] send_response error: {e:?}"); } h2_err(e) })?
        } else if let Some(p) = s.pushed.as_mut() {
            p.send_response(resp, end).map_err(h2_err)?
        } else {
            return Err(JsErrorBox::new("Error", "ERR_HTTP2_HEADERS_SENT: Response has already been initiated."));
        };
        s.respond = None;
        s.pushed = None;
        s.send = Some(send);
        Ok(())
    })
}

/// Write body data, honouring flow control.
#[op2]
pub async fn op_h2_write(sid: u32, #[buffer(copy)] data: Vec<u8>) -> Result<(), JsErrorBox> {
    let mut data = Bytes::from(data);
    while !data.is_empty() {
        let want = data.len();
        let cap = std::future::poll_fn(|cx| {
            with(|h| {
                let Some(s) = h.streams.get_mut(&sid) else { return Poll::Ready(Err(stream_err())) };
                s.wakers[1] = Some(cx.waker().clone());
                let Some(send) = s.send.as_mut() else { return Poll::Ready(Err(stream_err())) };
                send.reserve_capacity(want);
                match send.poll_capacity(cx) {
                    Poll::Ready(Some(Ok(n))) => Poll::Ready(Ok(n)),
                    Poll::Ready(Some(Err(e))) => Poll::Ready(Err(h2_err(e))),
                    Poll::Ready(None) => Poll::Ready(Err(stream_err())),
                    Poll::Pending => Poll::Pending,
                }
            })
        })
        .await?;
        let n = cap.min(data.len());
        if n == 0 { continue; }
        let chunk = data.split_to(n);
        with(|h| {
            let s = h.streams.get_mut(&sid).ok_or_else(stream_err)?;
            let send = s.send.as_mut().ok_or_else(stream_err)?;
            send.send_data(chunk, false).map_err(h2_err)
        })?;
    }
    Ok(())
}

/// End the stream (optionally with trailers "k\0v\0...").
#[op2(fast)]
pub fn op_h2_end(sid: u32, #[string] trailers: &str) -> Result<(), JsErrorBox> {
    with(|h| {
        let s = h.streams.get_mut(&sid).ok_or_else(stream_err)?;
        let send = s.send.as_mut().ok_or_else(stream_err)?;
        if trailers.is_empty() {
            send.send_data(Bytes::new(), true).map_err(h2_err)
        } else {
            let mut map = http::HeaderMap::new();
            apply_flat_headers(&mut map, trailers);
            send.send_trailers(map).map_err(h2_err)
        }
    })
}

#[op2(fast)]
pub fn op_h2_rst(sid: u32, code: u32) {
    with(|h| {
        if let Some(mut s) = h.streams.remove(&sid) {
            let reason = h2::Reason::from(code);
            if let Some(mut r) = s.respond.take() { r.send_reset(reason); }
            if let Some(mut p) = s.pushed.take() { p.send_reset(reason); }
            if let Some(mut w) = s.send.take() { w.send_reset(reason); }
        }
    });
}

/// Drop the stream's handles once JS is done with it.
#[op2(fast)]
pub fn op_h2_release(sid: u32) {
    with(|h| {
        h.streams.remove(&sid);
    });
}

/// Server push: promise `method path` with `headers` on the connection of `sid`; returns the
/// pushed stream id, which is then answered with `op_h2_respond`/`op_h2_write`/`op_h2_end`.
#[op2(fast)]
pub fn op_h2_push(sid: u32, #[string] method: &str, #[string] path: &str, #[string] authority: &str, #[string] scheme: &str, #[string] headers: &str) -> Result<u32, JsErrorBox> {
    let uri = format!("{scheme}://{authority}{path}");
    let mut req = Request::builder().method(method).uri(uri.as_str()).body(()).map_err(|e| JsErrorBox::type_error(format!("ERR_HTTP2_INVALID_HEADER_VALUE: {e}")))?;
    apply_flat_headers(req.headers_mut(), headers);
    with(|h| {
        let cid = h.streams.get(&sid).map(|s| s.cid).ok_or_else(stream_err)?;
        let parent = h.streams.get_mut(&sid).ok_or_else(stream_err)?;
        let r = parent.respond.as_mut().ok_or_else(|| JsErrorBox::new("Error", "ERR_HTTP2_PUSH_DISABLED: pushStream must be called before the response is sent"))?;
        let pushed = r.push_request(req).map_err(h2_err)?;
        let psid = next_id(h);
        h.streams.insert(psid, Stream { wakers: Default::default(), cid, recv: None, respond: None, pushed: Some(pushed), resp_fut: None, pushed_fut: None, pushes: None, send: None });
        Ok(psid)
    })
}

/// Round-trip time of a PING on the stream's connection, in milliseconds.
#[op2]
pub async fn op_h2_ping(cid: u32) -> Result<f64, JsErrorBox> {
    let ping = with(|h| h.conns.get(&cid).and_then(|c| c.ping.clone())).ok_or_else(|| JsErrorBox::new("Error", "ERR_HTTP2_INVALID_SESSION: The session has been destroyed"))?;
    let mut pp = ping.borrow_mut().take().ok_or_else(|| JsErrorBox::new("Error", "ERR_HTTP2_PING_CANCEL: ping in flight"))?;
    let t0 = std::time::Instant::now();
    let r = pp.ping(h2::Ping::opaque()).await;
    *ping.borrow_mut() = Some(pp);
    r.map_err(h2_err)?;
    Ok(t0.elapsed().as_secs_f64() * 1000.0)
}

#[op2(fast)]
pub fn op_h2_conn_close(cid: u32) {
    with(|h| {
        if let Some(c) = h.conns.remove(&cid) {
            if let Some(t) = c.task { t.abort(); }
        }
        h.streams.retain(|_, s| s.cid != cid);
    });
}

// ---------- client ----------

#[derive(Serialize)]
pub struct ConnInfo {
    cid: u32,
    remote: String,
    remote_port: u16,
    local_port: u16,
    encrypted: bool,
}

/// Connect an HTTP/2 client session (TLS with ALPN `h2`, or h2c prior knowledge).
#[op2]
#[serde]
pub async fn op_h2_connect(#[string] host: String, port: u16, tls: bool, #[string] servername: String, insecure: bool) -> Result<ConnInfo, JsErrorBox> {
    let tcp = tokio::net::TcpStream::connect((host.as_str(), port)).await.map_err(|e| JsErrorBox::new("Error", format!("ECONNREFUSED: connect {host}:{port}: {e}")))?;
    let _ = tcp.set_nodelay(true);
    let remote = tcp.peer_addr().map(|a| a.ip().to_string()).unwrap_or_default();
    let remote_port = tcp.peer_addr().map(|a| a.port()).unwrap_or(0);
    let local_port = tcp.local_addr().map(|a| a.port()).unwrap_or(0);
    let (client, task, ping) = if tls {
        let cfg = crate::netimpl::tls_client_config(insecure, &["h2"]);
        let connector = tokio_rustls::TlsConnector::from(Arc::new(cfg));
        let name = rustls::pki_types::ServerName::try_from(if servername.is_empty() { host.clone() } else { servername }).map_err(|e| JsErrorBox::type_error(format!("bad servername: {e}")))?;
        let io = connector.connect(name, tcp).await.map_err(|e| JsErrorBox::new("Error", format!("ERR_TLS_HANDSHAKE: {e}")))?;
        client_handshake(io).await?
    } else {
        client_handshake(tcp).await?
    };
    let cid = with(|h| {
        let cid = next_id(h);
        h.conns.insert(cid, Conn { ping, remote: remote.clone(), remote_port, local_port, encrypted: tls, client: Some(client), task: Some(task) });
        cid
    });
    Ok(ConnInfo { cid, remote, remote_port, local_port, encrypted: tls })
}

async fn client_handshake<T>(io: T) -> Result<(h2::client::SendRequest<Bytes>, tokio::task::AbortHandle, Option<Rc<RefCell<Option<h2::PingPong>>>>), JsErrorBox>
where
    T: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let (client, mut conn) = h2::client::Builder::new().enable_push(true).handshake::<_, Bytes>(io).await.map_err(h2_err)?;
    let ping = conn.ping_pong().map(|p| Rc::new(RefCell::new(Some(p))));
    let task = tokio::spawn(async move {
        let _ = conn.await;
    })
    .abort_handle();
    Ok((client, task, ping))
}

/// Start a request; returns the stream id. `end` closes the request body at once.
#[op2]
pub async fn op_h2_request(cid: u32, #[string] method: String, #[string] uri: String, #[string] headers: String, end: bool) -> Result<u32, JsErrorBox> {
    let client = with(|h| h.conns.get(&cid).and_then(|c| c.client.clone())).ok_or_else(|| JsErrorBox::new("Error", "ERR_HTTP2_INVALID_SESSION: The session has been destroyed"))?;
    let mut client = client.ready().await.map_err(h2_err)?;
    let mut req = Request::builder().method(method.as_str()).uri(uri.as_str()).body(()).map_err(|e| JsErrorBox::type_error(format!("ERR_HTTP2_INVALID_HEADER_VALUE: {e}")))?;
    apply_flat_headers(req.headers_mut(), &headers);
    let (mut fut, send) = client.send_request(req, end).map_err(h2_err)?;
    let pushes = fut.push_promises();
    Ok(with(|h| {
        let sid = next_id(h);
        h.streams.insert(sid, Stream { wakers: Default::default(), cid, recv: None, respond: None, pushed: None, resp_fut: Some(fut), pushed_fut: None, pushes: Some(pushes), send: Some(send) });
        sid
    }))
}

#[derive(Serialize)]
pub struct Head {
    headers: Vec<(String, String)>,
    has_body: bool,
}

/// Response head of a client stream (or of a pushed stream).
#[op2]
#[serde]
pub async fn op_h2_response(sid: u32) -> Result<Head, JsErrorBox> {
    let r = std::future::poll_fn(|cx| {
        with(|h| {
            let Some(s) = h.streams.get_mut(&sid) else { return Poll::Ready(Err(stream_err())) };
            s.wakers[2] = Some(cx.waker().clone());
            let polled = if let Some(f) = s.resp_fut.as_mut() {
                Pin::new(f).poll(cx)
            } else if let Some(f) = s.pushed_fut.as_mut() {
                Pin::new(f).poll(cx)
            } else {
                return Poll::Ready(Err(JsErrorBox::new("Error", "ERR_HTTP2_INVALID_STREAM: no response pending")));
            };
            match polled {
                Poll::Pending => Poll::Pending,
                Poll::Ready(Err(e)) => Poll::Ready(Err(h2_err(e))),
                Poll::Ready(Ok(resp)) => {
                    s.resp_fut = None;
                    s.pushed_fut = None;
                    let (parts, body) = resp.into_parts();
                    let has_body = !body.is_end_stream();
                    s.recv = Some(body);
                    Poll::Ready(Ok(Head { headers: response_headers(&parts), has_body }))
                }
            }
        })
    })
    .await;
    r
}

#[derive(Serialize)]
pub struct Promise {
    psid: u32,
    headers: Vec<(String, String)>,
}

/// Next push promise received on a client stream; `null` when there will be no more.
#[op2]
#[serde]
pub async fn op_h2_push_promise(sid: u32) -> Result<Option<Promise>, JsErrorBox> {
    std::future::poll_fn(|cx| {
        with(|h| {
            let Some(s) = h.streams.get_mut(&sid) else { return Poll::Ready(Ok(None)) };
            s.wakers[3] = Some(cx.waker().clone());
            let Some(p) = s.pushes.as_mut() else { return Poll::Ready(Ok(None)) };
            match p.poll_push_promise(cx) {
                Poll::Pending => Poll::Pending,
                Poll::Ready(None) => { s.pushes = None; Poll::Ready(Ok(None)) }
                Poll::Ready(Some(Err(e))) => Poll::Ready(Err(h2_err(e))),
                Poll::Ready(Some(Ok(pp))) => {
                    let cid = s.cid;
                    let (req, fut) = pp.into_parts();
                    let (parts, _) = req.into_parts();
                    let headers = request_headers(&parts, false);
                    let psid = next_id(h);
                    h.streams.insert(psid, Stream { wakers: Default::default(), cid, recv: None, respond: None, pushed: None, resp_fut: None, pushed_fut: Some(fut), pushes: None, send: None });
                    Poll::Ready(Ok(Some(Promise { psid, headers })))
                }
            }
        })
    })
    .await
}

#[op2]
#[serde]
pub fn op_h2_conn_info(cid: u32) -> Option<ConnInfo> {
    with(|h| h.conns.get(&cid).map(|c| ConnInfo { cid, remote: c.remote.clone(), remote_port: c.remote_port, local_port: c.local_port, encrypted: c.encrypted }))
}

#[allow(dead_code)]
fn _state_unused(_: &mut OpState) {}
