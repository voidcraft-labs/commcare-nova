"""``python3 -m proof.matrix.adopt``: the one way the retained trees are written from a run.

The contract: adopting takes every output of a run (one a shard) and merges
by file: every file a block wrote is written over its committed one, a
committed file is removed only where a comparison of the test that owns it
recorded it as committed and not made (``retained-held/``) and no block
wrote it, a directory the run did not write stays as it is, two blocks that
wrote one file apart are refused, across outputs as within one, a run that
wrote nothing is refused, a base whose reading did not come in (no
``expected.json``) is left out by name and ``hq-apps-unread/`` is never
copied, and the report names what changed of a base's stored app and of its
answers. The plausible failures: a stale file left beside a regenerated base
(the hold of ``test_retained.py`` fails on it again), a tree emptied by a
run that did not regenerate it, the files one shard's block wrote into a
directory removed by adopting another shard's block that writes the same
directory (``proof/hq/test_retained_reads.py`` and
``proof/editors/test_retained_reads.py`` both write ``navigation-base/``),
the files of a test that did not reach its comparison removed, one block's
answer silently chosen over another's, a base Nova did not read committed as
if retained, and a report that says nothing changed of a base whose app
changed. Standard library only: it runs with no image.
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
            # test_retained.py's comparison of hq-plain found stale.json committed and did not make it.
            "blocks/a/retained-held/hq-apps/hq-plain.json": b'{"extra": ["stale.json"]}\n',
            "blocks/b/hq-apps/hq-plain/app-source.json": b'{"status": 200}\n',
            "blocks/b/hq-reads/reading/application.json": b'{"status": 404}\n',
        },
    )
    return proof, output


def test_a_written_directory_takes_the_files_written_and_loses_only_what_its_comparison_did_not_make():
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


def _shards(scratch: Path):
    """A run of two shards whose blocks both write ``hq-reads/navigation-base/``: the HQ test's block on one (its
    reads, and the read it no longer makes), the editors' block on the other (its saves, and the save it no longer
    makes)."""
    proof = scratch / "proof"
    _write(
        proof,
        {
            "hq-reads/navigation-base/app-source.json": b"old\n",
            "hq-reads/navigation-base/app-source-gone.json": b"gone\n",
            "hq-reads/navigation-base/app-source-after-menu-save.json": b"old save\n",
            "hq-reads/navigation-base/app-source-after-gone-save.json": b"gone save\n",
        },
    )
    hq, editors = scratch / "proof-out-1", scratch / "proof-out-2"
    _write(
        hq,
        {
            "blocks/h/hq-reads/navigation-base/app-source.json": b"new\n",
            "blocks/h/retained-held/hq-reads/navigation-base.json": b'{"extra": ["app-source-gone.json"]}\n',
        },
    )
    _write(
        editors,
        {
            "blocks/e/hq-reads/navigation-base/app-source-after-menu-save.json": b"new save\n",
            "blocks/e/retained-held/hq-reads/navigation-base.json": (
                b'{"extra": ["app-source-after-gone-save.json"]}\n'
            ),
        },
    )
    return proof, hq, editors


def test_a_sharded_run_is_adopted_from_every_output_by_file_each_test_removing_only_its_own():
    with tempfile.TemporaryDirectory() as scratch:
        proof, hq, editors = _shards(Path(scratch))
        lines = adopt.adopt([hq, editors], proof=proof)
        assert _tree(proof) == {
            "hq-reads/navigation-base/app-source.json": b"new\n",
            "hq-reads/navigation-base/app-source-after-menu-save.json": b"new save\n",
        }
        assert lines == ["Adopted 0 directories of proof/hq-apps/.", "Adopted 1 directory of proof/hq-reads/."]


def test_adopting_one_shard_keeps_what_another_test_writes_into_the_same_directory():
    """Adopting the HQ test's shard alone once replaced navigation-base/ whole, deleting the editors' saves."""
    with tempfile.TemporaryDirectory() as scratch:
        proof, hq, editors = _shards(Path(scratch))
        adopt.adopt(hq, proof=proof)
        assert _tree(proof) == {
            "hq-reads/navigation-base/app-source.json": b"new\n",
            "hq-reads/navigation-base/app-source-after-menu-save.json": b"old save\n",
            "hq-reads/navigation-base/app-source-after-gone-save.json": b"gone save\n",
        }
        # The other shard adopted after it gives what adopting both at once gives.
        adopt.adopt(editors, proof=proof)
        proof2, hq2, editors2 = _shards(Path(scratch) / "again")
        adopt.adopt([hq2, editors2], proof=proof2)
        assert _tree(proof) == _tree(proof2)


def test_a_test_that_did_not_reach_its_comparison_removes_nothing_and_a_file_another_block_wrote_stays():
    with tempfile.TemporaryDirectory() as scratch:
        proof, hq, editors = _shards(Path(scratch))
        # The editors' test stopped before its comparison: it wrote one save and recorded nothing.
        (editors / "blocks/e/retained-held/hq-reads/navigation-base.json").unlink()
        # A block of the HQ test's records a file as not made that another block of the run wrote.
        _write(hq, {"blocks/i/retained-held/hq-reads/navigation-base.json": b'{"extra": ["app-source.json"]}\n'})
        adopt.adopt([hq, editors], proof=proof)
        assert _tree(proof) == {
            "hq-reads/navigation-base/app-source.json": b"new\n",
            "hq-reads/navigation-base/app-source-after-menu-save.json": b"new save\n",
            "hq-reads/navigation-base/app-source-after-gone-save.json": b"gone save\n",
        }


def test_two_shards_that_wrote_one_file_apart_are_refused_and_an_output_that_is_no_run_is_named():
    with tempfile.TemporaryDirectory() as scratch:
        proof, hq, editors = _shards(Path(scratch))
        _write(editors, {"blocks/f/hq-reads/navigation-base/app-source.json": b"other\n"})
        before = _tree(proof)
        try:
            adopt.adopt([hq, editors], proof=proof)
        except adopt.AdoptRefused as refusal:
            assert "hq-reads/navigation-base/app-source.json differently" in str(refusal)
        else:
            raise AssertionError("adopt took two shards' different answers for one file")
        try:
            adopt.adopt([hq, Path(scratch) / "nothing"], proof=proof)
        except adopt.AdoptRefused as refusal:
            assert "nothing holds no blocks/ directory" in str(refusal)
        else:
            raise AssertionError("adopt took an output that is no run's")
        assert _tree(proof) == before


def test_what_a_comparison_records_is_what_adopting_removes(tmp_path, monkeypatch):
    """The writer of the held records (``retained.Retained``, whose comparisons the tests run) and their reader
    here agree on where the records sit and what they name, for ``hold`` (JSON files named without their suffix,
    another test's files left out) and for ``differences`` (every file, with its suffix)."""
    from proof.matrix import retained

    assert retained.HELD == adopt.HELD
    proof = tmp_path / "proof"
    _write(
        proof,
        {
            "hq-reads/shell/app-source.json": b"old\n",
            "hq-reads/shell/gone.json": b"gone\n",
            "hq-reads/shell/app-source-after-app-settings-save.json": b"the editors' save\n",
            "hq-apps/hq-plain/app.json": b"old\n",
            "hq-apps/hq-plain/media/9.png": b"gone",
        },
    )
    block = tmp_path / "out" / "blocks" / "a"
    monkeypatch.setenv("PROOF_OUT", str(block))
    shell = retained.Retained("shell")
    shell.keep("app-source", {"status": 200})
    try:
        shell.hold(proof / "hq-reads" / "shell", others=lambda name: name.endswith("-save"))
    except AssertionError:
        pass
    base = retained.Retained("hq-plain", tree="hq-apps", held=True)
    base.keep("app", {"new": True})
    base.keep("expected", {"reads": True})
    base.settle()
    assert base.differences(proof / "hq-apps" / "hq-plain") == (["expected.json"], ["app.json"], ["media/9.png"])
    adopt.adopt(tmp_path / "out", proof=proof)
    assert sorted(_tree(proof)) == [
        "hq-apps/hq-plain/app.json",
        "hq-apps/hq-plain/expected.json",
        "hq-reads/shell/app-source-after-app-settings-save.json",
        "hq-reads/shell/app-source.json",
    ]
    assert not (proof / "hq-apps" / "hq-plain" / "media").exists()
