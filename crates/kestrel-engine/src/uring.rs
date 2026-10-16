//! io_uring HTTP/1.1 fast path (Linux). Request handling is the same as `fastpath.rs`, but
//! reads and writes are queued as `recv`/`send` SQEs and submitted together: one
//! `io_uring_enter` per batch of completions instead of a `read` and a `write` syscall per
//! request. With `IORING_FEAT_FAST_POLL` a `recv` on an idle socket is parked inside the
//! kernel, so idle connections cost no syscalls either. Bodies, `Expect`, `Upgrade`,
//! `CONNECT`, the h2c preface and TLS are handed to hyper exactly as in the epoll loop.
//!
//! Invariants: an `SQE` only ever points into a connection's `rbuf` (recv) or `sending`
//! (send), both heap allocations that never move or shrink while the operation is in
//! flight, and a connection is freed only when no operation is in flight.

use std::cell::RefCell;
use std::os::fd::{AsRawFd, FromRawFd, IntoRawFd, RawFd};
use std::rc::Rc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use bytes::Bytes;
use io_uring::{opcode, types, IoUring};
use tokio::sync::oneshot;

use crate::fastpath::{flog, write_response};
use crate::httpimpl::{self, Outgoing, RawReq, Step};

const RBUF: usize = 16 * 1024;
const ENTRIES: u32 = 8192;
const KIND_SEND: u64 = 1 << 63;
const H2_PREFACE: &[u8] = b"PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n";

struct UConn {
    rid: u32,
    live: Option<Arc<AtomicUsize>>,
    fd: RawFd,
    /// Receive buffer; `rlen` bytes are valid (unparsed) at the front.
    rbuf: Box<[u8]>,
    rlen: usize,
    recv_inflight: bool,
    /// Bytes of the in-flight send; `sent` of them are already accepted by the kernel.
    sending: Vec<u8>,
    sent: usize,
    send_inflight: bool,
    /// Responses queued behind the in-flight send.
    wbuf: Vec<u8>,
    /// An async handler owns the request at the head of `rbuf`.
    waiting: bool,
    /// Close once everything queued has been sent.
    close_after: bool,
    /// Peer gone or error: free as soon as nothing is in flight.
    closing: bool,
    /// Hand the connection to hyper once the in-flight send completes.
    handover: bool,
    gen: u32,
}

impl Drop for UConn {
    fn drop(&mut self) {
        if let Some(l) = &self.live {
            l.fetch_sub(1, Ordering::Relaxed);
        }
        if self.fd >= 0 {
            // SAFETY: we own the descriptor and nothing is in flight on it (see module docs).
            unsafe { libc::close(self.fd) };
        }
    }
}

type Accepted = (u32, std::net::TcpStream, Arc<AtomicUsize>);

struct Uring {
    ring: IoUring,
    conns: Vec<Option<UConn>>,
    free: Vec<usize>,
    done_tx: tokio::sync::mpsc::UnboundedSender<(usize, u32, Outgoing)>,
    rxs: Vec<(u32, httpimpl::ConnRx)>,
    new_rx: Arc<tokio::sync::Notify>,
    /// SQEs pushed since the last `submit`.
    dirty: bool,
}

thread_local! {
    static URING: RefCell<Option<Rc<RefCell<Uring>>>> = const { RefCell::new(None) };
}

fn with_uring<R>(f: impl FnOnce(&mut Uring) -> R) -> Option<R> {
    URING.with(|u| u.borrow().as_ref().map(|r| f(&mut r.borrow_mut())))
}

struct RingFd(RawFd);
impl AsRawFd for RingFd {
    fn as_raw_fd(&self) -> RawFd {
        self.0
    }
}

/// Start this worker's io_uring loop (idempotent). False when io_uring is unavailable.
pub fn start() -> bool {
    if URING.with(|u| u.borrow().is_some()) {
        return true;
    }
    let ring = match IoUring::new(ENTRIES) {
        Ok(r) => r,
        Err(e) => {
            flog(|| format!("io_uring unavailable: {e}"));
            return false;
        }
    };
    if !ring.params().is_feature_fast_poll() {
        flog(|| "io_uring: no FAST_POLL, using epoll".to_string());
        return false;
    }
    let afd = match tokio::io::unix::AsyncFd::with_interest(RingFd(ring.as_raw_fd()), tokio::io::Interest::READABLE) {
        Ok(a) => a,
        Err(e) => {
            flog(|| format!("io_uring fd not pollable: {e}"));
            return false;
        }
    };
    let (done_tx, mut done_rx) = tokio::sync::mpsc::unbounded_channel::<(usize, u32, Outgoing)>();
    let new_rx = Arc::new(tokio::sync::Notify::new());
    let u = Rc::new(RefCell::new(Uring { ring, conns: Vec::new(), free: Vec::new(), done_tx, rxs: Vec::new(), new_rx: new_rx.clone(), dirty: false }));
    URING.with(|s| *s.borrow_mut() = Some(u));
    flog(|| "io_uring loop started".to_string());
    tokio::spawn(async move {
        loop {
            tokio::select! {
                guard = afd.readable() => {
                    let Ok(mut guard) = guard else { return };
                    if !turn() {
                        guard.clear_ready();
                    }
                }
                Some((key, gen, out)) = done_rx.recv() => {
                    complete_async(key, gen, out);
                }
                acc = recv_any() => {
                    register_accepted(acc);
                }
                _ = new_rx.notified() => {}
            }
            // Never let accepted connections or finished handlers queue up behind a busy
            // completion queue (the select above services one branch per turn).
            while let Ok((key, gen, out)) = done_rx.try_recv() {
                complete_async(key, gen, out);
            }
            while let Some(acc) = try_recv_any() {
                register_accepted(acc);
            }
            with_uring(flush_sq);
        }
    });
    true
}

pub fn adopt(rid: u32, rx: httpimpl::ConnRx) -> bool {
    flog(|| format!("uring adopt rid={rid}"));
    with_uring(|u| {
        u.rxs.push((rid, rx));
        u.new_rx.notify_one();
    })
    .is_some()
}

fn recv_any() -> impl std::future::Future<Output = Accepted> {
    std::future::poll_fn(|cx| {
        with_uring(|u| {
            let mut i = 0;
            while i < u.rxs.len() {
                let rid = u.rxs[i].0;
                match u.rxs[i].1.poll_recv(cx) {
                    std::task::Poll::Ready(Some((s, l))) => return std::task::Poll::Ready((rid, s, l)),
                    std::task::Poll::Ready(None) => {
                        u.rxs.swap_remove(i);
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
    with_uring(|u| {
        let mut i = 0;
        while i < u.rxs.len() {
            let rid = u.rxs[i].0;
            match u.rxs[i].1.try_recv() {
                Ok((s, l)) => return Some((rid, s, l)),
                Err(tokio::sync::mpsc::error::TryRecvError::Disconnected) => {
                    u.rxs.swap_remove(i);
                }
                Err(tokio::sync::mpsc::error::TryRecvError::Empty) => i += 1,
            }
        }
        None
    })
    .flatten()
}

fn register_accepted((rid, stream, live): Accepted) {
    if stream.set_nonblocking(true).is_err() {
        live.fetch_sub(1, Ordering::Relaxed);
        return;
    }
    let _ = stream.set_nodelay(true);
    let fd = stream.into_raw_fd();
    with_uring(|u| {
        let key = match u.free.pop() {
            Some(k) => k,
            None => {
                u.conns.push(None);
                u.conns.len() - 1
            }
        };
        let gen = u.conns[key].as_ref().map(|c| c.gen).unwrap_or(0).wrapping_add(1) & 0x3FFF_FFFF;
        u.conns[key] = Some(UConn {
            rid,
            live: Some(live),
            fd,
            rbuf: vec![0u8; RBUF].into_boxed_slice(),
            rlen: 0,
            recv_inflight: false,
            sending: Vec::new(),
            sent: 0,
            send_inflight: false,
            wbuf: Vec::new(),
            waiting: false,
            close_after: false,
            closing: false,
            handover: false,
            gen,
        });
        arm(u, key);
    });
}

fn ud(key: usize, gen: u32, send: bool) -> u64 {
    (key as u64) | ((gen as u64) << 32) | if send { KIND_SEND } else { 0 }
}

fn push(u: &mut Uring, e: io_uring::squeue::Entry) {
    loop {
        // SAFETY: the entry's buffer stays valid until its completion (module invariants).
        if unsafe { u.ring.submission().push(&e) }.is_ok() {
            u.dirty = true;
            return;
        }
        // Submission queue full: flush and retry.
        if let Err(e) = u.ring.submit() {
            flog(|| format!("io_uring submit: {e}"));
        }
    }
}

fn flush_sq(u: &mut Uring) {
    if u.dirty {
        u.dirty = false;
        if let Err(e) = u.ring.submit() {
            flog(|| format!("io_uring submit: {e}"));
        }
    }
}

/// Queue whatever the connection in slot `key` needs next (send, recv), or free it.
fn arm(u: &mut Uring, key: usize) {
    let Some(c) = u.conns[key].as_mut() else { return };
    let gen = c.gen;
    // Send: continue a partial send, or start the next buffer.
    if !c.send_inflight {
        if c.sending.is_empty() && !c.wbuf.is_empty() {
            std::mem::swap(&mut c.sending, &mut c.wbuf);
            c.sent = 0;
        }
        if c.sent < c.sending.len() {
            let ptr = c.sending[c.sent..].as_ptr();
            let len = (c.sending.len() - c.sent) as u32;
            let fd = c.fd;
            c.send_inflight = true;
            push(u, opcode::Send::new(types::Fd(fd), ptr, len).flags(libc::MSG_NOSIGNAL).build().user_data(ud(key, gen, true)));
        }
    }
    let Some(c) = u.conns[key].as_mut() else { return };
    let drained = c.sending.is_empty() && c.wbuf.is_empty() && !c.send_inflight;
    if c.handover && drained {
        if let Some(mut c) = u.conns[key].take() {
            u.free.push(key);
            do_handover(&mut c);
        }
        return;
    }
    if (c.closing || c.close_after) && drained && !c.recv_inflight {
        u.conns[key] = None;
        u.free.push(key);
        return;
    }
    if c.closing && !c.recv_inflight && !c.send_inflight {
        // Error with data still queued: nothing more can be delivered.
        u.conns[key] = None;
        u.free.push(key);
        return;
    }
    // Recv: unless a handler owns the head request, the connection is closing, or the
    // buffer is full (handled as 431 in process_buffer).
    if !c.recv_inflight && !c.waiting && !c.closing && !c.close_after && !c.handover && c.rlen < RBUF {
        let ptr = c.rbuf[c.rlen..].as_mut_ptr();
        let len = (RBUF - c.rlen) as u32;
        let fd = c.fd;
        c.recv_inflight = true;
        push(u, opcode::Recv::new(types::Fd(fd), ptr, len).build().user_data(ud(key, gen, false)));
    }
}

/// Process every available completion. Returns false when there was nothing to do.
fn turn() -> bool {
    let cqes: Vec<(u64, i32)> = with_uring(|u| u.ring.completion().map(|c| (c.user_data(), c.result())).collect()).unwrap_or_default();
    if cqes.is_empty() {
        return false;
    }
    for (user_data, res) in cqes {
        handle_cqe(user_data, res);
    }
    true
}

fn take(key: usize, gen: u32) -> Option<UConn> {
    let c = with_uring(|u| u.conns.get_mut(key).and_then(|c| c.take())).flatten()?;
    if c.gen != gen {
        with_uring(|u| u.conns[key] = Some(c));
        return None;
    }
    Some(c)
}

fn put_back(key: usize, c: UConn) {
    with_uring(|u| {
        u.conns[key] = Some(c);
        arm(u, key);
    });
}

fn handle_cqe(user_data: u64, res: i32) {
    let key = (user_data & 0xFFFF_FFFF) as usize;
    let gen = ((user_data >> 32) & 0x3FFF_FFFF) as u32;
    let is_send = user_data & KIND_SEND != 0;
    let Some(mut c) = take(key, gen) else { return };
    if is_send {
        c.send_inflight = false;
        if res < 0 {
            if res == -libc::EAGAIN || res == -libc::EINTR {
                // Retry the same range.
            } else {
                c.closing = true;
                c.wbuf.clear();
                c.sending.clear();
                c.sent = 0;
            }
        } else {
            c.sent += res as usize;
            if c.sent >= c.sending.len() {
                c.sending.clear();
                c.sent = 0;
            }
        }
        put_back(key, c);
        return;
    }
    c.recv_inflight = false;
    if res <= 0 {
        if res == -libc::EAGAIN || res == -libc::EINTR {
            put_back(key, c);
            return;
        }
        c.closing = true; // peer closed (0) or error
        put_back(key, c);
        return;
    }
    c.rlen += res as usize;
    if process_buffer(&mut c, key) {
        put_back(key, c);
    }
}

/// Parse and dispatch complete requests from `rbuf`. Returns false if the connection was
/// consumed (handed over to hyper).
fn process_buffer(c: &mut UConn, key: usize) -> bool {
    loop {
        if c.waiting || c.rlen == 0 || c.close_after || c.closing {
            break;
        }
        let buf = &c.rbuf[..c.rlen];
        if buf.starts_with(&H2_PREFACE[..buf.len().min(H2_PREFACE.len())]) {
            if buf.len() < H2_PREFACE.len() {
                break;
            }
            return handover_now(c, key);
        }
        let mut headers = [httparse::EMPTY_HEADER; 48];
        let mut req = httparse::Request::new(&mut headers);
        let parsed = match req.parse(buf) {
            Ok(httparse::Status::Complete(n)) => n,
            Ok(httparse::Status::Partial) => {
                if c.rlen >= RBUF {
                    write_response(&mut c.wbuf, &Outgoing { status: 431, headers: String::new(), body: Bytes::from_static(b"Request Header Fields Too Large") }, true);
                    c.close_after = true;
                }
                break;
            }
            Err(_) => {
                write_response(&mut c.wbuf, &Outgoing { status: 400, headers: String::new(), body: Bytes::from_static(b"Bad Request") }, true);
                c.close_after = true;
                break;
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
            return handover_now(c, key);
        }
        let raw = RawReq { method: method.to_string(), path: path.to_string(), headers: buf[..parsed].to_vec() };
        // Consume the request; keep any pipelined bytes at the front.
        c.rbuf.copy_within(parsed..c.rlen, 0);
        c.rlen -= parsed;
        match httpimpl::dispatch_raw(c.rid, raw) {
            Step::Done(out) => {
                write_response(&mut c.wbuf, &out, close_after);
                if close_after {
                    c.close_after = true;
                    break;
                }
            }
            Step::Pending(rrx) | Step::Queue(_, rrx) => {
                c.waiting = true;
                c.close_after = close_after;
                spawn_completion(key, c.gen, rrx);
                break;
            }
        }
    }
    true
}

/// Hand the connection to hyper now if nothing is being sent; otherwise after the send.
fn handover_now(c: &mut UConn, _key: usize) -> bool {
    if c.send_inflight || !c.sending.is_empty() || !c.wbuf.is_empty() {
        c.handover = true;
        return true;
    }
    do_handover(c);
    false
}

fn do_handover(c: &mut UConn) {
    // SAFETY: dup of a descriptor we own; hyper gets its own handle, ours closes on drop.
    let dup = unsafe { libc::dup(c.fd) };
    if dup < 0 {
        return;
    }
    // SAFETY: freshly duplicated, owned by nobody else.
    let stream = unsafe { std::net::TcpStream::from_raw_fd(dup) };
    let prefix = c.rbuf[..c.rlen].to_vec();
    c.rlen = 0;
    httpimpl::hyper_takeover(c.rid, stream, prefix);
}

fn spawn_completion(key: usize, gen: u32, rrx: oneshot::Receiver<Outgoing>) {
    let tx = with_uring(|u| u.done_tx.clone());
    let Some(tx) = tx else { return };
    tokio::spawn(async move {
        let out = rrx.await.unwrap_or(Outgoing { status: 500, headers: String::new(), body: Bytes::from_static(b"Internal Server Error") });
        let _ = tx.send((key, gen, out));
    });
}

fn complete_async(key: usize, gen: u32, out: Outgoing) {
    let Some(mut c) = take(key, gen) else { return };
    c.waiting = false;
    let close = c.close_after;
    write_response(&mut c.wbuf, &out, close);
    if !close && !process_buffer(&mut c, key) {
        return;
    }
    put_back(key, c);
}
