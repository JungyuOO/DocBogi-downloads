"""Stage and verify the Universal DocBogi 1.1.4 installer payload."""

import argparse
import json
import plistlib
import shutil
from pathlib import Path

from install_macos_payload_112 import FILE_HASH, approved_compilation, verify_licenses
from install_macos_payload_113 import (
    bundle_entries,
    bundle_info,
    command,
    package_metadata,
    require_file,
    require_tree,
    verified_dist,
    verify_universal,
)
from patch_macos import create_fixtures, require, resign

BASE_VERSION = "1.1.3"
TARGET_VERSION = "1.1.4"
NAME = "DocBogi"


def checked_bundle_info(bundle, suffix, identifier, version):
    plist, raw, info = bundle_info(bundle)
    name = NAME + suffix
    require(info.get("CFBundleIdentifier") == identifier and info.get("CFBundleVersion") == version,
            f"Unexpected bundle identity or build version: {bundle.name}")
    for field in ("CFBundleName", "CFBundleDisplayName", "CFBundleExecutable"):
        require(info.get(field) == name, f"Unexpected {field}: {bundle.name}")
    if not suffix:
        require(info.get("CFBundleShortVersionString") == version, "Unexpected visible app version")
    return plist, raw, info


def replace_resources(app, donor, digest, *, base_version=BASE_VERSION, target_version=TARGET_VERSION):
    _, donor_metadata = package_metadata(donor, target_version)
    require(donor_metadata.get("productName") == NAME, "Unexpected Windows donor product name")
    verified_dist(donor / "dist", digest)
    notices = verify_licenses(donor / "third-party-licenses")

    resources = require_tree(app / "Contents" / "Resources" / "app")
    package, metadata = package_metadata(resources, base_version)
    require(metadata.get("productName") == NAME, "Unexpected base product name")
    for directory in ("dist", "third-party-licenses"):
        destination = require_tree(resources / directory)
        shutil.rmtree(destination)
        shutil.copytree(donor / directory, destination)
    metadata["version"] = target_version
    package.write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return notices


def verify_bundle(app, digest, *, target_version=TARGET_VERSION):
    framework = require_tree(app / "Contents" / "Frameworks" / "Electron Framework.framework")
    framework_binary = (framework / "Electron Framework").resolve(strict=True)
    require(framework_binary.is_relative_to(framework / "Versions"), "Electron Framework binary escaped its bundle")
    verify_universal(require_file(framework_binary))
    for bundle, suffix, identifier in bundle_entries(app, NAME):
        checked_bundle_info(bundle, suffix, identifier, target_version)
        verify_universal(require_file(bundle / "Contents" / "MacOS" / (NAME + suffix)))
        require(not (bundle / "Contents" / "MacOS" / ("Docvia" + suffix)).exists(), "Unexpected old executable")
    command("codesign", "--verify", "--deep", "--strict", app)
    signature = command("codesign", "--display", "--verbose=4", app).stderr
    require("Signature=adhoc" in signature.splitlines(), "Expected an ad-hoc application signature")

    resources = require_tree(app / "Contents" / "Resources" / "app")
    _, metadata = package_metadata(resources, target_version)
    require(metadata.get("productName") == NAME, "Unexpected staged product name")
    files = verified_dist(resources / "dist", digest)
    notices = verify_licenses(resources / "third-party-licenses")
    print(f"Verified {len(files)} approved compiled files and a signed Universal app ({digest}).", flush=True)
    return notices


def main(*, base_version=BASE_VERSION, target_version=TARGET_VERSION):
    parser = argparse.ArgumentParser(description=f"Stage and verify the Universal DocBogi {target_version} installer payload.")
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
        require(app == work / "final-mounted" / (NAME + ".app"), "Application is outside the mounted installer")
        verify_bundle(app, args.expected_dist, target_version=target_version)
        return

    require(app == work / "volume" / (NAME + ".app"), "Application is outside the staging volume")
    require(args.donor and args.archiver, "Staging requires a Windows donor and archive reader")
    donor = require_file(args.donor)
    require(donor == work / "windows-setup.exe", "Donor is outside the temporary build directory")
    for bundle, suffix, identifier in bundle_entries(app, NAME):
        checked_bundle_info(bundle, suffix, identifier, base_version)
    payload = approved_compilation(args.archiver, donor, work)
    expected_notices = replace_resources(app, payload, args.expected_dist, base_version=base_version, target_version=target_version)

    for bundle, suffix, identifier in bundle_entries(app, NAME):
        plist, raw, info = checked_bundle_info(bundle, suffix, identifier, base_version)
        info["CFBundleVersion"] = target_version
        if info.get("CFBundleShortVersionString") == base_version:
            info["CFBundleShortVersionString"] = target_version
        fmt = plistlib.FMT_BINARY if raw.startswith(b"bplist00") else plistlib.FMT_XML
        plist.write_bytes(plistlib.dumps(info, fmt=fmt, sort_keys=False))
        resign(bundle)

    require(verify_bundle(app, args.expected_dist, target_version=target_version) == expected_notices, "Bundled notices changed while staging")
    create_fixtures(work / "fixtures")


if __name__ == "__main__":
    main()
