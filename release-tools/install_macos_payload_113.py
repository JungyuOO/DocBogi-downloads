"""Stage and verify the Universal DocBogi 1.1.3 installer payload."""

import argparse
import json
import plistlib
import shutil
import subprocess
from pathlib import Path

from install_macos_payload_112 import (
    FILE_HASH,
    approved_compilation,
    regular,
    safe_tree,
    verify_licenses,
)
from patch_macos import create_fixtures, require, resign, tree_hash

BASE_VERSION = "1.1.2"
TARGET_VERSION = "1.1.3"
OLD_NAME = "Docvia"
NEW_NAME = "DocBogi"
APP_ID = "com.docvia.desktop"
HELPERS = {
    " Helper": ".helper",
    " Helper (GPU)": ".helper.GPU",
    " Helper (Plugin)": ".helper.Plugin",
    " Helper (Renderer)": ".helper.Renderer",
}
COMPILED_ENTRY_POINTS = {
    "main.cjs",
    "preload.cjs",
    "extractor-worker.cjs",
    "pdf-text.mjs",
    "renderer/index.html",
    "pdf-renderer/index.html",
}


def command(name, *args):
    return subprocess.run(
        ["/usr/bin/" + name, *map(str, args)],
        check=True,
        text=True,
        capture_output=True,
        timeout=90,
    )


def require_tree(path):
    require(path.is_dir() and path.resolve() == path, f"Unsafe directory: {path}")
    return path


def require_file(path):
    require(regular(path) and path.resolve() == path, f"Unsafe file: {path}")
    return path


def package_metadata(directory, version):
    package = require_file(directory / "package.json")
    metadata = json.loads(package.read_text(encoding="utf-8"))
    require(
        metadata.get("name") == "docvia"
        and metadata.get("main") == "dist/main.cjs"
        and metadata.get("version") == version,
        "Unexpected application package identity or version",
    )
    return package, metadata


def verified_dist(directory, digest):
    files = safe_tree(directory)
    require(COMPILED_ENTRY_POINTS.issubset(files), "Required compiled entries are missing")
    require(tree_hash(files) == digest, "Compiled dist differs from the approved donor tree")
    return files


def replace_resources(app, payload, digest):
    _, donor_metadata = package_metadata(payload, TARGET_VERSION)
    require(donor_metadata.get("productName") == NEW_NAME, "Windows donor product name differs")
    verified_dist(payload / "dist", digest)
    licenses = verify_licenses(payload / "third-party-licenses")

    resources = require_tree(app / "Contents" / "Resources" / "app")
    package, mac_metadata = package_metadata(resources, BASE_VERSION)
    mac_metadata.update(
        productName=NEW_NAME,
        version=TARGET_VERSION,
        author=NEW_NAME,
        homepage="https://jungyuoo.github.io/DocBogi-downloads/",
    )
    if isinstance(mac_metadata.get("description"), str):
        mac_metadata["description"] = mac_metadata["description"].replace(OLD_NAME, NEW_NAME)
    for name in ("dist", "third-party-licenses"):
        target = require_tree(resources / name)
        shutil.rmtree(target)
        shutil.copytree(payload / name, target)
    package.write_text(json.dumps(mac_metadata, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return licenses


def bundle_entries(app, name):
    frameworks = require_tree(app / "Contents" / "Frameworks")
    expected = {name + suffix + ".app" for suffix in HELPERS}
    require({path.name for path in frameworks.glob("*.app")} == expected, "Unexpected Electron helper set")
    require(not (app / "Contents" / "Library" / "LoginItems").exists(), "Unexpected Electron login helper")
    for suffix, identifier in HELPERS.items():
        yield frameworks / (name + suffix + ".app"), suffix, APP_ID + identifier
    yield app, "", APP_ID


def bundle_info(bundle):
    require_tree(bundle)
    plist = require_file(bundle / "Contents" / "Info.plist")
    raw = plist.read_bytes()
    return plist, raw, plistlib.loads(raw)


def rename_bundle(bundle, suffix, identifier):
    previous = OLD_NAME + suffix
    target = NEW_NAME + suffix
    plist, raw, info = bundle_info(bundle)
    require(
        info.get("CFBundleIdentifier") == identifier
        and info.get("CFBundleExecutable") == previous
        and info.get("CFBundleVersion") == BASE_VERSION,
        f"Unexpected base identity: {bundle.name}",
    )
    if not suffix:
        require(info.get("CFBundleShortVersionString") == BASE_VERSION, "Wrong base bundle version")
    if info.get("CFBundleShortVersionString") == BASE_VERSION:
        info["CFBundleShortVersionString"] = TARGET_VERSION
    info.update(
        CFBundleName=target,
        CFBundleDisplayName=target,
        CFBundleExecutable=target,
        CFBundleVersion=TARGET_VERSION,
    )
    executable = require_file(bundle / "Contents" / "MacOS" / previous)
    renamed_executable = executable.with_name(target)
    renamed_bundle = bundle.with_name(target + ".app")
    require(not renamed_executable.exists() and not renamed_bundle.exists(), "DocBogi destination already exists")
    executable.rename(renamed_executable)
    fmt = plistlib.FMT_BINARY if raw.startswith(b"bplist00") else plistlib.FMT_XML
    plist.write_bytes(plistlib.dumps(info, fmt=fmt, sort_keys=False))
    bundle.rename(renamed_bundle)
    resign(renamed_bundle)
    return renamed_bundle


def verify_universal(binary):
    require(set(command("lipo", "-archs", binary).stdout.split()) == {"arm64", "x86_64"},
            f"Wrong Mach-O slices: {binary.name}")


def verify_bundle(app, digest):
    frameworks = require_tree(app / "Contents" / "Frameworks")
    framework = require_tree(frameworks / "Electron Framework.framework")
    framework_alias = framework / "Electron Framework"
    framework_binary = framework_alias.resolve(strict=True)
    require(framework_binary.is_relative_to(framework / "Versions"), "Electron Framework binary escaped its bundle")
    verify_universal(require_file(framework_binary))

    for bundle, suffix, identifier in bundle_entries(app, NEW_NAME):
        target = NEW_NAME + suffix
        _, _, info = bundle_info(bundle)
        require(info.get("CFBundleIdentifier") == identifier and info.get("CFBundleVersion") == TARGET_VERSION,
                f"Wrong bundle identity or build version: {bundle.name}")
        for field in ("CFBundleName", "CFBundleDisplayName", "CFBundleExecutable"):
            require(info.get(field) == target, f"Wrong {field}: {bundle.name}")
        if not suffix:
            require(info.get("CFBundleShortVersionString") == TARGET_VERSION, "Wrong visible application version")
        verify_universal(require_file(bundle / "Contents" / "MacOS" / target))
        require(not (bundle / "Contents" / "MacOS" / (OLD_NAME + suffix)).exists(), "Stale executable")

    command("codesign", "--verify", "--deep", "--strict", app)
    signature = command("codesign", "--display", "--verbose=4", app).stderr
    require("Signature=adhoc" in signature.splitlines(), "Expected an ad-hoc application signature")

    resources = require_tree(app / "Contents" / "Resources" / "app")
    _, metadata = package_metadata(resources, TARGET_VERSION)
    require(metadata.get("productName") == NEW_NAME, "Wrong bundled product name")
    files = verified_dist(resources / "dist", digest)
    notices = verify_licenses(resources / "third-party-licenses")
    print(f"Verified signed Universal app with {len(files)} approved compiled files ({digest}).", flush=True)
    return notices


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("stage", "verify"))
    parser.add_argument("--app", type=Path, required=True)
    parser.add_argument("--expected-dist", required=True)
    parser.add_argument("--work", type=Path, required=True)
    parser.add_argument("--donor", type=Path)
    parser.add_argument("--archiver")
    args = parser.parse_args()
    require(FILE_HASH.fullmatch(args.expected_dist), "Invalid approved dist SHA-256")
    work = args.work.resolve(strict=True)
    app = require_tree(args.app)
    if args.mode == "verify":
        require(app == work / "final-mounted" / (NEW_NAME + ".app"), "App is outside the mounted installer")
        verify_bundle(app, args.expected_dist)
        return

    require(app == work / "volume" / (OLD_NAME + ".app"), "App is outside the staging volume")
    require(args.donor and args.archiver, "Staging requires an approved Windows donor and archive reader")
    donor = require_file(args.donor)
    require(donor == work / "windows-setup.exe", "Donor is outside the temporary build directory")
    payload = approved_compilation(args.archiver, donor, work)
    expected_licenses = replace_resources(app, payload, args.expected_dist)
    for bundle, suffix, identifier in list(bundle_entries(app, OLD_NAME)):
        target = rename_bundle(bundle, suffix, identifier)
    require(verify_bundle(target, args.expected_dist) == expected_licenses, "Bundled licenses changed while staging")
    create_fixtures(work / "fixtures")


if __name__ == "__main__":
    main()
