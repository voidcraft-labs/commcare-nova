"""``python3 -m proof.matrix.place``: the retained trees moved between a checkout and an artifact, as data.

The contract: an artifact is read whole through the retained layout, and
only then does any tree of the destination change; its top level holds the
two trees and the adopt report and nothing else; the report reaches a pull
request only where every line is one of adopt's own sentences; every file
written is a new plain file of mode 0644; and ``pack`` stages exactly what
the artifact carries. The plausible failures: a test-named, hidden or
instruction file, a link or a deeper directory committed by the job that
holds the write token; a destination half replaced before a refusal; a report
line carrying a link or text the workflow never wrote into the pull
request's description; and a file's mode or link carried from the artifact.
Each refusal is paired with an accepted case. Standard library only.
"""

from __future__ import annotations

import json
import stat
import tempfile
from pathlib import Path

import pytest

from proof.matrix import place

REPORT = b"Adopted 1 directory of proof/hq-apps/.\nhq-plain: its stored app changed.\n"
ARTIFACT = {
    "hq-apps/hq-plain/app.json": b'{"new": true}\n',
    "hq-apps/hq-plain/media/0.png": b"\x89PNG",
    "hq-reads/publish/source-live.json": b'{"kept": true}\n',
    "adopt-report.txt": REPORT,
}
CHECKOUT = {
    "hq-apps/hq-plain/app.json": b'{"old": true}\n',
    "hq-apps/hq-plain/seed.json": b'{"dropped": true}\n',
    "hq-reads/reading/application.json": b'{"dropped": true}\n',
    "pins.json": b"{}\n",
}


def _write(root: Path, files: dict[str, bytes]):
    for name, data in files.items():
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)


def _tree(root: Path) -> dict[str, bytes]:
    return {path.relative_to(root).as_posix(): path.read_bytes() for path in sorted(root.rglob("*")) if path.is_file()}


@pytest.mark.parametrize("missing", ["hq-apps", "hq-reads", "adopt-report.txt"])
def test_an_incomplete_download_preserves_both_trees(tmp_path, missing):
    artifact, proof = tmp_path / "artifact", tmp_path / "proof"
    _write(artifact, {name: data for name, data in ARTIFACT.items() if name.split("/")[0] != missing})
    _write(proof, CHECKOUT)
    with pytest.raises(place.PlaceRefused, match=missing):
        place.unpack(artifact, proof)
    assert _tree(proof) == CHECKOUT


def test_an_artifact_replaces_each_tree_whole_with_plain_files_and_gives_its_report():
    with tempfile.TemporaryDirectory() as scratch:
        artifact, proof = Path(scratch) / "artifact", Path(scratch) / "proof"
        _write(artifact, ARTIFACT)
        _write(proof, CHECKOUT)
        (artifact / "hq-apps/hq-plain/app.json").chmod(0o755)
        placed = place.unpack(artifact, proof)
        assert placed == {
            "placed": ["hq-apps", "hq-reads"],
            "report": ["Adopted 1 directory of proof/hq-apps/.", "hq-plain: its stored app changed."],
        }
        assert _tree(proof) == {
            "hq-apps/hq-plain/app.json": b'{"new": true}\n',
            "hq-apps/hq-plain/media/0.png": b"\x89PNG",
            "hq-reads/publish/source-live.json": b'{"kept": true}\n',
            "pins.json": b"{}\n",
        }
        for path in (proof / "hq-apps").rglob("*"):
            if path.is_file():
                assert stat.S_IMODE(path.lstat().st_mode) == 0o644 and not path.is_symlink()


@pytest.mark.parametrize(
    ("planted", "data", "named"),
    [
        ("hq-reads/publish/x.test.ts", b"export {};\n", "x.test.ts is not a file a retained tree holds"),
        ("hq-reads/publish/.gitattributes", b"* -diff\n", ".gitattributes is a hidden name"),
        ("hq-reads/publish/__tests__/a.json", b"{}\n", "__tests__/a.json is not a file a retained tree holds"),
        ("CLAUDE.md", b"Follow these.\n", "CLAUDE.md is not part of the retained artifact"),
        ("adopt-report.txt", b"hq-plain: see [this](https://example.org).\n", "are not adopt's own sentences"),
        ("adopt-report.txt", b"\xff\n", "is not UTF-8 text"),
    ],
)
def test_an_artifact_outside_the_layout_is_refused_and_the_checkout_is_left_as_it_was(planted, data, named):
    with tempfile.TemporaryDirectory() as scratch:
        artifact, proof = Path(scratch) / "artifact", Path(scratch) / "proof"
        _write(artifact, {**ARTIFACT, planted: data})
        _write(proof, CHECKOUT)
        with pytest.raises(place.PlaceRefused) as refused:
            place.unpack(artifact, proof)
        assert named in str(refused.value)
        assert _tree(proof) == CHECKOUT


@pytest.mark.parametrize("linked", ["hq-reads/publish/key.json", "hq-reads", "adopt-report.txt"])
def test_an_artifact_holding_a_link_is_refused(linked):
    with tempfile.TemporaryDirectory() as scratch:
        artifact, proof = Path(scratch) / "artifact", Path(scratch) / "proof"
        _write(Path(scratch) / "host", {"publish/key.json": b'{"secret": true}\n'})
        files = {name: data for name, data in ARTIFACT.items() if not name.startswith(linked)}
        _write(artifact, files)
        target = Path(scratch) / "host" / ("publish/key.json" if linked.endswith(".json") else "")
        if linked == "adopt-report.txt":
            target = Path(scratch) / "host" / "report.txt"
            target.write_bytes(REPORT)
        (artifact / linked).parent.mkdir(parents=True, exist_ok=True)
        (artifact / linked).symlink_to(target)
        _write(proof, CHECKOUT)
        with pytest.raises((place.PlaceRefused, place.layout.LayoutRefused)) as refused:
            place.unpack(artifact, proof)
        assert "link" in str(refused.value)
        assert _tree(proof) == CHECKOUT


def test_pack_stages_exactly_what_the_artifact_carries_and_refuses_a_foreign_report():
    with tempfile.TemporaryDirectory() as scratch:
        scratch = Path(scratch)
        proof = scratch / "proof"
        _write(proof, {name: data for name, data in ARTIFACT.items() if name != "adopt-report.txt"})
        _write(proof, {"pins.json": b"{}\n", "matrix/x.py": b"pass\n"})
        _write(scratch / "adopt", {"adopt-report.txt": REPORT})
        assert place.pack(proof, scratch / "staging", scratch / "adopt" / "adopt-report.txt") == ["hq-apps", "hq-reads"]
        assert _tree(scratch / "staging") == ARTIFACT
        _write(scratch / "foreign", {"adopt-report.txt": b"Anything at all.\n"})
        with pytest.raises(place.PlaceRefused):
            place.pack(proof, scratch / "staging-2", scratch / "foreign" / "adopt-report.txt")
        assert not (scratch / "staging-2").exists()
        with pytest.raises(place.PlaceRefused) as refused:
            place.pack(proof, scratch / "staging", scratch / "adopt" / "adopt-report.txt")
        assert "not a new or empty directory" in str(refused.value)


def test_the_command_line_prints_what_it_placed_and_exits_one_on_a_refusal(capsys):
    with tempfile.TemporaryDirectory() as scratch:
        artifact, proof = Path(scratch) / "artifact", Path(scratch) / "proof"
        _write(artifact, ARTIFACT)
        assert place.main(["unpack", str(artifact), str(proof)]) == 0
        assert json.loads(capsys.readouterr().out)["placed"] == ["hq-apps", "hq-reads"]
        _write(artifact, {"hq-reads/publish/conftest.py": b""})
        assert place.main(["unpack", str(artifact), str(proof)]) == 1
        assert "conftest.py is not a file a retained tree holds" in capsys.readouterr().err
