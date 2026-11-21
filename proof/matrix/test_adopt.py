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
changed. A run's output is what a container wrote, so every output is read
through the retained layout: a name outside it, a link anywhere, or a held
record naming a path outside its directory's layout (which would make
adopting remove a host file) is refused whole, in any output, before
anything under ``proof/`` changes, and the report runs no reader inside any
output. Standard library only: it runs with no image.
"""

from __future__ import annotations

import json
import tempfile
from pathlib import Path

import pytest

from proof.matrix import adopt, layout


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
            "hq-apps/hq-plain/places.json": b"{}\n",
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
            # test_retained.py's comparison of hq-plain found places.json committed and did not make it.
            "blocks/a/retained-held/hq-apps/hq-plain/test_retained.json": b'{"extra": ["places.json"]}\n',
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
        (Path(scratch) / "corpus").mkdir()
        before = _tree(proof)
        try:
            adopt.adopt(output, proof=proof, report=True, corpus=Path(scratch) / "corpus")
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
            "hq-reads/navigation-base/app-source.json": b'["old"]\n',
            "hq-reads/navigation-base/app-source-gone.json": b'["gone"]\n',
            "hq-reads/navigation-base/app-source-after-menu-save.json": b'["old save"]\n',
            "hq-reads/navigation-base/app-source-after-gone-save.json": b'["gone save"]\n',
        },
    )
    hq, editors = scratch / "proof-out-1", scratch / "proof-out-2"
    _write(
        hq,
        {
            "blocks/h/hq-reads/navigation-base/app-source.json": b'["new"]\n',
            "blocks/h/retained-held/hq-reads/navigation-base/hq.json": b'{"extra": ["app-source-gone.json"]}\n',
        },
    )
    _write(
        editors,
        {
            "blocks/e/hq-reads/navigation-base/app-source-after-menu-save.json": b'["new save"]\n',
            "blocks/e/retained-held/hq-reads/navigation-base/editors.json": (
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
            "hq-reads/navigation-base/app-source.json": b'["new"]\n',
            "hq-reads/navigation-base/app-source-after-menu-save.json": b'["new save"]\n',
        }
        assert lines == ["Adopted 0 directories of proof/hq-apps/.", "Adopted 1 directory of proof/hq-reads/."]


def test_adopting_one_shard_keeps_what_another_test_writes_into_the_same_directory():
    """Adopting the HQ test's shard alone once replaced navigation-base/ whole, deleting the editors' saves."""
    with tempfile.TemporaryDirectory() as scratch:
        proof, hq, editors = _shards(Path(scratch))
        adopt.adopt(hq, proof=proof)
        assert _tree(proof) == {
            "hq-reads/navigation-base/app-source.json": b'["new"]\n',
            "hq-reads/navigation-base/app-source-after-menu-save.json": b'["old save"]\n',
            "hq-reads/navigation-base/app-source-after-gone-save.json": b'["gone save"]\n',
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
        (editors / "blocks/e/retained-held/hq-reads/navigation-base/editors.json").unlink()
        # A block of the HQ test's records a file as not made that another block of the run wrote.
        _write(hq, {"blocks/i/retained-held/hq-reads/navigation-base/hq.json": b'{"extra": ["app-source.json"]}\n'})
        adopt.adopt([hq, editors], proof=proof)
        assert _tree(proof) == {
            "hq-reads/navigation-base/app-source.json": b'["new"]\n',
            "hq-reads/navigation-base/app-source-after-menu-save.json": b'["new save"]\n',
            "hq-reads/navigation-base/app-source-after-gone-save.json": b'["gone save"]\n',
        }


def test_two_shards_that_wrote_one_file_apart_are_refused_and_an_output_that_is_no_run_is_named():
    with tempfile.TemporaryDirectory() as scratch:
        proof, hq, editors = _shards(Path(scratch))
        _write(editors, {"blocks/f/hq-reads/navigation-base/app-source.json": b'["other"]\n'})
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

    assert retained.HELD == layout.load().held
    proof = tmp_path / "proof"
    _write(
        proof,
        {
            "hq-reads/shell/app-source.json": b'["old"]\n',
            "hq-reads/shell/gone.json": b'["gone"]\n',
            "hq-reads/shell/app-source-after-app-settings-save.json": b"the editors' save\n",
            "hq-apps/hq-plain/app.json": b'["old"]\n',
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


def test_two_tests_comparing_one_directory_each_write_their_own_record_and_read_no_other(tmp_path, monkeypatch):
    """``proof/hq/test_retained_reads.py`` and ``proof/editors/test_retained_reads.py`` both compare ``shell/``, on two
    workers of one block in a run with no queue: each writes its own record and reads no other, so neither's extra
    files are lost to the other's write, and adopting removes both."""
    from proof.matrix import retained

    proof = tmp_path / "proof"
    _write(
        proof,
        {
            "hq-reads/shell/app-source.json": b'["old"]\n',
            "hq-reads/shell/gone-read.json": b'["gone"]\n',
            "hq-reads/shell/app-source-after-gone-save.json": b'["gone save"]\n',
        },
    )
    monkeypatch.setenv("PROOF_OUT", str(tmp_path / "out" / "blocks" / "a"))
    reads = original = Path.read_text

    def compare(test, keep, others):
        monkeypatch.setenv("PYTEST_CURRENT_TEST", f"{test} (call)")
        shell = retained.Retained("shell")
        for name in keep:
            shell.keep(name, {"status": 200})
        own = shell.held_record()

        def read_own_only(path, *args, **kwargs):
            if retained.HELD in path.parts and path != own:
                raise AssertionError(f"{test} read another test's held record, {path}")
            return original(path, *args, **kwargs)

        monkeypatch.setattr(Path, "read_text", read_own_only)
        try:
            shell.hold(proof / "hq-reads" / "shell", others=others)
        except AssertionError as failed:
            assert "is not what HQ answers" in str(failed), failed
        finally:
            monkeypatch.setattr(Path, "read_text", reads)
        return own

    hq = compare(
        "proof/hq/test_retained_reads.py::test_the_drift_reads", ["app-source"], lambda name: name.endswith("-save")
    )
    editors = compare(
        "proof/editors/test_retained_reads.py::test_saves",
        ["app-source-after-menu-save"],
        lambda name: not name.endswith("-save"),
    )
    assert hq != editors and hq.parent == editors.parent
    assert json.loads(hq.read_text(encoding="utf-8")) == {"extra": ["gone-read.json"]}
    assert json.loads(editors.read_text(encoding="utf-8")) == {"extra": ["app-source-after-gone-save.json"]}
    adopt.adopt(tmp_path / "out", proof=proof)
    assert sorted(_tree(proof)) == ["hq-reads/shell/app-source-after-menu-save.json", "hq-reads/shell/app-source.json"]


def test_a_comparison_that_finds_nothing_extra_leaves_another_test_s_extra_to_remove(tmp_path, monkeypatch):
    from proof.matrix import retained

    proof = tmp_path / "proof"
    _write(proof, {"hq-reads/shell/app-source.json": b'["old"]\n', "hq-reads/shell/gone-read.json": b'["gone"]\n'})
    monkeypatch.setenv("PROOF_OUT", str(tmp_path / "out" / "blocks" / "a"))
    for test, extra in (("proof/hq/test_a.py::test_a", ["gone-read.json"]), ("proof/editors/test_b.py::test_b", [])):
        monkeypatch.setenv("PYTEST_CURRENT_TEST", f"{test} (call)")
        retained.Retained("shell").record_held(extra)
    _write(tmp_path / "out", {"blocks/a/hq-reads/shell/app-source.json": b'["new"]\n'})
    adopt.adopt(tmp_path / "out", proof=proof)
    assert _tree(proof) == {"hq-reads/shell/app-source.json": b'["new"]\n'}


def test_a_record_takes_its_name_only_once_it_is_whole(tmp_path, monkeypatch):
    """A run stopped while a record is written leaves the record it had, or none, never part of one: the write that
    is cut off before its rename names nothing, and adopting reads no file left beside it."""
    from proof.matrix import retained

    monkeypatch.setenv("PROOF_OUT", str(tmp_path / "out" / "blocks" / "a"))
    shell = retained.Retained("shell")
    shell.record_held(["kept.json"])
    record = shell.held_record()

    def stopped(*args):
        raise KeyboardInterrupt("the run stopped before the rename")

    monkeypatch.setattr(retained.os, "replace", stopped)
    try:
        shell.record_held(["kept.json", "more.json"])
    except KeyboardInterrupt:
        pass
    else:
        raise AssertionError("the record was written with its rename stopped")
    monkeypatch.undo()
    assert json.loads(record.read_text(encoding="utf-8")) == {"extra": ["kept.json"]}
    assert sorted(path.name for path in record.parent.iterdir()) == [record.name]
    # A file left beside a record by a kill is no record, and no file of the tree.
    _write(tmp_path / "out", {f"blocks/a/retained-held/hq-reads/shell/.{record.name}.7.partial": b"{"})
    _write(tmp_path / "out", {"blocks/a/hq-reads/shell/.app-source.json.7.partial": b"{"})
    assert adopt.unmade([tmp_path / "out"], "hq-reads") == {"shell": {"kept.json"}}
    assert adopt.written([tmp_path / "out"], "hq-reads") == {}


def _settled_base(monkeypatch, out):
    from proof.matrix import retained

    monkeypatch.setenv("PROOF_OUT", str(out / "blocks" / "a"))
    base = retained.Retained("hq-plain", tree="hq-apps", held=True)
    base.keep("app", {"new": True})
    base.keep("base", {"id": "hq-plain"})
    base.keep_bytes("media/0.png", b"\x89PNG")
    base.keep("expected", {"reads": True})
    base.keep("seed", {"cases": []})
    base.keep("tables", [])
    return base


def test_a_base_settled_is_adopted_whole_or_not_at_all_wherever_its_writes_stop(tmp_path, monkeypatch):
    """``Retained.settle`` names a base's directory under ``hq-apps/`` only once every file is whole: a write that
    raises (a full disk) or a rename that does not happen at any point leaves no directory there, so adopting and
    the gate (which read ``expected.json`` as the reading having come in) never take a base with its old seed,
    media or tables beside a new app. The base settled with nothing stopping it is adopted whole."""
    whole = _settled_base(monkeypatch, tmp_path / "whole")
    whole.settle()
    expected = whole.all_made()
    assert adopt.written([tmp_path / "whole"], "hq-apps") == {"hq-plain": expected}
    assert adopt.unread_bases(adopt.written([tmp_path / "whole"], "hq-apps")) == []
    writes = len(expected)
    for stop in range(writes + 1):
        out = tmp_path / f"stopped-{stop}"
        base = _settled_base(monkeypatch, out)
        written = Path.write_bytes
        count = {"writes": 0}

        def full(path, data, count=count, stop=stop, written=written):
            if count["writes"] == stop:
                raise OSError(28, "No space left on device")
            count["writes"] += 1
            return written(path, data)

        def no_rename(*args):
            raise OSError(28, "No space left on device")

        with monkeypatch.context() as patch:
            patch.setattr(Path, "write_bytes", full)
            if stop == writes:
                patch.setattr("proof.matrix.retained.os.replace", no_rename)
            try:
                base.settle()
            except OSError:
                pass
            else:
                raise AssertionError(f"settle finished with its write {stop} stopped")
        found = adopt.written([out], "hq-apps")
        assert found == {}, f"a settle stopped at write {stop} left {sorted(found.get('hq-plain', {}))}"
        assert not (out / "blocks" / "a" / "hq-apps" / "hq-plain").exists()
        assert base.held, "a base whose settle stopped writes nothing more as it is made"


def test_a_file_at_the_top_of_a_block_s_tree_is_refused_and_one_a_directory_down_is_adopted(tmp_path):
    for tree in ("hq-reads", "hq-apps"):
        proof, output = _run(tmp_path / tree)
        before = _tree(proof)
        _write(output, {f"blocks/b/{tree}/stray.json": b"{}\n"})
        try:
            adopt.adopt(output, proof=proof)
        except adopt.AdoptRefused as refusal:
            assert "stray.json is a file at the top of the tree" in str(refusal), refusal
            assert "Left out" not in str(refusal)
        else:
            raise AssertionError(f"adopt took a file at the top of {tree}/")
        assert _tree(proof) == before
    proof, output = _run(tmp_path / "down")
    _write(output, {"blocks/b/hq-reads/reading/stray.json": b"{}\n"})
    adopt.adopt(output, proof=proof)
    assert (proof / "hq-reads" / "reading" / "stray.json").read_bytes() == b"{}\n"


def test_a_file_under_the_held_records_that_is_no_record_is_refused(tmp_path):
    proof, output = _run(tmp_path)
    # A record as the run once wrote it, one a directory beside the directories (``<directory>.json``).
    _write(output, {"blocks/b/retained-held/hq-reads/reading.json": b'{"extra": []}\n'})
    try:
        adopt.adopt(output, proof=proof)
    except adopt.AdoptRefused as refusal:
        assert "is no held record" in str(refusal)
    else:
        raise AssertionError("adopt read a held record outside a directory's own records")


@pytest.mark.parametrize("where", [None, "out/corpus", "out"])
def test_the_report_runs_no_reader_the_runs_container_wrote(where):
    # A local run emits its corpus inside its container, into the run's output: the host runs nothing from there.
    with tempfile.TemporaryDirectory() as scratch:
        proof, output = _run(Path(scratch))
        _write(output, {"corpus/native/reader/reader.mjs": b"process.exit(0)\n"})
        before = _tree(proof)
        corpus = None if where is None else Path(scratch) / where
        with pytest.raises(adopt.AdoptRefused) as refused:
            adopt.adopt(output, proof=proof, report=True, corpus=corpus)
        assert ("inside the run's output" if where else "name it with --corpus") in str(refused.value)
        assert _tree(proof) == before


def _refused(output: Path, proof: Path) -> str:
    before = _tree(proof)
    with pytest.raises(adopt.AdoptRefused) as refused:
        adopt.adopt(output, proof=proof)
    # Refused whole, before anything under proof/ changed.
    assert _tree(proof) == before
    return str(refused.value)


@pytest.mark.parametrize(
    ("planted", "named"),
    [
        ("blocks/a/hq-apps/hq-plain/evil.test.ts", "evil.test.ts is not a file a retained tree holds"),
        ("blocks/a/hq-reads/reading/conftest.py", "conftest.py is not a file a retained tree holds"),
        ("blocks/a/hq-reads/reading/.gitattributes", ".gitattributes is a hidden name"),
        ("blocks/a/hq-reads/reading/CLAUDE.md", "CLAUDE.md is not a file a retained tree holds"),
    ],
)
def test_a_run_that_wrote_a_name_outside_the_layout_is_refused_whole(planted, named):
    with tempfile.TemporaryDirectory() as scratch:
        proof, output = _run(Path(scratch))
        _write(output, {planted: b"{}\n"})
        assert named in _refused(output, proof)


@pytest.mark.parametrize("kind", ["member", "block", "tree"])
def test_a_link_the_run_left_is_refused_and_its_target_is_copied_nowhere(kind):
    with tempfile.TemporaryDirectory() as scratch:
        scratch = Path(scratch)
        proof, output = _run(scratch)
        secret = scratch / "host"
        _write(secret, {"reading/key.json": b'{"secret": true}\n'})
        if kind == "member":
            (output / "blocks/b/hq-reads/reading/key.json").symlink_to(secret / "reading/key.json")
            named = "key.json is a link"
        elif kind == "block":
            (output / "blocks/c").symlink_to(secret)
            named = "blocks/c is a link"
        else:
            (output / "blocks/d").mkdir()
            (output / "blocks/d/hq-reads").symlink_to(secret)
            named = "hq-reads is a link"
        assert named in _refused(output, proof)
        assert not any(data == b'{"secret": true}\n' for data in _tree(proof).values())


@pytest.mark.parametrize("named", ["../app.json", "/etc/hosts", "media/9.png"])
def test_a_media_row_naming_no_media_file_of_its_base_is_refused(named):
    with tempfile.TemporaryDirectory() as scratch:
        proof, output = _run(Path(scratch))
        rows = [{"path": "jr://file/a.png", "file": "media/0.png"}, {"path": "jr://file/b.png", "file": named}]
        _write(output, {"blocks/a/hq-apps/hq-plain/media.json": json.dumps(rows).encode()})
        assert f"names {json.dumps(named)}, which is not one of the base's media files" in _refused(output, proof)


def test_each_report_line_is_one_of_adopts_own_sentences_with_a_listed_base():
    bases = {"hq-plain", "hq-new-app"}
    for line in [
        adopt.report_line("left-out", base="hq-plain"),
        adopt.report_line("adopted", count=1, tree="hq-reads"),
        adopt.report_line("adopted", count=22, tree="hq-apps"),
        adopt.report_line("new", base="hq-new-app"),
        adopt.report_line("changed", base="hq-plain", what="stored app and its answers"),
        adopt.report_line("reading", base="hq-plain"),
    ]:
        assert adopt.is_report_line(line, bases), line
    for line in [
        "hq-plain: see [this](https://example.org).",
        "hq-other: new.",
        "Adopted 2 directory of proof/hq-apps/.",
        "Adopted 01 directories of proof/hq-apps/.",
        "Adopted 2 directories of proof/elsewhere/.",
        "hq-plain: its everything changed.",
        "Left out hq-plain: something else.",
        "",
    ]:
        assert not adopt.is_report_line(line, bases), line


@pytest.mark.parametrize(
    ("record", "data", "named"),
    [
        ("hq-apps/hq-plain/t.json", b'{"extra": ["../../../.env"]}\n', 'lists "../../../.env", which no directory'),
        ("hq-apps/hq-plain/t.json", b'{"extra": ["conftest.py"]}\n', 'lists "conftest.py", which no directory'),
        ("hq-reads/reading/t.json", b'{"extra": ["/etc/hosts"]}\n', 'lists "/etc/hosts", which no directory'),
        ("hq-reads/reading/t.json", b'{"extra": "application.json"}\n', "is not an object whose one key extra"),
        ("hq-reads/reading/t.json", b'{"extra": [], "more": []}\n', "is not an object whose one key extra"),
        ("hq-apps/not-a-base/t.json", b'{"extra": ["app.json"]}\n', "not-a-base holds the records of no directory"),
        ("hq-reads/reading/.hidden.json", b'{"extra": []}\n', ".hidden.json is a hidden name"),
        ("hq-reads/reading/t.txt", b'{"extra": []}\n', "t.txt is no held record"),
        ("hq-reads/reading/.t.json.7.partial/x.json", b'{"extra": []}\n', ".t.json.7.partial is a hidden name"),
    ],
)
def test_a_held_record_that_names_anything_outside_its_directory_is_refused_whole(record, data, named):
    # A held record says which committed files adopting removes, so a name it carries outside the layout would
    # remove a host file; it is refused on the second shard as on the first, before anything is written.
    with tempfile.TemporaryDirectory() as scratch:
        proof, hq, editors = _shards(Path(scratch))
        _write(editors, {f"blocks/e/retained-held/{record}": data})
        before = _tree(proof)
        with pytest.raises(adopt.AdoptRefused) as refused:
            adopt.adopt([hq, editors], proof=proof)
        assert named in str(refused.value)
        assert _tree(proof) == before


def test_a_held_record_that_is_a_link_is_refused_and_one_named_alike_on_disk_is_taken():
    with tempfile.TemporaryDirectory() as scratch:
        scratch = Path(scratch)
        proof, hq, editors = _shards(scratch)
        record = editors / "blocks/e/retained-held/hq-reads/navigation-base/editors.json"
        record.unlink()
        _write(scratch / "host", {"record.json": b'{"extra": ["app-source-after-gone-save.json"]}\n'})
        record.symlink_to(scratch / "host" / "record.json")
        before = _tree(proof)
        with pytest.raises(adopt.AdoptRefused) as refused:
            adopt.adopt([hq, editors], proof=proof)
        assert "editors.json is a link" in str(refused.value)
        assert _tree(proof) == before
        record.unlink()
        record.write_bytes((scratch / "host" / "record.json").read_bytes())
        adopt.adopt([hq, editors], proof=proof)
        assert "hq-reads/navigation-base/app-source-after-gone-save.json" not in _tree(proof)


def test_a_name_outside_the_layout_on_any_shard_refuses_the_whole_run():
    with tempfile.TemporaryDirectory() as scratch:
        proof, hq, editors = _shards(Path(scratch))
        _write(editors, {"blocks/e/hq-reads/navigation-base/conftest.py": b""})
        before = _tree(proof)
        with pytest.raises(adopt.AdoptRefused) as refused:
            adopt.adopt([hq, editors], proof=proof)
        assert "conftest.py is not a file a retained tree holds" in str(refused.value)
        assert _tree(proof) == before


def test_the_report_runs_no_reader_inside_any_output_of_the_run():
    with tempfile.TemporaryDirectory() as scratch:
        proof, hq, editors = _shards(Path(scratch))
        _write(editors, {"corpus/native/reader/reader.mjs": b"process.exit(0)\n"})
        before = _tree(proof)
        with pytest.raises(adopt.AdoptRefused) as refused:
            adopt.adopt([hq, editors], proof=proof, report=True, corpus=editors / "corpus")
        assert "inside the run's output" in str(refused.value)
        assert _tree(proof) == before


def test_the_report_reads_each_base_as_adopting_leaves_it_before_anything_is_written(monkeypatch):
    # The new reading is of the base merged by file (committed files kept, the held ones removed, the made ones
    # written over), made before proof/ changes, so a reader that fails leaves it as it was.
    with tempfile.TemporaryDirectory() as scratch:
        scratch = Path(scratch)
        proof, output = _run(scratch)
        _write(proof, {"hq-apps/hq-plain/base.json": b"{}\n", "hq-apps/hq-plain/seed.json": b"[]\n"})
        _write(output, {"blocks/a/hq-apps/hq-plain/base.json": b"{}\n"})
        _write(scratch / "corpus", {"native/reader/reader.mjs": b""})
        read = []

        def readings(reader, bases):
            read.append({base: sorted(members) for base, members in bases.items()})
            return {base: {"id": base, "files": sorted(members)} for base, members in bases.items()}

        monkeypatch.setattr(adopt, "readings", readings)
        lines = adopt.adopt(output, proof=proof, report=True, corpus=scratch / "corpus")
        assert read == [
            {"hq-plain": ["app.json", "base.json", "places.json", "seed.json"]},
            {
                "hq-plain": [
                    "app-source.json",
                    "app.json",
                    "base.json",
                    "expected.json",
                    "media/0.png",
                    "seed.json",
                ]
            },
        ]
        assert lines == [
            "Adopted 1 directory of proof/hq-apps/.",
            "Adopted 1 directory of proof/hq-reads/.",
            "hq-plain: its stored app and its answers changed.",
            "hq-plain: Nova's reading of it changed.",
        ]

        def failing(reader, bases):
            raise adopt.AdoptRefused("Nova's reader exited with 1 reading the bases' answers")

        monkeypatch.setattr(adopt, "readings", failing)
        before = _tree(proof)
        _write(output, {"blocks/a/hq-apps/hq-plain/app.json": b'{"newer": true}\n'})
        with pytest.raises(adopt.AdoptRefused):
            adopt.adopt(output, proof=proof, report=True, corpus=scratch / "corpus")
        assert _tree(proof) == before
