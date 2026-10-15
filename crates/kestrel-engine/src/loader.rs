//! ES module loader with Node-style resolution. CommonJS files are loaded
//! through a generated ESM shim that calls the JS `require` machinery.

use std::path::{Path, PathBuf};

use deno_core::error::ModuleLoaderError;
use deno_core::{
    ModuleLoadOptions, ModuleLoadReferrer, ModuleLoadResponse, ModuleLoader, ModuleResolveResponse, ModuleSource,
    ModuleSourceCode, ModuleSpecifier, ModuleType, RequestedModuleType, ResolutionKind,
};
use deno_error::JsErrorBox;

use crate::resolve::{self, Format, Kind, Resolved};
use crate::transpile;

pub struct KestrelModuleLoader;

fn referrer_path(referrer: &str) -> PathBuf {
    if let Ok(u) = ModuleSpecifier::parse(referrer) {
        if let Ok(p) = u.to_file_path() {
            return p;
        }
    }
    std::env::current_dir().map(|d| d.join("__main__")).unwrap_or_else(|_| PathBuf::from("/__main__"))
}

impl ModuleLoader for KestrelModuleLoader {
    fn resolve(&self, specifier: &str, referrer: &str, _kind: ResolutionKind) -> ModuleResolveResponse {
        if specifier.starts_with("ext:") {
            return ModuleSpecifier::parse(specifier).map_err(|e| JsErrorBox::generic(e.to_string()));
        }
        // Builtins resolve to `node:<name>`; load() turns that into a re-export of the
        // snapshotted ext: module (user code may not import ext: directly).
        if let Some(b) = resolve::builtin_name(specifier) {
            return ModuleSpecifier::parse(&format!("node:{b}")).map_err(|e| JsErrorBox::generic(e.to_string()));
        }
        // Absolute URLs other than file: pass through (data:, blob:, http: are unsupported downstream).
        if let Ok(u) = ModuleSpecifier::parse(specifier) {
            if u.scheme() != "file" {
                return Ok(u);
            }
        }
        let base = referrer_path(referrer);
        match resolve::resolve(specifier, &base, Kind::Import) {
            Ok(Resolved::Builtin(b)) => ModuleSpecifier::parse(&format!("node:{b}")).map_err(|e| JsErrorBox::generic(e.to_string())),
            Ok(Resolved::File(p)) => ModuleSpecifier::from_file_path(&p).map_err(|_| JsErrorBox::generic("bad path")),
            Err(msg) => Err(JsErrorBox::new("Error", format!("Cannot find module '{specifier}' imported from '{}'\n  {msg}", base.display()))),
        }
    }

    fn load(
        &self,
        module_specifier: &ModuleSpecifier,
        _maybe_referrer: Option<&ModuleLoadReferrer>,
        options: ModuleLoadOptions,
    ) -> ModuleLoadResponse {
        ModuleLoadResponse::Sync(load_inner(module_specifier, options))
    }
}

fn load_inner(spec: &ModuleSpecifier, options: ModuleLoadOptions) -> Result<ModuleSource, ModuleLoaderError> {
    if spec.scheme() == "node" {
        let name = spec.path();
        let ext = resolve::builtin_url(name);
        let code = format!("export * from \"{ext}\";\nexport {{ default }} from \"{ext}\";\n");
        return Ok(ModuleSource::new(ModuleType::JavaScript, ModuleSourceCode::String(code.into()), spec, None));
    }
    let path = spec
        .to_file_path()
        .map_err(|_| JsErrorBox::generic(format!("only file:// modules are supported, got {spec}")))?;
    let code = std::fs::read_to_string(&path)
        .map_err(|e| JsErrorBox::generic(format!("cannot read {}: {e}", path.display())))?;

    let is_json = path.extension().and_then(|e| e.to_str()) == Some("json")
        || options.requested_module_type == RequestedModuleType::Json;
    if is_json {
        return Ok(ModuleSource::new(ModuleType::Json, ModuleSourceCode::String(code.into()), spec, None));
    }

    let format = match resolve::format_of(&path) {
        Format::Cjs if resolve::looks_like_esm(&code) => Format::Esm,
        f => f,
    };

    let js = match format {
        Format::Cjs => cjs_shim(&path, &code),
        _ => esm_source(&path, code)?,
    };
    Ok(ModuleSource::new(ModuleType::JavaScript, ModuleSourceCode::String(js.into()), spec, None))
}

/// ESM shim for a CommonJS file: evaluate via require(), re-export default + detected names.
fn cjs_shim(path: &Path, code: &str) -> String {
    let names = resolve::cjs_named_exports(code);
    let p = serde_json::to_string(&path.to_string_lossy()).unwrap_or_else(|_| "\"\"".into());
    let mut s = format!("const __m = globalThis[Symbol.for(\"kestrel.require\")]({p});\nexport default __m;\n");
    for n in names {
        if is_ident(&n) && n != "default" {
            s.push_str(&format!("export const {n} = __m[{q}];\n", q = serde_json::to_string(&n).unwrap()));
        }
    }
    s
}

fn is_ident(s: &str) -> bool {
    let mut cs = s.chars();
    match cs.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' || c == '$' => {}
        _ => return false,
    }
    if !cs.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$') {
        return false;
    }
    !matches!(
        s,
        "await" | "break" | "case" | "catch" | "class" | "const" | "continue" | "debugger" | "default" | "delete" | "do"
            | "else" | "enum" | "export" | "extends" | "false" | "finally" | "for" | "function" | "if" | "import" | "in"
            | "instanceof" | "new" | "null" | "return" | "super" | "switch" | "this" | "throw" | "true" | "try"
            | "typeof" | "var" | "void" | "while" | "with" | "yield" | "let" | "static" | "implements" | "interface"
            | "package" | "private" | "protected" | "public"
    )
}

/// TS stripping plus the native tier for ESM sources.
fn esm_source(path: &Path, code: String) -> Result<String, ModuleLoaderError> {
    if !transpile::needs_transpile(path) {
        return Ok(code);
    }
    let aot_enabled = std::env::var("KESTREL_AOT").map(|v| v != "0").unwrap_or(true);
    let in_node_modules = path.components().any(|c| c.as_os_str() == "node_modules");
    if !aot_enabled || in_node_modules {
        return transpile::transpile(path, &code).map_err(|e| JsErrorBox::generic(e.to_string()));
    }
    let log = std::env::var("KESTREL_AOT_LOG").is_ok();
    let out = kestrel_aot::process(path, &code).map_err(|e| JsErrorBox::generic(e.to_string()))?;
    if log {
        for c in &out.compiled {
            eprintln!("[aot] {}: compiled {}/{} -> native #{}", path.display(), c.name, c.arity, c.index);
        }
        for (n, why) in &out.rejected {
            eprintln!("[aot] {}: kept {} on V8: {}", path.display(), n, why);
        }
    }
    let js = transpile::transpile(path, &out.source).map_err(|e| JsErrorBox::generic(e.to_string()))?;
    if out.compiled.is_empty() {
        return Ok(js);
    }
    let mut s = String::with_capacity(js.len() + out.prologue.len() + out.epilogue.len() + 2);
    if js.starts_with("#!") {
        let nl = js.find('\n').unwrap_or(js.len());
        s.push_str(&js[..nl]);
        s.push('\n');
        s.push_str(&out.prologue);
        s.push_str(&js[nl..]);
    } else {
        s.push_str(&out.prologue);
        s.push('\n');
        s.push_str(&js);
    }
    s.push_str(&out.epilogue);
    s.push('\n');
    Ok(s)
}
