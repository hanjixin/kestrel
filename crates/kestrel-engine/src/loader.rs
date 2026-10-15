//! Module loader: file:// ESM, with on-the-fly TS/JSX stripping and JSON modules.

use std::path::PathBuf;

use deno_core::error::ModuleLoaderError;
use deno_core::{
    resolve_import, ModuleLoadOptions, ModuleLoadReferrer, ModuleLoadResponse, ModuleLoader,
    ModuleResolveResponse, ModuleSource, ModuleSourceCode, ModuleSpecifier, ModuleType,
    RequestedModuleType, ResolutionKind,
};
use deno_error::JsErrorBox;

use crate::transpile;

pub struct KestrelModuleLoader;

const RESOLVE_EXTS: &[&str] = &["ts", "tsx", "mts", "js", "mjs", "jsx", "cjs", "json"];

impl KestrelModuleLoader {
    /// Extensionless and directory imports: try the usual suffixes.
    fn probe(path: PathBuf) -> PathBuf {
        if path.is_file() {
            return path;
        }
        for ext in RESOLVE_EXTS {
            let p = path.with_extension(ext);
            if p.is_file() {
                return p;
            }
        }
        if path.is_dir() {
            for ext in RESOLVE_EXTS {
                let p = path.join(format!("index.{ext}"));
                if p.is_file() {
                    return p;
                }
            }
        }
        path
    }
}

impl ModuleLoader for KestrelModuleLoader {
    fn resolve(&self, specifier: &str, referrer: &str, _kind: ResolutionKind) -> ModuleResolveResponse {
        let url = resolve_import(specifier, referrer).map_err(JsErrorBox::from_err)?;
        if url.scheme() == "file" {
            if let Ok(path) = url.to_file_path() {
                let probed = Self::probe(path);
                if let Ok(u) = ModuleSpecifier::from_file_path(&probed) {
                    return Ok(u);
                }
            }
        }
        Ok(url)
    }

    fn load(
        &self,
        module_specifier: &ModuleSpecifier,
        _maybe_referrer: Option<&ModuleLoadReferrer>,
        options: ModuleLoadOptions,
    ) -> ModuleLoadResponse {
        fn inner(spec: &ModuleSpecifier, options: ModuleLoadOptions) -> Result<ModuleSource, ModuleLoaderError> {
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

            let code = if transpile::needs_transpile(&path) {
                transpile::transpile(&path, &code).map_err(|e| JsErrorBox::generic(e.to_string()))?
            } else {
                code
            };
            Ok(ModuleSource::new(ModuleType::JavaScript, ModuleSourceCode::String(code.into()), spec, None))
        }
        ModuleLoadResponse::Sync(inner(module_specifier, options))
    }
}
