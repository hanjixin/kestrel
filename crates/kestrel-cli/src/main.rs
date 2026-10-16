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
    // --inspect[=[host:]port], --inspect-brk[=[host:]port] (before the script).
    while args.len() > 1 && args[1].starts_with("--inspect") {
        let flag = args.remove(1);
        let (name, val) = match flag.split_once('=') { Some((n, v)) => (n.to_string(), v.to_string()), None => (flag.clone(), "127.0.0.1:9229".to_string()) };
        let val = if val.contains(':') { val } else { format!("127.0.0.1:{val}") };
        let spec = if name == "--inspect-brk" { format!("brk,{val}") } else { val };
        std::env::set_var("KESTREL_INSPECT", spec);
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
