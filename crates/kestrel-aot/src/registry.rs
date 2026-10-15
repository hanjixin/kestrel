//! Table of compiled native functions, indexed by the id handed to JS wrappers.
//! All entries use the C ABI with `f64` params and an `f64` return.

use std::cell::RefCell;

thread_local! {
    static TABLE: RefCell<Vec<usize>> = const { RefCell::new(Vec::new()) };
}

/// Lowest stack address generated code may run at. Generated code compares SP
/// against this on entry; when it fails, the code flags overflow and pins the
/// limit to usize::MAX so every frame still on the stack bails out immediately.
#[no_mangle]
pub static mut K_STACK_LIMIT: usize = 0;
/// The real limit, restored by `take_overflow`.
#[no_mangle]
pub static mut K_STACK_LIMIT_REAL: usize = 0;
/// Set by generated code when the stack check fails; the op turns it into a RangeError.
#[no_mangle]
pub static mut K_OVERFLOW: u32 = 0;

/// Keep this much headroom below the limit for V8 / Rust frames.
const STACK_MARGIN: usize = 512 * 1024;

#[cfg(target_os = "macos")]
fn thread_stack_bounds() -> Option<(usize, usize)> {
    unsafe {
        let t = libc::pthread_self();
        let top = libc::pthread_get_stackaddr_np(t) as usize;
        let size = libc::pthread_get_stacksize_np(t);
        Some((top - size, top))
    }
}
#[cfg(target_os = "linux")]
fn thread_stack_bounds() -> Option<(usize, usize)> {
    unsafe {
        let mut attr: libc::pthread_attr_t = std::mem::zeroed();
        if libc::pthread_getattr_np(libc::pthread_self(), &mut attr) != 0 {
            return None;
        }
        let mut addr: *mut libc::c_void = std::ptr::null_mut();
        let mut size: libc::size_t = 0;
        let r = libc::pthread_attr_getstack(&attr, &mut addr, &mut size);
        libc::pthread_attr_destroy(&mut attr);
        if r != 0 { return None; }
        Some((addr as usize, addr as usize + size))
    }
}
#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn thread_stack_bounds() -> Option<(usize, usize)> { None }

/// Call once on every thread that will run native functions.
pub fn init_thread() {
    let limit = match thread_stack_bounds() {
        Some((lo, _hi)) => lo + STACK_MARGIN,
        None => {
            let here = &0u8 as *const u8 as usize;
            here.saturating_sub(4 * 1024 * 1024)
        }
    };
    // SAFETY: one JS thread per process today; per-thread globals come with the worker refactor.
    unsafe {
        K_STACK_LIMIT = limit;
        K_STACK_LIMIT_REAL = limit;
        K_OVERFLOW = 0;
    }
}

/// After a native call: did the callee hit the stack limit?
#[inline(always)]
pub fn take_overflow() -> bool {
    unsafe {
        if K_OVERFLOW != 0 {
            K_OVERFLOW = 0;
            K_STACK_LIMIT = K_STACK_LIMIT_REAL;
            true
        } else {
            false
        }
    }
}

pub fn register(ptr: *const u8) -> u32 {
    TABLE.with(|t| {
        let mut t = t.borrow_mut();
        t.push(ptr as usize);
        (t.len() - 1) as u32
    })
}

#[inline(always)]
fn get(idx: u32) -> usize {
    TABLE.with(|t| t.borrow()[idx as usize])
}

macro_rules! caller {
    ($name:ident, $($arg:ident),*) => {
        #[inline(always)]
        pub fn $name(idx: u32, $($arg: f64),*) -> f64 {
            let p = get(idx);
            let f: extern "C" fn($($arg: f64),*) -> f64 = unsafe { std::mem::transmute(p) };
            f($($arg),*)
        }
    };
}
#[inline(always)]
pub fn call0(idx: u32) -> f64 {
    let f: extern "C" fn() -> f64 = unsafe { std::mem::transmute(get(idx)) };
    f()
}
caller!(call1, a);
caller!(call2, a, b);
caller!(call3, a, b, c);
caller!(call4, a, b, c, d);
caller!(call5, a, b, c, d, e);
caller!(call6, a, b, c, d, e, f);

pub const MAX_ARITY: usize = 6;
