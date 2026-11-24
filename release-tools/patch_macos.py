"""Apply only the verified v1.0.9 renderer delta to a staged, released Docvia app."""

import argparse
import hashlib
import json
import plistlib
import re
import subprocess
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

BASE_VERSION = "1.0.8"
TARGET_VERSION = "1.0.9"
APP_ID = "com.docvia.desktop"
OLD_MEDIA_RULE = b"(height<=460px){.workspace{overflow:hidden auto"
NEW_MEDIA_RULE = b"(height<=600px){.workspace{overflow:hidden auto"
RENDERER_PATH = re.compile(r"(?:index\.html|assets/[A-Za-z0-9_.-]+\.(?:js|css))")
SHA256 = re.compile(r"[0-9a-f]{64}")


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


def apply_delta(renderer, manifest):
    base = renderer_tree(renderer)
    require(tree_hash(base) == manifest["baseTree"], "Base renderer tree does not match")
    changes = manifest["files"]
    require(len(changes) == 5, "Expected exactly five modified renderer files")
    old_paths = set()
    new_paths = set()
    renamed = {}
    for change in changes:
        old, new = change["old"], change["new"]
        require(RENDERER_PATH.fullmatch(old) and RENDERER_PATH.fullmatch(new), "Unsafe renderer path")
        require(old not in old_paths and new not in new_paths, "Duplicate delta path")
        old_paths.add(old)
        new_paths.add(new)
        require(old in base and base[old] == change["before"], f"Base digest differs: {old}")
        require(SHA256.fullmatch(change["after"]), f"Invalid expected digest: {new}")
        if old != new:
            require(old.startswith("assets/") and new.startswith("assets/"), "Only assets may be renamed")
            require(Path(old).suffix == Path(new).suffix and new not in base, f"Unsafe rename: {new}")
            renamed[Path(old).name.encode()] = Path(new).name.encode()
        else:
            require(old == "index.html", f"Expected a renamed asset: {old}")
    require("index.html" in old_paths, "Delta is missing index.html")
    rename_pattern = re.compile(b"|".join(re.escape(name) for name in sorted(renamed, key=len, reverse=True)))

    prepared = {}
    css_hits = 0
    expected_tree = {path: digest for path, digest in base.items() if path not in old_paths}
    for change in changes:
        old, new = change["old"], change["new"]
        content = (renderer / old).read_bytes()
        require(sha256(content) == change["before"], f"Base file changed: {old}")
        content = rename_pattern.sub(lambda match: renamed[match.group()], content)
        if old.endswith(".css"):
            css_hits += content.count(OLD_MEDIA_RULE)
            content = content.replace(OLD_MEDIA_RULE, NEW_MEDIA_RULE)
        require(sha256(content) == change["after"], f"Patched digest differs: {new}")
        prepared[new] = content
        expected_tree[new] = change["after"]
    require(css_hits == 1, f"Expected one compact-layout rule, found {css_hits}")
    require(tree_hash(expected_tree) == manifest["newTree"], "Expected renderer tree differs")

    for relpath, content in prepared.items():
        with (renderer / relpath).open("wb" if relpath == "index.html" else "xb") as destination:
            destination.write(content)
    for relpath in old_paths - new_paths:
        (renderer / relpath).unlink()
    require(tree_hash(renderer_tree(renderer)) == manifest["newTree"], "Final renderer tree differs")


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
        rb'("version"\s*:\s*)"1\.0\.8"', rb'\g<1>"1.0.9"', raw_package,
    )
    require(count == 1 and json.loads(package_bytes)["version"] == TARGET_VERSION, "Cannot update package version")

    manifest = json.loads(Path(__file__).with_name("delta-1.0.9.json").read_text(encoding="utf-8"))
    require(manifest["base"] == BASE_VERSION and manifest["version"] == TARGET_VERSION, "Delta versions differ")
    apply_delta(resources / "dist" / "renderer", manifest)
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
    print(f"Applied verified renderer delta {BASE_VERSION} → {TARGET_VERSION}")


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
  <w:body><w:p><w:r><w:t>Docvia 1.0.9 layout fixture {index}</w:t></w:r></w:p></w:body>
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
