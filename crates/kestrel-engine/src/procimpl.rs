//! child_process, fd-level fs, brotli and extra crypto ops.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use deno_core::{op2, OpState};
use deno_error::JsErrorBox;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

fn generic(e: impl std::fmt::Display) -> JsErrorBox {
    JsErrorBox::generic(e.to_string())
}

// ---------- child_process ----------

#[derive(Deserialize)]
pub struct SpawnOpts {
    pub cmd: String,
    pub args: Vec<String>,
    pub cwd: Option<String>,
    pub env: Option<Vec<(String, String)>>,
    /// "pipe" | "inherit" | "ignore" for stdin, stdout, stderr
    pub stdio: Vec<String>,
    pub shell: bool,
    pub detached: bool,
    /// Create a unix socketpair; the child gets its end as an inherited fd (KESTREL_IPC_FD).
    #[serde(default)]
    pub ipc: bool,
    #[serde(default)]
    pub serialization: Option<String>,
}

struct Child {
    child: tokio::process::Child,
    stdin: Option<tokio::process::ChildStdin>,
    stdout: Option<tokio::process::ChildStdout>,
    stderr: Option<tokio::process::ChildStderr>,
}

#[derive(Default)]
struct Children {
    next: u32,
    map: HashMap<u32, Rc<RefCell<Child>>>,
}

fn children(state: &mut OpState) -> &mut Children {
    if state.try_borrow::<Children>().is_none() {
        state.put(Children::default());
    }
    state.borrow_mut::<Children>()
}

fn stdio(mode: &str) -> std::process::Stdio {
    match mode {
        "inherit" => std::process::Stdio::inherit(),
        "ignore" => std::process::Stdio::null(),
        _ => std::process::Stdio::piped(),
    }
}

fn build_command(o: &SpawnOpts) -> std::process::Command {
    let mut c = if o.shell {
        let mut c = std::process::Command::new("/bin/sh");
        let mut line = o.cmd.clone();
        for a in &o.args {
            line.push(' ');
            line.push_str(a);
        }
        c.arg("-c").arg(line);
        c
    } else {
        let mut c = std::process::Command::new(&o.cmd);
        c.args(&o.args);
        c
    };
    if let Some(cwd) = &o.cwd {
        c.current_dir(cwd);
    }
    if let Some(env) = &o.env {
        c.env_clear();
        for (k, v) in env {
            c.env(k, v);
        }
    }
    c.stdin(stdio(o.stdio.first().map(String::as_str).unwrap_or("pipe")));
    c.stdout(stdio(o.stdio.get(1).map(String::as_str).unwrap_or("pipe")));
    c.stderr(stdio(o.stdio.get(2).map(String::as_str).unwrap_or("pipe")));
    #[cfg(unix)]
    if o.detached {
        use std::os::unix::process::CommandExt;
        c.process_group(0);
    }
    c
}

/// Returns [rid, pid, ipcFd(parent end, or -1)]. Errors carry a Node-style code in the message.
#[op2]
#[serde]
pub fn op_cp_spawn(state: &mut OpState, #[serde] o: SpawnOpts) -> Result<(u32, u32, i32), JsErrorBox> {
    let mut std_cmd = build_command(&o);
    let mut parent_fd: i32 = -1;
    #[cfg(unix)]
    let mut child_end: Option<std::os::unix::net::UnixStream> = None;
    #[cfg(unix)]
    if o.ipc {
        use std::os::unix::io::{AsRawFd, IntoRawFd};
        let (a, b) = std::os::unix::net::UnixStream::pair().map_err(generic)?;
        // Child end must survive exec: clear FD_CLOEXEC.
        unsafe { libc::fcntl(b.as_raw_fd(), libc::F_SETFD, 0); }
        std_cmd.env("KESTREL_IPC_FD", b.as_raw_fd().to_string());
        std_cmd.env("NODE_CHANNEL_FD", b.as_raw_fd().to_string());
        let serialization = o.serialization.as_deref().unwrap_or("json");
        std_cmd.env("NODE_CHANNEL_SERIALIZATION_MODE", serialization);
        std_cmd.env("KESTREL_IPC_SERIALIZATION", serialization);
        parent_fd = a.into_raw_fd();
        child_end = Some(b);
    }
    let mut cmd = tokio::process::Command::from(std_cmd);
    cmd.kill_on_drop(false);
    let mut child = cmd.spawn().map_err(|e| {
        let code = match e.kind() {
            std::io::ErrorKind::NotFound => "ENOENT",
            std::io::ErrorKind::PermissionDenied => "EACCES",
            _ => "EIO",
        };
        JsErrorBox::new("Error", format!("{code}: spawn {} {}", o.cmd, e))
    })?;
    let pid = child.id().unwrap_or(0);
    #[cfg(unix)]
    drop(child_end);
    let stdin = child.stdin.take();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let ch = children(state);
    let rid = ch.next;
    ch.next += 1;
    ch.map.insert(rid, Rc::new(RefCell::new(Child { child, stdin, stdout, stderr })));
    Ok((rid, pid, parent_fd))
}

fn child_of(state: &Rc<RefCell<OpState>>, rid: u32) -> Result<Rc<RefCell<Child>>, JsErrorBox> {
    let mut st = state.borrow_mut();
    children(&mut st).map.get(&rid).cloned().ok_or_else(|| JsErrorBox::type_error("unknown child"))
}

/// Read a chunk from stdout (which=1) or stderr (which=2). Empty = EOF.
#[op2]
#[buffer]
pub async fn op_cp_read(state: Rc<RefCell<OpState>>, rid: u32, which: u32) -> Result<Vec<u8>, JsErrorBox> {
    let ch = child_of(&state, rid)?;
    // Take the pipe out while reading so the RefCell is not held across the await.
    let pipe_out = if which == 1 { ch.borrow_mut().stdout.take() } else { None };
    let pipe_err = if which == 2 { ch.borrow_mut().stderr.take() } else { None };
    let mut buf = vec![0u8; 65536];
    let n = if let Some(mut p) = pipe_out {
        let n = p.read(&mut buf).await.map_err(generic)?;
        ch.borrow_mut().stdout = Some(p);
        n
    } else if let Some(mut p) = pipe_err {
        let n = p.read(&mut buf).await.map_err(generic)?;
        ch.borrow_mut().stderr = Some(p);
        n
    } else {
        0
    };
    buf.truncate(n);
    Ok(buf)
}

#[op2]
pub async fn op_cp_write(state: Rc<RefCell<OpState>>, rid: u32, #[buffer(copy)] data: Vec<u8>) -> Result<(), JsErrorBox> {
    let ch = child_of(&state, rid)?;
    let pipe = ch.borrow_mut().stdin.take();
    if let Some(mut p) = pipe {
        let r = p.write_all(&data).await;
        ch.borrow_mut().stdin = Some(p);
        r.map_err(generic)?;
    }
    Ok(())
}

#[op2(fast)]
pub fn op_cp_close_stdin(state: &mut OpState, rid: u32) {
    if let Some(ch) = children(state).map.get(&rid) {
        ch.borrow_mut().stdin = None;
    }
}

/// Resolves with [exit code or -1, signal number or 0].
#[op2]
#[serde]
pub async fn op_cp_wait(state: Rc<RefCell<OpState>>, rid: u32) -> Result<(i32, i32), JsErrorBox> {
    let ch = child_of(&state, rid)?;
    // Poll the child without holding the borrow across awaits.
    let status = loop {
        let r = { ch.borrow_mut().child.try_wait().map_err(generic)? };
        if let Some(s) = r {
            break s;
        }
        tokio::time::sleep(std::time::Duration::from_millis(2)).await;
    };
    let mut st = state.borrow_mut();
    children(&mut st).map.remove(&rid);
    #[cfg(unix)]
    let sig = {
        use std::os::unix::process::ExitStatusExt;
        status.signal().unwrap_or(0)
    };
    #[cfg(not(unix))]
    let sig = 0;
    Ok((status.code().unwrap_or(-1), sig))
}

#[op2(fast)]
pub fn op_cp_kill(state: &mut OpState, rid: u32, signal: i32) -> bool {
    let Some(ch) = children(state).map.get(&rid).cloned() else { return false };
    let pid = ch.borrow().child.id();
    #[cfg(unix)]
    if let Some(pid) = pid {
        return unsafe { libc::kill(pid as i32, signal) == 0 };
    }
    let _ = pid;
    let ok = ch.borrow_mut().child.start_kill().is_ok();
    ok
}

#[op2(fast)]
pub fn op_kill_pid(pid: i32, signal: i32) -> bool {
    #[cfg(unix)]
    {
        unsafe { libc::kill(pid, signal) == 0 }
    }
    #[cfg(not(unix))]
    {
        let _ = (pid, signal);
        false
    }
}

#[derive(Serialize)]
pub struct SyncResult {
    status: Option<i32>,
    signal: i32,
    stdout: deno_core::ToJsBuffer,
    stderr: deno_core::ToJsBuffer,
    error: Option<String>,
    pid: u32,
}

#[op2]
#[serde]
pub fn op_cp_spawn_sync(#[serde] o: SpawnOpts, #[buffer(copy)] input: Vec<u8>, timeout_ms: f64) -> SyncResult {
    use std::io::{Read, Write};
    let mut cmd = build_command(&o);
    if !input.is_empty() {
        cmd.stdin(std::process::Stdio::piped());
    }
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            let code = if e.kind() == std::io::ErrorKind::NotFound { "ENOENT" } else { "EIO" };
            return SyncResult { status: None, signal: 0, stdout: Vec::new().into(), stderr: Vec::new().into(), error: Some(format!("{code}: spawnSync {} {}", o.cmd, e)), pid: 0 };
        }
    };
    let pid = child.id();
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(&input);
    }
    let out = child.stdout.take().map(|mut p| std::thread::spawn(move || { let mut v = Vec::new(); let _ = p.read_to_end(&mut v); v }));
    let err = child.stderr.take().map(|mut p| std::thread::spawn(move || { let mut v = Vec::new(); let _ = p.read_to_end(&mut v); v }));
    let deadline = if timeout_ms > 0.0 { Some(std::time::Instant::now() + std::time::Duration::from_secs_f64(timeout_ms / 1000.0)) } else { None };
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break Some(s),
            Ok(None) => {
                if deadline.is_some_and(|d| std::time::Instant::now() > d) {
                    let _ = child.kill();
                    break child.wait().ok();
                }
                std::thread::sleep(std::time::Duration::from_millis(1));
            }
            Err(_) => break None,
        }
    };
    let stdout = out.and_then(|t| t.join().ok()).unwrap_or_default();
    let stderr = err.and_then(|t| t.join().ok()).unwrap_or_default();
    #[cfg(unix)]
    let signal = { use std::os::unix::process::ExitStatusExt; status.and_then(|s| s.signal()).unwrap_or(0) };
    #[cfg(not(unix))]
    let signal = 0;
    SyncResult { status: status.and_then(|s| s.code()), signal, stdout: stdout.into(), stderr: stderr.into(), error: None, pid }
}

// ---------- fd-level fs ----------

#[derive(Default)]
struct Files {
    next: i32,
    map: HashMap<i32, std::sync::Arc<std::fs::File>>,
}
fn files(state: &mut OpState) -> &mut Files {
    if state.try_borrow::<Files>().is_none() {
        state.put(Files { next: 10, map: HashMap::new() });
    }
    state.borrow_mut::<Files>()
}

fn fs_err(e: std::io::Error, syscall: &str, path: &str) -> JsErrorBox {
    let code = match e.kind() {
        std::io::ErrorKind::NotFound => "ENOENT",
        std::io::ErrorKind::PermissionDenied => "EACCES",
        std::io::ErrorKind::AlreadyExists => "EEXIST",
        _ => match e.raw_os_error() { Some(21) => "EISDIR", Some(9) => "EBADF", _ => "EIO" },
    };
    JsErrorBox::new("Error", format!("{code}: {}, {syscall} '{path}'", e.kind()))
}

fn open_file(path: &str, flags: &str, mode: u32) -> Result<std::fs::File, JsErrorBox> {
    let mut o = std::fs::OpenOptions::new();
    match flags {
        "r" => { o.read(true); }
        "r+" | "rs+" => { o.read(true).write(true); }
        "w" => { o.write(true).create(true).truncate(true); }
        "wx" => { o.write(true).create_new(true); }
        "w+" => { o.read(true).write(true).create(true).truncate(true); }
        "wx+" => { o.read(true).write(true).create_new(true); }
        "a" => { o.append(true).create(true); }
        "ax" => { o.append(true).create_new(true); }
        "a+" => { o.read(true).append(true).create(true); }
        "ax+" => { o.read(true).append(true).create_new(true); }
        _ => return Err(JsErrorBox::type_error(format!("invalid flag '{flags}'"))),
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        o.mode(mode);
    }
    let _ = mode;
    let f = o.open(path).map_err(|e| fs_err(e, "open", path))?;
    Ok(f)
}

/// flags: Node's string flags ("r", "r+", "w", "w+", "a", "a+", "wx", "ax").
#[op2(fast)]
pub fn op_fd_open(state: &mut OpState, #[string] path: &str, #[string] flags: &str, mode: u32) -> Result<i32, JsErrorBox> {
    let f = open_file(path, flags, mode)?;
    let t = files(state);
    let fd = t.next;
    t.next += 1;
    t.map.insert(fd, std::sync::Arc::new(f));
    Ok(fd)
}

#[op2(fast)]
pub fn op_fd_close(state: &mut OpState, fd: i32) -> Result<(), JsErrorBox> {
    files(state).map.remove(&fd).map(|_| ()).ok_or_else(|| JsErrorBox::new("Error", "EBADF: bad file descriptor, close"))
}

/// Reads into `buf`; `pos < 0` means current position. Returns bytes read.
#[op2(fast)]
pub fn op_fd_read(state: &mut OpState, fd: i32, #[buffer] buf: &mut [u8], pos: f64) -> Result<u32, JsErrorBox> {
    use std::io::Read;
    #[allow(unused_imports)]
    use std::io::{Seek, SeekFrom};
    if fd == 0 {
        let n = std::io::stdin().read(buf).map_err(|e| fs_err(e, "read", "stdin"))?;
        return Ok(n as u32);
    }
    let mut f = &**files(state).map.get(&fd).ok_or_else(|| JsErrorBox::new("Error", "EBADF: bad file descriptor, read"))?;
    let n = if pos >= 0.0 {
        #[cfg(unix)]
        { use std::os::unix::fs::FileExt; f.read_at(buf, pos as u64).map_err(|e| fs_err(e, "read", ""))? }
        #[cfg(not(unix))]
        { f.seek(SeekFrom::Start(pos as u64)).map_err(|e| fs_err(e, "read", ""))?; f.read(buf).map_err(|e| fs_err(e, "read", ""))? }
    } else {
        let _ = SeekFrom::Start(0);
        f.read(buf).map_err(|e| fs_err(e, "read", ""))?
    };
    Ok(n as u32)
}

#[op2(fast)]
pub fn op_fd_write(state: &mut OpState, fd: i32, #[buffer] buf: &[u8], pos: f64) -> Result<u32, JsErrorBox> {
    use std::io::Write;
    #[allow(unused_imports)]
    use std::io::{Seek, SeekFrom};
    if fd == 1 || fd == 2 {
        let r = if fd == 1 { std::io::stdout().write_all(buf).and_then(|_| std::io::stdout().flush()) } else { std::io::stderr().write_all(buf) };
        r.map_err(|e| fs_err(e, "write", ""))?;
        return Ok(buf.len() as u32);
    }
    let mut f = &**files(state).map.get(&fd).ok_or_else(|| JsErrorBox::new("Error", "EBADF: bad file descriptor, write"))?;
    let n = if pos >= 0.0 {
        #[cfg(unix)]
        { use std::os::unix::fs::FileExt; f.write_at(buf, pos as u64).map_err(|e| fs_err(e, "write", ""))? }
        #[cfg(not(unix))]
        { f.seek(SeekFrom::Start(pos as u64)).map_err(|e| fs_err(e, "write", ""))?; f.write(buf).map_err(|e| fs_err(e, "write", ""))? }
    } else {
        let _ = SeekFrom::Start(0);
        f.write(buf).map_err(|e| fs_err(e, "write", ""))?
    };
    Ok(n as u32)
}

#[op2]
#[serde]
pub fn op_fd_stat(state: &mut OpState, fd: i32) -> Result<super::nodeimpl::StatInfo, JsErrorBox> {
    let f = files(state).map.get(&fd).ok_or_else(|| JsErrorBox::new("Error", "EBADF: bad file descriptor, fstat"))?;
    let md = f.metadata().map_err(|e| fs_err(e, "fstat", ""))?;
    Ok(super::nodeimpl::stat_from_metadata(&md))
}

#[op2(fast)]
pub fn op_fd_sync(state: &mut OpState, fd: i32) -> Result<(), JsErrorBox> {
    let f = files(state).map.get(&fd).ok_or_else(|| JsErrorBox::new("Error", "EBADF: bad file descriptor, fsync"))?;
    f.sync_all().map_err(|e| fs_err(e, "fsync", ""))
}

#[op2(fast)]
pub fn op_fd_truncate(state: &mut OpState, fd: i32, len: f64) -> Result<(), JsErrorBox> {
    let f = files(state).map.get(&fd).ok_or_else(|| JsErrorBox::new("Error", "EBADF: bad file descriptor, ftruncate"))?;
    f.set_len(len.max(0.0) as u64).map_err(|e| fs_err(e, "ftruncate", ""))
}

// ---------- brotli ----------

#[op2]
#[buffer]
pub fn op_brotli(#[buffer] data: &[u8], compress: bool, quality: u32) -> Result<Vec<u8>, JsErrorBox> {
    use std::io::{Read, Write};
    if compress {
        let mut out = Vec::new();
        {
            let mut w = brotli::CompressorWriter::new(&mut out, 4096, quality.min(11), 22);
            w.write_all(data).map_err(generic)?;
        }
        Ok(out)
    } else {
        let mut out = Vec::new();
        brotli::Decompressor::new(data, 4096).read_to_end(&mut out).map_err(|e| JsErrorBox::new("Error", format!("brotli: {e}")))?;
        Ok(out)
    }
}

// ---------- key derivation and ciphers ----------

#[op2]
#[buffer]
pub fn op_pbkdf2(#[buffer] password: &[u8], #[buffer] salt: &[u8], iterations: u32, keylen: u32, #[string] digest: &str) -> Result<Vec<u8>, JsErrorBox> {
    let mut out = vec![0u8; keylen as usize];
    match digest.to_ascii_lowercase().as_str() {
        "sha1" => pbkdf2::pbkdf2_hmac::<sha1::Sha1>(password, salt, iterations, &mut out),
        "sha256" => pbkdf2::pbkdf2_hmac::<sha2::Sha256>(password, salt, iterations, &mut out),
        "sha384" => pbkdf2::pbkdf2_hmac::<sha2::Sha384>(password, salt, iterations, &mut out),
        "sha512" => pbkdf2::pbkdf2_hmac::<sha2::Sha512>(password, salt, iterations, &mut out),
        "md5" => pbkdf2::pbkdf2_hmac::<md5::Md5>(password, salt, iterations, &mut out),
        d => return Err(JsErrorBox::type_error(format!("Invalid digest: {d}"))),
    }
    Ok(out)
}

#[op2]
#[buffer]
pub fn op_scrypt(#[buffer] password: &[u8], #[buffer] salt: &[u8], n: u32, r: u32, p: u32, keylen: u32) -> Result<Vec<u8>, JsErrorBox> {
    let log_n = (n as f64).log2() as u8;
    let params = scrypt::Params::new(log_n, r, p, keylen as usize).map_err(|e| JsErrorBox::type_error(e.to_string()))?;
    let mut out = vec![0u8; keylen as usize];
    scrypt::scrypt(password, salt, &params, &mut out).map_err(|e| JsErrorBox::type_error(e.to_string()))?;
    Ok(out)
}

#[op2]
#[buffer]
pub fn op_hkdf(#[string] digest: &str, #[buffer] ikm: &[u8], #[buffer] salt: &[u8], #[buffer] info: &[u8], keylen: u32) -> Result<Vec<u8>, JsErrorBox> {
    let mut out = vec![0u8; keylen as usize];
    macro_rules! run { ($t:ty) => {{ hkdf::Hkdf::<$t>::new(Some(salt), ikm).expand(info, &mut out).map_err(|e| JsErrorBox::type_error(e.to_string()))?; }}; }
    match digest.to_ascii_lowercase().as_str() {
        "sha1" => run!(sha1::Sha1),
        "sha256" => run!(sha2::Sha256),
        "sha384" => run!(sha2::Sha384),
        "sha512" => run!(sha2::Sha512),
        d => return Err(JsErrorBox::type_error(format!("Invalid digest: {d}"))),
    }
    Ok(out)
}

/// One-shot AEAD / block cipher. `algo`: aes-128-gcm, aes-256-gcm, chacha20-poly1305,
/// aes-128-cbc, aes-256-cbc, aes-128-ctr, aes-256-ctr. For GCM/ChaCha the returned
/// ciphertext has the 16-byte tag appended (decrypt expects the same layout).
#[op2]
#[buffer]
pub fn op_cipher(#[string] algo: &str, encrypt: bool, #[buffer] key: &[u8], #[buffer] iv: &[u8], #[buffer] data: &[u8], #[buffer] aad: &[u8]) -> Result<Vec<u8>, JsErrorBox> {
    use aes_gcm::aead::{Aead, KeyInit, Payload};
    let bad = |m: &str| JsErrorBox::new("Error", m.to_string());
    match algo.to_ascii_lowercase().as_str() {
        "aes-128-gcm" | "aes-256-gcm" => {
            let nonce = aes_gcm::Nonce::from_slice(iv.get(..12).ok_or_else(|| bad("Invalid IV length"))?);
            let payload = Payload { msg: data, aad };
            let r = if key.len() == 16 {
                let c = aes_gcm::Aes128Gcm::new_from_slice(key).map_err(|_| bad("Invalid key length"))?;
                if encrypt { c.encrypt(nonce, payload) } else { c.decrypt(nonce, payload) }
            } else {
                let c = aes_gcm::Aes256Gcm::new_from_slice(key).map_err(|_| bad("Invalid key length"))?;
                if encrypt { c.encrypt(nonce, payload) } else { c.decrypt(nonce, payload) }
            };
            r.map_err(|_| bad("Unsupported state or unable to authenticate data"))
        }
        "chacha20-poly1305" => {
            let c = chacha20poly1305::ChaCha20Poly1305::new_from_slice(key).map_err(|_| bad("Invalid key length"))?;
            let nonce = chacha20poly1305::Nonce::from_slice(iv.get(..12).ok_or_else(|| bad("Invalid IV length"))?);
            let payload = Payload { msg: data, aad };
            (if encrypt { c.encrypt(nonce, payload) } else { c.decrypt(nonce, payload) }).map_err(|_| bad("Unsupported state or unable to authenticate data"))
        }
        "aes-128-cbc" | "aes-256-cbc" => {
            use cbc::cipher::{block_padding::Pkcs7, BlockDecryptMut, BlockEncryptMut, KeyIvInit};
            if iv.len() != 16 { return Err(bad("Invalid IV length")); }
            if key.len() == 16 {
                if encrypt { Ok(cbc::Encryptor::<aes::Aes128>::new_from_slices(key, iv).map_err(|_| bad("Invalid key length"))?.encrypt_padded_vec_mut::<Pkcs7>(data)) }
                else { cbc::Decryptor::<aes::Aes128>::new_from_slices(key, iv).map_err(|_| bad("Invalid key length"))?.decrypt_padded_vec_mut::<Pkcs7>(data).map_err(|_| bad("bad decrypt")) }
            } else {
                if encrypt { Ok(cbc::Encryptor::<aes::Aes256>::new_from_slices(key, iv).map_err(|_| bad("Invalid key length"))?.encrypt_padded_vec_mut::<Pkcs7>(data)) }
                else { cbc::Decryptor::<aes::Aes256>::new_from_slices(key, iv).map_err(|_| bad("Invalid key length"))?.decrypt_padded_vec_mut::<Pkcs7>(data).map_err(|_| bad("bad decrypt")) }
            }
        }
        "aes-128-ctr" | "aes-256-ctr" => {
            use ctr::cipher::{KeyIvInit, StreamCipher};
            if iv.len() != 16 { return Err(bad("Invalid IV length")); }
            let mut out = data.to_vec();
            if key.len() == 16 {
                let mut c = ctr::Ctr128BE::<aes::Aes128>::new_from_slices(key, iv).map_err(|_| bad("Invalid key length"))?;
                c.apply_keystream(&mut out);
            } else {
                let mut c = ctr::Ctr128BE::<aes::Aes256>::new_from_slices(key, iv).map_err(|_| bad("Invalid key length"))?;
                c.apply_keystream(&mut out);
            }
            Ok(out)
        }
        a => Err(bad(&format!("Unknown cipher: {a}"))),
    }
}

// ---------- asymmetric keys (RSA PKCS#1 v1.5 / PSS, ECDSA P-256) ----------

#[derive(Serialize)]
pub struct KeyPair {
    public_pem: String,
    private_pem: String,
}

/// `kind`: "rsa" (param = modulus bits) or "ec" (param ignored; P-256).
#[op2]
#[serde]
pub fn op_keygen(#[string] kind: &str, param: u32) -> Result<KeyPair, JsErrorBox> {
    use rsa::pkcs8::{EncodePrivateKey, EncodePublicKey};
    match kind {
        "rsa" => {
            let mut rng = rand_core::OsRng;
            let bits = if param == 0 { 2048 } else { param as usize };
            let sk = rsa::RsaPrivateKey::new(&mut rng, bits).map_err(generic)?;
            let pk = rsa::RsaPublicKey::from(&sk);
            Ok(KeyPair {
                public_pem: pk.to_public_key_pem(rsa::pkcs8::LineEnding::LF).map_err(generic)?,
                private_pem: sk.to_pkcs8_pem(rsa::pkcs8::LineEnding::LF).map_err(generic)?.to_string(),
            })
        }
        "ec" => {
            let sk = p256::SecretKey::random(&mut rand_core::OsRng);
            let pk = sk.public_key();
            Ok(KeyPair {
                public_pem: pk.to_public_key_pem(p256::pkcs8::LineEnding::LF).map_err(generic)?,
                private_pem: sk.to_pkcs8_pem(p256::pkcs8::LineEnding::LF).map_err(generic)?.to_string(),
            })
        }
        k => Err(JsErrorBox::type_error(format!("unsupported key type {k}"))),
    }
}

#[derive(Serialize)]
pub struct KeyInfo {
    kind: String,
    is_private: bool,
    bits: u32,
}

#[op2]
#[serde]
pub fn op_key_info(#[string] pem: &str) -> Result<KeyInfo, JsErrorBox> {
    use rsa::pkcs8::{DecodePrivateKey, DecodePublicKey};
    use rsa::traits::PublicKeyParts;
    if let Ok(k) = rsa::RsaPrivateKey::from_pkcs8_pem(pem) { return Ok(KeyInfo { kind: "rsa".into(), is_private: true, bits: k.size() as u32 * 8 }); }
    if let Ok(k) = rsa::pkcs1::DecodeRsaPrivateKey::from_pkcs1_pem(pem).map(|k: rsa::RsaPrivateKey| k) { return Ok(KeyInfo { kind: "rsa".into(), is_private: true, bits: k.size() as u32 * 8 }); }
    if let Ok(k) = rsa::RsaPublicKey::from_public_key_pem(pem) { return Ok(KeyInfo { kind: "rsa".into(), is_private: false, bits: k.size() as u32 * 8 }); }
    if let Ok(k) = rsa::pkcs1::DecodeRsaPublicKey::from_pkcs1_pem(pem).map(|k: rsa::RsaPublicKey| k) { return Ok(KeyInfo { kind: "rsa".into(), is_private: false, bits: k.size() as u32 * 8 }); }
    if p256::SecretKey::from_pkcs8_pem(pem).is_ok() || p256::SecretKey::from_sec1_pem(pem).is_ok() { return Ok(KeyInfo { kind: "ec".into(), is_private: true, bits: 256 }); }
    if p256::PublicKey::from_public_key_pem(pem).is_ok() { return Ok(KeyInfo { kind: "ec".into(), is_private: false, bits: 256 }); }
    Err(JsErrorBox::type_error("unsupported or malformed key (PEM: PKCS#8, PKCS#1, SPKI, SEC1; RSA or P-256)"))
}

fn rsa_private(pem: &str) -> Result<rsa::RsaPrivateKey, JsErrorBox> {
    use rsa::pkcs1::DecodeRsaPrivateKey;
    use rsa::pkcs8::DecodePrivateKey;
    rsa::RsaPrivateKey::from_pkcs8_pem(pem).or_else(|_| rsa::RsaPrivateKey::from_pkcs1_pem(pem)).map_err(|e| JsErrorBox::type_error(format!("bad RSA private key: {e}")))
}
fn rsa_public(pem: &str) -> Result<rsa::RsaPublicKey, JsErrorBox> {
    use rsa::pkcs1::DecodeRsaPublicKey;
    use rsa::pkcs8::{DecodePrivateKey, DecodePublicKey};
    if let Ok(k) = rsa::RsaPublicKey::from_public_key_pem(pem) { return Ok(k); }
    if let Ok(k) = rsa::RsaPublicKey::from_pkcs1_pem(pem) { return Ok(k); }
    rsa::RsaPrivateKey::from_pkcs8_pem(pem).map(|k| rsa::RsaPublicKey::from(&k)).map_err(|e| JsErrorBox::type_error(format!("bad RSA public key: {e}")))
}

/// `scheme`: "rsa-pkcs1" | "rsa-pss" | "ecdsa"; `digest`: sha256/sha384/sha512 (ECDSA: sha256).
#[op2]
#[buffer]
pub fn op_sign(#[string] scheme: &str, #[string] digest: &str, #[string] key_pem: &str, #[buffer] data: &[u8]) -> Result<Vec<u8>, JsErrorBox> {
    use rsa::signature::{RandomizedSigner, SignatureEncoding, Signer};
    let d = digest.to_ascii_lowercase().replace('-', "");
    match scheme {
        "rsa-pkcs1" => {
            let sk = rsa_private(key_pem)?;
            macro_rules! go { ($h:ty) => {{ let s = rsa::pkcs1v15::SigningKey::<$h>::new(sk); Ok(s.sign(data).to_vec()) }}; }
            match d.as_str() { "sha256" => go!(sha2::Sha256), "sha384" => go!(sha2::Sha384), "sha512" => go!(sha2::Sha512), _ => Err(JsErrorBox::type_error(format!("unsupported digest {digest}"))) }
        }
        "rsa-pss" => {
            let sk = rsa_private(key_pem)?;
            let mut rng = rand_core::OsRng;
            macro_rules! go { ($h:ty) => {{ let s = rsa::pss::SigningKey::<$h>::new(sk); Ok(s.sign_with_rng(&mut rng, data).to_vec()) }}; }
            match d.as_str() { "sha256" => go!(sha2::Sha256), "sha384" => go!(sha2::Sha384), "sha512" => go!(sha2::Sha512), _ => Err(JsErrorBox::type_error(format!("unsupported digest {digest}"))) }
        }
        "ecdsa" => {
            use p256::pkcs8::DecodePrivateKey;
            let sk = p256::SecretKey::from_pkcs8_pem(key_pem).or_else(|_| p256::SecretKey::from_sec1_pem(key_pem)).map_err(|e| JsErrorBox::type_error(format!("bad EC key: {e}")))?;
            let signing = p256::ecdsa::SigningKey::from(sk);
            let sig: p256::ecdsa::Signature = signing.sign(data);
            Ok(sig.to_der().to_vec())
        }
        s => Err(JsErrorBox::type_error(format!("unsupported scheme {s}"))),
    }
}

#[op2(fast)]
pub fn op_verify(#[string] scheme: &str, #[string] digest: &str, #[string] key_pem: &str, #[buffer] data: &[u8], #[buffer] sig: &[u8]) -> Result<bool, JsErrorBox> {
    use rsa::signature::Verifier;
    let d = digest.to_ascii_lowercase().replace('-', "");
    match scheme {
        "rsa-pkcs1" => {
            let pk = rsa_public(key_pem)?;
            macro_rules! go { ($h:ty) => {{ let v = rsa::pkcs1v15::VerifyingKey::<$h>::new(pk); let s = match rsa::pkcs1v15::Signature::try_from(sig) { Ok(s) => s, Err(_) => return Ok(false) }; Ok(v.verify(data, &s).is_ok()) }}; }
            match d.as_str() { "sha256" => go!(sha2::Sha256), "sha384" => go!(sha2::Sha384), "sha512" => go!(sha2::Sha512), _ => Err(JsErrorBox::type_error(format!("unsupported digest {digest}"))) }
        }
        "rsa-pss" => {
            let pk = rsa_public(key_pem)?;
            macro_rules! go { ($h:ty) => {{ let v = rsa::pss::VerifyingKey::<$h>::new(pk); let s = match rsa::pss::Signature::try_from(sig) { Ok(s) => s, Err(_) => return Ok(false) }; Ok(v.verify(data, &s).is_ok()) }}; }
            match d.as_str() { "sha256" => go!(sha2::Sha256), "sha384" => go!(sha2::Sha384), "sha512" => go!(sha2::Sha512), _ => Err(JsErrorBox::type_error(format!("unsupported digest {digest}"))) }
        }
        "ecdsa" => {
            use p256::pkcs8::DecodePublicKey;
            let pk = p256::PublicKey::from_public_key_pem(key_pem).map_err(|e| JsErrorBox::type_error(format!("bad EC public key: {e}")))?;
            let v = p256::ecdsa::VerifyingKey::from(pk);
            let s = match p256::ecdsa::Signature::from_der(sig).or_else(|_| p256::ecdsa::Signature::from_slice(sig)) { Ok(s) => s, Err(_) => return Ok(false) };
            Ok(v.verify(data, &s).is_ok())
        }
        s => Err(JsErrorBox::type_error(format!("unsupported scheme {s}"))),
    }
}

// Async file operations keep an Arc to the open file, avoiding a dup syscall per
// chunk and preventing close/reopen races while an operation is on the pool.
fn async_file(state: &mut OpState, fd: i32) -> Result<std::sync::Arc<std::fs::File>, JsErrorBox> {
    files(state).map.get(&fd).cloned().ok_or_else(|| JsErrorBox::generic("EBADF: bad file descriptor"))
}
#[op2]
pub async fn op_fd_open_async(state: Rc<RefCell<OpState>>, #[string] path: String, #[string] flags: String, mode: u32) -> Result<i32, JsErrorBox> {
    let file = tokio::task::spawn_blocking(move || open_file(&path, &flags, mode)).await.map_err(generic)??;
    let mut state = state.borrow_mut();
    let table = files(&mut state);
    let fd = table.next; table.next += 1;
    table.map.insert(fd, std::sync::Arc::new(file));
    Ok(fd)
}
#[op2]
#[buffer]
pub async fn op_fd_read_async(state: Rc<RefCell<OpState>>, fd: i32, len: u32, pos: f64) -> Result<Vec<u8>, JsErrorBox> {
    let file = if fd <= 2 { None } else { Some(async_file(&mut state.borrow_mut(), fd)?) };
    tokio::task::spawn_blocking(move || {
        use std::io::Read;
        let mut bytes = vec![0; len as usize];
        let n = if fd == 0 { std::io::stdin().read(&mut bytes) } else {
        let file = file.ok_or_else(|| JsErrorBox::generic("EBADF: invalid read descriptor"))?;
        if pos >= 0.0 {
            #[cfg(unix)]
            { use std::os::unix::fs::FileExt; file.read_at(&mut bytes, pos as u64) }
            #[cfg(not(unix))]
            { use std::io::{Seek, SeekFrom}; let mut f = &*file; f.seek(SeekFrom::Start(pos as u64))?; f.read(&mut bytes) }
        } else { (&*file).read(&mut bytes) } }.map_err(|e| fs_err(e, "read", ""))?;
        bytes.truncate(n); Ok(bytes)
    }).await.map_err(generic)?
}
#[op2]
pub async fn op_fd_write_async(state: Rc<RefCell<OpState>>, fd: i32, #[buffer(copy)] bytes: Vec<u8>, pos: f64) -> Result<u32, JsErrorBox> {
    let file = if fd <= 2 { None } else { Some(async_file(&mut state.borrow_mut(), fd)?) };
    tokio::task::spawn_blocking(move || {
        use std::io::Write;
        let n = if fd == 1 { std::io::stdout().write(&bytes) } else if fd == 2 { std::io::stderr().write(&bytes) } else {
        let file = file.ok_or_else(|| JsErrorBox::generic("EBADF: invalid write descriptor"))?;
        if pos >= 0.0 {
            #[cfg(unix)]
            { use std::os::unix::fs::FileExt; file.write_at(&bytes, pos as u64) }
            #[cfg(not(unix))]
            { use std::io::{Seek, SeekFrom}; let mut f = &*file; f.seek(SeekFrom::Start(pos as u64))?; f.write(&bytes) }
        } else { (&*file).write(&bytes) } }.map_err(|e| fs_err(e, "write", ""))?;
        Ok(n as u32)
    }).await.map_err(generic)?
}
#[op2]
pub async fn op_fd_close_async(state: Rc<RefCell<OpState>>, fd: i32) -> Result<(), JsErrorBox> {
    let file = files(&mut state.borrow_mut()).map.remove(&fd).ok_or_else(|| JsErrorBox::generic("EBADF: bad file descriptor, close"))?;
    tokio::task::spawn_blocking(move || drop(file)).await.map_err(generic)
}

#[op2]
#[serde]
pub async fn op_fd_stat_async(state: Rc<RefCell<OpState>>, fd: i32) -> Result<super::nodeimpl::StatInfo, JsErrorBox> {
    let file = async_file(&mut state.borrow_mut(), fd)?;
    tokio::task::spawn_blocking(move || file.metadata().map(|m| super::nodeimpl::stat_from_metadata(&m)).map_err(|e| fs_err(e, "fstat", ""))).await.map_err(generic)?
}
#[op2]
pub async fn op_fd_control_async(state: Rc<RefCell<OpState>>, fd: i32, truncate: bool, len: f64) -> Result<(), JsErrorBox> {
    let file = async_file(&mut state.borrow_mut(), fd)?;
    tokio::task::spawn_blocking(move || {
        if truncate { file.set_len(len as u64) } else { file.sync_all() }.map_err(|e| fs_err(e, if truncate { "ftruncate" } else { "fsync" }, ""))
    }).await.map_err(generic)?
}
