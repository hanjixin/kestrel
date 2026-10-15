//! ESM → CommonJS rewrite so `require()` can load ES modules synchronously
//! (Node 22 `require(esm)` behaviour). Exports become live getters; imports
//! become `require` calls with the usual `__esModule` default interop.

use std::path::Path;

use anyhow::{anyhow, bail, Result};
use oxc_allocator::Allocator;
use oxc_ast::ast::*;
use oxc_parser::Parser;
use oxc_span::{GetSpan, SourceType};

fn export_name(n: &ModuleExportName<'_>) -> String {
    match n {
        ModuleExportName::IdentifierName(i) => i.name.to_string(),
        ModuleExportName::IdentifierReference(r) => r.name.to_string(),
        ModuleExportName::StringLiteral(s) => s.value.to_string(),
    }
}

fn q(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "\"\"".to_string())
}

fn getter(exported: &str, expr: &str) -> String {
    format!("Object.defineProperty(exports, {}, {{ enumerable: true, configurable: true, get: () => {expr} }});\n", q(exported))
}

fn binding_names<'a>(p: &BindingPattern<'a>, out: &mut Vec<String>) -> Result<()> {
    match p {
        BindingPattern::BindingIdentifier(id) => out.push(id.name.to_string()),
        _ => bail!("destructuring in `export const` is not supported by require(esm) yet"),
    }
    Ok(())
}

pub fn esm_to_cjs(path: &Path, src: &str) -> Result<String> {
    let allocator = Allocator::default();
    let mut st = SourceType::from_path(path).unwrap_or_default();
    st = st.with_module(true);
    let parsed = Parser::new(&allocator, src, st).parse();
    if !parsed.diagnostics.is_empty() {
        let msg = parsed.diagnostics.iter().map(|e| e.to_string()).collect::<Vec<_>>().join("\n");
        bail!("{}: {msg}", path.display());
    }
    let program = &parsed.program;

    let mut edits: Vec<(u32, u32, String)> = Vec::new();
    let mut trailer = String::new();
    let mut n = 0usize;
    let mut next = || {
        n += 1;
        format!("__kimp{n}")
    };

    for stmt in &program.body {
        let span = stmt.span();
        match stmt {
            Statement::ImportDeclaration(d) => {
                if d.import_kind.is_type() {
                    edits.push((span.start, span.end, String::new()));
                    continue;
                }
                let v = next();
                let mut s = format!("const {v} = require({});", q(&d.source.value));
                if let Some(specs) = &d.specifiers {
                    for sp in specs {
                        match sp {
                            ImportDeclarationSpecifier::ImportDefaultSpecifier(x) => {
                                s.push_str(&format!(" const {} = {v}.__esModule ? {v}.default : {v};", x.local.name));
                            }
                            ImportDeclarationSpecifier::ImportNamespaceSpecifier(x) => {
                                s.push_str(&format!(" const {} = {v}.__esModule ? {v} : Object.assign(Object.create(null), {v}, {{ default: {v} }});", x.local.name));
                            }
                            ImportDeclarationSpecifier::ImportSpecifier(x) => {
                                if x.import_kind.is_type() {
                                    continue;
                                }
                                let imported = export_name(&x.imported);
                                if imported == "default" {
                                    s.push_str(&format!(" const {} = {v}.__esModule ? {v}.default : {v};", x.local.name));
                                } else {
                                    s.push_str(&format!(" const {} = {v}[{}];", x.local.name, q(&imported)));
                                }
                            }
                        }
                    }
                }
                edits.push((span.start, span.end, s));
            }
            Statement::ExportDeclaration(d) => {
                // `export <decl>` → `<decl>` + getters
                let decl_start = d.declaration.span().start;
                edits.push((span.start, decl_start, String::new()));
                match &d.declaration {
                    Declaration::VariableDeclaration(vd) => {
                        let mut names = Vec::new();
                        for dcl in &vd.declarations {
                            binding_names(&dcl.id, &mut names)?;
                        }
                        for nm in names {
                            trailer.push_str(&getter(&nm, &nm));
                        }
                    }
                    Declaration::FunctionDeclaration(f) => {
                        if let Some(id) = &f.id {
                            trailer.push_str(&getter(id.name.as_str(), id.name.as_str()));
                        }
                    }
                    Declaration::ClassDeclaration(c) => {
                        if let Some(id) = &c.id {
                            trailer.push_str(&getter(id.name.as_str(), id.name.as_str()));
                        }
                    }
                    // TS-only declarations are erased by the transpiler before we get here.
                    _ => {}
                }
            }
            Statement::ExportNamedDeclaration(d) => {
                edits.push((span.start, span.end, String::new()));
                if d.export_kind.is_type() {
                    continue;
                }
                for sp in &d.specifiers {
                    if sp.export_kind.is_type() {
                        continue;
                    }
                    trailer.push_str(&getter(&export_name(&sp.exported), &export_name(&sp.local)));
                }
            }
            Statement::ExportFromDeclaration(d) => {
                let v = next();
                edits.push((span.start, span.end, format!("const {v} = require({});", q(&d.source.value))));
                if d.export_kind.is_type() {
                    continue;
                }
                for sp in &d.specifiers {
                    let local = export_name(&sp.local);
                    let expr = if local == "default" { format!("({v}.__esModule ? {v}.default : {v})") } else { format!("{v}[{}]", q(&local)) };
                    trailer.push_str(&getter(&export_name(&sp.exported), &expr));
                }
            }
            Statement::ExportAllDeclaration(d) => {
                let v = next();
                edits.push((span.start, span.end, format!("const {v} = require({});", q(&d.source.value))));
                if d.export_kind.is_type() {
                    continue;
                }
                match &d.exported {
                    Some(name) => trailer.push_str(&getter(&export_name(name), &v)),
                    None => trailer.push_str(&format!(
                        "for (const __k of Object.keys({v})) if (__k !== \"default\" && !Object.prototype.hasOwnProperty.call(exports, __k)) Object.defineProperty(exports, __k, {{ enumerable: true, configurable: true, get: () => {v}[__k] }});\n"
                    )),
                }
            }
            Statement::ExportDefaultDeclaration(d) => {
                let decl_start = d.declaration.span().start;
                match &d.declaration {
                    ExportDefaultDeclarationKind::FunctionDeclaration(f) if f.id.is_some() => {
                        edits.push((span.start, decl_start, String::new()));
                        trailer.push_str(&getter("default", f.id.as_ref().unwrap().name.as_str()));
                    }
                    ExportDefaultDeclarationKind::ClassDeclaration(c) if c.id.is_some() => {
                        edits.push((span.start, decl_start, String::new()));
                        trailer.push_str(&getter("default", c.id.as_ref().unwrap().name.as_str()));
                    }
                    _ => {
                        // Anonymous function/class or expression: assign directly.
                        edits.push((span.start, decl_start, "exports.default = ".to_string()));
                        // Make sure the statement is terminated (declarations have no `;`).
                        edits.push((span.end, span.end, ";".to_string()));
                    }
                }
            }
            _ => {}
        }
    }

    edits.sort_by(|a, b| b.0.cmp(&a.0).then(b.1.cmp(&a.1)));
    let mut out = src.to_string();
    for (s, e, rep) in edits {
        out.replace_range(s as usize..e as usize, &rep);
    }

    // import.meta
    if out.contains("import.meta") {
        let url = url::Url::from_file_path(path).map(|u| u.to_string()).map_err(|_| anyhow!("bad path"))?;
        let dir = path.parent().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
        let meta = format!(
            "const __kimport_meta = {{ url: {}, filename: {}, dirname: {}, main: false, resolve: (s) => require.resolve(s) }};\n",
            q(&url),
            q(&path.to_string_lossy()),
            q(&dir)
        );
        out = out.replace("import.meta", "__kimport_meta");
        out = meta + &out;
    }
    if out.contains("await ") && program.body.iter().any(|s| matches!(s, Statement::ExpressionStatement(e) if matches!(e.expression, Expression::AwaitExpression(_)))) {
        bail!("{}: top-level await cannot be required synchronously; use import()", path.display());
    }

    let mut result = String::with_capacity(out.len() + trailer.len() + 128);
    result.push_str("\"use strict\"; Object.defineProperty(exports, \"__esModule\", { value: true });\n");
    result.push_str(&out);
    result.push('\n');
    result.push_str(&trailer);
    Ok(result)
}
