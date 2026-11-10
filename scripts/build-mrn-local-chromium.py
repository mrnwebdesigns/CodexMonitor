#!/usr/bin/env python3
"""Build the Apple Silicon MRN Local app with Chromium into Cargo's bundle directory."""
import argparse
import json
import os
from pathlib import Path
import plistlib
import shlex
import shutil
import subprocess

from browser_lab_runtime import bundle, prepare

ROOT = Path(__file__).resolve().parent.parent
IDENTIFIER = "com.mrnwebdesigns.codexmonitor.local"
NAME = "Codex Monitor MRN Local"


def install_launcher(app, codex_home):
    info = plistlib.loads((app / "Contents/Info.plist").read_bytes())
    if info.get("CFBundleIdentifier") != IDENTIFIER:
        raise SystemExit("Unexpected app identity; refusing to prepare the launcher")
    entry = app / "Contents/MacOS" / info["CFBundleExecutable"]
    native = entry.with_name(f"{entry.name}-mrn-native")
    entry.rename(native)
    entry.write_text(
        "#!/bin/zsh\n"
        f"export CODEX_HOME={shlex.quote(str(codex_home))}\n"
        'export PATH="/opt/homebrew/bin:$PATH"\n'
        f'exec "${{0:A:h}}/{native.name}" "$@"\n'
    )
    entry.chmod(0o755)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=ROOT / ".mrn-local/tauri.conf.json")
    parser.add_argument("--codex-home", type=Path, default=ROOT / ".mrn-local/codex-home")
    parser.add_argument(
        "--signing-identity",
        default=os.environ.get("CODEX_MONITOR_SIGNING_IDENTITY", "-"),
        help="macOS codesigning identity; defaults to ad-hoc signing for local development",
    )
    args = parser.parse_args()
    config = args.config.resolve(strict=True)
    codex_home = args.codex_home.resolve(strict=True)
    if not codex_home.is_dir():
        raise SystemExit("Select an existing MRN Local Codex home")
    if codex_home == (Path.home() / ".codex").resolve():
        raise SystemExit("Refusing to use the shared Codex home")
    local = json.loads(config.read_text())
    if local.get("identifier") != IDENTIFIER or local.get("productName") != NAME:
        raise SystemExit("Select the MRN Local Tauri configuration")
    if local.get("bundle", {}).get("createUpdaterArtifacts") is not False:
        raise SystemExit("Disable upstream updater artifacts in the MRN Local configuration")
    if shutil.disk_usage(ROOT).free < 8 * 1024**3:
        raise SystemExit("The native build requires at least 8 GiB free")

    env = os.environ.copy()
    rustup = Path("/opt/homebrew/opt/rustup/bin/rustup")
    if rustup.is_file():
        cargo = subprocess.check_output([str(rustup), "which", "cargo"], text=True).strip()
        env["PATH"] = f"{Path(cargo).parent}:/opt/homebrew/bin:{env['PATH']}"
    tools, cef = prepare(ROOT)
    env.update(
        PATH=f"{tools}:{env['PATH']}",
        CEF_PATH=str(cef),
        CARGO_TARGET_DIR=str(ROOT / "src-tauri/target"),
        CARGO_BUILD_JOBS="2",
        CARGO_PROFILE_DEV_DEBUG="0",
        CARGO_PROFILE_DEV_INCREMENTAL="false",
        VITE_SENTRY_DSN="",
        MACOSX_DEPLOYMENT_TARGET="11.0",
    )
    helper_env = env | {"CARGO_TARGET_DIR": str(ROOT / "src-tauri/target/chromium-helper")}
    subprocess.run([
        "cargo", "build", "--locked", "--manifest-path", str(ROOT / "src-tauri/chromium-helper/Cargo.toml"),
    ], cwd=ROOT, env=helper_env, check=True)
    subprocess.run([
        "npm", "run", "tauri", "--", "build", "--debug", "--bundles", "app", "--no-sign",
        "--features", "chromium-browser", "--config", str(config),
    ], cwd=ROOT, env=env, check=True)
    app = ROOT / "src-tauri/target/debug/bundle/macos" / f"{NAME}.app"
    install_launcher(app, codex_home)
    version = json.loads((ROOT / "src-tauri/tauri.conf.json").read_text())["version"]
    bundle(ROOT, cef, app, IDENTIFIER, version, args.signing_identity)
    print(app)


if __name__ == "__main__":
    main()
