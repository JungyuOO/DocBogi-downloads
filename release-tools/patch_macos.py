"""Update version metadata on a staged, verified Docvia macOS app."""

import argparse
import hashlib
import json
import plistlib
import re
import subprocess
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

BASE_VERSION = "1.0.9"
TARGET_VERSION = "1.1.0"
APP_ID = "com.docvia.desktop"
RENDERER_TREE_SHA256 = "0ec2c2bd730028bfc208d3c69b8891319b296a9a6112e5b91d1a85ffeb5b66f6"


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def renderer_tree(renderer):
    require(renderer.is_dir() and not renderer.is_symlink(), "Invalid renderer directory")
    entries = {}
    for path in renderer.rglob("*"):
        require(not path.is_symlink(), f"Unexpected renderer symlink: {path.name}")
        if not path.is_dir():
            require(path.is_file(), f"Unexpected renderer entry: {path.name}")
            entries[path.relative_to(renderer).as_posix()] = sha256(path.read_bytes())
    return entries


def tree_hash(entries):
    records = (f"{path}\0{entries[path]}\n" for path in sorted(entries))
    return sha256("".join(records).encode("utf-8"))


def update_bundle_version(bundle, accepted_id, root=False):
    plist = bundle / "Contents" / "Info.plist"
    require(plist.is_file() and not plist.is_symlink(), "Missing bundle plist")
    raw = plist.read_bytes()
    info = plistlib.loads(raw)
    require(accepted_id(info.get("CFBundleIdentifier", "")), f"Unexpected bundle identifier: {bundle.name}")
    if root:
        require(info.get("CFBundleShortVersionString") == BASE_VERSION, "Unexpected base app version")
    changed = False
    for key in ("CFBundleShortVersionString", "CFBundleVersion"):
        if info.get(key) == BASE_VERSION:
            info[key] = TARGET_VERSION
            changed = True
    if changed:
        fmt = plistlib.FMT_BINARY if raw.startswith(b"bplist00") else plistlib.FMT_XML
        plist.write_bytes(plistlib.dumps(info, fmt=fmt, sort_keys=False))
    return changed


def resign(bundle):
    subprocess.run(
        [
            "/usr/bin/codesign", "--force", "--sign", "-", "--timestamp=none",
            "--preserve-metadata=identifier,entitlements,flags,runtime", str(bundle),
        ],
        check=True,
    )


def update_app(app):
    require(app.name == "Docvia.app" and app.is_dir() and not app.is_symlink(), "Invalid staged app")
    resources = app / "Contents" / "Resources" / "app"
    require(resources.resolve() == resources and resources.is_dir(), "Unsafe app resources directory")
    package = resources / "package.json"
    require(package.is_file() and not package.is_symlink(), "Missing app package metadata")
    raw_package = package.read_bytes()
    require(json.loads(raw_package).get("version") == BASE_VERSION, "Base package version differs")
    package_bytes, count = re.subn(
        rb'("version"\s*:\s*)"1\.0\.9"', rb'\g<1>"1.1.0"', raw_package,
    )
    require(count == 1 and json.loads(package_bytes)["version"] == TARGET_VERSION, "Cannot update package version")

    renderer = resources / "dist" / "renderer"
    require(tree_hash(renderer_tree(renderer)) == RENDERER_TREE_SHA256, "Base renderer tree does not match")
    package.write_bytes(package_bytes)
    frameworks = app / "Contents" / "Frameworks"
    for helper in sorted(frameworks.glob("Docvia Helper*.app")):
        require(helper.is_dir() and not helper.is_symlink(), "Unsafe helper bundle")
        if update_bundle_version(
            helper,
            lambda identifier: identifier == APP_ID + ".helper" or identifier.startswith(APP_ID + ".helper."),
        ):
            resign(helper)
    update_bundle_version(app, lambda identifier: identifier == APP_ID, root=True)
    resign(app)
    require(tree_hash(renderer_tree(renderer)) == RENDERER_TREE_SHA256, "Renderer changed during packaging")
    print(f"Updated bundle metadata {BASE_VERSION} → {TARGET_VERSION} and verified the unchanged renderer")


def create_fixtures(directory):
    directory.mkdir()
    types = """<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>"""
    relationships = """<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>"""
    for index in range(1, 4):
        document = f"""<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body><w:p><w:r><w:t>Docvia 1.1.0 layout fixture {index}</w:t></w:r></w:p></w:body>
</w:document>"""
        with ZipFile(directory / f"layout-fixture-{index}.docx", "x", ZIP_DEFLATED) as archive:
            archive.writestr("[Content_Types].xml", types)
            archive.writestr("_rels/.rels", relationships)
            archive.writestr("word/document.xml", document)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("app", type=Path)
    parser.add_argument("--fixtures", type=Path, required=True)
    args = parser.parse_args()
    app = args.app.absolute()
    require(app.resolve() == app, "Unsafe staged app path")
    update_app(app)
    create_fixtures(args.fixtures)


if __name__ == "__main__":
    main()
