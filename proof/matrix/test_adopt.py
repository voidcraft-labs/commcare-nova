"""``python3 -m proof.matrix.adopt``: the one way the retained trees are written from a run.

The contract: every directory a run wrote replaces its committed one whole
(a file the run did not write there is removed), a directory the run did not
write stays as it is, two blocks that wrote one file apart are refused, a
run that wrote nothing is refused, a base whose reading did not come in (no
``expected.json``) is left out by name and ``hq-apps-unread/`` is never
copied, and the report names what changed of a base's stored app and of its
answers. The plausible failures: a stale file left beside a regenerated base
(the hold of ``test_retained.py`` fails on it again), a tree emptied by a
run that did not regenerate it, one block's answer silently chosen over
another's, a base Nova did not read committed as if retained, and a report
that says nothing changed of a base whose app changed. Standard library
only: it runs with no image.
"""

from __future__ import annotations

import tempfile
from pathlib import Path

from proof.matrix import adopt


def _write(root: Path, files: dict[str, bytes]):
    for name, data in files.items():
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)


def _tree(root: Path) -> dict[str, bytes]:
    return {path.relative_to(root).as_posix(): path.read_bytes() for path in sorted(root.rglob("*")) if path.is_file()}


def _run(scratch: Path):
    proof = scratch / "proof"
    output = scratch / "out"
    _write(
        proof,
        {
            "hq-apps/hq-plain/app.json": b'{"old": true}\n',
            "hq-apps/hq-plain/stale.json": b"{}\n",
            "hq-apps/hq-new-app/app.json": b'{"kept": true}\n',
            "hq-reads/reading/application.json": b'{"status": 200}\n',
            "hq-reads/publish/source-live.json": b'{"status": 200}\n',
        },
    )
    _write(
        output,
        {
            "blocks/a/hq-apps/hq-plain/app.json": b'{"new": true}\n',
            "blocks/a/hq-apps/hq-plain/media/0.png": b"\x89PNG",
            "blocks/a/hq-apps/hq-plain/expected.json": b'{"reads": true}\n',
            "blocks/b/hq-apps/hq-plain/app-source.json": b'{"status": 200}\n',
            "blocks/b/hq-reads/reading/application.json": b'{"status": 404}\n',
        },
    )
    return proof, output


def test_a_written_directory_replaces_its_committed_one_and_no_other():
    with tempfile.TemporaryDirectory() as scratch:
        proof, output = _run(Path(scratch))
        lines = adopt.adopt(output, proof=proof)
        assert _tree(proof) == {
            "hq-apps/hq-new-app/app.json": b'{"kept": true}\n',
            "hq-apps/hq-plain/app-source.json": b'{"status": 200}\n',
            "hq-apps/hq-plain/app.json": b'{"new": true}\n',
            "hq-apps/hq-plain/expected.json": b'{"reads": true}\n',
            "hq-apps/hq-plain/media/0.png": b"\x89PNG",
            "hq-reads/publish/source-live.json": b'{"status": 200}\n',
            "hq-reads/reading/application.json": b'{"status": 404}\n',
        }
        assert lines == ["Adopted 1 directory of proof/hq-apps/.", "Adopted 1 directory of proof/hq-reads/."]


def test_a_base_whose_reading_did_not_come_in_is_left_out_by_name_and_the_unread_tree_is_never_adopted():
    # A run's output from before retain held a base's files until it read leaves app.json, base.json and seed.json
    # under hq-apps/ with no expected.json; a run now keeps such a base under hq-apps-unread/ alone.
    with tempfile.TemporaryDirectory() as scratch:
        proof, output = _run(Path(scratch))
        _write(
            output,
            {
                "blocks/a/hq-apps/hq-menus/app.json": b'{"half": true}\n',
                "blocks/a/hq-apps/hq-menus/base.json": b"{}\n",
                "blocks/a/hq-apps-unread/hq-search/app.json": b'{"unread": true}\n',
                "blocks/a/hq-apps-unread/hq-search/reading.json": b'{"kind": "account"}\n',
            },
        )
        lines = adopt.adopt(output, proof=proof)
        tree = _tree(proof)
        assert not any(path.startswith(("hq-apps/hq-menus/", "hq-apps/hq-search/")) for path in tree)
        assert not any(path.startswith("hq-apps-unread") for path in tree)
        assert tree["hq-apps/hq-plain/app.json"] == b'{"new": true}\n'
        assert lines[0].startswith("Left out hq-menus: the run wrote no expected.json for it")
        assert lines[1:] == ["Adopted 1 directory of proof/hq-apps/.", "Adopted 1 directory of proof/hq-reads/."]


def test_a_run_whose_every_base_did_not_read_is_refused_by_name():
    with tempfile.TemporaryDirectory() as scratch:
        scratch = Path(scratch)
        _write(scratch / "out", {"blocks/a/hq-apps/hq-menus/app.json": b"{}\n"})
        try:
            adopt.adopt(scratch / "out", proof=scratch / "proof")
        except adopt.AdoptRefused as refusal:
            assert "Left out hq-menus" in str(refusal)
        else:
            raise AssertionError("adopt took a base whose reading did not come in")
        assert not (scratch / "proof").exists()


def test_two_blocks_that_wrote_one_file_apart_are_refused():
    with tempfile.TemporaryDirectory() as scratch:
        proof, output = _run(Path(scratch))
        _write(output, {"blocks/c/hq-apps/hq-plain/app.json": b'{"other": true}\n'})
        before = _tree(proof)
        try:
            adopt.adopt(output, proof=proof)
        except adopt.AdoptRefused as refusal:
            assert "hq-apps/hq-plain/app.json differently" in str(refusal)
        else:
            raise AssertionError("adopt took two blocks' different app.json for one base")
        assert _tree(proof) == before


def test_two_blocks_that_wrote_one_file_alike_are_adopted():
    with tempfile.TemporaryDirectory() as scratch:
        proof, output = _run(Path(scratch))
        _write(output, {"blocks/c/hq-apps/hq-plain/app.json": b'{"new": true}\n'})
        adopt.adopt(output, proof=proof)
        assert (proof / "hq-apps/hq-plain/app.json").read_bytes() == b'{"new": true}\n'


def test_a_run_that_wrote_nothing_is_refused():
    with tempfile.TemporaryDirectory() as scratch:
        scratch = Path(scratch)
        _write(scratch / "out", {"blocks/a/block.json": b"{}\n"})
        try:
            adopt.adopt(scratch / "out", proof=scratch / "proof")
        except adopt.AdoptRefused as refusal:
            assert "nothing to adopt" in str(refusal)
        else:
            raise AssertionError("adopt took a run that wrote no retained tree")
        assert not (scratch / "proof").exists()


def test_the_report_names_a_changed_app_and_changed_answers_and_a_new_base():
    before = {
        "hq-plain": {"app.json": b"1", "app-source.json": b"a"},
        "hq-new-app": {"app.json": b"1", "app-source.json": b"a"},
        "hq-saved-pages": {"app.json": b"1"},
    }
    after = {
        "hq-plain": {"app.json": b"2", "app-source.json": b"b"},
        "hq-new-app": {"app.json": b"1", "app-source.json": b"a"},
        "hq-saved-pages": {"app.json": b"1", "media/0.png": b"x"},
        "starter-health": {"app.json": b"1"},
    }
    assert adopt.changes(before, after) == {
        "hq-plain": ["stored app", "answers"],
        "hq-saved-pages": ["answers"],
        "starter-health": ["new"],
    }


def test_the_report_names_a_base_whose_reading_changed():
    before = {"hq-plain": {"id": "hq-plain", "kind": "read", "claims": "{}"}, "hq-new-app": {"id": "x", "kind": "read"}}
    after = {
        "hq-plain": {"id": "hq-plain", "kind": "read", "claims": '{"e": 1}'},
        "hq-new-app": {"id": "y", "kind": "read"},
        "hq-saved-pages": {"id": "hq-saved-pages", "kind": "read"},
    }
    assert adopt.reading_changes(before, after) == ["hq-plain", "hq-saved-pages"]


def test_the_report_refuses_a_corpus_that_carries_no_reader():
    with tempfile.TemporaryDirectory() as scratch:
        proof, output = _run(Path(scratch))
        before = _tree(proof)
        try:
            adopt.adopt(output, proof=proof, report=True)
        except adopt.AdoptRefused as refusal:
            assert "native/reader/reader.mjs" in str(refusal)
        else:
            raise AssertionError("adopt reported readings with no reader bundle to read them")
        assert _tree(proof) == before
