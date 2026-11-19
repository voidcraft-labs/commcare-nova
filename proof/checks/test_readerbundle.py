"""The reader bundle a judge runs is the one the corpus job built, sharp's runtime beside it included.

Contract (``proof.checks.readerbundle.held_bundle``): a bundle directory is
held when ``reader.mjs`` is the file ``reader.json`` names and every file
under ``node_modules/`` is the one ``runtime.json`` names by its path and
sha256, and no file it names is missing (``proof/reader/build.mjs`` writes
all three in one build; ``proof/ci/products.mjs::runtimeRecord`` holds the
same rule across platforms). The plausible failures: a judge that runs a
bundle whose sharp was changed, added to or left out after the build, so a
picture's verdict comes from a runtime nothing keyed, and a bundle with no
runtime record at all, which loads no sharp in a shard. Each refusal changes
one thing in a directory the accepted case holds.
"""

from __future__ import annotations

import hashlib
import json

import pytest

from proof.checks import readerbundle

RUNTIME = {
    "node_modules/sharp/package.json": b'{"name": "sharp"}',
    "node_modules/sharp/lib/index.js": b"module.exports = {};",
    "node_modules/@img/sharp-linux-x64/lib/sharp.node": b"\x7fELF binding",
}


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _bundle(directory):
    """A bundle directory as the corpus job writes one: the bundle, its digest, the runtime and its record."""
    bundle = b"export {};\n"
    (directory / readerbundle.BUNDLE).write_bytes(bundle)
    (directory / readerbundle.DIGEST).write_text(json.dumps({"sha256": _sha256(bundle)}), encoding="utf-8")
    for path, data in RUNTIME.items():
        (directory / path).parent.mkdir(parents=True, exist_ok=True)
        (directory / path).write_bytes(data)
    record = {
        "platform": "linux-x64",
        "versions": {"sharp": "0.0.0"},
        "packages": {"node_modules/sharp": "0.0.0"},
        "files": {path: _sha256(data) for path, data in RUNTIME.items()},
    }
    (directory / readerbundle.RUNTIME).write_text(json.dumps(record), encoding="utf-8")
    return directory


def test_a_bundle_with_the_runtime_its_record_names_is_held(tmp_path):
    directory = _bundle(tmp_path)
    assert readerbundle.held_bundle(directory, "the corpus") == directory / readerbundle.BUNDLE


def test_a_runtime_file_its_record_does_not_name_is_refused_by_name(tmp_path):
    directory = _bundle(tmp_path)
    (directory / "node_modules/sharp/lib/extra.js").write_bytes(b"planted")
    with pytest.raises(readerbundle.ReaderBundleMissing, match="node_modules/sharp/lib/extra.js is not named"):
        readerbundle.held_bundle(directory, "the corpus")


def test_a_runtime_file_changed_after_the_build_is_refused_by_name(tmp_path):
    directory = _bundle(tmp_path)
    (directory / "node_modules/@img/sharp-linux-x64/lib/sharp.node").write_bytes(b"\x7fELF another binding")
    with pytest.raises(readerbundle.ReaderBundleMissing, match="sharp.node is not the file runtime.json names"):
        readerbundle.held_bundle(directory, "the corpus")


def test_a_runtime_file_its_record_names_and_the_directory_lacks_is_refused_by_name(tmp_path):
    directory = _bundle(tmp_path)
    (directory / "node_modules/sharp/lib/index.js").unlink()
    with pytest.raises(readerbundle.ReaderBundleMissing, match="index.js is named in runtime.json and missing"):
        readerbundle.held_bundle(directory, "the corpus")


def test_a_bundle_with_no_runtime_record_is_refused_by_name(tmp_path):
    directory = _bundle(tmp_path)
    (directory / readerbundle.RUNTIME).unlink()
    with pytest.raises(readerbundle.ReaderBundleMissing, match="no readable runtime.json"):
        readerbundle.held_bundle(directory, "the corpus")
