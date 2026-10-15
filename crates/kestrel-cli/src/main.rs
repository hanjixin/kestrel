use std::path::PathBuf;

#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

fn usage() -> ! {
    eprintln!("kestrel {}\n\nUsage:\n  kestrel [run] <file.js|file.ts> [args...]", env!("CARGO_PKG_VERSION"));
    std::process::exit(2);
}

fn main() {
    let mut args: Vec<String> = std::env::args().collect();
    if args.len() < 2 {
        usage();
    }
    if args[1] == "run" {
        args.remove(1);
        if args.len() < 2 {
            usage();
        }
    }
    let file = PathBuf::from(&args[1]);
    let argv: Vec<String> = std::iter::once("kestrel".to_string())
        .chain(args[1..].iter().cloned())
        .collect();
    match kestrel_engine::run_file(&file, &argv) {
        Ok(code) => std::process::exit(code),
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(1);
        }
    }
}
