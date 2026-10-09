"""Configuration sensitivity: every change a gate HQ read makes to its build is the gate's effect or registered.

Contract (plan work item 11, "Configuration sensitivity"; decision 8's gate
effects): each corpus document, under each configuration it is exported
under, is built (A, the plain build) and built again once with each gate HQ
read during that build flipped: each feature flag, and each project-space
setting the build reads (CommTrack, sync cases on form entry, the flat
location fixture). Every difference from the plain build is named in the
flipped gate's effects (``lib/commcare/surface/entries/gates.json``) or
falls in a register class; a register entry holds any difference it names
first, so a defect that is also a gate's effect stays strict while it
lasts. A flip to a configuration Nova's publish refuses (decision 19) is
built for the gate's effects and held to them alone.

The plausible failures this catches: a flip that leaks into the next build
(a seam not restored, a cache answering from the plain build), so changes
are pinned on the wrong gate or missed; a gate HQ read left unflipped, one
flipped twice, or one flipped that HQ never read (paid for and proving
nothing); a setting turned in one of the places HQ reads it and not the
other; a change a gate makes going unnamed (a flag whose effects nobody
reviewed), or hidden behind another gate's effect; a register entry starved
by an effect; a refused configuration's symptom reaching the register; and
an effects writer that loses a class, keeps a stale one, writes from part
of a run's shards, presents a gate no run flipped as one that changed
nothing, or leaves the gates file in a form Biome would rewrite.

HQ's side runs on HQ's own suite-test app, published as Nova publishes:
plain, with a search on its menu (so it offers search, as Nova's searching
menus do), and with a form shown by a location lookup under
``HIERARCHICAL_LOCATION_FIXTURE`` (so HQ reads the flat fixture). Its plain
build and flips are observed as a document's unit observes them (the unit's
build of A is ``proof.observe.sensitivity.plain_build``, and each flip runs
in a fork of A's state, back at A's key, clock and writes after it) and
judged as a document's records are (``sensitivity.judged``).
"""

from __future__ import annotations

import json
import shutil

import pytest

from proof.checks import cases, observations, sensitivity
from proof.checks.differences import Difference
from proof.checks.registers import Entry
from proof.hq import operations
from proof.hq.check import hq_check
from proof.hq.configuration import Configuration
from proof.hq.conftest import hq_test_app, nova_shaped_upload
from proof.observe import sensitivity as observe

CONFIGURATION = Configuration(privileges={"CLOUDCARE"})
ANY_TARGET = {"minimumConfiguration": {"flags": [], "caseSearchEnabled": False}}
EMPTY_CASE_LIST_TEXT = sensitivity.flag_gate("USH_EMPTY_CASE_LIST_TEXT")


@pytest.mark.parametrize("document", cases.document_params() + cases.control_params("sensitivity"))
def test_every_change_a_flipped_gate_makes_is_its_effect_or_registered(document, hq, core_runner, editor_driver):
    records = observations.records_for(document, core_runner, editor_driver=editor_driver)
    observed = [
        sensitivity.judged(document.id, observations.sensitivity_view(records, name), document.verdict)
        for name in sorted(document.exports)
    ]
    entries = cases.load_register()
    holding = sensitivity.hold_flips(observed, sensitivity.load_effects(), entries)
    problems = []
    try:
        cases.hold(
            "sensitivity",
            document,
            holding.held + observations.soft_assertion_differences(records, "sensitivity"),
            entries,
            configurations=sorted(document.exports),
            observed=sensitivity.evidence_of(observed),
        )
    except AssertionError as failure:
        problems.append(str(failure))
    if holding.unexplained_refused:
        from proof.checks.differences import summary

        problems.append(
            "Under configurations Nova's publish refuses (decision 19), flipping these gates changed HQ's build in"
            " ways their gate entries' effects do not name. Write the effects again from the run's evidence"
            " (python -m proof.checks.sensitivity effects), and review what they add:\n"
            + summary(holding.unexplained_refused)
        )
    assert not problems, "\n".join(problems)


# HQ's builds --------------------------------------------------------------


def _with_search(app_json):
    """The suite app with a search on its menu: one search input, so the menu offers search."""
    app_json["modules"][0]["search_config"] = {"properties": [{"name": "name", "label": {"en": "Name"}}]}
    return app_json


def _with_location_lookup(app_json):
    """The suite app with its first form shown by a location lookup, so its entry reads ``instance('locations')``."""
    app_json["modules"][0]["forms"][0]["form_filter"] = "instance('locations')/locations/location[@id = 'a']/name = 'b'"
    return app_json


def _sensitivity(core_runner, app_json, *, configuration=CONFIGURATION, then=None):
    """The sensitivity of HQ's suite app under ``configuration``, and what ``then`` returns from the same state.

    The plain build and each flip are observed as a document's unit observes
    them, and judged as its records are. ``then(state, record, app_id, plain,
    parsed_plain)`` runs after every flip, with a new plain build.
    """
    from proof.checks.proof2 import parsed_build

    with hq_check(configuration) as (state, record):
        app_id, _ = operations.publish(state, [nova_shaped_upload(app_json, "Suite app")])
        built, flags_read, settings_read = observe.plain_build(state, record, app_id, configuration)
        plain = built.outcome
        plan = sensitivity.flip_plan(configuration, flags_read, settings_read)
        view = observations.SensitivityView(
            "proof",
            plain=plain,
            flags_read=flags_read,
            settings_read=settings_read,
            flips=observe.flip_builds(state, record, app_id, plan),
        )
        observed = sensitivity.judged("suite-app", view, ANY_TARGET)
        after = None
        if then is not None:
            plain = observe.build(state, record, app_id, "A").outcome
            after = then(state, record, app_id, plain, parsed_build(plain))
    return observed, after


def _classes(flip):
    return {(difference.artifact, difference.path, difference.kind) for difference in flip.differences}


def test_each_gate_hq_read_is_flipped_once_and_changes_only_its_own_build(hq, core_runner):
    def rebuilt(state, record, app_id, plain, parsed_plain):
        # A build after every flip, with nothing flipped: no flip's fork, seam or cache outlived its build.
        again = observe.build(state, record, app_id, "A").outcome
        return sensitivity.flip_differences("suite-app", "none", plain, parsed_plain, again)

    observed, after_flips = _sensitivity(core_runner, hq_test_app(), then=rebuilt)

    assert observed.flags_read, "HQ reads flags while it builds any app"
    assert observed.settings_read == [sensitivity.COMMTRACK], (
        "the menu offers no search and reads no location, so HQ reads neither sync nor the flat fixture"
    )
    # Every gate read is flipped, each once, flags first, and nothing else is.
    assert [flip.gate for flip in observed.flips] == [
        *(sensitivity.flag_gate(symbol) for symbol in observed.flags_read),
        sensitivity.COMMTRACK,
    ]

    # The flip takes effect: HQ writes a case list's empty text only under its flag.
    (empty_text,) = [flip for flip in observed.flips if flip.gate == EMPTY_CASE_LIST_TEXT]
    assert (
        f"suite.xml@{EMPTY_CASE_LIST_TEXT}",
        "/suite/detail[@id=*]/no_items_text[*]",
        "added",
    ) in _classes(empty_text)
    # Each change is pinned on the gate that made it: no class shows under two gates' flips.
    seen = {}
    for flip in observed.flips:
        for artifact, path, _ in _classes(flip):
            built, gate = sensitivity.split_artifact(artifact)
            assert seen.setdefault((built, path), gate) == gate, (
                f"{built} {path} changed under {seen[(built, path)]} and {gate}"
            )
    assert after_flips == []


def test_each_flip_builds_from_as_state_and_leaves_the_unit_there(hq, core_runner):
    """Each flip's build runs in a fork of A's state, in an operation of its own: after every flip the unit is at
    A's key, depth and write count again, so a flip's build is the same whichever flips ran before it."""
    from proof.observe.outcome import outcome_record
    from proof.observe.record import Blobs, digest

    with hq_check(CONFIGURATION) as (state, record):
        app_id, _ = operations.publish(state, [nova_shaped_upload(hq_test_app(), "Suite app")])
        _, flags_read, settings_read = observe.plain_build(state, record, app_id, CONFIGURATION)
        plan = sensitivity.flip_plan(CONFIGURATION, flags_read, settings_read)
        assert len(plan) >= 2, "the suite app's build reads more than one gate"
        at_a = (state.key, state.depth, state.writes)

        def scope(flip):
            return state.operation("flip", flip.gate.encode())

        forward = observe.flip_builds(state, record, app_id, plan, scope)
        assert (state.key, state.depth, state.writes) == at_a
        backward = observe.flip_builds(state, record, app_id, list(reversed(plan)), scope)
        assert (state.key, state.depth, state.writes) == at_a

    def digests(built):
        return {flip.gate: digest(outcome_record(outcome, Blobs())) for flip, outcome in built}

    assert digests(forward) == digests(backward)


def test_a_project_space_flip_turns_its_setting_wherever_hq_reads_it_and_restores_it(hq, core_runner):
    """CommTrack is read from the app and from the project; the flat fixture from the project's database."""
    from corehq.apps.app_manager.models import Application
    from corehq.apps.domain.models import Domain
    from corehq.apps.locations.models import LocationFixtureConfiguration

    from proof.hq.boot import clear_caches

    def commtrack(state):
        clear_caches()
        return Application(domain=state.domain).commtrack_enabled, Domain.get_by_name(state.domain).commtrack_enabled

    def flat_fixture(state):
        return LocationFixtureConfiguration.for_domain(state.domain).sync_flat_fixture

    with hq_check(CONFIGURATION) as (state, record):
        assert commtrack(state) == (False, False) and flat_fixture(state) is True

        # Each read counts toward its gate, wherever HQ makes it.
        reads = {}
        with observe.project_space_reads(CONFIGURATION, reads):
            clear_caches()
            assert Domain.get_by_name(state.domain).commtrack_enabled is False
            from_project = reads.get(sensitivity.COMMTRACK, 0)
            assert Application(domain=state.domain).commtrack_enabled is False
            assert from_project >= 1 and reads[sensitivity.COMMTRACK] == from_project + 1
            assert flat_fixture(state) is True and reads[sensitivity.FLAT_FIXTURE] == 1
        assert flat_fixture(state) is True and reads[sensitivity.FLAT_FIXTURE] == 1, "counted only while recording"

        settings = {sensitivity.COMMTRACK: 1, sensitivity.FLAT_FIXTURE: 1}
        commtrack_flip, flat_flip = sensitivity.flips(CONFIGURATION, set(), settings, ANY_TARGET)
        with observe.flipped(commtrack_flip, state):
            assert commtrack(state) == (True, True)
        assert commtrack(state) == (False, False)
        with observe.flipped(flat_flip, state):
            assert flat_fixture(state) is False
        assert flat_fixture(state) is True
        assert not LocationFixtureConfiguration.objects.filter(domain=state.domain).exists()


def test_the_flat_fixture_is_flipped_where_hq_reads_it_and_moves_the_locations_instance(hq, core_runner):
    """HQ reads the flat fixture only under HIERARCHICAL_LOCATION_FIXTURE, for an instance('locations')."""
    configuration = Configuration(privileges={"CLOUDCARE"}, flags={"HIERARCHICAL_LOCATION_FIXTURE"})
    observed, _ = _sensitivity(core_runner, _with_location_lookup(hq_test_app()), configuration=configuration)
    assert "HIERARCHICAL_LOCATION_FIXTURE" in observed.flags_read
    assert observed.settings_read == [sensitivity.COMMTRACK, sensitivity.FLAT_FIXTURE]

    (flat,) = [flip for flip in observed.flips if flip.gate == sensitivity.FLAT_FIXTURE]
    moved = [d for d in flat.differences if d.path.endswith("/instance[@id=*]/@src")]
    assert moved and {(d.before, d.after) for d in moved} == {
        ("jr://fixture/locations", "jr://fixture/commtrack:locations")
    }
    assert flat.accepted
    # Without the flag HQ never asks, and the flat fixture HQ's default syncs gives the same instance.
    (hierarchical,) = [f for f in observed.flips if f.gate == sensitivity.flag_gate("HIERARCHICAL_LOCATION_FIXTURE")]
    assert not [d for d in hierarchical.differences if d.path.endswith("/instance[@id=*]/@src")]


def test_sync_on_form_entry_is_flipped_for_a_menu_that_offers_search_and_adds_an_unconditioned_claim(hq, core_runner):
    from lxml import etree

    observed, _ = _sensitivity(core_runner, _with_search(hq_test_app()))
    assert sensitivity.SYNC_ON_FORM_ENTRY in observed.settings_read
    (sync,) = [flip for flip in observed.flips if flip.gate == sensitivity.SYNC_ON_FORM_ENTRY]
    added = [d for d in sync.differences if d.path == "/suite/entry[*]/post[*]" and d.kind == "added"]
    # Only the form that needs a case gets the claim (EntriesHelper.entry_for_module, form.requires_case()).
    assert [d.at for d in added] == ["/suite/entry[2]/post[1]"]
    claim = etree.fromstring(added[0].after)
    assert claim.get("relevant") is None and claim.get("url").endswith("/phone/claim-case/")
    assert sync.accepted


def test_a_setting_hq_never_read_changes_nothing_when_flipped(hq, core_runner):
    """Why the check flips only what the plain build read: building under sync anyway changes nothing."""

    def under_sync(state, record, app_id, plain, parsed_plain):
        flip = sensitivity.Flip(
            sensitivity.SYNC_ON_FORM_ENTRY,
            Configuration(privileges={"CLOUDCARE"}, case_search_enabled=True, sync_cases_on_form_entry=True),
            True,
        )
        with state.fork(), observe.flipped(flip, state):
            outcome = observe.build(state, record, app_id, "A").outcome
        return sensitivity.flip_differences("suite-app", flip.gate, plain, parsed_plain, outcome)

    observed, changed = _sensitivity(core_runner, hq_test_app(), then=under_sync)
    assert sensitivity.SYNC_ON_FORM_ENTRY not in observed.settings_read
    assert changed == []


# Holding --------------------------------------------------------------------

SYNC = sensitivity.SYNC_ON_FORM_ENTRY
CLAIM = Difference(
    "sensitivity",
    "doc",
    f"suite.xml@{SYNC}",
    "/suite/entry[*]/post[*]",
    "/suite/entry[2]/post[1]",
    "added",
    None,
    "<post/>",
)
TEXT = Difference(
    "sensitivity",
    "doc",
    f"app_strings:en@{EMPTY_CASE_LIST_TEXT}",
    "/m*_no_items_text",
    "/m0_no_items_text",
    "added",
    None,
    "List is empty.",
)
EFFECTS = {
    SYNC: (("suite.xml", "/suite/entry[*]/post[*]"),),
    EMPTY_CASE_LIST_TEXT: (("app_strings:*", "/m*_no_items_text"),),
}
DEFECT_20 = Entry(
    id="defect-20-sync",
    defect=20,
    part="sync on form entry",
    check="sensitivity",
    artifact=f"suite.xml@{SYNC}",
    path="/suite/entry[*]/post[*]",
    document="doc",
    control="defect-20-sync",
)


def _observed(*flips):
    return [sensitivity.Sensitivity("doc", "minimum", flips=list(flips))]


def _flip(difference, accepted=True):
    gate = sensitivity.split_artifact(difference.artifact)[1]
    return sensitivity.FlipResult(gate, accepted, [difference])


def test_a_flip_leaves_core_admission_to_the_bar_and_still_reports_hqs_verdicts():
    """A plain build Core refused to install, against a flipped build that is never admitted: the refusal is the
    bar's (``admission@A``), so no flip reports it gone; a ``validate_app`` error the flip removes still is."""
    from proof.observe.outcome import BuildOutcome

    problem = {"stage": "install", "resource": "r1", "descriptor": "Form: m0-f0", "message": "bad", "class": "E"}
    error = {"type": "blank form", "form_type": "module_form"}
    plain = BuildOutcome("A", 2, [error], {}, {}, admission={"admitted": False, "problems": [problem]})
    flipped = BuildOutcome("A", 2, [], {}, {})
    found = sensitivity._verdict_differences("doc", plain, flipped)
    assert [(d.artifact, d.kind) for d in found] == [("validate_app", "removed")]


def test_a_change_its_gate_names_is_explained_and_one_it_does_not_is_held():
    holding = sensitivity.hold_flips(_observed(_flip(CLAIM), _flip(TEXT)), EFFECTS, ())
    assert holding.explained == [CLAIM, TEXT] and holding.held == []

    # The same change under another gate's flip is that gate's to name.
    elsewhere = Difference(**{**CLAIM.as_json(), "artifact": f"suite.xml@{EMPTY_CASE_LIST_TEXT}"})
    assert sensitivity.hold_flips(_observed(_flip(elsewhere)), EFFECTS, ()).held == [elsewhere]
    # An effect names a class: the path must be its path.
    deeper = Difference(**{**CLAIM.as_json(), "path": "/suite/entry[*]/post[*]/@relevant"})
    assert sensitivity.hold_flips(_observed(_flip(deeper)), EFFECTS, ()).held == [deeper]


def test_a_register_entry_holds_what_it_names_even_where_an_effect_names_it_too():
    holding = sensitivity.hold_flips(_observed(_flip(CLAIM), _flip(TEXT)), EFFECTS, (DEFECT_20,))
    assert holding.held == [CLAIM] and holding.explained == [TEXT]


def test_a_refused_flip_is_held_to_its_gates_effects_alone():
    stranger = Difference(**{**CLAIM.as_json(), "path": "/suite/entry[*]/instance[@id=*]", "kind": "removed"})
    holding = sensitivity.hold_flips(
        _observed(sensitivity.FlipResult(SYNC, False, [CLAIM, stranger])), EFFECTS, (DEFECT_20,)
    )
    assert holding.held == [], "a symptom under a configuration Nova refuses never reaches the register"
    assert holding.explained == [CLAIM] and holding.unexplained_refused == [stranger]


def test_a_flip_is_refused_exactly_where_nova_publish_would_refuse_the_configuration():
    verdict = {"minimumConfiguration": {"flags": ["SYNC_SEARCH_CASE_CLAIM"], "caseSearchEnabled": True}}
    plain = Configuration(flags={"SYNC_SEARCH_CASE_CLAIM"}, case_search_enabled=True)
    flips = {
        flip.gate: flip
        for flip in sensitivity.flips(
            plain, {"SYNC_SEARCH_CASE_CLAIM", "SESSION_ENDPOINTS"}, {SYNC: 1, sensitivity.FLAT_FIXTURE: 1}, verdict
        )
    }
    assert sensitivity.accepts(verdict, plain)
    assert flips[sensitivity.flag_gate("SESSION_ENDPOINTS")].accepted
    assert flips[sensitivity.flag_gate("SESSION_ENDPOINTS")].configuration.flags == {
        "SYNC_SEARCH_CASE_CLAIM",
        "SESSION_ENDPOINTS",
    }
    assert not flips[sensitivity.flag_gate("SYNC_SEARCH_CASE_CLAIM")].accepted
    assert flips[SYNC].accepted and flips[SYNC].configuration.sync_cases_on_form_entry
    # Nova's publish asks nothing about the flat fixture yet, and its flip keeps the configuration.
    assert flips[sensitivity.FLAT_FIXTURE].accepted and flips[sensitivity.FLAT_FIXTURE].configuration == plain
    assert not sensitivity.accepts(verdict, Configuration(flags={"SYNC_SEARCH_CASE_CLAIM"}))


# The effects writer ---------------------------------------------------------


@pytest.mark.parametrize(
    ("artifact", "effect"),
    [
        ("suite.xml", "suite.xml"),
        ("profile.ccpr", "profile.ccpr"),
        ("form:0.1", "form:*"),
        ("app_strings:en", "app_strings:*"),
        ("app_strings:default", "app_strings:*"),
        ("proofprofile/form:2.0", "*/form:*"),
        ("proofprofile/suite.xml", "*/suite.xml"),
        ("validate_app", "validate_app"),
        ("create_all_files:proofprofile", "create_all_files:*"),
    ],
)
def test_an_effect_names_a_built_artifact_with_its_data_positions_as_stars(artifact, effect):
    assert sensitivity.effect_artifact(artifact) == effect


def _evidence(out, document_id, kind, flips, monkeypatch):
    from proof.checks.corpus import Document

    monkeypatch.setenv("PROOF_OUT", str(out))
    document = Document(id=document_id, source="test", root=out, kind=kind)
    observed = [sensitivity.Sensitivity(document_id, "minimum", flips=flips)]
    cases.evidence("sensitivity", document, [], observed=sensitivity.evidence_of(observed))


def _corpus(root, *document_ids):
    """A corpus index listing the documents, as the run that wrote the evidence read it."""
    root.mkdir(parents=True, exist_ok=True)
    (root / "index.json").write_text(json.dumps({"documents": [{"id": d} for d in document_ids]}))
    return root


def _gates(tmp_path):
    """The real gates file, with a stale effect on CommTrack and on SESSION_ENDPOINTS."""
    gates = tmp_path / "gates.json"
    entries = json.loads(sensitivity.GATES_JSON.read_text(encoding="utf-8"))
    for entry in entries:
        if entry["id"] in (sensitivity.COMMTRACK, sensitivity.flag_gate("SESSION_ENDPOINTS")):
            entry["effects"] = [{"artifact": "suite.xml", "path": "/suite/entry[*]/datum[*]"}]
    gates.write_text(sensitivity.format_gates(entries))
    return gates


def _blocks(out):
    """Every block directory of a run's output, as the effects command is handed them (``<output>/blocks/*``)."""
    return sorted(str(block) for block in (out / "blocks").iterdir())


def _whole_run(tmp_path, monkeypatch):
    """Evidence of one whole run over a corpus of two documents, plus a control; returns its output directory.

    Laid out as a run lays it out: the corpus the run emitted in ``<output>/corpus``, and each group's evidence in
    its own block's directory, ``<output>/blocks/<id>`` (``proof.lane.blocks.block_dir``), its ``PROOF_OUT``.
    """
    monkeypatch.delenv("PROOF_CORPUS", raising=False)
    out = tmp_path / "out"
    _corpus(out / "corpus", "one", "two")
    form_text = Difference(**{**TEXT.as_json(), "artifact": f"app_strings:default@{EMPTY_CASE_LIST_TEXT}"})
    unchanged = sensitivity.FlipResult(sensitivity.COMMTRACK, True, [])
    blocks = out / "blocks"
    _evidence(blocks / "b1", "one", "corpus", [_flip(TEXT), _flip(CLAIM, accepted=False), unchanged], monkeypatch)
    _evidence(blocks / "b2", "two", "corpus", [_flip(form_text)], monkeypatch)
    stale = Difference(**{**CLAIM.as_json(), "path": "/suite/menu[*]"})
    _evidence(blocks / "b3", "a-control", "control", [_flip(stale)], monkeypatch)
    return out


def test_the_gates_file_is_written_as_biome_leaves_it():
    text = sensitivity.GATES_JSON.read_text(encoding="utf-8")
    assert sensitivity.format_gates(json.loads(text)) == text


def test_effects_are_written_from_every_corpus_documents_flips_and_nothing_else(tmp_path, monkeypatch):
    out = _whole_run(tmp_path, monkeypatch)
    gates = _gates(tmp_path)

    written = tmp_path / "written.json"
    assert sensitivity.main(["effects", *_blocks(out), "--gates", str(gates), "--out", str(written)]) == 0
    entries = json.loads(written.read_text())
    effects = {entry["id"]: entry["effects"] for entry in entries if "effects" in entry}
    # Each flipped gate holds what its flips showed on the corpus (a control's differences are not effects):
    # the classes seen, and nothing where its flips changed nothing (a stale effect is dropped).
    assert effects == {
        EMPTY_CASE_LIST_TEXT: [{"artifact": "app_strings:*", "path": "/m*_no_items_text"}],
        SYNC: [{"artifact": "suite.xml", "path": "/suite/entry[*]/post[*]"}],
        sensitivity.COMMTRACK: [],
    }
    # A gate no run flipped holds no effects, stale or empty: no run measured it.
    assert [entry["id"] for entry in entries if "effects" not in entry] == [
        entry["id"] for entry in json.loads(gates.read_text()) if entry["id"] not in effects
    ]
    # Everything else about each entry, and the entries' order, is the gates file's.
    assert [{k: v for k, v in e.items() if k != "effects"} for e in entries] == [
        {k: v for k, v in e.items() if k != "effects"} for e in json.loads(gates.read_text())
    ]
    assert sensitivity.format_gates(entries) == written.read_text()
    # The check holds the next run to what was written: a gate no run flipped names nothing.
    held = sensitivity.load_effects(written)
    assert held[EMPTY_CASE_LIST_TEXT] == (("app_strings:*", "/m*_no_items_text"),)
    assert held[sensitivity.COMMTRACK] == () and held[sensitivity.flag_gate("SESSION_ENDPOINTS")] == ()

    # The same evidence writes the same file.
    again = tmp_path / "again.json"
    assert sensitivity.main(["effects", *_blocks(out), "--gates", str(written), "--out", str(again)]) == 0
    assert again.read_bytes() == written.read_bytes()


@pytest.mark.parametrize("fault", ["a shard missing", "another corpus mixed in", "a shard passed twice"])
def test_effects_are_not_written_from_evidence_that_is_not_one_whole_run(tmp_path, monkeypatch, capsys, fault):
    out = _whole_run(tmp_path, monkeypatch)
    if fault == "a shard missing":
        _corpus(out / "corpus", "one", "two", "three")
        expected = "1 of the corpus's 3 documents (three)"
    elif fault == "another corpus mixed in":
        _evidence(out / "blocks" / "b4", "elsewhere", "corpus", [_flip(TEXT)], monkeypatch)
        expected = "documents the corpus does not list (elsewhere)"
    directories = _blocks(out)
    if fault == "a shard passed twice":
        twice = tmp_path / "again" / "blocks" / "b2"
        _evidence(twice, "two", "corpus", [_flip(TEXT)], monkeypatch)
        directories.append(str(twice))
        expected = "Two runs both wrote the evidence of two"
    written = tmp_path / "written.json"
    assert sensitivity.main(["effects", *directories, "--gates", str(_gates(tmp_path)), "--out", str(written)]) == 1
    assert expected in capsys.readouterr().err
    assert not written.exists()


def test_the_corpus_is_read_where_the_run_read_it(tmp_path, monkeypatch, capsys):
    out = _whole_run(tmp_path, monkeypatch)
    elsewhere = _corpus(tmp_path / "named", "one", "two", "three")
    written = tmp_path / "written.json"
    gates = str(_gates(tmp_path))
    blocks = _blocks(out)
    # Named, it is the corpus: here one the run did not finish.
    assert (
        sensitivity.main(["effects", *blocks, "--corpus", str(elsewhere), "--gates", gates, "--out", str(written)]) == 1
    )
    assert "(three)" in capsys.readouterr().err
    monkeypatch.setenv("PROOF_CORPUS", str(elsewhere))
    assert sensitivity.main(["effects", *blocks, "--gates", gates, "--out", str(written)]) == 1
    assert "(three)" in capsys.readouterr().err
    # Unnamed, it is the one the run emitted beside its blocks: the run covered it, so the effects are written.
    monkeypatch.delenv("PROOF_CORPUS")
    assert sensitivity.main(["effects", *blocks, "--gates", gates, "--out", str(written)]) == 0
    written.unlink()
    # Unnamed and emitted by no run of those blocks, it is unknown.
    shutil.rmtree(out / "corpus")
    assert sensitivity.main(["effects", *blocks, "--gates", gates, "--out", str(written)]) == 1
    assert "Name the corpus with --corpus" in capsys.readouterr().err
    assert not written.exists()


def test_a_gate_the_runs_flipped_that_no_gate_entry_names_is_refused(tmp_path, monkeypatch, capsys):
    monkeypatch.delenv("PROOF_CORPUS", raising=False)
    out = tmp_path / "out"
    _corpus(out / "corpus", "one")
    unknown = Difference(**{**TEXT.as_json(), "artifact": "suite.xml@toggle/NOT_A_GATE_ENTRY"})
    _evidence(out / "blocks" / "b1", "one", "corpus", [_flip(TEXT), _flip(unknown)], monkeypatch)
    written = tmp_path / "written.json"
    assert sensitivity.main(["effects", *_blocks(out), "--gates", str(_gates(tmp_path)), "--out", str(written)]) == 1
    assert "toggle/NOT_A_GATE_ENTRY, which no gate entry names" in capsys.readouterr().err
    assert {e["id"]: e.get("effects") for e in json.loads(written.read_text())}[EMPTY_CASE_LIST_TEXT]
