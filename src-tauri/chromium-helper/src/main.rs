//! Sandboxed CEF renderer/GPU/utility subprocess entry point. No app IPC is linked.
#[cfg(target_os = "macos")]
fn main() -> std::process::ExitCode {
    use cef::*;
    let args = args::Args::new();
    let mut sandbox = sandbox::Sandbox::new();
    sandbox.initialize(args.as_main_args());
    let loader = library_loader::LibraryLoader::new(
        &std::env::current_exe().expect("Helper executable"),
        true,
    );
    if !loader.load() {
        return std::process::ExitCode::FAILURE;
    }
    let _ = api_hash(sys::CEF_API_VERSION_LAST, 0);
    let code = execute_process(
        Some(args.as_main_args()),
        None::<&mut App>,
        std::ptr::null_mut(),
    );
    std::process::ExitCode::from(u8::try_from(code).unwrap_or(1))
}

#[cfg(not(target_os = "macos"))]
fn main() {}
