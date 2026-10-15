//! TypeScript / JSX stripping with oxc. Type erasure only — no type checking.

use std::path::Path;

use anyhow::{anyhow, Result};
use oxc_allocator::Allocator;
use oxc_codegen::{Codegen, CodegenOptions};
use oxc_parser::Parser;
use oxc_semantic::SemanticBuilder;
use oxc_span::SourceType;
use oxc_transformer::{TransformOptions, Transformer};

/// Returns true when the file needs a transpile pass before V8 can load it.
pub fn needs_transpile(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|e| e.to_str()),
        Some("ts" | "tsx" | "mts" | "cts" | "jsx")
    )
}

/// Strip types (and lower JSX) from `source`, returning plain ESNext JavaScript.
pub fn transpile(path: &Path, source: &str) -> Result<String> {
    let allocator = Allocator::default();
    let source_type = SourceType::from_path(path)
        .map_err(|e| anyhow!("unknown source type for {}: {e:?}", path.display()))?;

    let parsed = Parser::new(&allocator, source, source_type).parse();
    if !parsed.diagnostics.is_empty() {
        let msg = parsed
            .diagnostics
            .iter()
            .map(|e| e.to_string())
            .collect::<Vec<_>>()
            .join("\n");
        return Err(anyhow!("parse error in {}:\n{msg}", path.display()));
    }
    let mut program = parsed.program;

    let semantic = SemanticBuilder::new()
        .with_excess_capacity(2.0)
        .with_enum_eval(true)
        .build(&program);
    if !semantic.diagnostics.is_empty() {
        let msg = semantic
            .diagnostics
            .iter()
            .map(|e| e.to_string())
            .collect::<Vec<_>>()
            .join("\n");
        return Err(anyhow!("semantic error in {}:\n{msg}", path.display()));
    }
    let scoping = semantic.semantic.into_scoping();

    let options = TransformOptions::default();
    let ret = Transformer::new(&allocator, path, &options).build_with_scoping(scoping, &mut program);
    if !ret.diagnostics.is_empty() {
        let msg = ret
            .diagnostics
            .iter()
            .map(|e| e.to_string())
            .collect::<Vec<_>>()
            .join("\n");
        return Err(anyhow!("transform error in {}:\n{msg}", path.display()));
    }

    let out = Codegen::new()
        .with_options(CodegenOptions::default())
        .build(&program);
    Ok(out.code)
}
