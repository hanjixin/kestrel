//! Tier 1: ahead-of-time native compilation of the statically-typed numeric
//! subset of a TypeScript module. Everything that is not provably in the subset
//! stays on V8; compiled functions are reached through a guard that falls back
//! to the original JS when an argument is not a number, so observable
//! behaviour is unchanged for every input.

pub mod codegen;
pub mod registry;

use std::path::Path;

use anyhow::{anyhow, Result};
use oxc_allocator::Allocator;
use oxc_ast::ast::*;
use oxc_ast_visit::Visit;
use oxc_parser::Parser;
use oxc_span::{SourceType, Span};

pub struct Candidate<'a> {
    pub name: String,
    pub arity: usize,
    pub func: &'a Function<'a>,
    pub id_span: Span,
    /// Span covering `export ` (start of the export statement to start of `function`).
    pub export_prefix: Option<(u32, u32)>,
    pub param_names: Vec<String>,
}

pub struct CompiledInfo {
    pub name: String,
    pub arity: usize,
    pub index: u32,
}

pub struct AotOutput {
    /// Original source with compiled functions renamed to `__kestrel_js_<name>`.
    pub source: String,
    /// JS to prepend (ops binding). Contains no imports.
    pub prologue: String,
    /// JS to append: guarded wrappers that dispatch to native code.
    pub epilogue: String,
    pub compiled: Vec<CompiledInfo>,
    pub rejected: Vec<(String, String)>,
}

fn is_number(t: &Option<oxc_allocator::Box<'_, TSTypeAnnotation<'_>>>) -> bool {
    matches!(t.as_deref().map(|a| &a.type_annotation), Some(TSType::TSNumberKeyword(_)))
}

/// Conservative "every path returns" check.
fn always_returns(stmts: &[Statement<'_>]) -> bool {
    stmts.last().is_some_and(stmt_returns)
}
fn stmt_returns(s: &Statement<'_>) -> bool {
    match s {
        Statement::ReturnStatement(_) => true,
        Statement::BlockStatement(b) => always_returns(&b.body),
        Statement::IfStatement(i) => {
            stmt_returns(&i.consequent) && i.alternate.as_ref().is_some_and(stmt_returns)
        }
        _ => false,
    }
}

/// Collects identifiers that are assignment targets anywhere in the module.
#[derive(Default)]
struct AssignedNames(std::collections::HashSet<String>);
impl<'a> Visit<'a> for AssignedNames {
    fn visit_assignment_target(&mut self, t: &AssignmentTarget<'a>) {
        if let AssignmentTarget::AssignmentTargetIdentifier(id) = t {
            self.0.insert(id.name.to_string());
        }
        oxc_ast_visit::walk::walk_assignment_target(self, t);
    }
    fn visit_simple_assignment_target(&mut self, t: &SimpleAssignmentTarget<'a>) {
        if let SimpleAssignmentTarget::AssignmentTargetIdentifier(id) = t {
            self.0.insert(id.name.to_string());
        }
        oxc_ast_visit::walk::walk_simple_assignment_target(self, t);
    }
}

fn candidate<'a>(f: &'a Function<'a>, export_prefix: Option<(u32, u32)>) -> Result<Candidate<'a>, (String, String)> {
    let id = match &f.id {
        Some(id) => id,
        None => return Err(("<anonymous>".into(), "anonymous".into())),
    };
    let name = id.name.to_string();
    let reject = |why: &str| Err((name.clone(), why.to_string()));
    if f.r#async || f.generator || f.declare {
        return reject("async/generator");
    }
    if f.params.rest.is_some() || f.params.items.len() > registry::MAX_ARITY {
        return reject("rest params or too many params");
    }
    let mut param_names = Vec::new();
    for p in &f.params.items {
        if p.optional || p.initializer.is_some() {
            return reject("optional/default param");
        }
        if !is_number(&p.type_annotation) {
            return reject("param not annotated `: number`");
        }
        match codegen::param_name(p) {
            Some(n) => param_names.push(n.to_string()),
            None => return reject("destructured param"),
        }
    }
    if !is_number(&f.return_type) {
        return reject("return type not annotated `: number`");
    }
    let body = match &f.body {
        Some(b) => b,
        None => return reject("no body"),
    };
    if !always_returns(&body.statements) {
        return reject("not every path returns");
    }
    Ok(Candidate { name, arity: param_names.len(), func: f, id_span: id.span, export_prefix, param_names })
}

pub fn process(path: &Path, source: &str) -> Result<AotOutput> {
    let allocator = Allocator::default();
    let source_type = SourceType::from_path(path).map_err(|e| anyhow!("{e:?}"))?;
    let parsed = Parser::new(&allocator, source, source_type).parse();
    if !parsed.diagnostics.is_empty() {
        // Let the normal transpile path report syntax errors.
        return Ok(AotOutput { source: source.to_string(), prologue: String::new(), epilogue: String::new(), compiled: vec![], rejected: vec![] });
    }
    let program = &parsed.program;

    let mut assigned = AssignedNames::default();
    assigned.visit_program(program);

    let mut cands: Vec<Candidate<'_>> = Vec::new();
    let mut rejected: Vec<(String, String)> = Vec::new();
    for s in &program.body {
        let (f, export_prefix) = match s {
            Statement::FunctionDeclaration(f) => (&**f, None),
            Statement::ExportDeclaration(ed) => match &ed.declaration {
                Declaration::FunctionDeclaration(f) => (&**f, Some((ed.span.start, f.span.start))),
                _ => continue,
            },
            _ => continue,
        };
        match candidate(f, export_prefix) {
            Ok(c) => {
                if assigned.0.contains(&c.name) {
                    rejected.push((c.name.clone(), "function binding is reassigned".into()));
                } else {
                    cands.push(c);
                }
            }
            Err(r) => rejected.push(r),
        }
    }

    // Fixpoint: compile; drop whatever fails; retry until a round has no failures.
    let mut compiled: Vec<codegen::Compiled> = Vec::new();
    while !cands.is_empty() {
        let backend = codegen::Backend::new()?;
        match backend.compile_all_lenient(&cands) {
            Ok(out) => {
                compiled = out;
                break;
            }
            Err(failures) => {
                for (name, why) in failures {
                    cands.retain(|c| c.name != name);
                    rejected.push((name, why));
                }
            }
        }
    }

    // Source edits (apply back to front so spans stay valid).
    let mut edits: Vec<(u32, u32, String)> = Vec::new();
    for c in &cands {
        edits.push((c.id_span.start, c.id_span.end, format!("__kestrel_js_{}", c.name)));
        if let Some((s, e)) = c.export_prefix {
            edits.push((s, e, String::new()));
        }
    }
    edits.sort_by(|a, b| b.0.cmp(&a.0));
    let mut src = source.to_string();
    for (s, e, rep) in edits {
        src.replace_range(s as usize..e as usize, &rep);
    }

    let mut prologue = String::from("const __kestrel_ops = Deno.core.ops;");
    let mut epilogue = String::new();
    let mut infos = Vec::new();
    for c in &cands {
        let cc = compiled.iter().find(|x| x.name == c.name).unwrap();
        let index = registry::register(cc.ptr);
        let params = c.param_names.join(", ");
        let guard = c
            .param_names
            .iter()
            .map(|p| format!("typeof {p} === \"number\""))
            .collect::<Vec<_>>()
            .join(" && ");
        let guard = if guard.is_empty() { "true".to_string() } else { guard };
        let export = if c.export_prefix.is_some() { "export " } else { "" };
        let args = if params.is_empty() { String::new() } else { format!(", {params}") };
        epilogue.push_str(&format!(
            "\n{export}function {name}({params}) {{ if ({guard}) return __kestrel_ops.op_kestrel_call{arity}({index}{args}); return __kestrel_js_{name}({params}); }}",
            name = c.name,
            arity = c.arity,
        ));
        infos.push(CompiledInfo { name: c.name.clone(), arity: c.arity, index });
    }
    if infos.is_empty() {
        prologue.clear();
    }
    Ok(AotOutput { source: src, prologue, epilogue, compiled: infos, rejected })
}
