//! Cranelift code generation for the numeric subset.
//!
//! Semantics are JavaScript's, exactly: every `number` is an IEEE-754 f64,
//! comparisons are ordered (NaN compares false), bitwise ops go through
//! ToInt32/ToUint32, `%` is fmod, `**` is pow.

use std::collections::HashMap;

use anyhow::{anyhow, bail, Result};
use cranelift_codegen::ir::condcodes::{FloatCC, IntCC};
use cranelift_codegen::ir::{types, AbiParam, Block, FuncRef, InstBuilder, Signature, Type, Value};
use cranelift_codegen::settings::{self, Configurable};
use cranelift_frontend::{FunctionBuilder, FunctionBuilderContext, Variable};
use cranelift_jit::{JITBuilder, JITModule};
use cranelift_module::{FuncId, Linkage, Module};
use oxc_ast::ast::*;
use oxc_syntax::operator::{AssignmentOperator, BinaryOperator, LogicalOperator, UnaryOperator, UpdateOperator};

use crate::Candidate;

// ---------- runtime helpers reachable from generated code ----------
extern "C" fn k_fmod(a: f64, b: f64) -> f64 { a % b }
extern "C" fn k_pow(a: f64, b: f64) -> f64 { a.powf(b) }
extern "C" fn k_sin(a: f64) -> f64 { a.sin() }
extern "C" fn k_cos(a: f64) -> f64 { a.cos() }
extern "C" fn k_tan(a: f64) -> f64 { a.tan() }
extern "C" fn k_atan(a: f64) -> f64 { a.atan() }
extern "C" fn k_atan2(a: f64, b: f64) -> f64 { a.atan2(b) }
extern "C" fn k_exp(a: f64) -> f64 { a.exp() }
extern "C" fn k_log(a: f64) -> f64 { a.ln() }
extern "C" fn k_log2(a: f64) -> f64 { a.log2() }
extern "C" fn k_log10(a: f64) -> f64 { a.log10() }
/// JS Math.round: round half toward +Infinity.
extern "C" fn k_round(a: f64) -> f64 {
    if !a.is_finite() { return a; }
    let f = a.floor();
    let r = if a - f >= 0.5 { f + 1.0 } else { f };
    if r == 0.0 && a < 0.0 { -0.0 } else { r }
}
/// ECMAScript ToInt32 for the slow path (|x| >= 2^63).
extern "C" fn k_to_int32_slow(a: f64) -> i32 {
    if !a.is_finite() { return 0; }
    let m = a.trunc().rem_euclid(4294967296.0);
    (m as u64) as u32 as i32
}

const HELPERS: &[(&str, *const u8, usize)] = &[
    ("k_fmod", k_fmod as *const u8, 2),
    ("k_pow", k_pow as *const u8, 2),
    ("k_sin", k_sin as *const u8, 1),
    ("k_cos", k_cos as *const u8, 1),
    ("k_tan", k_tan as *const u8, 1),
    ("k_atan", k_atan as *const u8, 1),
    ("k_atan2", k_atan2 as *const u8, 2),
    ("k_exp", k_exp as *const u8, 1),
    ("k_log", k_log as *const u8, 1),
    ("k_log2", k_log2 as *const u8, 1),
    ("k_log10", k_log10 as *const u8, 1),
    ("k_round", k_round as *const u8, 1),
];

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Ty {
    Num,  // f64
    Bool, // i8 (0/1)
}

#[derive(Clone, Copy)]
struct TVal {
    ty: Ty,
    v: Value,
}

pub struct Compiled {
    pub name: String,
    pub arity: usize,
    pub ptr: *const u8,
}

pub struct Backend {
    module: JITModule,
    helpers: HashMap<&'static str, FuncId>,
    to_int32_slow: FuncId,
    depth_data: cranelift_module::DataId,
    overflow_data: cranelift_module::DataId,
}

impl Backend {
    pub fn new() -> Result<Self> {
        let mut flags = settings::builder();
        flags.set("use_colocated_libcalls", "false")?;
        flags.set("is_pic", "false")?;
        flags.set("opt_level", "speed")?;
        let isa = cranelift_native::builder()
            .map_err(|m| anyhow!("host not supported: {m}"))?
            .finish(settings::Flags::new(flags))?;
        let mut jb = JITBuilder::with_isa(isa, cranelift_module::default_libcall_names());
        for (name, ptr, _) in HELPERS {
            jb.symbol(*name, *ptr);
        }
        jb.symbol("k_to_int32_slow", k_to_int32_slow as *const u8);
        jb.symbol("K_STACK_LIMIT", std::ptr::addr_of!(crate::registry::K_STACK_LIMIT) as *const u8);
        jb.symbol("K_OVERFLOW", std::ptr::addr_of!(crate::registry::K_OVERFLOW) as *const u8);
        let mut module = JITModule::new(jb);
        let depth_data = module.declare_data("K_STACK_LIMIT", Linkage::Import, true, false)?;
        let overflow_data = module.declare_data("K_OVERFLOW", Linkage::Import, true, false)?;

        let mut helpers = HashMap::new();
        for (name, _, arity) in HELPERS {
            let mut sig = module.make_signature();
            for _ in 0..*arity {
                sig.params.push(AbiParam::new(types::F64));
            }
            sig.returns.push(AbiParam::new(types::F64));
            let id = module.declare_function(name, Linkage::Import, &sig)?;
            helpers.insert(*name, id);
        }
        let mut sig = module.make_signature();
        sig.params.push(AbiParam::new(types::F64));
        sig.returns.push(AbiParam::new(types::I32));
        let to_int32_slow = module.declare_function("k_to_int32_slow", Linkage::Import, &sig)?;

        Ok(Self { module, helpers, to_int32_slow, depth_data, overflow_data })
    }

    fn num_sig(&self, arity: usize) -> Signature {
        let mut sig = self.module.make_signature();
        for _ in 0..arity {
            sig.params.push(AbiParam::new(types::F64));
        }
        sig.returns.push(AbiParam::new(types::F64));
        sig
    }

    /// Compile all candidates. If any function body falls outside the subset,
    /// returns the failures instead so the caller can retry without them.
    pub fn compile_all_lenient<'a>(self, cands: &[Candidate<'a>]) -> std::result::Result<Vec<Compiled>, Vec<(String, String)>> {
        let mut failures = Vec::new();
        let r = self.compile_all(cands, &mut failures);
        if !failures.is_empty() {
            return Err(failures);
        }
        match r {
            Ok(v) => Ok(v),
            Err(e) => Err(cands.iter().map(|c| (c.name.clone(), format!("backend: {e}"))).collect()),
        }
    }

    fn compile_all<'a>(mut self, cands: &[Candidate<'a>], failures: &mut Vec<(String, String)>) -> Result<Vec<Compiled>> {
        // Declare first so mutual recursion resolves.
        let mut ids: HashMap<String, (FuncId, usize)> = HashMap::new();
        for c in cands {
            let sig = self.num_sig(c.arity);
            let id = self.module.declare_function(&format!("js_{}", c.name), Linkage::Local, &sig)?;
            ids.insert(c.name.to_string(), (id, c.arity));
        }

        let mut fb_ctx = FunctionBuilderContext::new();
        for c in cands {
            let (id, _) = ids[c.name.as_str()];
            let mut ctx = self.module.make_context();
            ctx.func.signature = self.num_sig(c.arity);
            let mut b = FunctionBuilder::new(&mut ctx.func, &mut fb_ctx);
            let built: Result<()> = (|| {
                let entry = b.create_block();
                b.append_block_params_for_function_params(entry);
                b.switch_to_block(entry);
                b.seal_block(entry);

                let depth_gv = self.module.declare_data_in_func(self.depth_data, b.func);
                let overflow_gv = self.module.declare_data_in_func(self.overflow_data, b.func);
                let mut fc: FnCx<'_, 'a, '_> = FnCx {
                    _p: std::marker::PhantomData,
                    depth_gv,
                    overflow_gv,
                    b: &mut b,
                    module: &mut self.module,
                    fn_ids: &ids,
                    helpers: &self.helpers,
                    to_int32_slow: self.to_int32_slow,
                    scopes: vec![HashMap::new()],
                    loops: vec![],
                    func_refs: HashMap::new(),
                    helper_refs: HashMap::new(),
                    slow_ref: None,
                };
                for (i, p) in c.func.params.items.iter().enumerate() {
                    let name = param_name(p).ok_or_else(|| anyhow!("param pattern"))?;
                    let var = fc.b.declare_var(types::F64);
                    let pv = fc.b.block_params(entry)[i];
                    fc.b.def_var(var, pv);
                    fc.scopes[0].insert(name.to_string(), (var, Ty::Num));
                }
                fc.enter_frame();
                let body = c.func.body.as_ref().ok_or_else(|| anyhow!("no body"))?;
                let terminated = fc.stmts(&body.statements)?;
                if !terminated {
                    // `check` guarantees all paths return; keep the IR well-formed anyway.
                    let nan = fc.b.ins().f64const(f64::NAN);
                    fc.ret(nan);
                }
                fc.b.seal_all_blocks();
                Ok(())
            })();
            b.finalize(self.module.target_config());
            if let Err(e) = built {
                failures.push((c.name.clone(), e.to_string()));
                continue;
            }
            self.module
                .define_function(id, &mut ctx)
                .map_err(|e| anyhow!("cranelift define {}: {e}", c.name))?;
            self.module.clear_context(&mut ctx);
        }
        if !failures.is_empty() {
            return Ok(vec![]);
        }
        self.module.finalize_definitions()?;

        let out = cands
            .iter()
            .map(|c| {
                let (id, arity) = ids[c.name.as_str()];
                Compiled { name: c.name.to_string(), arity, ptr: self.module.get_finalized_function(id) }
            })
            .collect();
        // Keep the JIT memory alive for the life of the process.
        std::mem::forget(self.module);
        Ok(out)
    }
}

pub fn param_name<'a>(p: &'a FormalParameter<'a>) -> Option<&'a str> {
    match &p.pattern {
        BindingPattern::BindingIdentifier(id) => Some(id.name.as_str()),
        _ => None,
    }
}

struct LoopCx {
    continue_block: Block,
    break_block: Block,
}

struct FnCx<'x, 'a, 'b> {
    _p: std::marker::PhantomData<&'a ()>,
    b: &'x mut FunctionBuilder<'b>,
    module: &'x mut JITModule,
    fn_ids: &'x HashMap<String, (FuncId, usize)>,
    helpers: &'x HashMap<&'static str, FuncId>,
    to_int32_slow: FuncId,
    scopes: Vec<HashMap<String, (Variable, Ty)>>,
    loops: Vec<LoopCx>,
    func_refs: HashMap<String, FuncRef>,
    helper_refs: HashMap<&'static str, FuncRef>,
    slow_ref: Option<FuncRef>,
    depth_gv: cranelift_codegen::ir::GlobalValue,
    overflow_gv: cranelift_codegen::ir::GlobalValue,
}

impl<'x, 'a, 'b> FnCx<'x, 'a, 'b> {
    fn lookup(&self, name: &str) -> Option<(Variable, Ty)> {
        for s in self.scopes.iter().rev() {
            if let Some(v) = s.get(name) {
                return Some(*v);
            }
        }
        None
    }

    fn declare(&mut self, name: &str, ty: Ty) -> Variable {
        let var = self.b.declare_var(clif_ty(ty));
        self.scopes.last_mut().unwrap().insert(name.to_string(), (var, ty));
        var
    }

    fn func_ref(&mut self, name: &str) -> FuncRef {
        if let Some(r) = self.func_refs.get(name) {
            return *r;
        }
        let (id, _) = self.fn_ids[name];
        let r = self.module.declare_func_in_func(id, self.b.func);
        self.func_refs.insert(name.to_string(), r);
        r
    }

    fn helper_ref(&mut self, name: &'static str) -> FuncRef {
        if let Some(r) = self.helper_refs.get(name) {
            return *r;
        }
        let id = self.helpers[name];
        let r = self.module.declare_func_in_func(id, self.b.func);
        self.helper_refs.insert(name, r);
        r
    }

    fn call_helper(&mut self, name: &'static str, args: &[Value]) -> Value {
        let r = self.helper_ref(name);
        let call = self.b.ins().call(r, args);
        self.b.inst_results(call)[0]
    }

    // ---------- frame accounting (JS-compatible RangeError on deep recursion) ----------

    /// Stack check: if SP is below K_STACK_LIMIT, flag overflow, pin the limit so
    /// every frame above us bails too (O(depth) unwind like a JS RangeError), return NaN.
    fn enter_frame(&mut self) {
        let ptr_ty = self.module.target_config().pointer_type();
        let sp = self.b.ins().get_stack_pointer(ptr_ty);
        let lp = self.b.ins().symbol_value(ptr_ty, self.depth_gv);
        let lim = self.b.ins().load(ptr_ty, cranelift_codegen::ir::MemFlagsData::trusted(), lp, 0);
        let ok = self.b.ins().icmp(IntCC::UnsignedGreaterThan, sp, lim);
        let bail_b = self.b.create_block();
        let cont = self.b.create_block();
        self.b.ins().brif(ok, cont, &[], bail_b, &[]);
        self.b.switch_to_block(bail_b);
        self.b.seal_block(bail_b);
        self.b.set_cold_block(bail_b);
        let op = self.b.ins().symbol_value(ptr_ty, self.overflow_gv);
        let one = self.b.ins().iconst(types::I32, 1);
        self.b.ins().store(cranelift_codegen::ir::MemFlagsData::trusted(), one, op, 0);
        let pinned = self.b.ins().iconst(ptr_ty, -1);
        self.b.ins().store(cranelift_codegen::ir::MemFlagsData::trusted(), pinned, lp, 0);
        let nan = self.b.ins().f64const(f64::NAN);
        self.b.ins().return_(&[nan]);
        self.b.switch_to_block(cont);
        self.b.seal_block(cont);
    }

    fn ret(&mut self, v: Value) {
        self.b.ins().return_(&[v]);
    }

    /// JS `%` on numbers. Fast path: both operands are integers with |x| < 2^53 and the
    /// divisor is non-zero -> integer remainder with the dividend's sign (incl. -0).
    /// Otherwise fmod via libm.
    fn js_rem(&mut self, a: Value, b: Value) -> Value {
        let fast = self.b.create_block();
        let slow = self.b.create_block();
        let merge = self.b.create_block();
        self.b.append_block_param(merge, types::F64);

        let ai = self.b.ins().fcvt_to_sint_sat(types::I64, a);
        let bi = self.b.ins().fcvt_to_sint_sat(types::I64, b);
        let af = self.b.ins().fcvt_from_sint(types::F64, ai);
        let bf = self.b.ins().fcvt_from_sint(types::F64, bi);
        let a_int = self.b.ins().fcmp(FloatCC::Equal, af, a);
        let b_int = self.b.ins().fcmp(FloatCC::Equal, bf, b);
        let lim = self.b.ins().f64const(9007199254740992.0);
        let aa = self.b.ins().fabs(a);
        let ab = self.b.ins().fabs(b);
        let a_small = self.b.ins().fcmp(FloatCC::LessThan, aa, lim);
        let b_small = self.b.ins().fcmp(FloatCC::LessThan, ab, lim);
        let b_nz = self.b.ins().icmp_imm_s(IntCC::NotEqual, bi, 0);
        let c1 = self.b.ins().band(a_int, b_int);
        let c2 = self.b.ins().band(a_small, b_small);
        let c3 = self.b.ins().band(c1, c2);
        let cond = self.b.ins().band(c3, b_nz);
        self.b.ins().brif(cond, fast, &[], slow, &[]);

        self.b.switch_to_block(fast);
        self.b.seal_block(fast);
        let r = self.b.ins().srem(ai, bi);
        let rf = self.b.ins().fcvt_from_sint(types::F64, r);
        let rs = self.b.ins().fcopysign(rf, a);
        self.b.ins().jump(merge, &[rs.into()]);

        self.b.switch_to_block(slow);
        self.b.seal_block(slow);
        let sv = self.call_helper("k_fmod", &[a, b]);
        self.b.ins().jump(merge, &[sv.into()]);

        self.b.switch_to_block(merge);
        self.b.seal_block(merge);
        self.b.block_params(merge)[0]
    }

    // ---------- statements ----------

    /// Returns true if control flow is terminated (return/break/continue) after these statements.
    fn stmts(&mut self, stmts: &[Statement<'a>]) -> Result<bool> {
        for s in stmts {
            if self.stmt(s)? {
                return Ok(true);
            }
        }
        Ok(false)
    }

    fn stmt(&mut self, s: &Statement<'a>) -> Result<bool> {
        match s {
            Statement::EmptyStatement(_) => Ok(false),
            Statement::BlockStatement(bs) => {
                self.scopes.push(HashMap::new());
                let t = self.stmts(&bs.body);
                self.scopes.pop();
                t
            }
            Statement::VariableDeclaration(vd) => {
                self.var_decl(vd)?;
                Ok(false)
            }
            Statement::ExpressionStatement(es) => {
                self.expr(&es.expression)?;
                Ok(false)
            }
            Statement::ReturnStatement(rs) => {
                let arg = rs.argument.as_ref().ok_or_else(|| anyhow!("bare return"))?;
                let v = self.expr(arg)?;
                let v = self.to_num(v);
                self.ret(v);
                Ok(true)
            }
            Statement::IfStatement(is) => {
                let cond = self.expr(&is.test)?;
                let cond = self.to_bool(cond);
                let then_b = self.b.create_block();
                let else_b = self.b.create_block();
                let merge = self.b.create_block();
                self.b.ins().brif(cond, then_b, &[], else_b, &[]);

                self.b.switch_to_block(then_b);
                self.b.seal_block(then_b);
                self.scopes.push(HashMap::new());
                let t1 = self.stmt(&is.consequent)?;
                self.scopes.pop();
                if !t1 {
                    self.b.ins().jump(merge, &[]);
                }

                self.b.switch_to_block(else_b);
                self.b.seal_block(else_b);
                let t2 = match &is.alternate {
                    Some(alt) => {
                        self.scopes.push(HashMap::new());
                        let t = self.stmt(alt)?;
                        self.scopes.pop();
                        t
                    }
                    None => false,
                };
                if !t2 {
                    self.b.ins().jump(merge, &[]);
                }

                self.b.switch_to_block(merge);
                self.b.seal_block(merge);
                if t1 && t2 {
                    // merge is unreachable; give it a terminator so the IR validates.
                    let nan = self.b.ins().f64const(f64::NAN);
                    self.ret(nan);
                    return Ok(true);
                }
                Ok(false)
            }
            Statement::WhileStatement(ws) => {
                let header = self.b.create_block();
                let body = self.b.create_block();
                let exit = self.b.create_block();
                self.b.ins().jump(header, &[]);
                self.b.switch_to_block(header);
                let c = self.expr(&ws.test)?;
                let c = self.to_bool(c);
                self.b.ins().brif(c, body, &[], exit, &[]);
                self.b.switch_to_block(body);
                self.b.seal_block(body);
                self.loops.push(LoopCx { continue_block: header, break_block: exit });
                self.scopes.push(HashMap::new());
                let t = self.stmt(&ws.body)?;
                self.scopes.pop();
                self.loops.pop();
                if !t {
                    self.b.ins().jump(header, &[]);
                }
                self.b.seal_block(header);
                self.b.switch_to_block(exit);
                self.b.seal_block(exit);
                Ok(false)
            }
            Statement::DoWhileStatement(dw) => {
                let body = self.b.create_block();
                let cond_b = self.b.create_block();
                let exit = self.b.create_block();
                self.b.ins().jump(body, &[]);
                self.b.switch_to_block(body);
                self.loops.push(LoopCx { continue_block: cond_b, break_block: exit });
                self.scopes.push(HashMap::new());
                let t = self.stmt(&dw.body)?;
                self.scopes.pop();
                self.loops.pop();
                if !t {
                    self.b.ins().jump(cond_b, &[]);
                }
                self.b.switch_to_block(cond_b);
                self.b.seal_block(cond_b);
                let c = self.expr(&dw.test)?;
                let c = self.to_bool(c);
                self.b.ins().brif(c, body, &[], exit, &[]);
                self.b.seal_block(body);
                self.b.switch_to_block(exit);
                self.b.seal_block(exit);
                Ok(false)
            }
            Statement::ForStatement(fs) => {
                self.scopes.push(HashMap::new());
                if let Some(init) = &fs.init {
                    match init {
                        ForStatementInit::VariableDeclaration(vd) => self.var_decl(vd)?,
                        other => {
                            let e = other.as_expression().ok_or_else(|| anyhow!("for init"))?;
                            self.expr(e)?;
                        }
                    }
                }
                let header = self.b.create_block();
                let body = self.b.create_block();
                let update = self.b.create_block();
                let exit = self.b.create_block();
                self.b.ins().jump(header, &[]);
                self.b.switch_to_block(header);
                match &fs.test {
                    Some(t) => {
                        let c = self.expr(t)?;
                        let c = self.to_bool(c);
                        self.b.ins().brif(c, body, &[], exit, &[]);
                    }
                    None => {
                        self.b.ins().jump(body, &[]);
                    }
                }
                self.b.switch_to_block(body);
                self.b.seal_block(body);
                self.loops.push(LoopCx { continue_block: update, break_block: exit });
                self.scopes.push(HashMap::new());
                let t = self.stmt(&fs.body)?;
                self.scopes.pop();
                self.loops.pop();
                if !t {
                    self.b.ins().jump(update, &[]);
                }
                self.b.switch_to_block(update);
                self.b.seal_block(update);
                if let Some(u) = &fs.update {
                    self.expr(u)?;
                }
                self.b.ins().jump(header, &[]);
                self.b.seal_block(header);
                self.b.switch_to_block(exit);
                self.b.seal_block(exit);
                self.scopes.pop();
                Ok(false)
            }
            Statement::BreakStatement(bs) => {
                if bs.label.is_some() {
                    bail!("labeled break");
                }
                let l = self.loops.last().ok_or_else(|| anyhow!("break outside loop"))?;
                let target = l.break_block;
                self.b.ins().jump(target, &[]);
                Ok(true)
            }
            Statement::ContinueStatement(cs) => {
                if cs.label.is_some() {
                    bail!("labeled continue");
                }
                let l = self.loops.last().ok_or_else(|| anyhow!("continue outside loop"))?;
                let target = l.continue_block;
                self.b.ins().jump(target, &[]);
                Ok(true)
            }
            other => bail!("unsupported statement {:?}", std::mem::discriminant(other)),
        }
    }

    fn var_decl(&mut self, vd: &VariableDeclaration<'a>) -> Result<()> {
        if vd.kind == VariableDeclarationKind::Var {
            bail!("var is not supported (use let/const)");
        }
        for d in &vd.declarations {
            let name = match &d.id {
                BindingPattern::BindingIdentifier(id) => id.name.as_str(),
                _ => bail!("destructuring"),
            };
            let init = d.init.as_ref().ok_or_else(|| anyhow!("uninitialized let"))?;
            let v = self.expr(init)?;
            let var = self.declare(name, v.ty);
            self.b.def_var(var, v.v);
        }
        Ok(())
    }

    // ---------- expressions ----------

    fn to_num(&mut self, v: TVal) -> Value {
        match v.ty {
            Ty::Num => v.v,
            Ty::Bool => {
                let i = self.b.ins().uextend(types::I32, v.v);
                self.b.ins().fcvt_from_uint(types::F64, i)
            }
        }
    }

    /// JS truthiness of a number: not 0, not -0, not NaN.
    fn to_bool(&mut self, v: TVal) -> Value {
        match v.ty {
            Ty::Bool => v.v,
            Ty::Num => {
                let zero = self.b.ins().f64const(0.0);
                self.b.ins().fcmp(FloatCC::OrderedNotEqual, v.v, zero)
            }
        }
    }

    /// ECMAScript ToInt32.
    fn to_int32(&mut self, x: Value) -> Value {
        let fast = self.b.create_block();
        let slow = self.b.create_block();
        let merge = self.b.create_block();
        self.b.append_block_param(merge, types::I32);
        let lim = self.b.ins().f64const(9223372036854775808.0); // 2^63
        let ax = self.b.ins().fabs(x);
        let in_range = self.b.ins().fcmp(FloatCC::LessThan, ax, lim);
        self.b.ins().brif(in_range, fast, &[], slow, &[]);

        self.b.switch_to_block(fast);
        self.b.seal_block(fast);
        let i64v = self.b.ins().fcvt_to_sint_sat(types::I64, x);
        let i32v = self.b.ins().ireduce(types::I32, i64v);
        self.b.ins().jump(merge, &[i32v.into()]);

        self.b.switch_to_block(slow);
        self.b.seal_block(slow);
        let r = match self.slow_ref {
            Some(r) => r,
            None => {
                let r = self.module.declare_func_in_func(self.to_int32_slow, self.b.func);
                self.slow_ref = Some(r);
                r
            }
        };
        let call = self.b.ins().call(r, &[x]);
        let sv = self.b.inst_results(call)[0];
        self.b.ins().jump(merge, &[sv.into()]);

        self.b.switch_to_block(merge);
        self.b.seal_block(merge);
        self.b.block_params(merge)[0]
    }

    fn i32_to_num(&mut self, i: Value) -> TVal {
        TVal { ty: Ty::Num, v: self.b.ins().fcvt_from_sint(types::F64, i) }
    }

    fn expr(&mut self, e: &Expression<'a>) -> Result<TVal> {
        match e {
            Expression::NumericLiteral(n) => Ok(TVal { ty: Ty::Num, v: self.b.ins().f64const(n.value) }),
            Expression::BooleanLiteral(bl) => Ok(TVal { ty: Ty::Bool, v: self.b.ins().iconst(types::I8, bl.value as i64) }),
            Expression::ParenthesizedExpression(p) => self.expr(&p.expression),
            Expression::TSAsExpression(t) => self.expr(&t.expression),
            Expression::TSNonNullExpression(t) => self.expr(&t.expression),
            Expression::Identifier(id) => {
                let name = id.name.as_str();
                if name == "NaN" {
                    return Ok(TVal { ty: Ty::Num, v: self.b.ins().f64const(f64::NAN) });
                }
                if name == "Infinity" {
                    return Ok(TVal { ty: Ty::Num, v: self.b.ins().f64const(f64::INFINITY) });
                }
                let (var, ty) = self.lookup(name).ok_or_else(|| anyhow!("unknown identifier {name}"))?;
                Ok(TVal { ty, v: self.b.use_var(var) })
            }
            Expression::UnaryExpression(u) => {
                let a = self.expr(&u.argument)?;
                match u.operator {
                    UnaryOperator::UnaryNegation => {
                        let x = self.to_num(a);
                        Ok(TVal { ty: Ty::Num, v: self.b.ins().fneg(x) })
                    }
                    UnaryOperator::UnaryPlus => Ok(TVal { ty: Ty::Num, v: self.to_num(a) }),
                    UnaryOperator::LogicalNot => {
                        let c = self.to_bool(a);
                        let one = self.b.ins().iconst(types::I8, 1);
                        Ok(TVal { ty: Ty::Bool, v: self.b.ins().bxor(c, one) })
                    }
                    UnaryOperator::BitwiseNot => {
                        let x = self.to_num(a);
                        let i = self.to_int32(x);
                        let n = self.b.ins().bnot(i);
                        Ok(self.i32_to_num(n))
                    }
                    _ => bail!("unsupported unary operator"),
                }
            }
            Expression::BinaryExpression(bin) => {
                let l = self.expr(&bin.left)?;
                // x / 2^k == x * 2^-k exactly in IEEE-754 (as long as 2^-k is normal).
                if bin.operator == BinaryOperator::Division {
                    if let Expression::NumericLiteral(n) = &bin.right {
                        let d = n.value;
                        if d.is_finite() && d != 0.0 && d.abs().log2().fract() == 0.0 && d.abs() <= 1e300 && d.abs() >= 1e-300 {
                            let a = self.to_num(l);
                            let inv = self.b.ins().f64const(1.0 / d);
                            return Ok(TVal { ty: Ty::Num, v: self.b.ins().fmul(a, inv) });
                        }
                    }
                }
                let r = self.expr(&bin.right)?;
                self.binary(bin.operator, l, r)
            }
            Expression::LogicalExpression(lg) => {
                // Both sides must be boolean-typed so the JS "returns an operand" semantics
                // collapse to plain boolean logic.
                let l = self.expr(&lg.left)?;
                if l.ty != Ty::Bool {
                    bail!("logical operator on non-boolean");
                }
                let rhs_b = self.b.create_block();
                let merge = self.b.create_block();
                self.b.append_block_param(merge, types::I8);
                match lg.operator {
                    LogicalOperator::And => self.b.ins().brif(l.v, rhs_b, &[], merge, &[l.v.into()]),
                    LogicalOperator::Or => self.b.ins().brif(l.v, merge, &[l.v.into()], rhs_b, &[]),
                    LogicalOperator::Coalesce => bail!("?? unsupported"),
                };
                self.b.switch_to_block(rhs_b);
                self.b.seal_block(rhs_b);
                let r = self.expr(&lg.right)?;
                if r.ty != Ty::Bool {
                    bail!("logical operator on non-boolean");
                }
                self.b.ins().jump(merge, &[r.v.into()]);
                self.b.switch_to_block(merge);
                self.b.seal_block(merge);
                Ok(TVal { ty: Ty::Bool, v: self.b.block_params(merge)[0] })
            }
            Expression::ConditionalExpression(c) => {
                let t = self.expr(&c.test)?;
                let cond = self.to_bool(t);
                let then_b = self.b.create_block();
                let else_b = self.b.create_block();
                let merge = self.b.create_block();
                self.b.ins().brif(cond, then_b, &[], else_b, &[]);
                self.b.switch_to_block(then_b);
                self.b.seal_block(then_b);
                let a = self.expr(&c.consequent)?;
                let av = self.to_num(a);
                self.b.ins().jump(merge, &[av.into()]);
                self.b.switch_to_block(else_b);
                self.b.seal_block(else_b);
                let bv = self.expr(&c.alternate)?;
                let bv = self.to_num(bv);
                self.b.append_block_param(merge, types::F64);
                self.b.ins().jump(merge, &[bv.into()]);
                self.b.switch_to_block(merge);
                self.b.seal_block(merge);
                Ok(TVal { ty: Ty::Num, v: self.b.block_params(merge)[0] })
            }
            Expression::AssignmentExpression(asg) => {
                let name = match &asg.left {
                    AssignmentTarget::AssignmentTargetIdentifier(id) => id.name.as_str(),
                    _ => bail!("assignment to non-identifier"),
                };
                let (var, ty) = self.lookup(name).ok_or_else(|| anyhow!("unknown identifier {name}"))?;
                let rhs = self.expr(&asg.right)?;
                let newv = if asg.operator == AssignmentOperator::Assign {
                    if rhs.ty != ty {
                        bail!("assignment changes type of {name}");
                    }
                    rhs
                } else {
                    let cur = TVal { ty, v: self.b.use_var(var) };
                    let op = match asg.operator {
                        AssignmentOperator::Addition => BinaryOperator::Addition,
                        AssignmentOperator::Subtraction => BinaryOperator::Subtraction,
                        AssignmentOperator::Multiplication => BinaryOperator::Multiplication,
                        AssignmentOperator::Division => BinaryOperator::Division,
                        AssignmentOperator::Remainder => BinaryOperator::Remainder,
                        AssignmentOperator::Exponential => BinaryOperator::Exponential,
                        AssignmentOperator::ShiftLeft => BinaryOperator::ShiftLeft,
                        AssignmentOperator::ShiftRight => BinaryOperator::ShiftRight,
                        AssignmentOperator::ShiftRightZeroFill => BinaryOperator::ShiftRightZeroFill,
                        AssignmentOperator::BitwiseOR => BinaryOperator::BitwiseOR,
                        AssignmentOperator::BitwiseXOR => BinaryOperator::BitwiseXOR,
                        AssignmentOperator::BitwiseAnd => BinaryOperator::BitwiseAnd,
                        _ => bail!("unsupported compound assignment"),
                    };
                    let r = self.binary(op, cur, rhs)?;
                    if r.ty != ty {
                        bail!("compound assignment changes type of {name}");
                    }
                    r
                };
                self.b.def_var(var, newv.v);
                Ok(newv)
            }
            Expression::UpdateExpression(up) => {
                let name = match &up.argument {
                    SimpleAssignmentTarget::AssignmentTargetIdentifier(id) => id.name.as_str(),
                    _ => bail!("update of non-identifier"),
                };
                let (var, ty) = self.lookup(name).ok_or_else(|| anyhow!("unknown identifier {name}"))?;
                if ty != Ty::Num {
                    bail!("++/-- on non-number");
                }
                let old = self.b.use_var(var);
                let one = self.b.ins().f64const(1.0);
                let new = match up.operator {
                    UpdateOperator::Increment => self.b.ins().fadd(old, one),
                    UpdateOperator::Decrement => self.b.ins().fsub(old, one),
                };
                self.b.def_var(var, new);
                Ok(TVal { ty: Ty::Num, v: if up.prefix { new } else { old } })
            }
            Expression::CallExpression(call) => self.call(call),
            other => bail!("unsupported expression {:?}", std::mem::discriminant(other)),
        }
    }

    fn call(&mut self, call: &CallExpression<'a>) -> Result<TVal> {
        let mut args = Vec::with_capacity(call.arguments.len());
        for a in &call.arguments {
            let e = a.as_expression().ok_or_else(|| anyhow!("spread argument"))?;
            let v = self.expr(e)?;
            args.push(self.to_num(v));
        }
        match &call.callee {
            Expression::Identifier(id) => {
                let name = id.name.as_str();
                let (_, arity) = *self.fn_ids.get(name).ok_or_else(|| anyhow!("call to non-compiled function {name}"))?;
                if arity != args.len() {
                    bail!("arity mismatch calling {name}");
                }
                let r = self.func_ref(name);
                let inst = self.b.ins().call(r, &args);
                Ok(TVal { ty: Ty::Num, v: self.b.inst_results(inst)[0] })
            }
            Expression::StaticMemberExpression(m) => {
                let obj = match &m.object {
                    Expression::Identifier(id) => id.name.as_str(),
                    _ => bail!("unsupported callee"),
                };
                if obj != "Math" {
                    bail!("unsupported callee object {obj}");
                }
                let f = m.property.name.as_str();
                let a = |i: usize| -> Result<Value> { args.get(i).copied().ok_or_else(|| anyhow!("Math.{f} arity")) };
                let v = match (f, args.len()) {
                    ("floor", 1) => self.b.ins().floor(a(0)?),
                    ("ceil", 1) => self.b.ins().ceil(a(0)?),
                    ("trunc", 1) => self.b.ins().trunc(a(0)?),
                    ("abs", 1) => self.b.ins().fabs(a(0)?),
                    ("sqrt", 1) => self.b.ins().sqrt(a(0)?),
                    ("min", 2) => self.b.ins().fmin(a(0)?, a(1)?),
                    ("max", 2) => self.b.ins().fmax(a(0)?, a(1)?),
                    ("round", 1) => self.call_helper("k_round", &[a(0)?]),
                    ("pow", 2) => self.call_helper("k_pow", &[a(0)?, a(1)?]),
                    ("sin", 1) => self.call_helper("k_sin", &[a(0)?]),
                    ("cos", 1) => self.call_helper("k_cos", &[a(0)?]),
                    ("tan", 1) => self.call_helper("k_tan", &[a(0)?]),
                    ("atan", 1) => self.call_helper("k_atan", &[a(0)?]),
                    ("atan2", 2) => self.call_helper("k_atan2", &[a(0)?, a(1)?]),
                    ("exp", 1) => self.call_helper("k_exp", &[a(0)?]),
                    ("log", 1) => self.call_helper("k_log", &[a(0)?]),
                    ("log2", 1) => self.call_helper("k_log2", &[a(0)?]),
                    ("log10", 1) => self.call_helper("k_log10", &[a(0)?]),
                    _ => bail!("unsupported Math.{f}/{}", args.len()),
                };
                Ok(TVal { ty: Ty::Num, v })
            }
            _ => bail!("unsupported callee"),
        }
    }

    fn binary(&mut self, op: BinaryOperator, l: TVal, r: TVal) -> Result<TVal> {
        use BinaryOperator as B;
        match op {
            B::Addition | B::Subtraction | B::Multiplication | B::Division | B::Remainder | B::Exponential => {
                let a = self.to_num(l);
                let b = self.to_num(r);
                let v = match op {
                    B::Addition => self.b.ins().fadd(a, b),
                    B::Subtraction => self.b.ins().fsub(a, b),
                    B::Multiplication => self.b.ins().fmul(a, b),
                    B::Division => self.b.ins().fdiv(a, b),
                    B::Remainder => self.js_rem(a, b),
                    _ => self.call_helper("k_pow", &[a, b]),
                };
                Ok(TVal { ty: Ty::Num, v })
            }
            B::LessThan | B::LessEqualThan | B::GreaterThan | B::GreaterEqualThan
            | B::Equality | B::StrictEquality | B::Inequality | B::StrictInequality => {
                if l.ty == Ty::Bool && r.ty == Ty::Bool {
                    let cc = match op {
                        B::Equality | B::StrictEquality => IntCC::Equal,
                        B::Inequality | B::StrictInequality => IntCC::NotEqual,
                        B::LessThan => IntCC::UnsignedLessThan,
                        B::LessEqualThan => IntCC::UnsignedLessThanOrEqual,
                        B::GreaterThan => IntCC::UnsignedGreaterThan,
                        _ => IntCC::UnsignedGreaterThanOrEqual,
                    };
                    return Ok(TVal { ty: Ty::Bool, v: self.b.ins().icmp(cc, l.v, r.v) });
                }
                if l.ty != r.ty && matches!(op, B::StrictEquality) {
                    // number === boolean is always false in JS
                    return Ok(TVal { ty: Ty::Bool, v: self.b.ins().iconst(types::I8, 0) });
                }
                if l.ty != r.ty && matches!(op, B::StrictInequality) {
                    return Ok(TVal { ty: Ty::Bool, v: self.b.ins().iconst(types::I8, 1) });
                }
                let a = self.to_num(l);
                let b = self.to_num(r);
                let cc = match op {
                    B::LessThan => FloatCC::LessThan,
                    B::LessEqualThan => FloatCC::LessThanOrEqual,
                    B::GreaterThan => FloatCC::GreaterThan,
                    B::GreaterEqualThan => FloatCC::GreaterThanOrEqual,
                    B::Equality | B::StrictEquality => FloatCC::Equal,
                    _ => FloatCC::NotEqual,
                };
                Ok(TVal { ty: Ty::Bool, v: self.b.ins().fcmp(cc, a, b) })
            }
            B::BitwiseAnd | B::BitwiseOR | B::BitwiseXOR | B::ShiftLeft | B::ShiftRight | B::ShiftRightZeroFill => {
                let a = self.to_num(l);
                let b = self.to_num(r);
                let ai = self.to_int32(a);
                let bi = self.to_int32(b);
                let v = match op {
                    B::BitwiseAnd => self.b.ins().band(ai, bi),
                    B::BitwiseOR => self.b.ins().bor(ai, bi),
                    B::BitwiseXOR => self.b.ins().bxor(ai, bi),
                    B::ShiftLeft => {
                        let s = self.b.ins().band_imm_s(bi, 31);
                        self.b.ins().ishl(ai, s)
                    }
                    B::ShiftRight => {
                        let s = self.b.ins().band_imm_s(bi, 31);
                        self.b.ins().sshr(ai, s)
                    }
                    _ => {
                        let s = self.b.ins().band_imm_s(bi, 31);
                        let u = self.b.ins().ushr(ai, s);
                        // ToUint32 result: convert as unsigned.
                        return Ok(TVal { ty: Ty::Num, v: self.b.ins().fcvt_from_uint(types::F64, u) });
                    }
                };
                Ok(self.i32_to_num(v))
            }
            _ => bail!("unsupported binary operator"),
        }
    }
}

fn clif_ty(t: Ty) -> Type {
    match t {
        Ty::Num => types::F64,
        Ty::Bool => types::I8,
    }
}
