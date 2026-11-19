"""``proof.matrix.layout``: the one reader of a retained tree, over real directories.

The contract: what a run or an artifact wrote is read as data, so every name,
type and size outside ``proof/matrix/retained-layout.json`` is refused by
name, nothing is read through a link, and the checkout's own trees hold to the
layout. The plausible failures: a planted test module, conftest.py, agent
instruction file or hidden git file adopted into a tree a runner or a coding
agent then reads; a link that copies a host file (a key, a cloud credential)
into a tree a pull request publishes; a pipe that holds the host reading it;
a ``media.json`` row that makes a reader open a path outside its base; and a
stray file in ``proof/hq-reads/`` that no other test holds. Each refusal is
paired with an accepted case. Standard library only.
"""

from __future__ import annotations

import dataclasses
import json
import os
import tempfile
from pathlib import Path

import pytest

from proof.matrix import layout

PROOF = Path(__file__).resolve().parents[1]
APP = b'{"id": "x"}\n'


def _write(root: Path, files: dict[str, bytes]):
    for name, data in files.items():
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)


def _refusal(root: Path, tree: str, retained=None) -> str:
    with pytest.raises(layout.LayoutRefused) as refused:
        layout.read_tree(root, tree, tree=tree, layout=retained)
    return str(refused.value)


def test_the_checkouts_own_trees_hold_to_the_layout_file_for_file():
    for tree in layout.TREES:
        read = layout.read_tree(PROOF, tree, tree=tree)
        on_disk = sum(len(files) for _, _, files in os.walk(PROOF / tree))
        assert sum(len(members) for members in read.values()) == on_disk > 0


ACCEPTED = {
    "hq-reads/reading/app-source-after-addOns.json": b"{}\n",
    "hq-reads/case-list-inline/ownership.json": b"[]\n",
    "hq-apps/hq-plain/app.json": APP,
    "hq-apps/hq-plain/fixture-rows-crop-types.json": b"[]\n",
    "hq-apps/hq-media/media.json": json.dumps([{"path": "jr://file/a.mp4", "file": "media/12.mp4"}]).encode(),
    "hq-apps/hq-media/media/12.mp4": b"\x00\x00\x00\x18ftypmp42",
}


def test_each_shape_a_tree_holds_is_read_member_for_member():
    with tempfile.TemporaryDirectory() as scratch:
        root = Path(scratch)
        _write(root, ACCEPTED)
        assert layout.read_tree(root, "hq-reads", tree="hq-reads") == {
            "case-list-inline": {"ownership.json": b"[]\n"},
            "reading": {"app-source-after-addOns.json": b"{}\n"},
        }
        apps = layout.read_tree(root, "hq-apps", tree="hq-apps")
        assert sorted(apps["hq-media"]) == ["media.json", "media/12.mp4"]
        assert apps["hq-plain"]["fixture-rows-crop-types.json"] == b"[]\n"
        assert layout.read_base(root / "hq-apps" / "hq-plain") == apps["hq-plain"]
        assert layout.read_tree(root, "absent", tree="hq-apps") == {}


@pytest.mark.parametrize(
    ("planted", "named"),
    [
        ("hq-reads/reading/x.test.ts", "x.test.ts is not a file a retained tree holds"),
        ("hq-reads/reading/conftest.py", "conftest.py is not a file a retained tree holds"),
        ("hq-reads/reading/test_x.py", "test_x.py is not a file a retained tree holds"),
        ("hq-reads/reading/.gitattributes", ".gitattributes is a hidden name"),
        ("hq-reads/reading/CLAUDE.md", "CLAUDE.md is not a file a retained tree holds"),
        ("hq-reads/reading/__tests__/a.json", "__tests__/a.json is not a file a retained tree holds"),
        ("hq-reads/reading/a.JSON", "a.JSON is not a file a retained tree holds"),
        ("hq-reads/read_ing/a.json", "read_ing is no group name"),
        ("hq-reads/top.json", "top.json is a file at the top of the tree"),
        ("hq-apps/not-a-base/app.json", "not-a-base is no base proof/matrix/bases.json lists"),
        ("hq-apps/hq-plain/stale.json", "stale.json is not a file a retained tree holds"),
        ("hq-apps/hq-plain/media/0.exe", "media/0.exe is not a file a retained tree holds"),
        ("hq-apps/hq-plain/media/01.png", "media/01.png is not a file a retained tree holds"),
        ("hq-apps/hq-plain/media/a/b/0.png", "is a directory deeper than a retained tree goes"),
        ("hq-reads/reading/.conftest.py.7.partial", "an unfinished write of conftest.py, which is not a file"),
        ("hq-apps/hq-plain/media/.0.exe.7.partial", "an unfinished write of 0.exe, which is not a file"),
        ("hq-reads/reading/.a.json.x.partial", ".a.json.x.partial is a hidden name"),
    ],
)
def test_a_name_outside_the_layout_is_refused_by_name(planted, named):
    with tempfile.TemporaryDirectory() as scratch:
        root = Path(scratch)
        _write(root, {**ACCEPTED, planted: b"{}\n"})
        tree = planted.split("/")[0]
        assert named in _refusal(root, tree)


def test_an_unfinished_write_of_a_member_is_passed_over_unread():
    # A run stopped between ``retained.write_whole``'s write and its rename leaves the write beside its name: no file
    # the run made, so it is neither read nor refused, whatever it holds.
    with tempfile.TemporaryDirectory() as scratch:
        root = Path(scratch)
        _write(
            root,
            {
                **ACCEPTED,
                "hq-reads/reading/.app-source-after-addOns.json.4242.partial": b"{",
                "hq-apps/hq-media/media/.12.mp4.7.partial": b"\x00",
            },
        )
        assert layout.read_tree(root, "hq-reads", tree="hq-reads")["reading"] == {
            "app-source-after-addOns.json": b"{}\n"
        }
        assert sorted(layout.read_tree(root, "hq-apps", tree="hq-apps")["hq-media"]) == ["media.json", "media/12.mp4"]


@pytest.mark.parametrize("kind", ["file", "directory", "tree"])
def test_a_link_is_refused_and_nothing_is_read_through_it(kind):
    with tempfile.TemporaryDirectory() as scratch:
        root = Path(scratch)
        secret = root / "outside"
        secret.mkdir()
        (secret / "key.json").write_bytes(b'{"secret": true}\n')
        _write(root / "run", ACCEPTED)
        reads = root / "run" / "hq-reads"
        if kind == "file":
            (reads / "reading" / "key.json").symlink_to(secret / "key.json")
            expected = "key.json is a link"
        elif kind == "directory":
            (reads / "linked").symlink_to(secret)
            expected = "linked is a link"
        else:
            (root / "run" / "linked-tree").symlink_to(reads)
            with pytest.raises(layout.LayoutRefused) as refused:
                layout.read_tree(root / "run", "linked-tree", tree="hq-reads")
            assert "linked-tree is a link" in str(refused.value)
            return
        refusal = _refusal(root / "run", "hq-reads")
        assert expected in refusal
        assert '"secret": true' not in refusal


def test_a_pipe_is_refused_without_the_reader_blocking_on_it():
    with tempfile.TemporaryDirectory() as scratch:
        root = Path(scratch)
        _write(root, ACCEPTED)
        os.mkfifo(root / "hq-reads" / "reading" / "pipe.json")
        assert "pipe.json is a pipe" in _refusal(root, "hq-reads")


def test_a_member_over_its_bound_is_refused_and_one_at_it_is_read():
    retained = dataclasses.replace(layout.load(), json_bound=8)
    with tempfile.TemporaryDirectory() as scratch:
        root = Path(scratch)
        _write(root, {"hq-reads/reading/at.json": b'{"a": 1}'})
        assert layout.read_tree(root, "hq-reads", tree="hq-reads", layout=retained) == {
            "reading": {"at.json": b'{"a": 1}'}
        }
        _write(root, {"hq-reads/reading/over.json": b'{"a": 12}'})
        assert "over.json holds more than 8 bytes" in _refusal(root, "hq-reads", retained)


def test_a_tree_over_its_bound_is_refused():
    retained = dataclasses.replace(layout.load(), tree_bound=10)
    with tempfile.TemporaryDirectory() as scratch:
        root = Path(scratch)
        _write(root, {"hq-reads/reading/a.json": b'{"a": 1}', "hq-reads/reading/b.json": b'{"b": 1}'})
        assert "holds more than 10 bytes, a retained tree's bound" in _refusal(root, "hq-reads", retained)


@pytest.mark.parametrize(
    ("data", "why"),
    [
        (b"not json", "is not strict UTF-8 JSON"),
        (b'{"a": NaN}', "is not strict UTF-8 JSON"),
        (b"\xff\xfe{}", "is not strict UTF-8 JSON"),
        (b'"a string"', "holds neither an object nor an array at its top"),
    ],
)
def test_a_json_member_that_is_not_strict_json_is_refused(data, why):
    with tempfile.TemporaryDirectory() as scratch:
        root = Path(scratch)
        _write(root, {**ACCEPTED, "hq-reads/reading/bad.json": data})
        assert why in _refusal(root, "hq-reads")


@pytest.mark.parametrize("named", ["../app.json", "/etc/hosts", "media/7.png", "app.json", 7])
def test_a_media_row_naming_no_media_file_of_its_base_is_refused(named):
    with tempfile.TemporaryDirectory() as scratch:
        root = Path(scratch)
        rows = [{"path": "jr://file/a.mp4", "file": "media/12.mp4"}, {"path": "jr://file/b.png", "file": named}]
        _write(root, {**ACCEPTED, "hq-apps/hq-media/media.json": json.dumps(rows).encode()})
        assert f"media.json's row 1 names {json.dumps(named)}" in _refusal(root, "hq-apps")


def test_every_name_is_checked_before_a_byte_is_read():
    # An oversized member beside a stray name: the stray name is what the refusal says, since names are checked
    # first and nothing was read.
    retained = dataclasses.replace(layout.load(), json_bound=4)
    with tempfile.TemporaryDirectory() as scratch:
        root = Path(scratch)
        _write(root, {"hq-reads/reading/big.json": b'{"a": 1}', "hq-reads/reading/x.test.ts": b""})
        refusal = _refusal(root, "hq-reads", retained)
        assert "x.test.ts is not a file a retained tree holds" in refusal
        assert "holds more than" not in refusal
