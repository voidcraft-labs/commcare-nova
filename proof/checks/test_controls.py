"""A control reads what its document's checks read, without the document itself.

Contract (plan decision 12): a control retains a document's upload bodies,
export bytes and expected values, and the checks read it as they read the
document, but it never depends on the shape of Nova's document, which a later
cutover changes. So a control holds no ``document.json``: what the checks
derive from D and D' (the wire layout and languages, the intent, the lookup
tags and the case database) is written beside its files when it is retained
(``controls.derived``), and each check reads that where it reads it of a
document (``Document.derived``). The plausible failures: a derived value that
is not what the check derives from the document (a set read back as a list,
a case's properties out of order), a check that still reads the control's
document and so fails, or passes on a shape it no longer has, once Nova's
document changes, and a control that keeps files no check of its entries
reads (an edit only proofs 2 and 3 name it for, whose B-edit the unit would
then observe, or an archive its checks never open), or drops one a check
does.

A control is retained under its document's id, or under a name of its own
(``--as``), which leaves the document's own control as it was; and a
directory a fixed-defect entry names is never retained again, since its bytes
are the pre-fix inputs that entry must keep showing on. The plausible
failures: a retention under a new name that overwrites the document's own
control, and a re-retention that replaces a fixed entry's pre-fix bytes with
the fixed ones, so the entry stops showing and the check's blindness hides.

The accepted case is the lane's own corpus: a document with an edit and a
targeted one with expectations and a restore, each retained into a directory
of its own.
"""

from __future__ import annotations

import json

import pytest

from proof.checks import cases, controls, corpus, registers
from proof.checks.intent import intent_of
from proof.checks.proof1 import document_lookup_tags
from proof.observe import unit
from proof.observe.casedata import document_case_database


def _documents():
    """An edited corpus document and a targeted one with a local archive, each where the corpus holds one (a
    corpus of a run's own may hold neither)."""
    documents = cases.load_corpus().emitted
    edited = next((document for document in documents if document.edit is not None and not document.targeted), None)
    targeted = next((d for d in documents if d.targeted and d.local_ccz is not None), None)
    return [pytest.param(d, id=name) for name, d in (("edited", edited), ("targeted", targeted)) if d is not None]


@pytest.mark.parametrize("document", _documents())
def test_a_control_reads_what_its_documents_checks_derive_and_holds_no_document(document, tmp_path):
    retained = controls.retain(document, ["proof1"], tmp_path)
    control = corpus.Document(id=document.id, source="control", root=retained, kind="control")
    assert not (retained / "document.json").exists() and not (retained / "edit" / "document.json").exists()
    assert control.wire_modules == document.wire_modules
    assert control.wire_languages == document.wire_languages
    assert intent_of(control) == intent_of(document)
    assert document_case_database(control) == document_case_database(document)
    assert document_lookup_tags(control) == document_lookup_tags(document)
    assert control.exports.keys() == document.exports.keys()
    assert control.targeted == document.targeted
    if document.edit is not None:
        assert control.edit_wire_modules == document.edit_wire_modules
        assert intent_of(control, edit=True) == intent_of(document, edit=True)
        assert document_case_database(control, edit=True) == document_case_database(document, edit=True)
        assert control.edit.footprint == document.edit.footprint
        # The batch keeps its footprint, never the mutations Nova's planner wrote.
        assert set(json.loads((retained / "edit" / "batch.json").read_text())) <= set(controls.BATCH_KEYS)
    with pytest.raises(corpus.CorpusLayoutError, match="is a control"):
        _ = control.document
    # The observation keys and runs a control's sessions over the cases its document's did.
    assert unit.case_databases(control) == unit.case_databases(document)
    assert set(unit.computed_inputs(control)["configurations"]) == set(document.exports)


@pytest.mark.parametrize("document", _documents()[:1])
def test_a_control_keeps_the_edit_and_each_local_archive_only_for_a_check_that_reads_it(document, tmp_path):
    def files(checks):
        retained = controls.retain(document, checks, tmp_path / "-".join(checks))
        assert not (retained / "inputs.json").exists() and not list(retained.rglob("outcome.json"))
        return retained, {path.relative_to(retained).as_posix() for path in retained.rglob("*") if path.is_file()}

    archives = {"local.ccz", "local-again.ccz", "edit/local.ccz"}
    # Proof 4 reads B-edit's publish and its editors, and no local archive.
    retained, kept = files(["proof4"])
    assert "edit/batch.json" in kept and "edit/verdict.json" in kept and not kept & archives
    assert set(json.loads((retained / corpus.DERIVED).read_text())) == {"D", "D'"}
    # Proof 3 runs local.ccz over A and B alone: no second export, no edit, and nothing derived of D'.
    retained, kept = files(["proof3"])
    assert kept & archives == {"local.ccz"} and not any(path.startswith("edit/") for path in kept)
    assert (retained / "local.ccz").read_bytes() == document.local_ccz.read_bytes()
    assert set(json.loads((retained / corpus.DERIVED).read_text())) == {"D"}
    control = corpus.Document(id=document.id, source="control", root=retained, kind="control")
    assert control.edit is None and "b_edit" not in unit.computed_inputs(control)["configurations"]["minimum"]
    # Proof 5 compares local.ccz with edit/local.ccz, proof 1 the two exports of D, and the bar admits all three.
    assert files(["proof5"])[1] & archives == {"local.ccz", "edit/local.ccz"}
    assert files(["proof1"])[1] & archives == {"local.ccz", "local-again.ccz"}
    assert files(["bar"])[1] & archives == archives
    # Configuration sensitivity builds A alone.
    _, kept = files(["sensitivity"])
    assert not kept & archives and not any(path.startswith("edit/") for path in kept)


@pytest.mark.parametrize("document", _documents()[:1])
def test_a_control_retained_under_a_name_is_written_there_and_a_fixed_or_stopped_control_is_never_retained_again(
    document, tmp_path, monkeypatch
):
    root = corpus.corpus_root()
    into = tmp_path / "controls"
    own = into / document.id
    own.mkdir(parents=True)
    (own / "configurations.json").write_text("the document's own control\n", encoding="utf-8")

    def untouched():
        return {path.relative_to(own).as_posix(): path.read_bytes() for path in own.rglob("*") if path.is_file()}

    before = untouched()
    assert controls.main([str(root), document.id, "proof1", str(into), "--as", "named-after"]) == 0
    retained = into / "named-after"
    assert (retained / corpus.DERIVED).is_file() and (retained / "verdict.json").is_file()
    assert untouched() == before
    # Without <into>, into proof/controls (here a directory of the test's own).
    monkeypatch.setattr(corpus, "CONTROLS_DIR", tmp_path / "default")
    assert controls.main([str(root), document.id, "proof1", "--as", "also-named"]) == 0
    assert [path.name for path in (tmp_path / "default").iterdir()] == ["also-named"]
    assert controls.main([str(root), document.id, "proof1", "--as"]) == 2

    # A directory a fixed entry names is never retained again, under its own name or another's.
    fixed_control = next(path.name for path in sorted(registers.CONTROLS.iterdir()) if path.is_dir())
    register = tmp_path / "registers" / "known-defects.json"
    register.parent.mkdir()
    register.write_text("[]\n", encoding="utf-8")
    entry = {"id": "fixed", "defect": 1, "part": "p", "check": "proof1", "artifact": "app.json", "path": "/x"}
    (register.parent / "fixed-defects.json").write_text(json.dumps([{**entry, "control": fixed_control}]))
    monkeypatch.setenv("PROOF_KNOWN_DEFECTS", str(register))
    with pytest.raises(corpus.CorpusLayoutError, match="never retained again"):
        controls.retain(document, ["proof1"], into, name=fixed_control)
    assert not (into / fixed_control).exists()

    # Nor is a directory a held stop's control entry names: its walks stop where the entry holds them.
    walk_stops = tmp_path / "registers" / "walk-stops.json"
    held = {"control": "stopped", "reader": "formplayer", "cause": "notification:x", "reason": "Because."}
    walk_stops.write_text(json.dumps([held]), encoding="utf-8")
    monkeypatch.setenv("PROOF_WALK_STOPS", str(walk_stops))
    with pytest.raises(corpus.CorpusLayoutError, match="held stops formplayer notification:x"):
        controls.retain(document, ["proof1"], into, name="stopped")
    assert not (into / "stopped").exists()
