fn main() {
    println!("cargo:rustc-check-cfg=cfg(chromium_browser)");
    if std::env::var_os("CARGO_FEATURE_CHROMIUM_BROWSER").is_some()
        && std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos")
        && std::env::var("CARGO_CFG_TARGET_ARCH").as_deref() == Ok("aarch64")
    {
        println!("cargo:rustc-cfg=chromium_browser");
    }
    tauri_build::build();

    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("ios") {
        println!("cargo:rustc-link-lib=z");
        println!("cargo:rustc-link-lib=iconv");
    }
}
