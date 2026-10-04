"""The registers are strict: every difference is registered, and every entry is needed.

Contract (decision 12, the plan's test row "The register is strict"): the
lane passes only when every difference a check reports on a document falls
in a class of ``proof/known-defects.json``, and every entry naming a
document and check matches a difference there that no other entry holds;
over the whole run (every shard's evidence), every entry was seen on its
document and on its control; and ``proof/identity-moves.json`` is the only
way proof 1 accepts an identity change. The failures this catches: a new
failure absorbed by the register, a fixed defect left listed, an entry the
register would pass without, an entry no check ever runs on (its check has
no test, or never reached its document or control), and an entry on a fuzz
document, which a change to the sample's size or seed would drop.

The register's own files are loaded as the checks load them. Its strictness
is shown on real differences whose every member is known (an update of HQ's
own suite-test app that changes two identities, ``proof.checks.suite_app``):
a register naming each of their classes holds, a copy with any one entry
removed fails, and so does one with an entry the differences never show or
an entry another already covers; a control whose retained inputs no longer
show its entry's symptom fails; and a run's evidence, written by the
checks' own writer, holds only when every entry was seen on both, but for a
run over a sample of the corpus, which holds an entry naming a document the
sample left out on its control alone.
"""

from __future__ import annotations

import json
from dataclasses import replace

import pytest

from proof.checks import cases, registers, suite_app
from proof.checks.corpus import Document
from proof.checks.differences import Difference
from proof.checks.identity import compare_identities


def test_the_registers_hold_what_decision_12_needs():
    entries = cases.load_register()
    moves = registers.load_identity_moves()
    documents = {document.id: document for document in cases.load_corpus().emitted}
    for entry in entries:
        assert documents[entry.document].exports, f"{entry.id}'s targeted document has no export to show it on"
    assert all(move.path.startswith("/") for move in moves)


def _write(path, value):
    path.write_text(json.dumps(value), encoding="utf-8")
    return path


GOOD = {
    "id": "defect-1-form-ids",
    "defect": 1,
    "part": "ids and xmlns",
    "check": "proof1",
    "artifact": "app.json",
    "path": "/modules/*/forms/*/unique_id",
    "document": "targeted.defect-1",
    "control": "defect-1-form-ids",
}


# A check no test holds, made so for the test: a held check taken out of HELD_CHECKS, so the refusal does not
# depend on which checks the lane holds as each check's test arrives.
UNHELD = "bar"


@pytest.fixture
def unheld(monkeypatch):
    monkeypatch.setattr(registers, "HELD_CHECKS", registers.HELD_CHECKS - {UNHELD})
    return UNHELD


@pytest.mark.parametrize(
    ("change", "refusal"),
    [
        ({"surprise": True}, "beyond them"),
        ({"check": "proof9"}, "is not one of"),
        ({"check": UNHELD}, "has no test holding its differences"),
        ({"path": "modules/*/forms/*/unique_id"}, "structural path from the artifact's root"),
        ({"document": "producer.unknown"}, "which the corpus does not hold"),
        ({"document": "fuzz-xform-20260930-3"}, "one of the fuzz sample's"),
        ({"control": "no-such-control"}, "does not exist"),
        ({"document": "producer.plain", "values": {"before": "a", "after": "b"}}, "not a targeted document"),
        ({"values": {"before": "a"}}, "exactly before and after"),
        ({"kind": "moved"}, "or left out for every kind"),
        ({"equivalence": ""}, "equivalence names the runtimes"),
    ],
    ids=[
        "unknown-key",
        "unknown-check",
        "unheld-check",
        "relative-path",
        "unknown-document",
        "fuzz-document",
        "missing-control",
        "values-untargeted",
        "values-shape",
        "unknown-kind",
        "empty-equivalence",
    ],
)
def test_the_register_loader_refuses_an_entry_it_cannot_hold_to(tmp_path, change, refusal, unheld):
    controls = tmp_path / "controls"
    (controls / GOOD["control"]).mkdir(parents=True)
    corpus = {
        "documents": {"targeted.defect-1", "producer.plain", "fuzz-xform-20260930-3"},
        "targeted": {"targeted.defect-1"},
        "fuzz": {"fuzz-xform-20260930-3"},
    }
    accepted = registers.load_known_defects(_write(tmp_path / "good.json", [GOOD]), controls=controls, **corpus)
    assert [entry.id for entry in accepted] == [GOOD["id"]]
    named = {**GOOD, "equivalence": "Android's and Web Apps' readers take the value its absence gives"}
    (held,) = registers.load_known_defects(_write(tmp_path / "named.json", [named]), controls=controls, **corpus)
    assert held.equivalence == named["equivalence"]
    with pytest.raises(registers.RegisterError) as refused:
        registers.load_known_defects(_write(tmp_path / "bad.json", [{**GOOD, **change}]), controls=controls, **corpus)
    assert refusal in str(refused.value)


def test_a_manifest_entry_holds_a_refused_class_and_never_an_undecided_one(tmp_path):
    """A manifest difference the check could not place in or out of a REFUSED value class is a gap in the check
    (proof.checks.manifest_usage.standing), so no entry may hold it; the refused class beside it is a symptom an
    entry holds."""
    controls = tmp_path / "controls"
    (controls / GOOD["control"]).mkdir(parents=True)
    refused = {**GOOD, "check": "manifest", "artifact": "form:*", "path": "/jr-action:setvalue/refused/form-level"}
    accepted = registers.load_known_defects(_write(tmp_path / "refused.json", [refused]), controls=controls)
    assert [entry.path for entry in accepted] == [refused["path"]]
    undecided = {**refused, "path": "/jr-action:setvalue/undecided/form-level"}
    with pytest.raises(registers.RegisterError, match="manifest_value_classes.py"):
        registers.load_known_defects(_write(tmp_path / "undecided.json", [undecided]), controls=controls)


BIND = "/html/head[*]/model[*]/bind[@nodeset=/data/*]/@constraint"


def _constraint(kind, at="/html/head[1]/model[1]/bind[@nodeset=/data/q]/@constraint", path=BIND):
    before, after = {"removed": ("x", None), "added": (None, "x"), "changed": ("x", "y")}[kind]
    return Difference("proof4", "producer.plain", "form:0.0@vellum", path, at, kind, before, after)


def test_an_entry_naming_a_kind_holds_only_that_kind_and_only_its_exact_path():
    """A removed constraint and a changed one at one path are two symptoms: an entry naming ``removed`` holds the
    first and leaves the second unregistered, one naming no kind holds both. A path is the entry's exactly: its
    ``[*]`` is the step itself, never a pattern, so a path another document or position would write differently is
    not held."""
    entry = registers.Entry(
        id="constraint-removed",
        defect=13,
        part="leaf guards",
        check="proof4",
        artifact="form:*@vellum",
        path=BIND,
        document="producer.plain",
        control="constraint-removed",
        kind="removed",
    )
    removed, changed = _constraint("removed"), _constraint("changed")
    assert entry.matches(removed) and not entry.matches(changed)
    result = registers.reconcile("proof4", "producer.plain", [removed, changed], (entry,))
    assert result.unregistered == [changed] and not result.holds
    assert "constraint-removed" in result.registered
    every_kind = replace(entry, id="constraint", kind=None)
    assert every_kind.matches(removed) and every_kind.matches(changed)
    assert registers.reconcile("proof4", "producer.plain", [removed, changed], (every_kind,)).holds
    # A glob would read the entry's ``[*]`` as a character class and ``*`` as any run: the path is not a pattern.
    elsewhere = _constraint("removed", path="/html/head[*]/model[*]/bind[@nodeset=/data/*/item]/@constraint")
    assert not entry.matches(elsewhere)
    assert not entry.matches(replace(removed, path="/html/head[1]/model[*]/bind[@nodeset=/data/*]/@constraint"))


def test_two_entries_with_one_id_are_refused(tmp_path):
    controls = tmp_path / "controls"
    (controls / GOOD["control"]).mkdir(parents=True)
    with pytest.raises(registers.RegisterError) as refused:
        registers.load_known_defects(_write(tmp_path / "twice.json", [GOOD, dict(GOOD)]), controls=controls)
    assert "share the id" in str(refused.value)


@pytest.fixture(scope="module")
def known_differences(hq, core_runner):
    (_, identities_a), (_, identities_b) = suite_app.identity_change(core_runner)
    found = compare_identities(identities_a, identities_b, document="suite-app")
    assert {(d.artifact, d.path, d.at, d.kind) for d in found} == suite_app.CHANGED
    return found


def _register(differences):
    """One entry per class of the differences, each naming the suite app."""
    classes = sorted({(d.check, d.artifact, d.path) for d in differences})
    return tuple(
        registers.Entry(
            id=f"class-{index}",
            defect=0,
            part=f"{artifact} {path}",
            check=check,
            artifact=artifact,
            path=path,
            document="suite-app",
            control=f"class-{index}",
        )
        for index, (check, artifact, path) in enumerate(classes)
    )


def test_a_register_naming_every_class_holds(known_differences):
    result = registers.reconcile("proof1", "suite-app", known_differences, _register(known_differences))
    assert result.holds, result.explain()


def test_removing_any_one_entry_fails(known_differences):
    """The plan's control: a copy of the register with one entry removed must fail."""
    register = _register(known_differences)
    assert len(register) == 3
    for removed in register:
        copy = tuple(entry for entry in register if entry is not removed)
        result = registers.reconcile("proof1", "suite-app", known_differences, copy)
        assert not result.holds
        assert {(d.artifact, d.path) for d in result.unregistered} == {(removed.artifact, removed.path)}
        assert "no known-defect entry names" in result.explain()


def test_a_fixed_defect_left_listed_fails(known_differences):
    stale = registers.Entry(
        id="fixed",
        defect=1,
        part="module ids",
        check="proof1",
        artifact="app.json",
        path="/modules/*/unique_id",
        document="suite-app",
        control="fixed",
    )
    result = registers.reconcile("proof1", "suite-app", known_differences, (*_register(known_differences), stale))
    assert not result.holds and result.unseen == [stale]
    assert "no longer shows it there" in result.explain()


def test_an_entry_another_already_covers_fails(known_differences):
    register = _register(known_differences)
    wildcard = registers.Entry(
        id="every-form",
        defect=0,
        part="every form's case updates",
        check="proof1",
        artifact="form:*",
        path="/case_updates/*/*",
        document="suite-app",
        control="every-form",
    )
    result = registers.reconcile("proof1", "suite-app", known_differences, (*register, wildcard))
    assert not result.holds
    assert {entry.id for entry in result.redundant} >= {"every-form"}


def test_pinned_values_match_only_their_values_on_their_document(known_differences):
    option = next(d for d in known_differences if d.path == "/questions/*/options/*")
    pinned = registers.Entry(
        id="option",
        defect=0,
        part="option",
        check="proof1",
        artifact="form:0.0",
        path=option.path,
        document="suite-app",
        control="option",
        values={"before": option.before, "after": option.after},
    )
    assert pinned.matches(option)
    assert not registers.Entry(**{**pinned.__dict__, "values": {"before": option.before, "after": "z"}}).matches(option)
    assert not registers.Entry(**{**pinned.__dict__, "document": "another"}).matches(option)


def test_proof1_accepts_exactly_the_identity_moves_the_register_names(known_differences, tmp_path):
    moves = registers.load_identity_moves(
        _write(tmp_path / "moves.json", [{"defect": 1, "entity": "case_types", "path": "/*/properties/*"}])
    )
    accepted, rest = registers.accepted_moves(known_differences, moves)
    assert {(d.artifact, d.path) for d in accepted} == {("case_types", "/*/properties/*")}
    assert {(d.artifact, d.path) for d in rest} == {
        ("form:0.0", "/questions/*/options/*"),
        ("form:0.0", "/case_updates/*/*"),
    }
    with pytest.raises(registers.RegisterError):
        registers.load_identity_moves(_write(tmp_path / "bad.json", [{"defect": 1, "entity": "case_types"}]))


def test_a_control_must_keep_showing_each_symptom_its_entries_name(known_differences, tmp_path, monkeypatch):
    """Every entry reproduces on its control: the check run on the retained inputs must still show it."""
    monkeypatch.setenv("PROOF_OUT", str(tmp_path))
    control = Document(id="class-0", source="control", root=tmp_path, kind="control")
    register = tuple(replace(entry, document="targeted.suite-app") for entry in _register(known_differences))
    on_control = [replace(difference, document=control.id) for difference in known_differences]

    cases.hold("proof1", control, on_control, register)  # class-0's symptom is among them

    shown = register[0]
    fixed = [d for d in on_control if not (d.artifact == shown.artifact and d.path == shown.path)]
    with pytest.raises(AssertionError, match="no longer shows"):
        cases.hold("proof1", control, fixed, register)


def _write_evidence(out, monkeypatch, differences, document, control):
    monkeypatch.setenv("PROOF_OUT", str(out))
    if document is not None:
        cases.evidence("proof1", document, [replace(d, document=document.id) for d in differences])
    if control is not None:
        cases.evidence("proof1", control, [replace(d, document=control.id) for d in differences])
    return out


def test_a_run_holds_only_when_every_entry_was_seen_on_its_document_and_control(
    known_differences, tmp_path, monkeypatch
):
    document = Document(id="targeted.suite-app", source="targeted", root=tmp_path)
    register = tuple(
        replace(entry, document=document.id, control="suite-app") for entry in _register(known_differences)
    )
    control = Document(id="suite-app", source="control", root=tmp_path, kind="control")

    complete = _write_evidence(tmp_path / "complete", monkeypatch, known_differences, document, control)
    assert registers.verify_evidence([complete], register) == []

    # Two shards' evidence together hold as one run does.
    shard_1 = _write_evidence(tmp_path / "shard-1", monkeypatch, known_differences, document, None)
    shard_2 = _write_evidence(tmp_path / "shard-2", monkeypatch, known_differences, None, control)
    assert registers.verify_evidence([shard_1, shard_2], register) == []

    # No shard ran the check on the entries' document: nothing shows the defects are still there.
    problems = registers.verify_evidence([shard_2], register)
    assert len(problems) == len(register) and all("no shard ran proof1 on targeted.suite-app" in p for p in problems)

    # No shard ran the check on the control.
    problems = registers.verify_evidence([shard_1], register)
    assert len(problems) == len(register) and all("retains its control suite-app" in p for p in problems)

    # A new difference on the document, which no entry names.
    extra = replace(known_differences[0], artifact="suite.xml", path="/suite/entry[*]", at="/suite/entry[1]")
    new = _write_evidence(tmp_path / "new", monkeypatch, [*known_differences, extra], document, control)
    assert any("no known-defect entry names" in p for p in registers.verify_evidence([new], register))

    # The control no longer shows one entry's symptom.
    shown = register[0]
    fixed = [d for d in known_differences if not (d.artifact == shown.artifact and d.path == shown.path)]
    on_fixed = _write_evidence(tmp_path / "fixed", monkeypatch, fixed, None, control)
    problems = registers.verify_evidence([shard_1, on_fixed], register)
    assert problems == [
        f"The known-defect entry {shown.id}'s control suite-app no longer shows proof1 {shown.artifact} {shown.path}."
    ]

    # A run over a sample that left the entries' document out holds each entry on its control alone, and still
    # fails one whose control no longer shows it or never ran; one that left out only other documents is held
    # as a whole run is.
    assert registers.verify_evidence([shard_2], register, unsampled={document.id}) == []
    problems = registers.verify_evidence([on_fixed], register, unsampled={document.id})
    assert problems == [
        f"The known-defect entry {shown.id}'s control suite-app no longer shows proof1 {shown.artifact} {shown.path}."
    ]
    problems = registers.verify_evidence([shard_1], register, unsampled={document.id})
    assert len(problems) == len(register) and all("retains its control suite-app" in p for p in problems)
    problems = registers.verify_evidence([shard_2], register, unsampled={"another"})
    assert len(problems) == len(register) and all("no shard ran proof1 on targeted.suite-app" in p for p in problems)


def test_a_check_no_test_holds_cannot_hold_differences(known_differences, tmp_path, monkeypatch, unheld):
    monkeypatch.setenv("PROOF_OUT", str(tmp_path))
    document = Document(id="suite-app", source="corpus", root=tmp_path)
    cases.hold("proof1", document, known_differences, _register(known_differences))
    with pytest.raises(AssertionError, match="HELD_CHECKS does not list it"):
        cases.hold(unheld, document, [], ())
