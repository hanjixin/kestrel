// Export the Node-API symbols (napi_*, uv_*) from the `kestrel` binary so `.node` addons
// resolve them at dlopen time, exactly as they do against the `node` binary.
fn main() {
    let os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let name = match os.as_str() {
        "android" | "freebsd" | "openbsd" => "generated_symbol_exports_list_linux.def".to_string(),
        os => format!("generated_symbol_exports_list_{os}.def"),
    };
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../kestrel-napi").join(&name);
    let Ok(path) = path.canonicalize() else { return };
    println!("cargo:rerun-if-changed={}", path.display());
    match os.as_str() {
        "macos" => println!("cargo:rustc-link-arg-bin=kestrel=-Wl,-exported_symbols_list,{}", path.display()),
        "linux" | "android" | "freebsd" | "openbsd" => println!("cargo:rustc-link-arg-bin=kestrel=-Wl,--export-dynamic-symbol-list={}", path.display()),
        "windows" => println!("cargo:rustc-link-arg-bin=kestrel=/DEF:{}", path.display()),
        _ => {}
    }
}
