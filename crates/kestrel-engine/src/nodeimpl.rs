//! Native ops behind the Node compatibility layer: filesystem, text encoding,
//! URL parsing, hashing/random, OS info, zlib. Pure functions over std +
//! small crates, so this file is also compiled into build.rs for the snapshot.

use std::path::Path;

use deno_core::op2;
use deno_error::JsErrorBox;
use serde::Serialize;

// ---------- errors with Node-style codes ----------

fn io_err(e: &std::io::Error, syscall: &str, path: &str) -> JsErrorBox {
    use std::io::ErrorKind as K;
    let code = match e.kind() {
        K::NotFound => "ENOENT",
        K::PermissionDenied => "EACCES",
        K::AlreadyExists => "EEXIST",
        K::InvalidInput => "EINVAL",
        K::NotADirectory => "ENOTDIR",
        K::IsADirectory => "EISDIR",
        K::DirectoryNotEmpty => "ENOTEMPTY",
        _ => match e.raw_os_error() {
            Some(2) => "ENOENT",
            Some(13) => "EACCES",
            Some(17) => "EEXIST",
            Some(20) => "ENOTDIR",
            Some(21) => "EISDIR",
            Some(66) | Some(39) => "ENOTEMPTY",
            _ => "EIO",
        },
    };
    let desc = match code {
        "ENOENT" => "no such file or directory",
        "EACCES" => "permission denied",
        "EEXIST" => "file already exists",
        "ENOTDIR" => "not a directory",
        "EISDIR" => "illegal operation on a directory",
        "ENOTEMPTY" => "directory not empty",
        "EINVAL" => "invalid argument",
        _ => "i/o error",
    };
    // The JS side parses "CODE: desc, syscall 'path'" into err.code / err.syscall / err.path.
    JsErrorBox::new("Error", format!("{code}: {desc}, {syscall} '{path}'"))
}

// ---------- fs ----------

#[op2]
#[string]
pub fn op_k_fs_read_text(#[string] path: &str) -> Result<String, JsErrorBox> {
    let bytes = std::fs::read(path).map_err(|e| io_err(&e, "open", path))?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

#[op2]
#[buffer]
pub fn op_k_fs_read_bytes(#[string] path: &str) -> Result<Vec<u8>, JsErrorBox> {
    std::fs::read(path).map_err(|e| io_err(&e, "open", path))
}

fn write_bytes_impl(path: &str, data: &[u8], append: bool) -> Result<(), JsErrorBox> {
    use std::io::Write;
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .append(append)
        .truncate(!append)
        .open(path)
        .map_err(|e| io_err(&e, "open", path))?;
    f.write_all(data).map_err(|e| io_err(&e, "write", path))
}

#[op2(fast)]
pub fn op_k_fs_write_bytes(#[string] path: &str, #[buffer] data: &[u8], append: bool) -> Result<(), JsErrorBox> {
    write_bytes_impl(path, data, append)
}

#[op2(fast)]
pub fn op_k_fs_write_text(#[string] path: &str, #[string] data: &str, append: bool) -> Result<(), JsErrorBox> {
    write_bytes_impl(path, data.as_bytes(), append)
}

#[derive(Serialize)]
pub struct StatInfo {
    is_file: bool,
    is_dir: bool,
    is_symlink: bool,
    size: f64,
    mtime_ms: f64,
    atime_ms: f64,
    ctime_ms: f64,
    birthtime_ms: f64,
    mode: u32,
    ino: f64,
    nlink: f64,
    uid: u32,
    gid: u32,
    dev: f64,
}

fn ms(t: std::io::Result<std::time::SystemTime>) -> f64 {
    t.ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

pub fn stat_from_metadata(md: &std::fs::Metadata) -> StatInfo {
    #[cfg(unix)]
    let (mode, ino, nlink, uid, gid, dev) = {
        use std::os::unix::fs::MetadataExt;
        (md.mode(), md.ino() as f64, md.nlink() as f64, md.uid(), md.gid(), md.dev() as f64)
    };
    #[cfg(not(unix))]
    let (mode, ino, nlink, uid, gid, dev) = (0u32, 0.0, 1.0, 0u32, 0u32, 0.0);
    StatInfo {
        is_file: md.is_file(),
        is_dir: md.is_dir(),
        is_symlink: md.file_type().is_symlink(),
        size: md.len() as f64,
        mtime_ms: ms(md.modified()),
        atime_ms: ms(md.accessed()),
        ctime_ms: ms(md.modified()),
        birthtime_ms: ms(md.created()),
        mode,
        ino,
        nlink,
        uid,
        gid,
        dev,
    }
}

#[op2]
#[serde]
pub fn op_k_fs_stat(#[string] path: &str, follow: bool) -> Result<StatInfo, JsErrorBox> {
    let md = if follow { std::fs::metadata(path) } else { std::fs::symlink_metadata(path) };
    let md = md.map_err(|e| io_err(&e, if follow { "stat" } else { "lstat" }, path))?;
    Ok(stat_from_metadata(&md))
}

#[op2(fast)]
pub fn op_k_fs_exists(#[string] path: &str) -> bool {
    Path::new(path).exists()
}

/// Entries as [name, kind] with kind 1=file 2=dir 3=symlink 0=other.
#[op2]
#[serde]
pub fn op_k_fs_readdir(#[string] path: &str) -> Result<Vec<(String, u8)>, JsErrorBox> {
    let rd = std::fs::read_dir(path).map_err(|e| io_err(&e, "scandir", path))?;
    let mut out = Vec::new();
    for e in rd {
        let e = e.map_err(|e| io_err(&e, "scandir", path))?;
        let ft = e.file_type().ok();
        let kind = match ft {
            Some(t) if t.is_symlink() => 3,
            Some(t) if t.is_dir() => 2,
            Some(t) if t.is_file() => 1,
            _ => 0,
        };
        out.push((e.file_name().to_string_lossy().into_owned(), kind));
    }
    out.sort();
    Ok(out)
}

#[op2(fast)]
pub fn op_k_fs_mkdir(#[string] path: &str, recursive: bool, mode: u32) -> Result<(), JsErrorBox> {
    let mut b = std::fs::DirBuilder::new();
    b.recursive(recursive);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        b.mode(mode);
    }
    let _ = mode;
    b.create(path).map_err(|e| io_err(&e, "mkdir", path))
}

#[op2(fast)]
pub fn op_k_fs_remove(#[string] path: &str, recursive: bool, force: bool) -> Result<(), JsErrorBox> {
    let p = Path::new(path);
    let md = match std::fs::symlink_metadata(p) {
        Ok(m) => m,
        Err(e) => {
            if force && e.kind() == std::io::ErrorKind::NotFound {
                return Ok(());
            }
            return Err(io_err(&e, "rm", path));
        }
    };
    let r = if md.is_dir() && !md.file_type().is_symlink() {
        if recursive { std::fs::remove_dir_all(p) } else { std::fs::remove_dir(p) }
    } else {
        std::fs::remove_file(p)
    };
    r.map_err(|e| io_err(&e, "rm", path))
}

#[op2(fast)]
pub fn op_k_fs_rename(#[string] from: &str, #[string] to: &str) -> Result<(), JsErrorBox> {
    std::fs::rename(from, to).map_err(|e| io_err(&e, "rename", from))
}

#[op2(fast)]
pub fn op_k_fs_copy(#[string] from: &str, #[string] to: &str) -> Result<(), JsErrorBox> {
    std::fs::copy(from, to).map(|_| ()).map_err(|e| io_err(&e, "copyfile", from))
}

#[op2]
#[string]
pub fn op_k_fs_realpath(#[string] path: &str) -> Result<String, JsErrorBox> {
    std::fs::canonicalize(path)
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(|e| io_err(&e, "realpath", path))
}

#[op2]
#[string]
pub fn op_k_fs_readlink(#[string] path: &str) -> Result<String, JsErrorBox> {
    std::fs::read_link(path)
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(|e| io_err(&e, "readlink", path))
}

#[op2(fast)]
pub fn op_k_fs_chmod(#[string] path: &str, mode: u32) -> Result<(), JsErrorBox> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).map_err(|e| io_err(&e, "chmod", path))
    }
    #[cfg(not(unix))]
    {
        let _ = (path, mode);
        Ok(())
    }
}

#[op2(fast)]
pub fn op_k_fs_symlink(#[string] target: &str, #[string] path: &str) -> Result<(), JsErrorBox> {
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(target, path).map_err(|e| io_err(&e, "symlink", path))
    }
    #[cfg(not(unix))]
    {
        let _ = target;
        Err(JsErrorBox::generic(format!("symlink unsupported: {path}")))
    }
}

#[op2(fast)]
pub fn op_k_fs_utimes(#[string] path: &str, atime_ms: f64, mtime_ms: f64) -> Result<(), JsErrorBox> {
    let to = |ms: f64| std::time::UNIX_EPOCH + std::time::Duration::from_secs_f64((ms / 1000.0).max(0.0));
    let f = std::fs::File::options().write(true).open(path).map_err(|e| io_err(&e, "utime", path))?;
    f.set_times(std::fs::FileTimes::new().set_accessed(to(atime_ms)).set_modified(to(mtime_ms)))
        .map_err(|e| io_err(&e, "utime", path))
}

#[op2]
#[string]
pub fn op_k_fs_mkdtemp(#[string] prefix: &str) -> Result<String, JsErrorBox> {
    for _ in 0..100 {
        let suffix: String = (0..6).map(|_| {
            let b = rand::random::<u8>() % 36;
            (if b < 10 { b'0' + b } else { b'a' + b - 10 }) as char
        }).collect();
        let p = format!("{prefix}{suffix}");
        match std::fs::create_dir(&p) {
            Ok(()) => return Ok(p),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(io_err(&e, "mkdtemp", &p)),
        }
    }
    Err(JsErrorBox::generic("mkdtemp: too many attempts"))
}

// ---------- encodings ----------

#[op2]
#[string]
pub fn op_k_utf8_decode(#[buffer] data: &[u8]) -> String {
    String::from_utf8_lossy(data).into_owned()
}

#[op2]
#[buffer]
pub fn op_k_utf8_encode(#[string] s: &str) -> Vec<u8> {
    s.as_bytes().to_vec()
}

#[op2]
#[string]
pub fn op_k_base64_encode(#[buffer] data: &[u8], url_safe: bool) -> String {
    use base64::Engine;
    if url_safe {
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(data)
    } else {
        base64::engine::general_purpose::STANDARD.encode(data)
    }
}

#[op2]
#[buffer]
pub fn op_k_base64_decode(#[string] s: &str) -> Result<Vec<u8>, JsErrorBox> {
    use base64::Engine;
    let cleaned: String = s.chars().filter(|c| !c.is_whitespace()).map(|c| match c { '-' => '+', '_' => '/', c => c }).collect();
    let cleaned = cleaned.trim_end_matches('=');
    base64::engine::general_purpose::STANDARD_NO_PAD
        .decode(cleaned)
        .map_err(|e| JsErrorBox::new("InvalidCharacterError", format!("invalid base64: {e}")))
}

#[op2]
#[string]
pub fn op_k_hex_encode(#[buffer] data: &[u8]) -> String {
    const H: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(data.len() * 2);
    for b in data {
        s.push(H[(b >> 4) as usize] as char);
        s.push(H[(b & 15) as usize] as char);
    }
    s
}

#[op2]
#[buffer]
pub fn op_k_hex_decode(#[string] s: &str) -> Vec<u8> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len() / 2);
    let val = |c: u8| -> Option<u8> {
        match c {
            b'0'..=b'9' => Some(c - b'0'),
            b'a'..=b'f' => Some(c - b'a' + 10),
            b'A'..=b'F' => Some(c - b'A' + 10),
            _ => None,
        }
    };
    let mut i = 0;
    while i + 1 < b.len() {
        match (val(b[i]), val(b[i + 1])) {
            (Some(h), Some(l)) => out.push(h << 4 | l),
            _ => break,
        }
        i += 2;
    }
    out
}

#[op2]
#[buffer]
pub fn op_k_latin1_encode(#[string] s: &str) -> Vec<u8> {
    s.chars().map(|c| (c as u32 & 0xff) as u8).collect()
}

#[op2]
#[string]
pub fn op_k_latin1_decode(#[buffer] data: &[u8]) -> String {
    data.iter().map(|&b| b as char).collect()
}

// ---------- URL ----------

/// [href, protocol, username, password, hostname, port, pathname, search, hash, host, origin]
#[op2]
#[serde]
pub fn op_k_url_parse(#[string] href: &str, #[string] base: &str) -> Option<Vec<String>> {
    let u = if base.is_empty() {
        url::Url::parse(href).ok()?
    } else {
        url::Url::parse(base).ok()?.join(href).ok()?
    };
    Some(vec![
        u.as_str().to_string(),
        format!("{}:", u.scheme()),
        u.username().to_string(),
        u.password().unwrap_or("").to_string(),
        u.host_str().unwrap_or("").to_string(),
        u.port().map(|p| p.to_string()).unwrap_or_default(),
        u.path().to_string(),
        u.query().map(|q| format!("?{q}")).unwrap_or_default(),
        u.fragment().map(|f| format!("#{f}")).unwrap_or_default(),
        match (u.host_str(), u.port()) {
            (Some(h), Some(p)) => format!("{h}:{p}"),
            (Some(h), None) => h.to_string(),
            _ => String::new(),
        },
        match u.origin() {
            url::Origin::Tuple(s, h, p) => {
                let default = matches!((s.as_str(), p), ("http", 80) | ("https", 443) | ("ws", 80) | ("wss", 443) | ("ftp", 21));
                if default { format!("{s}://{h}") } else { format!("{s}://{h}:{p}") }
            }
            url::Origin::Opaque(_) => "null".to_string(),
        },
    ])
}

#[op2]
#[string]
pub fn op_k_url_to_path(#[string] href: &str) -> Result<String, JsErrorBox> {
    url::Url::parse(href)
        .ok()
        .and_then(|u| u.to_file_path().ok())
        .map(|p| p.to_string_lossy().into_owned())
        .ok_or_else(|| JsErrorBox::type_error(format!("not a file URL: {href}")))
}

#[op2]
#[string]
pub fn op_k_path_to_url(#[string] path: &str) -> Result<String, JsErrorBox> {
    let p = std::path::absolute(path).map_err(|e| JsErrorBox::type_error(e.to_string()))?;
    url::Url::from_file_path(&p)
        .map(|u| u.to_string())
        .map_err(|_| JsErrorBox::type_error(format!("cannot convert to file URL: {path}")))
}

// ---------- crypto ----------

#[op2]
#[buffer]
pub fn op_k_random_bytes(n: u32) -> Vec<u8> {
    let mut v = vec![0u8; n as usize];
    rand::fill(&mut v[..]);
    v
}

#[op2]
#[string]
pub fn op_k_random_uuid() -> String {
    let mut b = [0u8; 16];
    rand::fill(&mut b);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7], b[8], b[9], b[10], b[11], b[12], b[13], b[14], b[15]
    )
}

fn digest(algo: &str, data: &[u8]) -> Option<Vec<u8>> {
    use sha2::Digest;
    Some(match algo {
        "md5" => md5::Md5::digest(data).to_vec(),
        "sha1" | "sha-1" => sha1::Sha1::digest(data).to_vec(),
        "sha224" => sha2::Sha224::digest(data).to_vec(),
        "sha256" | "sha-256" => sha2::Sha256::digest(data).to_vec(),
        "sha384" | "sha-384" => sha2::Sha384::digest(data).to_vec(),
        "sha512" | "sha-512" => sha2::Sha512::digest(data).to_vec(),
        _ => return None,
    })
}

#[op2]
#[buffer]
pub fn op_k_hash(#[string] algo: &str, #[buffer] data: &[u8]) -> Result<Vec<u8>, JsErrorBox> {
    digest(&algo.to_ascii_lowercase(), data).ok_or_else(|| JsErrorBox::new("Error", format!("Digest method not supported: {algo}")))
}

#[op2]
#[buffer]
pub fn op_k_hmac(#[string] algo: &str, #[buffer] key: &[u8], #[buffer] data: &[u8]) -> Result<Vec<u8>, JsErrorBox> {
    use hmac::{Hmac, Mac};
    macro_rules! run {
        ($t:ty) => {{
            let mut m = <Hmac<$t>>::new_from_slice(key).map_err(|e| JsErrorBox::generic(e.to_string()))?;
            m.update(data);
            Ok(m.finalize().into_bytes().to_vec())
        }};
    }
    match algo.to_ascii_lowercase().as_str() {
        "md5" => run!(md5::Md5),
        "sha1" => run!(sha1::Sha1),
        "sha224" => run!(sha2::Sha224),
        "sha256" => run!(sha2::Sha256),
        "sha384" => run!(sha2::Sha384),
        "sha512" => run!(sha2::Sha512),
        _ => Err(JsErrorBox::new("Error", format!("Digest method not supported: {algo}"))),
    }
}

// ---------- zlib ----------

#[op2]
#[buffer]
pub fn op_k_zlib(#[string] mode: &str, #[buffer] data: &[u8], level: i32) -> Result<Vec<u8>, JsErrorBox> {
    use std::io::{Read, Write};
    let lvl = if level < 0 { flate2::Compression::default() } else { flate2::Compression::new(level.min(9) as u32) };
    let r: std::io::Result<Vec<u8>> = (|| match mode {
        "gzip" => { let mut e = flate2::write::GzEncoder::new(Vec::new(), lvl); e.write_all(data)?; e.finish() }
        "gunzip" => { let mut d = flate2::read::MultiGzDecoder::new(data); let mut v = Vec::new(); d.read_to_end(&mut v)?; Ok(v) }
        "deflate" => { let mut e = flate2::write::ZlibEncoder::new(Vec::new(), lvl); e.write_all(data)?; e.finish() }
        "inflate" => { let mut d = flate2::read::ZlibDecoder::new(data); let mut v = Vec::new(); d.read_to_end(&mut v)?; Ok(v) }
        "deflateRaw" => { let mut e = flate2::write::DeflateEncoder::new(Vec::new(), lvl); e.write_all(data)?; e.finish() }
        "inflateRaw" => { let mut d = flate2::read::DeflateDecoder::new(data); let mut v = Vec::new(); d.read_to_end(&mut v)?; Ok(v) }
        "unzip" => {
            if data.len() >= 2 && data[0] == 0x1f && data[1] == 0x8b {
                let mut d = flate2::read::MultiGzDecoder::new(data); let mut v = Vec::new(); d.read_to_end(&mut v)?; Ok(v)
            } else {
                let mut d = flate2::read::ZlibDecoder::new(data); let mut v = Vec::new(); d.read_to_end(&mut v)?; Ok(v)
            }
        }
        _ => Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "bad zlib mode")),
    })();
    r.map_err(|e| JsErrorBox::new("Error", format!("zlib {mode}: {e}")))
}

// ---------- os / process ----------

#[derive(Serialize)]
pub struct OsInfo {
    hostname: String,
    arch: String,
    platform: String,
    release: String,
    version: String,
    homedir: String,
    tmpdir: String,
    cpus: u32,
    total_mem: f64,
    uptime: f64,
    username: String,
    uid: i64,
    gid: i64,
    shell: String,
    exec_path: String,
    pid: u32,
    ppid: u32,
}

#[op2]
#[serde]
pub fn op_k_os_info() -> OsInfo {
    let hostname = {
        let mut buf = [0u8; 256];
        #[cfg(unix)]
        unsafe {
            libc::gethostname(buf.as_mut_ptr() as *mut libc::c_char, buf.len());
        }
        let end = buf.iter().position(|&b| b == 0).unwrap_or(0);
        String::from_utf8_lossy(&buf[..end]).into_owned()
    };
    #[cfg(unix)]
    let (release, version) = unsafe {
        let mut u: libc::utsname = std::mem::zeroed();
        libc::uname(&mut u);
        let c = |p: &[libc::c_char]| std::ffi::CStr::from_ptr(p.as_ptr()).to_string_lossy().into_owned();
        (c(&u.release), c(&u.version))
    };
    #[cfg(not(unix))]
    let (release, version) = (String::new(), String::new());
    #[cfg(unix)]
    let (uid, gid, ppid) = unsafe { (libc::getuid() as i64, libc::getgid() as i64, libc::getppid() as u32) };
    #[cfg(not(unix))]
    let (uid, gid, ppid) = (-1i64, -1i64, 0u32);
    let arch = match std::env::consts::ARCH { "aarch64" => "arm64", "x86_64" => "x64", a => a }.to_string();
    #[cfg(target_os = "macos")]
    let total_mem = unsafe {
        let mut v: u64 = 0;
        let mut len = std::mem::size_of::<u64>();
        let name = std::ffi::CString::new("hw.memsize").unwrap();
        libc::sysctlbyname(name.as_ptr(), &mut v as *mut _ as *mut libc::c_void, &mut len, std::ptr::null_mut(), 0);
        v as f64
    };
    #[cfg(target_os = "linux")]
    let total_mem = unsafe { (libc::sysconf(libc::_SC_PHYS_PAGES) as f64) * (libc::sysconf(libc::_SC_PAGESIZE) as f64) };
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    let total_mem = 0.0;
    OsInfo {
        hostname,
        arch,
        platform: std::env::consts::OS.to_string(),
        release,
        version,
        homedir: std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")).unwrap_or_default(),
        tmpdir: std::env::temp_dir().to_string_lossy().trim_end_matches('/').to_string(),
        cpus: std::thread::available_parallelism().map(|n| n.get() as u32).unwrap_or(1),
        total_mem,
        uptime: 0.0,
        username: std::env::var("USER").or_else(|_| std::env::var("USERNAME")).unwrap_or_default(),
        uid,
        gid,
        shell: std::env::var("SHELL").unwrap_or_default(),
        exec_path: std::env::current_exe().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default(),
        pid: std::process::id(),
        ppid,
    }
}

/// Monotonic clock in milliseconds since process start (for performance.now / hrtime).
#[op2(fast)]
pub fn op_k_now_ms() -> f64 {
    static START: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
    START.get_or_init(std::time::Instant::now).elapsed().as_secs_f64() * 1000.0
}

#[op2(fast)]
pub fn op_k_chdir(#[string] path: &str) -> Result<(), JsErrorBox> {
    std::env::set_current_dir(path).map_err(|e| io_err(&e, "chdir", path))
}

#[op2(fast)]
pub fn op_k_setenv(#[string] k: &str, #[string] v: &str) {
    // SAFETY: single-threaded runtime per process at the point user code calls this.
    unsafe { std::env::set_var(k, v) };
}

#[op2(fast)]
pub fn op_k_sleep_ms(ms: f64) {
    std::thread::sleep(std::time::Duration::from_secs_f64((ms / 1000.0).max(0.0)));
}

/// Read a line from stdin (for the tiny readline/prompt support). Empty string on EOF.
#[op2]
#[string]
pub fn op_k_read_stdin_line() -> String {
    let mut s = String::new();
    let _ = std::io::stdin().read_line(&mut s);
    s
}

#[op2]
#[buffer]
pub fn op_k_read_stdin_all() -> Vec<u8> {
    use std::io::Read;
    let mut v = Vec::new();
    let _ = std::io::stdin().read_to_end(&mut v);
    v
}

#[op2(fast)]
pub fn op_k_isatty(fd: u32) -> bool {
    #[cfg(unix)]
    unsafe {
        libc::isatty(fd as i32) == 1
    }
    #[cfg(not(unix))]
    {
        let _ = fd;
        false
    }
}

#[op2(fast)]
pub fn op_k_write_fd(fd: u32, #[buffer] data: &[u8]) -> bool {
    use std::io::Write;
    let r = match fd {
        1 => std::io::stdout().write_all(data).and_then(|_| std::io::stdout().flush()),
        2 => std::io::stderr().write_all(data),
        _ => return false,
    };
    r.is_ok()
}

// ---------- module resolution (shared with the ESM loader) ----------

/// Returns "builtin:<name>" or "file:<abs path>"; throws with a Node-style message.
#[op2]
#[string]
pub fn op_k_resolve(#[string] spec: &str, #[string] referrer: &str, is_require: bool) -> Result<String, JsErrorBox> {
    let kind = if is_require { super::resolve::Kind::Require } else { super::resolve::Kind::Import };
    match super::resolve::resolve(spec, Path::new(referrer), kind) {
        Ok(super::resolve::Resolved::Builtin(b)) => Ok(format!("builtin:{b}")),
        Ok(super::resolve::Resolved::File(p)) => Ok(format!("file:{}", p.to_string_lossy())),
        Err(msg) => Err(JsErrorBox::new("Error", format!("MODULE_NOT_FOUND: {msg}"))),
    }
}

#[op2]
#[string]
pub fn op_k_transpile(#[string] path: &str, #[string] src: &str) -> Result<String, JsErrorBox> {
    super::transpile::transpile(Path::new(path), src).map_err(|e| JsErrorBox::new("SyntaxError", e.to_string()))
}

/// "esm" | "cjs" | "json" for a file about to be `require`d.
#[op2]
#[string]
pub fn op_k_module_format(#[string] path: &str, #[string] src: &str) -> String {
    match super::resolve::format_of(Path::new(path)) {
        super::resolve::Format::Json => "json".into(),
        super::resolve::Format::Esm => "esm".into(),
        super::resolve::Format::Cjs => if super::resolve::looks_like_esm(src) { "esm".into() } else { "cjs".into() },
    }
}

#[op2]
#[string]
pub fn op_k_esm_to_cjs(#[string] path: &str, #[string] src: &str) -> Result<String, JsErrorBox> {
    super::esm2cjs::esm_to_cjs(Path::new(path), src).map_err(|e| JsErrorBox::new("SyntaxError", e.to_string()))
}

#[op2(fast)]
pub fn op_k_is_builtin(#[string] spec: &str) -> bool {
    super::resolve::builtin_name(spec).is_some()
}
