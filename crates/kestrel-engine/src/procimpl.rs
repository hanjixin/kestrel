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

/// Returns [rid, pid]. Errors carry a Node-style code in the message.
#[op2]
#[serde]
pub fn op_cp_spawn(state: &mut OpState, #[serde] o: SpawnOpts) -> Result<(u32, u32), JsErrorBox> {
    let cmd = tokio::process::Command::from(build_command(&o));
    let mut cmd = cmd;
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
    let stdin = child.stdin.take();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let ch = children(state);
    let rid = ch.next;
    ch.next += 1;
    ch.map.insert(rid, Rc::new(RefCell::new(Child { child, stdin, stdout, stderr })));
    Ok((rid, pid))
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
    map: HashMap<i32, std::fs::File>,
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

/// flags: Node's string flags ("r", "r+", "w", "w+", "a", "a+", "wx", "ax").
#[op2(fast)]
pub fn op_fd_open(state: &mut OpState, #[string] path: &str, #[string] flags: &str, mode: u32) -> Result<i32, JsErrorBox> {
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
    let t = files(state);
    let fd = t.next;
    t.next += 1;
    t.map.insert(fd, f);
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
    let f = files(state).map.get_mut(&fd).ok_or_else(|| JsErrorBox::new("Error", "EBADF: bad file descriptor, read"))?;
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
    let f = files(state).map.get_mut(&fd).ok_or_else(|| JsErrorBox::new("Error", "EBADF: bad file descriptor, write"))?;
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
