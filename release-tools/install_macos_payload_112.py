"""Stage a Universal Docvia app from the pinned Mac base and approved compiled Setup payload."""

import argparse
import hashlib
import json
import plistlib
import re
import shutil
import subprocess
from pathlib import Path, PurePosixPath

from patch_macos import create_fixtures, require, resign, tree_hash

BASE_VERSION = "1.1.1"
TARGET_VERSION = "1.1.2"
APP_ID = "com.docvia.desktop"
APP_ARCHIVE = "$PLUGINSDIR/app-64.7z"
PACKAGE = "resources/app/package.json"
DIST = "resources/app/dist"
LICENSES = "resources/app/third-party-licenses"
MAX_ENTRY_BYTES = 128 * 1024 * 1024
MAX_TREE_BYTES = 256 * 1024 * 1024
FILE_HASH = re.compile(r"[a-f0-9]{64}")
DENIED_SUFFIX = re.compile(r"\.(?:map|ts|tsx|pem|key|sqlite(?:-wal|-shm)?|db|log|exe|dll|node|msi|bat|cmd|ps1)$", re.I)
DENIED_DIRECTORY = re.compile(r"^(?:node_modules|tests?|source|output|tmp|logs?|credentials(?:\.json)?|auth\.json)$", re.I)


def file_digest(path):
    with path.open("rb") as file:
        return hashlib.file_digest(file, "sha256").hexdigest()


def regular(path):
    return path.is_file() and not path.is_symlink()


def safe_relative(name):
    text = name.replace("\\", "/")
    require(re.fullmatch(r"[^\x00-\x1f:]+", text), "Invalid archive path")
    parts = text.split("/")
    require(parts and all(part and part not in (".", "..") for part in parts), "Archive entry escaped its directory")
    relative = PurePosixPath(*parts)
    require(not relative.is_absolute(), "Absolute archive path")
    return relative


def ensure_allowed(relative):
    require(all(not part.startswith(".") and not DENIED_DIRECTORY.fullmatch(part) for part in relative.parts),
            "Compilation includes a private or transient path")
    require(not DENIED_SUFFIX.search(relative.name), "Compilation includes a source map or platform-specific file")


def zip_inventory(archiver, archive):
    result = subprocess.run([archiver, "l", "-slt", "-ba", str(archive)], text=True,
                            stdout=subprocess.PIPE, check=True, timeout=90)
    records = []
    for group in re.split(r"\n\s*\n", result.stdout):
        record = {}
        for line in group.splitlines():
            key, separator, value = line.partition(" = ")
            if separator:
                record[key] = value
        if "Path" in record:
            records.append((safe_relative(record["Path"]), record))
    return records


def no_links(record):
    attributes = record.get("Attributes", "")
    mode = record.get("Mode", "")
    require(not record.get("Symbolic Link") and not record.get("Hard Link") and
            not mode.startswith("l") and not re.search(r"(?:^|\s)l[rwx-]{9}(?:\s|$)", attributes),
            "Unexpected link in the donor archive")


def approved_compilation(archiver, donor, scratch):
    inventory = zip_inventory(archiver, donor)
    parts = [record for path, record in inventory if str(path) == APP_ARCHIVE]
    require(len(parts) == 1 and int(parts[0].get("Size", "0")) <= MAX_TREE_BYTES, "NSIS application archive is missing or oversized")
    no_links(parts[0])
    nsis = scratch / "nsis"
    nsis.mkdir()
    subprocess.run([archiver, "x", "-y", "-o" + str(nsis), str(donor), APP_ARCHIVE], check=True, timeout=150)
    embedded = nsis.joinpath(*PurePosixPath(APP_ARCHIVE).parts)
    require(regular(embedded) and embedded.resolve() == embedded, "Unsafe or missing NSIS application archive")

    output = scratch / "compiled"
    output.mkdir()
    expected = set()
    total = 0
    for relative, record in zip_inventory(archiver, embedded):
        subject = relative.as_posix()
        if not (subject == PACKAGE or subject == DIST or subject == LICENSES or
                subject.startswith(DIST + "/") or subject.startswith(LICENSES + "/")):
            continue
        no_links(record)
        ensure_allowed(relative)
        require(subject not in expected, "Donor contains a duplicate allowed path")
        expected.add(subject)
        size = int(record.get("Size", "0"))
        require(0 <= size <= MAX_ENTRY_BYTES, "Oversized donor file")
        total += size
        require(total <= MAX_TREE_BYTES, "Oversized donor application data")
    require(PACKAGE in expected, "Donor is missing package.json")
    subprocess.run([archiver, "x", "-y", "-r", "-o" + str(output), str(embedded),
                    PACKAGE, DIST + "/*", LICENSES + "/*"], check=True, timeout=180)
    extracted = output / "resources" / "app"
    require(extracted.is_dir() and extracted.resolve() == extracted, "Unsafe compiled application directory")
    for entry in output.rglob("*"):
        require(not entry.is_symlink() and entry.resolve() == entry, "Donor extraction returned a link")
        if not entry.is_dir():
            require(entry.is_file() and entry.relative_to(output).as_posix() in expected, "Unexpected extracted file")
    return extracted


def safe_tree(directory):
    require(directory.is_dir() and directory.resolve() == directory, "Unsafe source or destination tree")
    output = {}
    total = 0
    for entry in directory.rglob("*"):
        require(not entry.is_symlink(), "Unexpected link in a build tree")
        relative = safe_relative(entry.relative_to(directory).as_posix())
        ensure_allowed(relative)
        if entry.is_dir():
            continue
        require(entry.is_file(), "Build tree contains an unsupported entry")
        size = entry.stat().st_size
        total += size
        require(size <= MAX_ENTRY_BYTES and total <= MAX_TREE_BYTES, "Build tree size exceeded")
        output[relative.as_posix()] = file_digest(entry)
    return output


def verify_licenses(directory):
    files = safe_tree(directory)
    require("manifest.json" in files, "Third-party notices manifest is missing")
    manifest = json.loads((directory / "manifest.json").read_text(encoding="utf-8"))
    expected = {}
    for package in manifest["packages"]:
        for notice in package["files"]:
            path = safe_relative(notice["path"]).as_posix()
            require(path not in expected and FILE_HASH.fullmatch(notice["sha256"]), "Invalid third-party notice")
            expected[path] = notice["sha256"]
    actual = {path: digest for path, digest in files.items() if path != "manifest.json"}
    require(expected and expected == actual, "Third-party notices do not match their manifest")
    return files


def update_plist(bundle, main):
    plist = bundle / "Contents" / "Info.plist"
    require(regular(plist) and plist.resolve() == plist, "Unsafe application Info.plist")
    data = plist.read_bytes()
    resource = plistlib.loads(data)
    identifier = resource.get("CFBundleIdentifier", "")
    if main:
        require(identifier == APP_ID and resource.get("CFBundleShortVersionString") == BASE_VERSION, "The base app metadata differs")
    else:
        require(identifier == APP_ID + ".helper" or identifier.startswith(APP_ID + ".helper."), "Unexpected helper app")
    changed = False
    for key in ("CFBundleShortVersionString", "CFBundleVersion"):
        if resource.get(key) == BASE_VERSION:
            resource[key] = TARGET_VERSION
            changed = True
    if changed:
        fmt = plistlib.FMT_BINARY if data.startswith(b"bplist00") else plistlib.FMT_XML
        plist.write_bytes(plistlib.dumps(resource, fmt=fmt, sort_keys=False))
    return changed


def replace_resources(app, donor, expected_hash):
    require(app.name == "Docvia.app" and app.is_dir() and app.resolve() == app, "Unsafe staging bundle")
    resources = app / "Contents" / "Resources" / "app"
    require(resources.is_dir() and resources.resolve() == resources, "Unsafe destination application resources")
    incoming_package = donor / "package.json"
    require(regular(incoming_package), "Donor manifest is missing")
    incoming = json.loads(incoming_package.read_text(encoding="utf-8"))
    require(incoming.get("name") == "docvia" and incoming.get("main") == "dist/main.cjs" and incoming.get("version") == TARGET_VERSION,
            "Wrong donor application or version")
    compiled = safe_tree(donor / "dist")
    require({"main.cjs", "preload.cjs", "extractor-worker.cjs", "pdf-text.mjs",
             "renderer/index.html", "pdf-renderer/index.html"}.issubset(compiled), "Required compiled entry is missing")
    require(tree_hash(compiled) == expected_hash, "Compiled donor tree does not match the approved dist SHA-256")
    license_tree = verify_licenses(donor / "third-party-licenses")

    package = resources / "package.json"
    require(regular(package), "The base Mac package metadata is missing")
    original = package.read_bytes()
    metadata = json.loads(original)
    require(metadata.get("name") == "docvia" and metadata.get("main") == "dist/main.cjs" and metadata.get("version") == BASE_VERSION,
            "Wrong base Mac application")
    changed, count = re.subn(rb'("version"\s*:\s*)"1\.1\.1"', rb'\g<1>"1.1.2"', original)
    require(count == 1 and json.loads(changed)["version"] == TARGET_VERSION, "Could not preserve base metadata while updating its version")
    for name in ("dist", "third-party-licenses"):
        target = resources / name
        require(target.is_dir() and target.resolve() == target, "Unsafe destination payload directory")
        shutil.rmtree(target)
        shutil.copytree(donor / name, target, symlinks=True)
    package.write_bytes(changed)

    for helper in sorted((app / "Contents" / "Frameworks").glob("Docvia Helper*.app")):
        require(helper.is_dir() and helper.resolve() == helper, "Unsafe helper bundle")
        if update_plist(helper, False):
            resign(helper)
    require(update_plist(app, True), "Base bundle version could not be updated")
    resign(app)
    require(safe_tree(resources / "dist") == compiled and verify_licenses(resources / "third-party-licenses") == license_tree,
            "The bundled compilation or notices changed while resigning")
    print(f"Approved compiled dist contains {len(compiled)} files · {expected_hash}", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app", type=Path, required=True)
    parser.add_argument("--donor", type=Path, required=True)
    parser.add_argument("--expected-dist", required=True)
    parser.add_argument("--work", type=Path, required=True)
    parser.add_argument("--archiver", required=True)
    args = parser.parse_args()
    require(FILE_HASH.fullmatch(args.expected_dist), "Invalid approved dist SHA-256")
    work = args.work.resolve(strict=True)
    donor = args.donor.resolve(strict=True)
    require(regular(donor) and donor.parent == work, "Donor is outside the temporary build directory")
    app = args.app.resolve(strict=True)
    require(app == work / "volume" / "Docvia.app", "App is outside the temporary build directory")
    payload = approved_compilation(args.archiver, donor, work)
    replace_resources(app, payload, args.expected_dist)
    create_fixtures(work / "fixtures")


if __name__ == "__main__":
    main()
