//! Table of compiled native functions, indexed by the id handed to JS wrappers.
//! All entries use the C ABI with `f64` params and an `f64` return.

use std::cell::RefCell;

thread_local! {
    static TABLE: RefCell<Vec<usize>> = const { RefCell::new(Vec::new()) };
}

/// Recursion depth of native frames on this thread, maintained by generated code.
#[no_mangle]
pub static mut K_DEPTH: u32 = 0;
/// Set by generated code when K_DEPTH exceeds the limit; the op turns it into a RangeError.
#[no_mangle]
pub static mut K_OVERFLOW: u32 = 0;
pub const DEPTH_LIMIT: u32 = 40_000;

/// After a native call: did the callee hit the recursion limit?
#[inline(always)]
pub fn take_overflow() -> bool {
    // SAFETY: single JS thread per table; generated code writes these on the same thread.
    unsafe {
        if K_OVERFLOW != 0 {
            K_OVERFLOW = 0;
            K_DEPTH = 0;
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
