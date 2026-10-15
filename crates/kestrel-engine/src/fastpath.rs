//! HTTP/1.1 fast path: a level-triggered epoll/kqueue loop per worker that serves
//! keep-alive requests without bodies with one `read` and one `write` per request
//! (hyper's edge-triggered model costs an extra read returning EAGAIN per request,
//! which dominates once the kernel is the bottleneck). Anything the fast path does
//! not handle — request bodies, `Expect`, `Upgrade`, TLS — is handed to hyper with the
//! bytes read so far.

use std::cell::RefCell;
use std::io::{Read, Write};
use std::os::fd::{AsRawFd, RawFd};
use std::rc::Rc;
use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use polling::{Event, Events, PollMode, Poller};
use tokio::sync::oneshot;

use crate::httpimpl::{self, Outgoing, RawReq, Step};

const READ_CHUNK: usize = 16 * 1024;
const MAX_HEADER: usize = 64 * 1024;

struct Conn {
    /// Server (listen call) this connection belongs to; selects the JS handler.
    rid: u32,
    /// Live-connection counter of this worker (for least-loaded accept); decremented on drop.
    live: Option<Arc<std::sync::atomic::AtomicUsize>>,
    stream: std::net::TcpStream,
    rbuf: Vec<u8>,
    wbuf: Vec<u8>,
    /// A handler is running asynchronously for the request at the head of `rbuf`.
    waiting: bool,
    /// Close once `wbuf` is flushed.
    close_after: bool,
    want_write: bool,
    gen: u32,
}

struct Fast {
    poller: Arc<Poller>,
    conns: Vec<Option<Conn>>,
    free: Vec<usize>,
    done_tx: tokio::sync::mpsc::UnboundedSender<(usize, u32, Outgoing)>,
    /// Accepted connections from the acceptor threads, one receiver per listening port.
    /// The loop itself drains these: a separate task woken from another thread lands on
    /// tokio's inject queue, which the current-thread scheduler consults only every 31
    /// ticks, and that left freshly accepted connections unserved for up to a second
    /// under load (measured: first-second p99 of 700 ms at 4096 connections).
    rxs: Vec<(u32, httpimpl::ConnRx)>,
    new_rx: Arc<tokio::sync::Notify>,
}

type Accepted = (u32, std::net::TcpStream, Arc<std::sync::atomic::AtomicUsize>);

/// Hand a port's connection receiver to this worker's fast loop. Returns false if the loop
/// is not running (the caller then serves the receiver itself).
fn flog(msg: impl FnOnce() -> String) {
    static ON: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    if *ON.get_or_init(|| std::env::var("KESTREL_FAST_LOG").is_ok()) { eprintln!("[fast w{}] {}", httpimpl::worker_id(), msg()); }
}

pub fn adopt(rid: u32, rx: httpimpl::ConnRx) -> bool {
    flog(|| format!("adopt rid={rid}"));
    with_fast(|fast| {
        fast.rxs.push((rid, rx));
        fast.new_rx.notify_one();
    })
    .is_some()
}

/// Poll every adopted receiver once; `Pending` (with wakers registered) if none has a connection.
fn recv_any() -> impl std::future::Future<Output = Accepted> {
    std::future::poll_fn(|cx| {
        with_fast(|fast| {
            let mut i = 0;
            while i < fast.rxs.len() {
                let rid = fast.rxs[i].0;
                match fast.rxs[i].1.poll_recv(cx) {
                    std::task::Poll::Ready(Some((s, l))) => return std::task::Poll::Ready((rid, s, l)),
                    std::task::Poll::Ready(None) => {
                        fast.rxs.swap_remove(i);
                    }
                    std::task::Poll::Pending => i += 1,
                }
            }
            std::task::Poll::Pending
        })
        .unwrap_or(std::task::Poll::Pending)
    })
}

fn try_recv_any() -> Option<Accepted> {
    with_fast(|fast| {
        let mut i = 0;
        while i < fast.rxs.len() {
            let rid = fast.rxs[i].0;
            match fast.rxs[i].1.try_recv() {
                Ok((s, l)) => return Some((rid, s, l)),
                Err(tokio::sync::mpsc::error::TryRecvError::Disconnected) => {
                    fast.rxs.swap_remove(i);
                }
                Err(tokio::sync::mpsc::error::TryRecvError::Empty) => i += 1,
            }
        }
        None
    })
    .flatten()
}

fn register_accepted((rid, stream, live): Accepted) {
    flog(|| format!("register rid={rid}"));
    if !register(rid, stream, live.clone()) {
        live.fetch_sub(1, std::sync::atomic::Ordering::Relaxed);
    }
}

thread_local! {
    static FAST: RefCell<Option<Rc<RefCell<Fast>>>> = const { RefCell::new(None) };
}

pub fn enabled() -> bool {
    static ON: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ON.get_or_init(|| {
        let env_ok = std::env::var("KESTREL_FASTPATH").map(|v| v != "0").unwrap_or(true);
        env_ok && (cfg!(target_os = "linux") || cfg!(target_os = "macos"))
    })
}

struct PollFd(RawFd);
impl AsRawFd for PollFd {
    fn as_raw_fd(&self) -> RawFd {
        self.0
    }
}

/// Start this worker's fast loop (idempotent). Returns false if it could not start.
pub fn start() -> bool {
    if FAST.with(|f| f.borrow().is_some()) {
        return true;
    }
    let Ok(poller) = Poller::new() else { return false };
    if !poller.supports_level() {
        return false;
    }
    let poller = Arc::new(poller);
    let (done_tx, mut done_rx) = tokio::sync::mpsc::unbounded_channel::<(usize, u32, Outgoing)>();
    let new_rx = Arc::new(tokio::sync::Notify::new());
    let fast = Rc::new(RefCell::new(Fast { poller: poller.clone(), conns: Vec::new(), free: Vec::new(), done_tx, rxs: Vec::new(), new_rx: new_rx.clone() }));
    // Register the loop only once its driver handle exists: a half-started loop would make
    // later `start()` calls report success and swallow every adopted connection.
    // Readable interest only: kqueue rejects EVFILT_WRITE on a kqueue fd (EINVAL), which is
    // what registering with the default read+write interest does on macOS.
    let afd = match tokio::io::unix::AsyncFd::with_interest(PollFd(poller.as_raw_fd()), tokio::io::Interest::READABLE) {
        Ok(a) => a,
        Err(e) => {
            flog(|| format!("fast loop unavailable: {e}"));
            return false;
        }
    };
    FAST.with(|f| *f.borrow_mut() = Some(fast));
    tokio::spawn(async move {
        let mut events = Events::new();
        // True while the poller may still hold ready events we have not served. Under
        // sustained load a level-triggered set of thousands of keep-alive connections is
        // never empty, so the loop serves a bounded number of batches and then yields:
        // otherwise newly accepted connections (handed over through a channel on this
        // runtime), timers and async-handler completions starve for seconds.
        let mut backlog = false;
        loop {
            if backlog {
                while let Ok((key, gen, out)) = done_rx.try_recv() {
                    complete_async(key, gen, out);
                }
                while let Some(acc) = try_recv_any() {
                    register_accepted(acc);
                }
                tokio::task::yield_now().await;
                backlog = drain(&poller, &mut events, None);
                continue;
            }
            tokio::select! {
                guard = afd.readable() => {
                    let Ok(mut guard) = guard else { return };
                    backlog = drain(&poller, &mut events, Some(&mut guard));
                }
                Some((key, gen, out)) = done_rx.recv() => {
                    complete_async(key, gen, out);
                }
                acc = recv_any() => {
                    register_accepted(acc);
                }
                _ = new_rx.notified() => {}
            }
        }
    });
    true
}

/// Batches served per scheduler turn before yielding to the rest of the runtime.
const DRAIN_BUDGET: usize = 2;

/// Serve up to `DRAIN_BUDGET` batches of ready events. Returns true if the poller may still
/// have ready events (budget exhausted). When the poller is empty, clears tokio's
/// readiness for the poller fd (if a guard was given) so the task sleeps until the next event.
fn drain(poller: &Poller, events: &mut Events, mut guard: Option<&mut tokio::io::unix::AsyncFdReadyGuard<'_, PollFd>>) -> bool {
    for _ in 0..DRAIN_BUDGET {
        events.clear();
        let n = match poller.wait(events, Some(Duration::ZERO)) { Ok(n) => n, Err(_) => 0 };
        if n == 0 {
            if let Some(g) = guard.as_mut() {
                g.clear_ready();
            }
            return false;
        }
        let evs: Vec<Event> = events.iter().collect();
        for ev in evs {
            handle_event(ev);
        }
    }
    true
}

impl Drop for Conn {
    fn drop(&mut self) {
        if let Some(l) = &self.live {
            l.fetch_sub(1, std::sync::atomic::Ordering::Relaxed);
        }
    }
}

/// Register an accepted connection with this worker's fast loop.
pub fn register(rid: u32, stream: std::net::TcpStream, live: Arc<std::sync::atomic::AtomicUsize>) -> bool {
    FAST.with(|f| {
        let f = f.borrow();
        let Some(fast) = f.as_ref() else { return false };
        let mut fast = fast.borrow_mut();
        if stream.set_nonblocking(true).is_err() {
            return false;
        }
        let _ = stream.set_nodelay(true);
        let key = match fast.free.pop() {
            Some(k) => k,
            None => {
                fast.conns.push(None);
                fast.conns.len() - 1
            }
        };
        let gen = fast.conns[key].as_ref().map(|c| c.gen).unwrap_or(0).wrapping_add(1);
        // SAFETY: the stream stays alive in `conns` for as long as it is registered.
        if unsafe { fast.poller.add_with_mode(&stream, Event::readable(key), PollMode::Level) }.is_err() {
            fast.free.push(key);
            return false;
        }
        fast.conns[key] = Some(Conn { rid, live: Some(live), stream, rbuf: Vec::with_capacity(READ_CHUNK), wbuf: Vec::new(), waiting: false, close_after: false, want_write: false, gen });
        true
    })
}

fn with_fast<R>(f: impl FnOnce(&mut Fast) -> R) -> Option<R> {
    FAST.with(|c| c.borrow().as_ref().map(|fast| f(&mut fast.borrow_mut())))
}

fn handle_event(ev: Event) {
    let key = ev.key;
    // Take the connection out while working on it so JS callbacks (which may touch FAST) do not alias.
    let taken = with_fast(|fast| fast.conns.get_mut(key).and_then(|c| c.take())).flatten();
    let Some(mut conn) = taken else { return };
    let mut alive = true;
    if ev.readable && !conn.waiting {
        alive = on_readable(&mut conn, key);
    }
    if alive && ev.writable && !conn.wbuf.is_empty() {
        alive = flush(&mut conn);
    }
    if alive && conn.wbuf.is_empty() && conn.close_after {
        alive = false;
    }
    finish(conn, key, alive);
}

/// Put the connection back (with interest matching its state) or close it.
fn finish(mut conn: Conn, key: usize, alive: bool) {
    with_fast(|fast| {
        if alive {
            let want_write = !conn.wbuf.is_empty();
            if want_write != conn.want_write {
                conn.want_write = want_write;
                let interest = Event::new(key, !conn.waiting, want_write);
                let _ = fast.poller.modify_with_mode(&conn.stream, interest, PollMode::Level);
            }
            fast.conns[key] = Some(conn);
        } else {
            let _ = fast.poller.delete(&conn.stream);
            drop(conn);
            fast.conns[key] = None;
            fast.free.push(key);
        }
    });
}

fn set_interest(conn: &mut Conn, key: usize, readable: bool, writable: bool) {
    conn.want_write = writable;
    FAST.with(|f| {
        if let Some(fast) = f.borrow().as_ref() {
            let _ = fast.borrow().poller.modify_with_mode(&conn.stream, Event::new(key, readable, writable), PollMode::Level);
        }
    });
}

/// One read, then serve every complete request in the buffer. Returns false to close.
fn on_readable(conn: &mut Conn, key: usize) -> bool {
    let start = conn.rbuf.len();
    conn.rbuf.resize(start + READ_CHUNK, 0);
    let n = match conn.stream.read(&mut conn.rbuf[start..]) {
        Ok(0) => {
            conn.rbuf.truncate(start);
            return false; // peer closed
        }
        Ok(n) => n,
        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
            conn.rbuf.truncate(start);
            return true;
        }
        Err(_) => {
            conn.rbuf.truncate(start);
            return false;
        }
    };
    conn.rbuf.truncate(start + n);
    process_buffer(conn, key)
}

/// Parse and dispatch requests from `rbuf`. Returns false to close.
fn process_buffer(conn: &mut Conn, key: usize) -> bool {
    loop {
        if conn.waiting || conn.rbuf.is_empty() {
            break;
        }
        // HTTP/2 prior knowledge (h2c): hand the whole connection to hyper.
        const H2_PREFACE: &[u8] = b"PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n";
        if conn.rbuf.starts_with(&H2_PREFACE[..conn.rbuf.len().min(H2_PREFACE.len())]) {
            if conn.rbuf.len() < H2_PREFACE.len() {
                break; // need more bytes to be sure
            }
            let rest = conn.rbuf.split_off(0);
            if let Some(stream) = take_stream(conn) {
                httpimpl::hyper_takeover(conn.rid, stream, rest);
            }
            return false;
        }
        let mut headers = [httparse::EMPTY_HEADER; 48];
        let mut req = httparse::Request::new(&mut headers);
        let parsed = match req.parse(&conn.rbuf) {
            Ok(httparse::Status::Complete(n)) => n,
            Ok(httparse::Status::Partial) => {
                if conn.rbuf.len() > MAX_HEADER {
                    queue_response(conn, Outgoing { status: 431, headers: String::new(), body: Bytes::from_static(b"Request Header Fields Too Large") }, true);
                    return flush(conn);
                }
                break;
            }
            Err(_) => {
                queue_response(conn, Outgoing { status: 400, headers: String::new(), body: Bytes::from_static(b"Bad Request") }, true);
                return flush(conn);
            }
        };
        let method = req.method.unwrap_or("GET");
        let path = req.path.unwrap_or("/");
        let version = req.version.unwrap_or(1);
        let mut content_length = 0usize;
        let mut chunked = false;
        let mut upgrade = false;
        let mut expect = false;
        let mut close_after = version == 0;
        for h in req.headers.iter() {
            let name = h.name;
            if name.eq_ignore_ascii_case("content-length") {
                content_length = std::str::from_utf8(h.value).ok().and_then(|v| v.trim().parse().ok()).unwrap_or(0);
            } else if name.eq_ignore_ascii_case("transfer-encoding") {
                chunked = true;
            } else if name.eq_ignore_ascii_case("upgrade") {
                upgrade = true;
            } else if name.eq_ignore_ascii_case("expect") {
                expect = true;
            } else if name.eq_ignore_ascii_case("connection") {
                let v = std::str::from_utf8(h.value).unwrap_or("");
                if v.eq_ignore_ascii_case("close") { close_after = true; }
                if v.eq_ignore_ascii_case("keep-alive") { close_after = false; }
            }
        }
        if content_length > 0 || chunked || upgrade || expect || method == "CONNECT" {
            // Hand the connection to hyper with the unread bytes.
            let rest = conn.rbuf.split_off(0);
            if let Some(stream) = take_stream(conn) {
                httpimpl::hyper_takeover(conn.rid, stream, rest);
            }
            return false;
        }
        let raw = RawReq {
            method: method.to_string(),
            path: path.to_string(),
            headers: conn.rbuf[..parsed].to_vec(),
        };
        conn.rbuf.drain(..parsed);
        flog(|| format!("dispatch rid={} {}", conn.rid, raw.path));
        let step = httpimpl::dispatch_raw(conn.rid, raw);
        match step {
            Step::Done(out) => {
                queue_response(conn, out, close_after);
                if close_after {
                    return flush(conn);
                }
            }
            Step::Pending(rrx) | Step::Queue(_, rrx) => {
                conn.waiting = true;
                conn.close_after = close_after;
                set_interest(conn, key, false, !conn.wbuf.is_empty());
                spawn_completion(key, conn.gen, rrx);
                break;
            }
        }
    }
    flush(conn)
}

/// Detach the socket from the poller and return a duplicate fd carrying the connection
/// (the original stays in `conn` and is dropped with it).
fn take_stream(conn: &mut Conn) -> Option<std::net::TcpStream> {
    let dup = conn.stream.try_clone().ok()?;
    FAST.with(|f| {
        if let Some(fast) = f.borrow().as_ref() {
            let _ = fast.borrow().poller.delete(&conn.stream);
        }
    });
    Some(dup)
}

fn spawn_completion(key: usize, gen: u32, rrx: oneshot::Receiver<Outgoing>) {
    let tx = with_fast(|f| f.done_tx.clone());
    let Some(tx) = tx else { return };
    tokio::spawn(async move {
        let out = rrx.await.unwrap_or(Outgoing { status: 500, headers: String::new(), body: Bytes::from_static(b"Internal Server Error") });
        let _ = tx.send((key, gen, out));
    });
}

fn complete_async(key: usize, gen: u32, out: Outgoing) {
    let taken = with_fast(|fast| fast.conns.get_mut(key).and_then(|c| c.take())).flatten();
    let Some(mut conn) = taken else { return };
    if conn.gen != gen {
        with_fast(|fast| fast.conns[key] = Some(conn));
        return;
    }
    conn.waiting = false;
    let close_after = conn.close_after;
    queue_response(&mut conn, out, close_after);
    let mut alive = if close_after { flush(&mut conn) } else { process_buffer(&mut conn, key) };
    if alive && conn.wbuf.is_empty() && conn.close_after {
        alive = false;
    }
    // Re-arm read interest (dropped while the handler was pending) unless we went async again.
    if alive {
        let w = !conn.wbuf.is_empty();
        let r = !conn.waiting;
        set_interest(&mut conn, key, r, w);
    }
    finish(conn, key, alive);
}

/// Write as much of `wbuf` as the socket takes. Returns false on a fatal error.
fn flush(conn: &mut Conn) -> bool {
    while !conn.wbuf.is_empty() {
        match conn.stream.write(&conn.wbuf) {
            Ok(0) => return false,
            Ok(n) => {
                conn.wbuf.drain(..n);
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => return true,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => return false,
        }
    }
    true
}

thread_local! {
    static DATE: RefCell<(u64, String)> = const { RefCell::new((0, String::new())) };
}
fn date_header() -> String {
    let now = std::time::SystemTime::now();
    let secs = now.duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    DATE.with(|d| {
        let mut d = d.borrow_mut();
        if d.0 != secs || d.1.is_empty() {
            d.0 = secs;
            d.1 = httpdate::fmt_http_date(now);
        }
        d.1.clone()
    })
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK", 201 => "Created", 202 => "Accepted", 204 => "No Content", 206 => "Partial Content",
        301 => "Moved Permanently", 302 => "Found", 303 => "See Other", 304 => "Not Modified", 307 => "Temporary Redirect", 308 => "Permanent Redirect",
        400 => "Bad Request", 401 => "Unauthorized", 403 => "Forbidden", 404 => "Not Found", 405 => "Method Not Allowed", 409 => "Conflict",
        410 => "Gone", 412 => "Precondition Failed", 413 => "Payload Too Large", 415 => "Unsupported Media Type", 422 => "Unprocessable Entity",
        429 => "Too Many Requests", 431 => "Request Header Fields Too Large", 500 => "Internal Server Error", 501 => "Not Implemented",
        502 => "Bad Gateway", 503 => "Service Unavailable", 504 => "Gateway Timeout", _ => "",
    }
}

fn queue_response(conn: &mut Conn, out: Outgoing, close: bool) {
    let w = &mut conn.wbuf;
    w.extend_from_slice(format!("HTTP/1.1 {} {}\r\n", out.status, reason(out.status)).as_bytes());
    let mut has_ct = false;
    let mut has_cl = false;
    if !out.headers.is_empty() {
        let mut it = out.headers.split('\0');
        while let (Some(k), Some(v)) = (it.next(), it.next()) {
            if k.is_empty() { continue; }
            if k.eq_ignore_ascii_case("content-type") { has_ct = true; }
            if k.eq_ignore_ascii_case("content-length") { has_cl = true; }
            if k.eq_ignore_ascii_case("transfer-encoding") { continue; }
            w.extend_from_slice(k.as_bytes());
            w.extend_from_slice(b": ");
            w.extend_from_slice(v.as_bytes());
            w.extend_from_slice(b"\r\n");
        }
    }
    if !has_ct {
        w.extend_from_slice(b"content-type: text/plain;charset=UTF-8\r\n");
    }
    if !has_cl {
        w.extend_from_slice(format!("content-length: {}\r\n", out.body.len()).as_bytes());
    }
    w.extend_from_slice(format!("date: {}\r\n", date_header()).as_bytes());
    if close {
        w.extend_from_slice(b"connection: close\r\n");
        conn.close_after = true;
    }
    w.extend_from_slice(b"\r\n");
    w.extend_from_slice(&out.body);
}
