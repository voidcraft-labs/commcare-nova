"""A control reads what its document's checks read, without the document itself.

Contract (plan decision 12): a control retains a document's upload bodies,
export bytes and expected values, and the checks read it as they read the
document, but it never depends on the shape of Nova's document, which a later
cutover changes. So a control holds no ``document.json``: what the checks
derive from D and D' (the wire layout and languages, the intent, the lookup
tags, the case database and the case-property types) is written beside its
files when it is retained (``controls.derived``), and each check reads that
where it reads it of a document (``Document.derived``). The plausible failures: a derived value that
is not what the check derives from the document (a set read back as a list,
a case's properties out of order), a check that still reads the control's
document and so fails, or passes on a shape it no longer has, once Nova's
document changes, and a control that keeps files no check of its entries
reads (an edit only proofs 2 and 3 name it for, whose B-edit the unit would
then observe, or an archive its checks never open), or drops one a check
does.

Case-property types are optional metadata: a control retained before that
reader existed holds no ``caseTypes`` and answers None, while a new control
keeps each effective type from the emitted catalog without inferring any type in Python.

A control is retained under its document's id, or under a name of its own
(``--as``), which leaves the document's own control as it was; and a
directory a fixed-defect entry names is never retained again, since its bytes
are the pre-fix inputs that entry must keep showing on. The plausible
failures: a retention under a new name that overwrites the document's own
control, and a re-retention that replaces a fixed entry's pre-fix bytes with
the fixed ones, so the entry stops showing and the check's blindness hides.

The accepted case is the lane's own corpus: a document with an edit and a
targeted one with expectations and a restore, each retained into a directory
of its own. Those documents are read from the whole emitted corpus, and a
test of one runs in that document's group only where the run checks it; one
the run's sample or selection leaves out runs in this package's group, which
the queue accounts for. The plausible failure: a selection of targeted
documents alone, whose edited document then ran in a group no queue holds.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from types import SimpleNamespace

import pytest

from proof.checks import cases, controls, corpus, registers, sharding
from proof.checks.intent import intent_of
from proof.checks.proof1 import document_lookup_tags
from proof.observe import unit
from proof.observe.casedata import document_case_database


@dataclass(frozen=True)
class Retained:
    """A document a control is retained from, and the lane group its items run in (None for this package's)."""

    document: corpus.Document
    group: str | None


def _documents(loaded=None):
    """An edited corpus document and a targeted one with a local archive, each where the corpus holds one (a
    corpus of a run's own may hold neither), the run's checked documents first.

    Only a document the run checks has a group a queue holds, so a test of it runs in that group; one the run's
    sample or selection leaves out is retained by this package's own items, which the queue accounts for."""
    loaded = cases.load_corpus() if loaded is None else loaded
    checked = {document.id for document in loaded.documents}
    documents = loaded.emitted
    edited = next((document for document in documents if document.edit is not None and not document.targeted), None)
    targeted = next((d for d in documents if d.targeted and d.local_ccz is not None), None)
    return [
        pytest.param(Retained(d, d.group if d.id in checked else None), id=name)
        for name, d in (("edited", edited), ("targeted", targeted))
        if d is not None
    ]


def test_a_document_the_run_leaves_out_is_retained_in_this_packages_group():
    """A run over documents named by hand, all of them targeted, checks no edited document: the edited one this
    module retains is one the run leaves out, and its items run in proof/checks's group, which the queue accounts
    for, never in a document group no queue runs (the gate's "Every block ran exactly once")."""

    def stub(identifier, *, targeted, edit):
        return SimpleNamespace(
            id=identifier,
            group=f"corpus:{identifier}",
            targeted=targeted,
            edit=SimpleNamespace() if edit else None,
            local_ccz=Path("local.ccz") if targeted else None,
        )

    named, left_out = stub("named", targeted=True, edit=False), stub("left-out", targeted=False, edit=True)

    def groups(loaded):
        found = {}
        for param in _documents(loaded):
            (retained,) = param.values
            item = SimpleNamespace(callspec=SimpleNamespace(params={"retained_from": retained}), path=__file__)
            found[param.id] = sharding.item_group(item)
        return found

    own = sharding.item_group(SimpleNamespace(path=__file__))
    assert own == "proof/checks"
    selected = SimpleNamespace(documents=(named,), emitted=(named, left_out))
    assert groups(selected) == {"edited": own, "targeted": "corpus:named"}
    # Where the run checks the edited document too, its items run in its own group, as every check's do.
    whole = SimpleNamespace(documents=(named, left_out), emitted=(named, left_out))
    assert groups(whole) == {"edited": "corpus:left-out", "targeted": "corpus:named"}


@pytest.mark.parametrize("retained_from", _documents())
def test_a_control_reads_what_its_documents_checks_derive_and_holds_no_document(retained_from, tmp_path):
    document = retained_from.document
    # Under a name of its own: the control the document's id names may hold pre-fix bytes an entry keeps showing
    # on, which ``retain`` refuses to replace.
    retained = controls.retain(document, ["proof1"], tmp_path, name=f"{document.id}-retained")
    control = corpus.Document(id=document.id, source="control", root=retained, kind="control")
    assert not (retained / "document.json").exists() and not (retained / "edit" / "document.json").exists()
    assert control.wire_modules == document.wire_modules
    assert control.wire_languages == document.wire_languages
    assert intent_of(control) == intent_of(document)
    assert document_case_database(control) == document_case_database(document)
    assert document_lookup_tags(control) == document_lookup_tags(document)
    assert control.case_types() == document.case_types()
    # The control retains the platforms its document declares, and reads them back as the document does.
    held = json.loads((retained / corpus.DERIVED).read_text(encoding="utf-8"))
    assert held["D"]["platforms"] == sorted(document.platforms())
    assert control.platforms() == document.platforms()
    assert control.exports.keys() == document.exports.keys()
    assert control.targeted == document.targeted
    if document.edit is not None:
        assert control.edit_wire_modules == document.edit_wire_modules
        assert intent_of(control, edit=True) == intent_of(document, edit=True)
        assert document_case_database(control, edit=True) == document_case_database(document, edit=True)
        assert control.case_types(edit=True) == document.case_types(edit=True)
        assert held["D'"]["platforms"] == sorted(document.platforms(edit=True))
        assert control.platforms(edit=True) == document.platforms(edit=True)
        assert control.edit.footprint == document.edit.footprint
        # The batch keeps its footprint, never the mutations Nova's planner wrote.
        assert set(json.loads((retained / "edit" / "batch.json").read_text())) <= set(controls.BATCH_KEYS)
    with pytest.raises(corpus.CorpusLayoutError, match="is a control"):
        _ = control.document
    # The observation keys and runs a control's sessions over the cases its document's did.
    assert unit.case_databases(control) == unit.case_databases(document)
    assert set(unit.computed_inputs(control)["configurations"]) == set(document.exports)


@pytest.mark.parametrize("with_case_types", [False, True])
def test_a_control_reads_optional_case_types_and_an_older_control_leaves_them_unknown(tmp_path, with_case_types):
    types = {"visit": {"seen": "datetime", "clock": "time", "day": "date", "untyped": None}}
    changed = {"visit": {"seen": "date"}}
    held = {"D": dict.fromkeys(corpus.DERIVED_KEYS), "D'": dict.fromkeys(corpus.DERIVED_KEYS)}
    if with_case_types:
        held["D"]["caseTypes"], held["D'"]["caseTypes"] = types, changed
    path = tmp_path / corpus.DERIVED
    path.write_text(json.dumps(held), encoding="utf-8")
    control = corpus.Document(id="retained", source="control", root=tmp_path, kind="control")
    assert control.derived("caseTypes") == (types if with_case_types else None)
    assert control.case_types() == (types if with_case_types else None)
    assert control.case_types(edit=True) == (changed if with_case_types else None)

    # Optional metadata does not make the layout permissive about a misspelling or a lost required key.
    held["D"]["caseType"] = types
    path.write_text(json.dumps(held), encoding="utf-8")
    with pytest.raises(corpus.CorpusLayoutError, match="optionally"):
        corpus.Document(id="misspelled", source="control", root=tmp_path, kind="control").case_types()
    del held["D"]["caseType"], held["D"]["wire"]
    path.write_text(json.dumps(held), encoding="utf-8")
    with pytest.raises(corpus.CorpusLayoutError, match="optionally"):
        corpus.Document(id="incomplete", source="control", root=tmp_path, kind="control").case_types()


def test_case_property_types_read_the_emitted_effective_catalog_without_inference(tmp_path):
    (tmp_path / "document.json").write_text(
        json.dumps(
            {
                "doc": {
                    "caseTypes": [
                        {"name": "visit", "properties": [{"name": "seen", "data_type": "datetime"}, {"name": "day"}]},
                        {"name": "other", "properties": [{"name": "seen", "data_type": "date"}]},
                    ]
                },
                "catalog": [
                    {
                        "name": "visit",
                        "properties": [
                            {"name": "seen", "data_type": "datetime"},
                            {"name": "day", "data_type": "date"},
                            {"name": "saved", "data_type": "int"},
                            {"name": "untyped"},
                        ],
                    },
                    {"name": "other", "properties": [{"name": "seen", "data_type": "date"}]},
                ],
            }
        ),
        encoding="utf-8",
    )
    document = corpus.Document(id="effective", source="test", root=tmp_path)
    assert document.case_types() == {
        "visit": {"seen": "datetime", "day": "date", "saved": "int", "untyped": None},
        "other": {"seen": "date"},
    }


@pytest.mark.parametrize("retained_from", _documents()[:1])
def test_a_control_keeps_the_edit_and_each_local_archive_only_for_a_check_that_reads_it(retained_from, tmp_path):
    document = retained_from.document

    def files(checks):
        retained = controls.retain(document, checks, tmp_path / "-".join(checks), name=f"{document.id}-retained")
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


@pytest.mark.parametrize("retained_from", _documents()[:1])
def test_a_control_retained_under_a_name_is_written_there_and_a_fixed_or_stopped_control_is_never_retained_again(
    retained_from, tmp_path, monkeypatch
):
    document = retained_from.document
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
