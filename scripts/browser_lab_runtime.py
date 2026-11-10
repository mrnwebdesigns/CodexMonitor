"""Pinned macOS Chromium dependencies and app-bundle assembly."""
from pathlib import Path
import hashlib
import json
import platform
import plistlib
import shutil
import subprocess
import tarfile
import tempfile
import zipfile

CEF_VERSION = "156.0.15+gcf671c0+chromium-156.0.8078.80"
CEF_ARCHIVE = f"cef_binary_{CEF_VERSION}_macosarm64_minimal.tar.bz2"
CEF_SHA1 = "bcdd1877edb300b0fb91d8f71c0b14aae256cd0f"
CEF_BYTES = 135024501
NINJA_VERSION = "1.13.2"
NINJA_SHA256 = "c99048673aa765960a99cf10c6ddb9f1fad506099ff0a0e137ad8960a88f321b"


def digest(path, algorithm):
    value = hashlib.new(algorithm)
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


def download(url, target):
    subprocess.run([
        "curl", "--fail", "--location", "--retry", "3", "--connect-timeout", "20",
        "--max-time", "600", "--output", str(target), url,
    ], check=True)


def prepare(root):
    if platform.system() != "Darwin" or platform.machine() != "arm64":
        raise SystemExit("Chromium app bundles currently require Apple Silicon macOS")
    local = root / ".browser-lab"
    tools = local / "tools"
    tools.mkdir(parents=True, exist_ok=True)
    ninja_archive = tools / "ninja-mac.zip"
    if not ninja_archive.exists():
        download(f"https://github.com/ninja-build/ninja/releases/download/v{NINJA_VERSION}/ninja-mac.zip", ninja_archive)
    if digest(ninja_archive, "sha256") != NINJA_SHA256:
        raise SystemExit("Ninja archive checksum mismatch")
    if not (tools / "ninja").is_file():
        with zipfile.ZipFile(ninja_archive) as archive:
            (tools / "ninja").write_bytes(archive.read("ninja"))
        (tools / "ninja").chmod(0o755)
    cef = local / "cef" / "cef_macos_aarch64"
    marker = cef / "archive.json"
    expected = {"type": "minimal", "name": CEF_ARCHIVE, "sha1": CEF_SHA1}
    if marker.is_file() and json.loads(marker.read_text()) == expected:
        if not (cef / "Chromium Embedded Framework.framework/Chromium Embedded Framework").is_file():
            raise SystemExit("The private CEF cache is incomplete; inspect it before rebuilding")
        return tools, cef
    archives = local / "downloads"
    archives.mkdir(parents=True, exist_ok=True)
    path = archives / CEF_ARCHIVE
    if not path.is_file():
        download("https://cef-builds.spotifycdn.com/" + CEF_ARCHIVE, path)
    if path.stat().st_size != CEF_BYTES or digest(path, "sha1") != CEF_SHA1:
        raise SystemExit("CEF archive size or checksum mismatch; no archive was extracted")
    if cef.exists():
        raise SystemExit("An incomplete CEF directory exists; inspect it before replacing it")
    cef.parent.mkdir(parents=True, exist_ok=True)
    # Use the same flattened layout as tauri-apps/download-cef. The archive is
    # pinned and verified before extraction; preserve its framework symlinks.
    with tempfile.TemporaryDirectory(prefix="cef-extract-", dir=archives) as temporary:
        temporary = Path(temporary)
        with tarfile.open(path) as archive:
            archive.extractall(temporary, filter="data")
        extracted = temporary / CEF_ARCHIVE.removesuffix(".tar.bz2")
        shutil.move(str(extracted / "Release"), cef)
        for name in ["CMakeLists.txt", "cmake", "include", "libcef_dll", "CREDITS.html", "LICENSE.txt"]:
            if (extracted / name).exists():
                shutil.move(str(extracted / name), cef / name)
        marker.write_text(json.dumps(expected, indent=2) + "\n")
    return tools, cef


def bundle(root, cef, app, identifier, version, signing_identity="-"):
    info_path = app / "Contents/Info.plist"
    info = plistlib.loads(info_path.read_bytes())
    if info.get("CFBundleIdentifier") != identifier:
        raise SystemExit("Refusing to modify a bundle with the wrong app identifier")
    frameworks = app / "Contents/Frameworks"
    frameworks.mkdir(exist_ok=True)
    target = frameworks / "Chromium Embedded Framework.framework"
    if target.exists():
        shutil.rmtree(target)
    subprocess.run(["/bin/cp", "-cR", str(cef / target.name), str(target)], check=True)
    binary = root / "src-tauri/target/chromium-helper/debug/browser-lab-chromium-helper"
    if not binary.is_file():
        raise SystemExit("Build the Chromium helper before bundling")
    for role in ["", " (Renderer)", " (GPU)", " (Plugin)", " (Alerts)"]:
        name = "Codex Monitor Chromium Helper" + role
        contents = frameworks / (name + ".app") / "Contents"
        executable = contents / "MacOS" / name
        executable.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(binary, executable)
        helper_info = {
            "CFBundleExecutable": name,
            "CFBundleName": name,
            "CFBundleIdentifier": identifier + ".helper" + ("." + role.strip(" ()").lower() if role else ""),
            "CFBundleVersion": version,
            "CFBundleShortVersionString": version,
            "CFBundleInfoDictionaryVersion": "6.0",
            "CFBundlePackageType": "APPL",
            "LSUIElement": True,
            "LSMinimumSystemVersion": "11.0",
            "NSSupportsAutomaticGraphicsSwitching": True,
            # Chromium initializes Bluetooth discovery in helper processes on
            # current macOS releases. TCC aborts the whole application if the
            # requesting helper lacks this required usage description.
            "NSBluetoothAlwaysUsageDescription": "Allow Chromium to discover nearby Bluetooth devices when a website requests it.",
        }
        (contents / "Info.plist").write_bytes(plistlib.dumps(helper_info))
    for name in ["CREDITS.html", "LICENSE.txt"]:
        source = cef / name
        if source.is_file():
            shutil.copy2(source, app / "Contents/Resources" / ("Chromium " + name))
    # CEF must see MallocNanoZone=0 in browser and helper processes.
    info.setdefault("LSEnvironment", {})["MallocNanoZone"] = "0"
    info_path.write_bytes(plistlib.dumps(info))
    subprocess.run(["/usr/bin/codesign", "--force", "--deep", "--sign", signing_identity, str(app)], check=True)
    subprocess.run(["/usr/bin/codesign", "--verify", "--deep", "--strict", str(app)], check=True)
