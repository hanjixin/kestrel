//! Chrome DevTools Protocol endpoint for external debuggers (`--inspect`, `inspector.open()`):
//! the discovery endpoints `/json`, `/json/list`, `/json/version` and a WebSocket per session
//! that is bridged onto the isolate's inspector through deno_core's session proxy (the same
//! channel pair Deno's own `--inspect` uses), so `chrome://inspect`, VS Code and the Node
//! inspector protocol clients attach as to Node.
//!
//! Runs on its own thread with a small Tokio runtime; frames are a minimal RFC 6455
//! implementation (text/binary/ping/pong/close, fragmentation, 64-bit lengths).

use std::io::{Read, Write};
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use base64::Engine;
use deno_core::futures::channel::mpsc::{unbounded, UnboundedSender};
use deno_core::futures::StreamExt;
use deno_core::{InspectorMsg, InspectorSessionChannels, InspectorSessionKind, InspectorSessionProxy, JsRuntimeInspector};
use sha1::Digest;

struct Server {
    url: String,
    closed: Arc<AtomicBool>,
}
static SERVER: OnceLock<Mutex<Option<Server>>> = OnceLock::new();

fn server() -> &'static Mutex<Option<Server>> {
    SERVER.get_or_init(|| Mutex::new(None))
}

/// `ws://host:port/<id>` of the running endpoint, if any.
pub fn url() -> Option<String> {
    server().lock().unwrap().as_ref().map(|s| s.url.clone())
}

pub fn close() {
    if let Some(s) = server().lock().unwrap().take() {
        s.closed.store(true, Ordering::Relaxed);
    }
}

/// Start listening. Returns the bound port. Idempotent while a server is open.
pub fn open(inspector: Rc<JsRuntimeInspector>, host: &str, port: u16, main: &str) -> std::io::Result<u16> {
    if let Some(s) = server().lock().unwrap().as_ref() {
        return Ok(s.url.split(':').nth(2).and_then(|p| p.split('/').next()).and_then(|p| p.parse().ok()).unwrap_or(port));
    }
    let listener = std::net::TcpListener::bind((host, port))?;
    let bound = listener.local_addr()?.port();
    let id = format!(
        "{:08x}-{:04x}-4{:03x}-{:04x}-{:012x}",
        rand::random::<u32>(),
        rand::random::<u16>(),
        rand::random::<u16>() & 0xfff,
        (rand::random::<u16>() & 0x3fff) | 0x8000,
        rand::random::<u64>() & 0xffff_ffff_ffff
    );
    let ws_url = format!("ws://{host}:{bound}/{id}");
    let closed = Arc::new(AtomicBool::new(false));
    let session_sender = inspector.get_session_sender();
    let main_url = if main.starts_with("file://") { main.to_string() } else { format!("file://{main}") };
    let title = format!("kestrel[{}]", std::process::id());
    let state = Arc::new(Shared { id, host: host.to_string(), port: bound, main_url, title, closed: closed.clone(), session_sender });
    std::thread::Builder::new()
        .name("kestrel-inspector".into())
        .spawn(move || serve(listener, state))
        .map_err(|e| std::io::Error::other(e.to_string()))?;
    eprintln!("Debugger listening on {ws_url}\nFor help, see: https://nodejs.org/en/docs/inspector");
    *server().lock().unwrap() = Some(Server { url: ws_url, closed });
    Ok(bound)
}

struct Shared {
    id: String,
    host: String,
    port: u16,
    main_url: String,
    title: String,
    closed: Arc<AtomicBool>,
    session_sender: UnboundedSender<InspectorSessionProxy>,
}

fn serve(listener: std::net::TcpListener, state: Arc<Shared>) {
    // Non-blocking accept so the closed flag is noticed (`inspector.close()`).
    let _ = listener.set_nonblocking(true);
    loop {
        if state.closed.load(Ordering::Relaxed) {
            return;
        }
        let (stream, _) = match listener.accept() {
            Ok(s) => s,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(std::time::Duration::from_millis(100));
                continue;
            }
            Err(_) => return,
        };
        let _ = stream.set_nonblocking(false);
        let st = state.clone();
        std::thread::spawn(move || {
            let _ = handle(stream, st);
        });
    }
}

fn json_list(s: &Shared) -> String {
    let ws = format!("{}:{}/{}", s.host, s.port, s.id);
    format!(
        "[ {{\n  \"description\": \"kestrel instance\",\n  \"devtoolsFrontendUrl\": \"devtools://devtools/bundled/js_app.html?experiments=true&v8only=true&ws={ws}\",\n  \"devtoolsFrontendUrlCompat\": \"devtools://devtools/bundled/inspector.html?experiments=true&v8only=true&ws={ws}\",\n  \"faviconUrl\": \"https://nodejs.org/static/images/favicons/favicon.ico\",\n  \"id\": \"{}\",\n  \"title\": \"{}\",\n  \"type\": \"node\",\n  \"url\": \"{}\",\n  \"webSocketDebuggerUrl\": \"ws://{ws}\"\n}} ]\n",
        s.id, s.title, s.main_url
    )
}

fn json_version() -> String {
    format!("{{\n  \"Browser\": \"kestrel/{}\",\n  \"Protocol-Version\": \"1.1\"\n}}\n", env!("CARGO_PKG_VERSION"))
}

fn handle(mut stream: std::net::TcpStream, s: Arc<Shared>) -> std::io::Result<()> {
    let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(10)));
    let mut buf = Vec::new();
    let mut tmp = [0u8; 4096];
    let head_len = loop {
        let n = stream.read(&mut tmp)?;
        if n == 0 {
            return Ok(());
        }
        buf.extend_from_slice(&tmp[..n]);
        if let Some(p) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break p + 4;
        }
        if buf.len() > 64 * 1024 {
            return Ok(());
        }
    };
    let mut headers = [httparse::EMPTY_HEADER; 32];
    let mut req = httparse::Request::new(&mut headers);
    if req.parse(&buf[..head_len]).is_err() {
        return Ok(());
    }
    let path = req.path.unwrap_or("/").split('?').next().unwrap_or("/").to_string();
    let hdr = |name: &str| req.headers.iter().find(|h| h.name.eq_ignore_ascii_case(name)).map(|h| String::from_utf8_lossy(h.value).to_string());
    let upgrade = hdr("upgrade").map(|v| v.eq_ignore_ascii_case("websocket")).unwrap_or(false);
    if !upgrade {
        let (status, body) = match path.as_str() {
            "/json" | "/json/list" => ("200 OK", json_list(&s)),
            "/json/version" => ("200 OK", json_version()),
            "/json/protocol" => ("404 Not Found", String::new()),
            _ => ("404 Not Found", String::new()),
        };
        let resp = format!("HTTP/1.1 {status}\r\nContent-Type: application/json; charset=UTF-8\r\nCache-Control: no-cache\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
        stream.write_all(resp.as_bytes())?;
        return Ok(());
    }
    if path.trim_start_matches('/') != s.id {
        stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n")?;
        return Ok(());
    }
    let Some(key) = hdr("sec-websocket-key") else { return Ok(()) };
    let mut h = sha1::Sha1::new();
    h.update(key.trim().as_bytes());
    h.update(b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11");
    let accept = base64::engine::general_purpose::STANDARD.encode(h.finalize());
    stream.write_all(format!("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n\r\n").as_bytes())?;
    let _ = stream.set_read_timeout(None);
    let _ = stream.set_nodelay(true);

    // Bridge: one inspector session per socket.
    let (outbound_tx, mut outbound_rx) = unbounded::<InspectorMsg>();
    let (inbound_tx, inbound_rx) = unbounded::<String>();
    let proxy = InspectorSessionProxy { channels: InspectorSessionChannels::Regular { tx: outbound_tx, rx: inbound_rx }, kind: InspectorSessionKind::NonBlocking { wait_for_disconnect: false } };
    if s.session_sender.unbounded_send(proxy).is_err() {
        return Ok(());
    }
    // Writer thread: inspector -> socket.
    let mut wstream = stream.try_clone()?;
    let writer = std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_current_thread().build().unwrap();
        rt.block_on(async move {
            while let Some(msg) = outbound_rx.next().await {
                if write_frame(&mut wstream, 0x1, msg.content.as_bytes()).is_err() {
                    break;
                }
            }
        });
    });
    // Reader: socket -> inspector.
    let mut rest = buf[head_len..].to_vec();
    let mut fragments: Vec<u8> = Vec::new();
    loop {
        let (fin, op, payload) = match read_frame(&mut stream, &mut rest) {
            Ok(f) => f,
            Err(_) => break,
        };
        match op {
            0x1 | 0x2 | 0x0 => {
                fragments.extend_from_slice(&payload);
                if fin {
                    let text = String::from_utf8_lossy(&fragments).to_string();
                    fragments.clear();
                    if inbound_tx.unbounded_send(text).is_err() {
                        break;
                    }
                }
            }
            0x8 => {
                let _ = write_frame(&mut stream, 0x8, &payload);
                break;
            }
            0x9 => {
                let _ = write_frame(&mut stream, 0xA, &payload);
            }
            _ => {}
        }
    }
    drop(inbound_tx);
    let _ = stream.shutdown(std::net::Shutdown::Both);
    let _ = writer.join();
    Ok(())
}

fn read_exact_from(stream: &mut std::net::TcpStream, rest: &mut Vec<u8>, n: usize) -> std::io::Result<Vec<u8>> {
    while rest.len() < n {
        let mut tmp = [0u8; 8192];
        let got = stream.read(&mut tmp)?;
        if got == 0 {
            return Err(std::io::ErrorKind::UnexpectedEof.into());
        }
        rest.extend_from_slice(&tmp[..got]);
    }
    let out = rest[..n].to_vec();
    rest.drain(..n);
    Ok(out)
}

/// Returns (fin, opcode, unmasked payload).
fn read_frame(stream: &mut std::net::TcpStream, rest: &mut Vec<u8>) -> std::io::Result<(bool, u8, Vec<u8>)> {
    let h = read_exact_from(stream, rest, 2)?;
    let fin = h[0] & 0x80 != 0;
    let op = h[0] & 0x0f;
    let masked = h[1] & 0x80 != 0;
    let mut len = (h[1] & 0x7f) as usize;
    if len == 126 {
        let b = read_exact_from(stream, rest, 2)?;
        len = u16::from_be_bytes([b[0], b[1]]) as usize;
    } else if len == 127 {
        let b = read_exact_from(stream, rest, 8)?;
        len = u64::from_be_bytes(b[..8].try_into().unwrap()) as usize;
    }
    if len > 64 * 1024 * 1024 {
        return Err(std::io::ErrorKind::InvalidData.into());
    }
    let mask = if masked { Some(read_exact_from(stream, rest, 4)?) } else { None };
    let mut payload = read_exact_from(stream, rest, len)?;
    if let Some(m) = mask {
        for (i, b) in payload.iter_mut().enumerate() {
            *b ^= m[i % 4];
        }
    }
    Ok((fin, op, payload))
}

fn write_frame(stream: &mut std::net::TcpStream, op: u8, payload: &[u8]) -> std::io::Result<()> {
    let mut f = Vec::with_capacity(payload.len() + 10);
    f.push(0x80 | op);
    let n = payload.len();
    if n < 126 {
        f.push(n as u8);
    } else if n < 65536 {
        f.push(126);
        f.extend_from_slice(&(n as u16).to_be_bytes());
    } else {
        f.push(127);
        f.extend_from_slice(&(n as u64).to_be_bytes());
    }
    f.extend_from_slice(payload);
    stream.write_all(&f)
}
