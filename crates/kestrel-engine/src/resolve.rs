//! Node-style module resolution: builtins, relative/absolute files with
//! extension probing, directories with package.json, and bare specifiers via
//! `node_modules` lookup with `exports`/`main`. Shared by the ESM loader (Rust)
//! and the CommonJS `require` (JS, through an op).

use std::path::{Path, PathBuf};

use serde_json::Value;

pub const BUILTINS: &[&str] = &[
    "assert", "buffer", "child_process", "crypto", "events", "fs", "fs/promises", "module", "os", "path",
    "path/posix", "process", "querystring", "stream", "string_decoder", "timers", "timers/promises", "tty",
    "url", "util", "util/types", "worker_threads", "zlib", "http", "https", "net", "readline",
];

pub fn builtin_name(spec: &str) -> Option<&str> {
    let name = spec.strip_prefix("node:").unwrap_or(spec);
    BUILTINS.contains(&name).then_some(name)
}

/// Path of the builtin's ESM implementation inside the snapshot.
pub fn builtin_url(name: &str) -> String {
    format!("ext:kestrel/node/{}.js", name.replace('/', "_"))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Import,
    Require,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Resolved {
    Builtin(String),
    File(PathBuf),
}

const EXTS: &[&str] = &["js", "mjs", "cjs", "ts", "tsx", "mts", "cts", "jsx", "json"];

fn try_file(p: &Path) -> Option<PathBuf> {
    if p.is_file() {
        return Some(p.to_path_buf());
    }
    let s = p.to_string_lossy();
    for e in EXTS {
        let c = PathBuf::from(format!("{s}.{e}"));
        if c.is_file() {
            return Some(c);
        }
    }
    None
}

fn try_index(dir: &Path) -> Option<PathBuf> {
    for e in EXTS {
        let c = dir.join(format!("index.{e}"));
        if c.is_file() {
            return Some(c);
        }
    }
    None
}

fn read_pkg(dir: &Path) -> Option<Value> {
    let s = std::fs::read_to_string(dir.join("package.json")).ok()?;
    serde_json::from_str(&s).ok()
}

/// Resolve a path that may be a file (with or without extension) or a directory.
pub fn resolve_file_or_dir(p: &Path, kind: Kind) -> Option<PathBuf> {
    if let Some(f) = try_file(p) {
        return Some(f);
    }
    if p.is_dir() {
        if let Some(pkg) = read_pkg(p) {
            if let Some(t) = pkg_entry(&pkg, ".", kind) {
                if let Some(f) = resolve_file_or_dir(&p.join(t.trim_start_matches("./")), kind) {
                    return Some(f);
                }
            }
        }
        return try_index(p);
    }
    None
}

fn conditions(kind: Kind) -> &'static [&'static str] {
    match kind {
        Kind::Import => &["node", "import", "module", "default"],
        Kind::Require => &["node", "require", "default"],
    }
}

/// Pick a target string out of an `exports` value for the given conditions.
fn pick_target(v: &Value, kind: Kind) -> Option<String> {
    match v {
        Value::String(s) => Some(s.clone()),
        Value::Array(a) => a.iter().find_map(|x| pick_target(x, kind)),
        Value::Object(o) => {
            for c in conditions(kind) {
                if let Some(x) = o.get(*c) {
                    if let Some(t) = pick_target(x, kind) {
                        return Some(t);
                    }
                }
            }
            None
        }
        _ => None,
    }
}

/// Entry for `subpath` ("." or "./x") from package.json, honouring `exports` then `main`.
fn pkg_entry(pkg: &Value, subpath: &str, kind: Kind) -> Option<String> {
    if let Some(exports) = pkg.get("exports") {
        // Sugar: exports is a string/array/conditions object for "."
        let is_subpath_map = exports.as_object().map(|o| o.keys().all(|k| k.starts_with('.'))).unwrap_or(false);
        if !is_subpath_map {
            return if subpath == "." { pick_target(exports, kind) } else { None };
        }
        let o = exports.as_object().unwrap();
        if let Some(v) = o.get(subpath) {
            return pick_target(v, kind);
        }
        // Pattern keys like "./*" or "./lib/*.js"
        for (k, v) in o {
            if let Some(star) = k.find('*') {
                let (pre, post) = (&k[..star], &k[star + 1..]);
                if subpath.starts_with(pre) && subpath.ends_with(post) && subpath.len() >= pre.len() + post.len() {
                    let m = &subpath[pre.len()..subpath.len() - post.len()];
                    if let Some(t) = pick_target(v, kind) {
                        return Some(t.replace('*', m));
                    }
                }
            }
        }
        return None;
    }
    if subpath == "." {
        if kind == Kind::Import {
            if let Some(m) = pkg.get("module").and_then(|v| v.as_str()) {
                return Some(m.to_string());
            }
        }
        if let Some(m) = pkg.get("main").and_then(|v| v.as_str()) {
            return Some(m.to_string());
        }
        return Some("./index.js".to_string());
    }
    Some(subpath.to_string())
}

fn split_bare(spec: &str) -> (&str, String) {
    let mut parts = spec.splitn(if spec.starts_with('@') { 3 } else { 2 }, '/');
    let name = if spec.starts_with('@') {
        let scope = parts.next().unwrap_or("");
        let n = parts.next().unwrap_or("");
        &spec[..scope.len() + 1 + n.len()]
    } else {
        parts.next().unwrap_or(spec)
    };
    let rest = &spec[name.len()..];
    let subpath = if rest.is_empty() { ".".to_string() } else { format!(".{rest}") };
    (name, subpath)
}

/// Canonical form used as the module identity (Node resolves symlinks by default too).
fn canonical(p: PathBuf) -> PathBuf {
    std::fs::canonicalize(&p).unwrap_or(p)
}

/// Resolve `spec` as seen from the file `referrer` (a path; its parent is the base dir).
pub fn resolve(spec: &str, referrer: &Path, kind: Kind) -> Result<Resolved, String> {
    resolve_inner(spec, referrer, kind).map(|r| match r {
        Resolved::File(p) => Resolved::File(canonical(p)),
        b => b,
    })
}

fn resolve_inner(spec: &str, referrer: &Path, kind: Kind) -> Result<Resolved, String> {
    if let Some(b) = builtin_name(spec) {
        return Ok(Resolved::Builtin(b.to_string()));
    }
    if spec.starts_with("node:") {
        return Err(format!("unknown builtin module {spec}"));
    }
    let base = referrer.parent().unwrap_or(Path::new("/"));
    if spec.starts_with("./") || spec.starts_with("../") || spec == "." || spec == ".." || spec.starts_with('/') {
        let p = if spec.starts_with('/') { PathBuf::from(spec) } else { base.join(spec) };
        return resolve_file_or_dir(&p, kind)
            .map(Resolved::File)
            .ok_or_else(|| format!("cannot find module '{spec}' from {}", referrer.display()));
    }
    if let Some(rest) = spec.strip_prefix("file://") {
        return resolve_file_or_dir(Path::new(rest), kind)
            .map(Resolved::File)
            .ok_or_else(|| format!("cannot find module '{spec}'"));
    }
    // Bare specifier: walk up node_modules.
    let (name, subpath) = split_bare(spec);
    let mut dir = Some(base);
    while let Some(d) = dir {
        let pkg_dir = d.join("node_modules").join(name);
        if pkg_dir.is_dir() {
            let pkg = read_pkg(&pkg_dir);
            let target = match &pkg {
                Some(p) => pkg_entry(p, &subpath, kind),
                None => Some(if subpath == "." { "./index.js".into() } else { subpath.clone() }),
            };
            if let Some(t) = target {
                let full = pkg_dir.join(t.trim_start_matches("./"));
                if let Some(f) = resolve_file_or_dir(&full, kind) {
                    return Ok(Resolved::File(f));
                }
            }
            return Err(format!("package '{name}' does not export '{subpath}'"));
        }
        dir = d.parent();
    }
    Err(format!("cannot find package '{name}' from {}", referrer.display()))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    Esm,
    Cjs,
    Json,
}

/// Decide how to load a file: extension first, then the nearest package.json `type`.
pub fn format_of(path: &Path) -> Format {
    match path.extension().and_then(|e| e.to_str()) {
        Some("json") => return Format::Json,
        Some("mjs" | "mts" | "ts" | "tsx") => return Format::Esm,
        Some("cjs" | "cts") => return Format::Cjs,
        _ => {}
    }
    let mut dir = path.parent();
    while let Some(d) = dir {
        if let Some(pkg) = read_pkg(d) {
            return if pkg.get("type").and_then(|v| v.as_str()) == Some("module") { Format::Esm } else { Format::Cjs };
        }
        dir = d.parent();
    }
    Format::Cjs
}

/// Does the source use ESM syntax? Used to run extension-less / package-less `.js`
/// written as ESM without forcing a package.json.
pub fn looks_like_esm(src: &str) -> bool {
    src.lines().any(|l| {
        let t = l.trim_start();
        t.starts_with("import ") || t.starts_with("import{") || t.starts_with("export ") || t.starts_with("export{") || t.starts_with("import(")
    }) && !src.contains("module.exports") && !src.contains("require(")
}

/// Cheap CommonJS named-export detection (a small subset of cjs-module-lexer).
pub fn cjs_named_exports(src: &str) -> Vec<String> {
    let mut names = std::collections::BTreeSet::new();
    let bytes = src.as_bytes();
    let is_ident = |c: u8| c.is_ascii_alphanumeric() || c == b'_' || c == b'$';
    let mut i = 0;
    while let Some(off) = src[i..].find("exports") {
        let s = i + off;
        let e = s + "exports".len();
        // module.exports.X = / exports.X =
        if e < bytes.len() && bytes[e] == b'.' {
            let mut j = e + 1;
            while j < bytes.len() && is_ident(bytes[j]) {
                j += 1;
            }
            let name = &src[e + 1..j];
            let mut k = j;
            while k < bytes.len() && bytes[k] == b' ' {
                k += 1;
            }
            if !name.is_empty() && k < bytes.len() && bytes[k] == b'=' && bytes.get(k + 1) != Some(&b'=') {
                names.insert(name.to_string());
            }
        }
        // module.exports = { a, b: x, c }
        if src[e..].trim_start().starts_with('=') && s >= 7 && src[..s].ends_with("module.") {
            let after = src[e..].trim_start()[1..].trim_start();
            if let Some(body) = after.strip_prefix('{') {
                if let Some(end) = body.find('}') {
                    for part in body[..end].split(',') {
                        let key = part.split(':').next().unwrap_or("").trim();
                        let key = key.strip_prefix("...").unwrap_or(key);
                        if !key.is_empty() && key.bytes().all(is_ident) && !key.as_bytes()[0].is_ascii_digit() {
                            names.insert(key.to_string());
                        }
                    }
                }
            }
        }
        i = e;
    }
    // Object.defineProperty(exports, "X"
    let mut i = 0;
    while let Some(off) = src[i..].find("defineProperty(exports,") {
        let s = i + off + "defineProperty(exports,".len();
        let rest = src[s..].trim_start();
        if let Some(q) = rest.chars().next().filter(|c| *c == '"' || *c == '\'') {
            if let Some(end) = rest[1..].find(q) {
                names.insert(rest[1..1 + end].to_string());
            }
        }
        i = s;
    }
    names.remove("default");
    names.remove("__esModule");
    names.into_iter().filter(|n| !n.is_empty()).collect()
}
