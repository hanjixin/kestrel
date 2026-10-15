pub mod loader;
/// Native dispatch table shared with the AOT tier.
pub mod bridge {
    pub use kestrel_aot::registry::*;
}
pub mod ops;
pub mod runtime;
pub mod transpile;

pub use runtime::{run_file, Runtime};
