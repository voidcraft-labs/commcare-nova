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

The accepted case is the lane's own corpus: a document with an edit and a
targeted one with expectations and a restore, each retained into a directory
of its own.
"""

from __future__ import annotations

import json

import pytest

from proof.checks import cases, controls, corpus
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
