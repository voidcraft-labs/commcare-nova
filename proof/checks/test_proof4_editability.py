"""Proof 4, HQ editability: HQ's own editors save over Nova's next publish and leave it unchanged.

Contract (plan work item 11, proof 4; work item 4's configurations): over
each B, the app Nova's next publish leaves in HQ (of D again, and of D′
after the edit batch), under every configuration the document is exported
under (its minimum, its maximum, and each single-flag configuration a
reproduction names), every app-manager save HQ offers is made once and
Vellum opens and saves every form twice, each save over B itself (a form's
second Vellum save over its first, and judged against what the first
left), and each save leaves the state it was made over unchanged up to the
registered spelling rules. Where a save changes what HQ stores, the saved
app is built and compared with that state's build as proof 2 compares two
builds, and where the build still differs, both run as proof 3 runs two
builds, so the change is seen as a build failure, a build difference or a
behavior difference (``proof.observe.proof4`` observes, ``proof.checks.proof4``
judges). The plausible failures: an editor that rewrites or drops what Nova
emitted (defects 3, 12 to 15, 21, 23 to 27), an editor that refuses Nova's
content, and HQ's own views failing on what an editor sends them.

The framework tests below hold the check to that over HQ's own suite-test
app as B, in a unit of its own (published, built as A, saved again as the
next publish over it, built over saved(build(A)) as B, then marked, as the
unit makes B), each through the path the corpus check takes (``observe_b``
over a ``BContext``, its record judged by ``judge_b``), and each pairing
what the check must report with what it must not:

- a Case List save that drops a single-date search input without
  ``CASE_SEARCH_ADVANCED`` is seen in the stored app and in HQ's build, and
  with the flag the same save shows neither;
- a Vellum save's change to the stored form is seen whether or not HQ's
  build carries it, only what the build carries is a build difference
  (``requiredCondition`` is carried, the ``vellum:`` attributes are
  stripped, ``xform.py::XForm.strip_vellum_ns_attributes``), and a build
  difference no runtime reads (Core ignores ``requiredCondition``, and the
  form's new version is the version clause's) gives no behavior difference;
  the second save, over the first, is judged against what the first left
  (its stored app, its build, made the previous build of the second's so
  the form keeps its version, and its sessions), so it reports what the
  second round trip changes and no more, and each open reports all Vellum
  says of the form it opened;
- a Case Management save that turns a non-writing follow-up's ``update
  never`` into ``always`` is seen in HQ's case processing and the traces;
- sessions never run on a build HQ would not release, nor over a restore
  HQ refuses: a save over a B whose tables HQ will not serve is one refused
  trace naming the restore in its path, a save whose build HQ will not
  release one naming the step that raised, and a save over a B whose own
  ``validate_app`` lists an error is no refused trace at all (the bar
  reports B's errors); the same save over a valid B with its restore served
  runs the sessions;
- HQ's case processing runs with HQ's soft assertions as production runs
  them, so an emptied case id is HQ's refusal, not a harness failure, and
  the note HQ makes on the way is proof 4's difference, named for the save's
  editor; a kept trace's case processing notes it again under the save that
  reused it;
- a page HQ withholds (case management of a form HQ cannot validate) is a
  difference naming why, and a page with nothing to save is not;
- the alerts a save adds and the messages HQ's views leave are reported,
  each keyed by what it says, and the notices a page shows before any save
  are not; the record keeps those notices for each section the view's one
  load saved, and none for a section saved from a load of its own after HQ
  answered with a redirect;
- an editor's message is keyed by what it says, the app's names written
  ``*``: one sentence over one kind of node is one class on any form, two
  kinds of node two classes, and a logic warning one class per kind of
  reference it names;
- HQ's own view raising on an editor's request is a difference, and a
  request the harness refused, or a run the driver could not finish, ends
  the check;
- the Case Detail and User Properties saves reach HQ's own views, and each
  stores only its own part of the app.

And what fork-from-B rests on:

- a save's judged differences do not depend on the order the views, their
  sections and the Vellum forms ran in (each runs over B: the record and
  its judgment are the same in HQ's order and reversed);
- a view or Vellum run replayed from a transcript gives the record a live
  run gives, and a transcript HQ no longer answers as recorded falls back to
  a live run with the same record;
- a kept build or trace is made again under ``PROOF_VERIFY_MEMOS=1`` and must
  be equal, and one that is not is caught;
- Core decides when two spellings of an attribute it reads are one: a
  respelling in whitespace is the same expression, a regrouping is not; the
  observation records Core's reading of each attribute a save respelled in
  the stored and the built forms, read as Core's form parser reads it there
  (a bind's conditions and a group's ``ref`` as XPath, an itemset label as
  ``ItemSetParsingUtils.setLabel`` reads it, a question's label or hint as
  text, a group's ``nodeset`` not at all), so a Vellum save that re-spaces
  an expression is no difference and one that regroups it is;
- a save's build is compared wherever the save changed what HQ stores,
  whatever Core's reading of that change: an instance call re-spaced is the
  same expression to Core, and HQ's build, which finds instances by a
  pattern over the form's text, no longer declares the instance; an itemset
  label Core refuses is a difference, through ``validate_app`` too;
- an attachment is compared by its content, whatever it shows as;
- the stored app's patch gives back exactly the stored app;
- a saved app's build is compared with build(B) parsed once, reading only
  the files whose bytes differ and the profiles and suites, and that gives
  the answer comparing both builds whole gives, wherever the version clause
  reads a file differently on the two sides (a version moved with nothing
  else, a form whose content changed) and wherever a file of the same bytes
  is still a difference (one that does not parse);
- what a view offers is read from B's app as read once only while HQ holds
  B's app document, and from the app read afresh once a save changed it;
  under ``PROOF_VERIFY_MEMOS=1`` every reading of B's app as read once (the
  views and forms proof 4 runs, what a view offers, which forms Vellum
  opens) is held to the app read afresh.

Every corpus difference must fall in a class of ``proof/known-defects.json``.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
from contextlib import contextmanager
from dataclasses import replace
from types import SimpleNamespace
from unittest import mock

import pytest
from lxml import etree

from proof.checks import casedata, cases, observations, proof4
from proof.checks.compare import names
from proof.checks.differences import Difference, summary
from proof.editors import pages
from proof.editors.client import EditorDriverError
from proof.editors.conftest import publish_hq_app
from proof.editors.hq import EditorRunFailed, HQAnswers, HQRefusedPageRequest
from proof.hq import operations
from proof.hq.configuration import Configuration
from proof.observe import proof4 as observed
from proof.observe.outcome import BuildOutcome

XFORMS = "http://www.w3.org/2002/xforms"
ORX = "http://openrosa.org/jr/xforms"
SUITE = "hq-suite-app"
OVER = proof4.Over(proof4.REPUBLISH, "suite")
CONFIGURATION = Configuration(privileges={"CLOUDCARE"})


@pytest.mark.parametrize("document", cases.document_params() + cases.control_params("proof4"))
def test_hqs_editors_leave_the_next_publish_unchanged(document, hq, core_runner, editor_driver):
    records = observations.records_for(document, core_runner, editor_driver=editor_driver)
    found, saves = proof4.document_editability(document, records)
    cases.hold(
        "proof4",
        document,
        found,
        cases.load_register(),
        configurations=sorted(document.exports),
        saves=saves,
    )


# HQ's suite-test app as B, and its case data -------------------------------------------------------


def _stamp(minute):
    return f"2025-12-01T08:{minute:02d}:00.000000Z"


# A case of the suite app's case type that passes its case list's filter (``filter = 'danny'``), and the
# worker's user case, as every project with user cases gives its workers (proof.checks.casedata).
SUITE_DATABASE = casedata.CaseDatabase(
    user_id=casedata.USER_ID,
    username=casedata.USERNAME,
    user_data=(),
    cases=(
        casedata.CaseRecord(
            case_id="suite-case",
            case_type="suite_test",
            name="Danny",
            owner_id=casedata.USER_ID,
            opened_on=_stamp(0),
            modified_on=_stamp(0),
            external_id=None,
            properties=(
                ("filter", "danny"),
                ("plain", "Plain text"),
                ("phone", "5550100"),
                ("enum", "yes"),
                ("address", "Main Street"),
            ),
        ),
        casedata.CaseRecord(
            case_id=casedata.USERCASE_ID,
            case_type=casedata.USERCASE_TYPE,
            name=casedata.USERNAME,
            owner_id=casedata.USER_ID,
            opened_on=_stamp(1),
            modified_on=_stamp(1),
            external_id=None,
            properties=(("hq_user_id", casedata.USER_ID), ("username", casedata.USERNAME)),
        ),
    ),
)


def _followup_as_hqs_editor_writes_it(app):
    # suite/app.json stores the follow-up form's unused open_case name as null, which HQ's form page script
    # cannot read (case_config_ui.js::to_case_transaction maps name_update_multi's question paths) and HQ's
    # editor never writes: a form it makes holds an empty ConditionalCaseUpdate there.
    from corehq.apps.app_manager.models import ConditionalCaseUpdate

    app.modules[0].forms[1].actions.open_case.name_update = ConditionalCaseUpdate()


def _without_indicators(app):
    # The suite app's case list shows a call-center indicator, which Core reads from HQ's indicators fixture;
    # the case data here carries cases only, so the column is left out.
    for detail in (app.modules[0].case_details.short, app.modules[0].case_details.long):
        detail.columns = [column for column in detail.columns if not column.field.startswith("indicator:")]


class _Store:
    """A store holding nothing but the browser transcripts it is given (``proof.observe.record.Store``)."""

    fresh = False

    def __init__(self, transcripts=None):
        self.transcripts = transcripts


@contextmanager
def suite_b(configuration, prepares, core_runner, editor_driver, *, store=None, restore_refusal=None):
    """HQ's suite app as B, in a unit of its own, as the unit makes B: yields ``(BContext, B's mark)``.

    The app is published (with ``prepares`` applied and saved), built as A
    with no previous build, saved(build(A)) kept, built again over it as B,
    and the unit marked there, each step in an operation of the unit, so HQ's
    entropy and clock are the state's (``proof.hq.branch``). HQ serves the
    case data's restore, unless ``restore_refusal`` gives HQ's reason for
    refusing it (``proof.observe.sessions.hq_restore``).
    """
    from proof.hq.state import hq_unit
    from proof.observe.record import Blobs
    from proof.observe.sensitivity import build
    from proof.observe.unit import BContext, HookUnit, OperationLog

    root = hashlib.sha256(b"proof4 framework: " + configuration.digest()).digest()
    with hq_unit(configuration, root_key=root, validate=core_runner.validate_form) as unit:
        log = OperationLog(unit, unit.record, {})
        with log("create", b"hq suite app"):
            app_id = publish_hq_app(unit)
            app = operations.held_app(unit, app_id)
            _without_indicators(app)
            _followup_as_hqs_editor_writes_it(app)
            for prepare in prepares:
                prepare(app)
            app.save()
        with log("build", b"A"):
            built_a = build(unit, unit.record, app_id, "A", None)
        with log("save-build", b""):
            saved_a = built_a.hq_build.saved_build()
        # B is the next publish over A: HQ saves the app again, its version one on (here with A's content).
        with log("publish", b"hq suite app again"):
            operations.held_app(unit, app_id).save()
        with log("build", b"B"):
            built_b = build(unit, unit.record, app_id, "B", saved_a)
        restore, outcome = None, {"refused": restore_refusal}
        if restore_refusal is None:
            with log("restore", b""):
                restore, outcome = casedata.restore(SUITE_DATABASE, unit.domain), {"served": True}
        mark = unit.mark()
        ctx = BContext(
            document=SimpleNamespace(id=SUITE),
            over="B",
            configuration=configuration,
            configuration_name=OVER.configuration,
            unit=HookUnit(unit, log, "proof4"),
            app_id=app_id,
            build=built_b.outcome,
            hq_build=built_b.hq_build,
            sessions=(SUITE_DATABASE, None),
            restore=restore,
            core_runner=core_runner,
            editor_driver=editor_driver,
            blobs=Blobs(),
            store=store or _Store(),
            restore_outcome=outcome,
        )
        yield ctx, mark


def _judged(ctx, record):
    return proof4.judge_b(SUITE, record, ctx.blobs, OVER, ctx.build)


def _observe(configuration, prepares, core_runner, editor_driver, *, views=None, forms=None, store=None):
    """Proof 4 over the suite app's B, narrowed to ``views`` and ``forms``: the record, its differences, saves."""
    with suite_b(configuration, prepares, core_runner, editor_driver, store=store) as (ctx, _):
        record = observed.observe_b(ctx, views=views, forms=forms)
        found, saves = _judged(ctx, record)
    return record, found, saves


def _view(name, m=None, f=None):
    return lambda view, scope: view == name and scope == [m, f]


def _nothing(*_):
    return False


def _artifact(name):
    return f"{name}@{OVER.state}@{OVER.configuration}"


def _classes(differences, artifact):
    return {difference.path for difference in differences if difference.artifact == _artifact(artifact)}


def _save(saves, editor):
    (found,) = [save for save in saves if save["editor"] == editor]
    return found


@pytest.fixture(autouse=True)
def _transcripts_off(monkeypatch):
    # Each test observes its own B live; the transcript tests turn replay on themselves.
    monkeypatch.setenv(observed.TRANSCRIPTS_ENVIRONMENT, "off")


# The Case List and the stored app ----------------------------------------------------------------


def _date_search(app):
    # One module searching by a single date, as test_control.py stores it, through HQ's own models.
    from corehq.apps.app_manager.models import CaseSearch, CaseSearchProperty

    app.modules[0].search_config = CaseSearch(
        properties=[CaseSearchProperty(name="dob", label={"en": "Date of birth"}, input_="date")]
    )


def test_a_case_list_save_that_drops_a_date_input_is_seen_in_the_stored_app_and_the_build(
    hq, core_runner, editor_driver
):
    def save_with(flags):
        configuration = Configuration(privileges={"CLOUDCARE"}, flags=flags, case_search_enabled=True)
        _, found, _ = _observe(
            configuration, [_date_search], core_runner, editor_driver, views=_view("view_module", 0), forms=_nothing
        )
        return found

    dropped, kept = save_with(set()), save_with({"CASE_SEARCH_ADVANCED"})

    stored_input = "/modules/*/search_config/properties/*/input_"
    assert stored_input in _classes(dropped, "app.json@case list"), summary(dropped)
    assert stored_input not in _classes(kept, "app.json@case list"), summary(kept)
    # HQ's suite writes a date prompt's input (remote_requests.py), so the build shows the drop too.
    built = [path for path in _classes(dropped, "suite.xml@case list") if "/prompt[" in path and "@input" in path]
    assert built, summary(dropped)
    assert not [path for path in _classes(kept, "suite.xml@case list") if "/prompt[" in path and "@input" in path]
    # The module's other saves were made over B too, so none of them carries the case list's drop.
    assert not [d for d in dropped if "@case list@" not in d.artifact and "input_" in d.path], summary(dropped)


# Vellum, the build, and behavior ---------------------------------------------------------------------


def _required_condition_and_an_id_vellum_refuses(app):
    # On the suite app's first form: a required condition, as an author writes one in Vellum, and a hidden
    # value whose id starts with an underscore, which Vellum reports as no valid question id (mugs.js). The
    # form's data node and title are given the form's name, which Vellum writes there on every save (defect 14's
    # data node name), so that the required condition is the save's only change a runtime could read.
    form = app.modules[0].forms[0]
    tree = etree.fromstring(form.source.encode("utf-8"))
    name = form.name["en"]
    next(tree.iter(f"{{{XFORMS}}}instance"))[0].set("name", name)
    next(element for element in tree.iter() if etree.QName(element).localname == "title").text = name
    binds = list(tree.iter(f"{{{XFORMS}}}bind"))
    (bind,) = [element for element in binds if element.get("nodeset") == "/data/address"]
    bind.set("required", "/data/plain = 'x'")
    data = next(tree.iter(f"{{{XFORMS}}}instance"))[0]
    etree.SubElement(data, etree.QName(data, "_proof_hidden").text)
    hidden = etree.Element(f"{{{XFORMS}}}bind", nodeset="/data/_proof_hidden", calculate="1")
    binds[-1].addnext(hidden)
    form.source = etree.tostring(tree, encoding="unicode")


def test_a_vellum_save_is_seen_in_the_stored_form_and_in_the_build_only_where_hqs_build_carries_it(
    hq, core_runner, editor_driver, without_spelling_rules
):
    record, found, saves = _observe(
        CONFIGURATION,
        [_required_condition_and_an_id_vellum_refuses],
        core_runner,
        editor_driver,
        views=_nothing,
        forms=lambda scope: scope == [0, 0],
    )
    (form,) = record["vellum"]
    assert len(form["runs"]) == 2 and "again" not in form, form
    # Vellum reports the id on both opens, keyed by what it says (the id is the app's, written *), and each open's
    # report is whole: the second open says it of the form Vellum's own first save wrote.
    refused_id = (
        "/modules/*/forms/*/questions/*/nodeID/mug-nodeID-error/* is not a valid Question ID. It must start with a"
        " letter and contain only letters, numbers, and '*' or '*' characters."
    )
    assert refused_id in _classes(found, "editor:vellum"), summary(found)
    assert refused_id in _classes(found, "editor:vellum again"), summary(found)
    first = _classes(found, "source:form:0.0@vellum")
    # The address question's bind, as the comparison writes a bind of a question (its node set by its data path).
    (bind,) = {path.rsplit("/", 1)[0] for path in first if path.endswith("/@requiredCondition")}
    assert bind.startswith("/html/head[*]/model[*]/bind[@nodeset="), bind
    assert {f"{bind}/@vellum:required", f"{bind}/@requiredCondition"} <= first, summary(found)
    # HQ's build keeps the plain attribute and strips every vellum: one.
    built = _classes(found, "form:0.0@vellum")
    assert f"{bind}/@requiredCondition" in built
    assert not [path for path in built if "@vellum:" in path]
    # The build differs, so both builds' sessions ran; Core ignores requiredCondition (XFormParser.parseBind
    # reads only the standard bind attributes), and the form's new version is the version clause's, so the
    # traces and HQ's case processing agree.
    assert (_save(saves, proof4.VELLUM)["built"], _save(saves, proof4.VELLUM)["ran"]) == (True, True)
    # The form the save left as it was keeps the version build(B) gave it (HQ's set_form_versions over
    # saved(build(B)), whose forms hold the versions B's build decided), so nothing of it differs.
    assert not [d for d in found if d.artifact.startswith(("form:0.1@", "source:form:0.1@"))], summary(found)
    assert not _classes(found, "trace@vellum") and not _classes(found, "case_blocks@vellum"), summary(found)
    # The second save is over the first and judged against what the first left: it keeps the first's changes, so
    # none of them is its own, and adds to the vellum: attributes the first wrote (a chain with no fixed point),
    # which HQ's build drops whole. Its build, made over the first's as HQ's previous build, keeps the form's
    # version, so nothing of it differs from the first's and no session runs.
    again = _classes(found, "source:form:0.0@vellum again")
    assert f"{bind}/@vellum:vellum__required" in again, summary(found)
    assert f"{bind}/@requiredCondition" not in again, summary(found)
    stored_or_said = ("source:", "editor:", "app.json@")
    built_or_ran = [d for d in found if "@vellum again@" in d.artifact and not d.artifact.startswith(stored_or_said)]
    assert built_or_ran == [], summary(found)
    assert [_save(saves, proof4.VELLUM_AGAIN)[key] for key in ("stored_changed", "built", "ran")] == [True, True, False]


VELLUM_NAMESPACE = "http://commcarehq.org/xforms/vellum"
RESPACED = ("/data/plain='x'", "/data/plain = 'x'")
REGROUPED = ("(/data/plain + 1) * 2 > 3", "/data/plain + 1 * 2 > 3")


def _a_condition_vellum_respaces_and_one_it_regroups(app):
    # Two display conditions on the suite app's first form, each written back by Vellum's save. Vellum prints every
    # expression it reads with its operators between single spaces (js-xpath's binary expressions), so one spelled
    # without spaces is re-spaced. Vellum reads a rich-text form's vellum: attribute over the plain one
    # (parser.js::parseVellumAttrs; HQ's form designer turns rich text on) and writes the plain one from it, so a
    # vellum:relevant that groups the condition otherwise has the save regroup it.
    form = app.modules[0].forms[0]
    tree = etree.fromstring(form.source.encode("utf-8"))
    root = etree.Element(tree.tag, tree.attrib, nsmap={**tree.nsmap, "vellum": VELLUM_NAMESPACE})
    root.extend(list(tree))
    binds = {element.get("nodeset"): element for element in root.iter(f"{{{XFORMS}}}bind")}
    binds["/data/phone"].set("relevant", RESPACED[0])
    binds["/data/address"].set("relevant", REGROUPED[0])
    binds["/data/address"].set(f"{{{VELLUM_NAMESPACE}}}relevant", "#form/plain + 1 * 2 > 3")
    form.source = etree.tostring(root, encoding="unicode")


def test_a_vellum_save_that_respaces_an_expression_is_no_difference_and_one_that_regroups_it_is(
    hq, core_runner, editor_driver
):
    with suite_b(CONFIGURATION, [_a_condition_vellum_respaces_and_one_it_regroups], core_runner, editor_driver) as (
        ctx,
        _,
    ):
        record = observed.observe_b(ctx, views=_nothing, forms=lambda scope: scope == [0, 0])
        found, saves = _judged(ctx, record)
        (form,) = record["vellum"]
        # What the observation recorded of Core's reading of each pair the save respelled, run by run.
        readings = [
            {
                (a, b): result["same"]
                for reading, a, b, result in (ctx.blobs.get_json(run["xpath"]) if run.get("xpath") else [])
                if reading == "xpath"
            }
            for run in form["runs"]
        ]
    # The first save read the re-spaced condition as one expression and the regrouped one as two; the second,
    # over the first, wrote both as the first left them, so it respelled nothing Core reads.
    assert [(run.get(RESPACED), run.get(REGROUPED)) for run in readings] == [(True, False), (None, None)], readings
    # So in the stored form and in its build the regrouped condition is the first save's one difference, and the
    # second save, judged against what the first left, changes no condition.
    address = "/html/head[1]/model[1]/bind[@nodeset=/data/address]/@relevant"
    for artifact in ("source:form:0.0@vellum", "form:0.0@vellum"):
        relevant = {
            d.at: (d.kind, d.before, d.after)
            for d in found
            if d.artifact == _artifact(artifact) and d.path.endswith("/@relevant")
        }
        assert relevant == {address: ("changed", *REGROUPED)}, (artifact, summary(found))
    assert not [d for d in found if "@vellum again@" in d.artifact and d.path.endswith("/@relevant")], summary(found)
    assert [_save(saves, proof4.VELLUM)[key] for key in ("stored_changed", "built")] == [True, True]


def _non_writing_followup(app):
    # The suite app's follow-up form (View Case) loads its case and writes nothing to it.
    form = app.modules[0].forms[1]
    form.actions.update_case.update = {}
    form.actions.update_case.condition.type = "never"
    form.actions.case_preload.preload = {}
    form.actions.case_preload.condition.type = "never"


def test_a_case_management_save_that_makes_a_followup_write_is_seen_in_hqs_case_processing(
    hq, core_runner, editor_driver
):
    _, found, saves = _observe(
        CONFIGURATION,
        [_non_writing_followup],
        core_runner,
        editor_driver,
        views=_view("view_form", 0, 1),
        forms=_nothing,
    )
    assert "/modules/*/forms/*/actions/update_case/condition/type" in _classes(found, "app.json@case management")
    save = _save(saves, "case management")
    assert (save["built"], save["ran"]) == (True, True)
    # The follow-up's submission now carries a case block, which HQ applies to the loaded case.
    blocks = _classes(found, "case_blocks@case management")
    assert any(path.startswith("/runs/*/blocks") for path in blocks), summary(found)
    assert any(path.startswith("/runs/*/cases") for path in blocks), summary(found)
    assert any("/submission" in path for path in _classes(found, "trace@case management")), summary(found)
    # The form settings save beside it, over B, writes no case block.
    assert not _classes(found, "case_blocks@form settings"), summary(found)


def _invalid_form_filter(app):
    # A form display condition HQ's XPath validator cannot parse: validate_app lists it as the form's error
    # (helpers/validators.py, ``form filter has xpath error``), and create_all_files still writes every file.
    app.modules[0].forms[0].form_filter = "/data/plain = = 'x'"


@pytest.mark.parametrize(
    ("prepares", "buildable"),
    [
        pytest.param([], True, id="over a B HQ releases: the sessions run"),
        pytest.param([_invalid_form_filter], False, id="over a B whose validate_app lists an error: nothing runs"),
    ],
)
def test_sessions_run_only_on_builds_hq_would_release(hq, core_runner, editor_driver, prepares, buildable):
    with suite_b(CONFIGURATION, prepares, core_runner, editor_driver) as (ctx, _):
        record = observed.observe_b(ctx, views=_view("app_settings"), forms=_nothing)
        found, saves = _judged(ctx, record)
        b_errors = ctx.build.errors
    save = _save(saves, "app settings")
    traces = [d for d in found if d.artifact == _artifact("trace@app settings")]
    # The settings save writes the posted settings into the profile (proof.editors.test_pages), so HQ's build
    # differs either way.
    assert save["built"] and any(d.artifact == _artifact("profile.xml@app settings") for d in found), summary(found)
    if buildable:
        assert save["ran"] and "admission" in record["baseline"]
        assert any(d.path.startswith("/profile/properties/") for d in traces), summary(found)
    else:
        # B's own validate_app lists the error, which the bar reports (validate_app@B); no session runs over it,
        # and proof 4 reports no refusal of its own for it.
        assert b_errors and not save["ran"] and record["baseline"] == {"unbuildable": True}
        assert traces == [], summary(found)
        assert not [d for d in found if d.artifact.startswith(("case_blocks@", "admission@"))]


def test_sessions_never_run_over_a_restore_hq_refuses(hq, core_runner, editor_driver):
    # HQ refuses the restore of a document's tables where it would serve the worker none of them
    # (proof.observe.casedata.lookup_fixtures); B's sessions have nothing to run over, so a save whose build differs
    # is one refused trace naming HQ's reason, where a restore HQ serves runs them (the test above).
    refusal = {
        "why": "HQ holds a lookup table per owner after Nova's upload, and Nova's push uploads every table as global;"
        " the restore here serves only global tables.",
        "workbook": "lookups.xlsx",
        "table": "proof",
    }
    with suite_b(CONFIGURATION, [], core_runner, editor_driver, restore_refusal=refusal) as (ctx, _):
        record = observed.observe_b(ctx, views=_view("app_settings"), forms=_nothing)
        found, saves = _judged(ctx, record)
    assert record["baseline"] == {"restore": refusal}
    save = _save(saves, "app settings")
    assert save["built"] and not save["ran"], save
    traces = [d for d in found if d.artifact == _artifact("trace@app settings")]
    # Named as proof 3 names HQ's refusal of the tables (proof3.lookup_refusal): a table held per owner.
    assert [(d.path, d.kind, d.after) for d in traces] == [("/lookups-not-served/per-owner-table", "refused", refusal)]
    assert not [d for d in found if d.artifact.startswith(("case_blocks@", "admission@"))]


def _submission(case_id, date_modified):
    return (
        '<data xmlns="http://openrosa.org/formdesigner/proof-soft-asserts" uiVersion="1" version="1" name="Proof">'
        f'<case xmlns="http://commcarehq.org/case/transaction/v2" case_id="{case_id}"'
        f' date_modified="{date_modified}" user_id="{casedata.USER_ID}"><update><plain>soft</plain></update></case>'
        f'<n0:meta xmlns:n0="{ORX}"><n0:deviceID>proof</n0:deviceID>'
        "<n0:timeStart>2026-01-15T10:00:00.000Z</n0:timeStart><n0:timeEnd>2026-01-15T10:01:00.000Z</n0:timeEnd>"
        f"<n0:username>{casedata.USERNAME}</n0:username><n0:userID>{casedata.USER_ID}</n0:userID>"
        "<n0:instanceID>uuid:5d5a7d4e-6c1b-4f3e-9a8d-2b7c1e0f4a61</n0:instanceID></n0:meta></data>"
    )


@pytest.mark.parametrize(
    ("case_id", "date_modified", "refusal", "noted"),
    [
        pytest.param("suite-case", "2026-01-15T10:01:00.000Z", None, False, id="a whole case block is applied"),
        pytest.param("", "", "IllegalCaseId", True, id="an emptied case id is HQ's refusal, its note proof 4's"),
    ],
)
def test_hqs_case_processing_runs_with_production_soft_assertions(
    hq, core_runner, case_id, date_modified, refusal, noted
):
    from proof.observe.record import ConfigurationRecords, DocumentRecords
    from proof.observe.sessions import processed_runs

    trace = {"runs": [{"trace": [{"screen": "form", "submission": _submission(case_id, date_modified)}]}]}
    with suite_b(CONFIGURATION, [], core_runner, None) as (ctx, _):
        # As proof 4's observation processes a saved build's submissions: in an operation named for the save's
        # editor.
        with ctx.unit.operation(observed.processing_label(proof4.VELLUM), b"probe"):
            (run,) = processed_runs(ctx.unit, SUITE_DATABASE, trace)["runs"]
        part = ctx.unit._log.recorded({"kind": "b"})
    assert run["submitted"]
    assert (run["refusal"] or {}).get("class") == refusal, run
    if refusal is None:
        assert run["cases"]["suite-case"]["properties"]["plain"] == "soft"
    records = DocumentRecords(SUITE, "corpus")
    records.configurations["suite"] = ConfigurationRecords("suite", {}, a={}, b=part)
    notes = [
        d for d in observations.soft_assertion_differences(records, "proof4") if "proof4-case-processing" in d.artifact
    ]
    # HQ's empty date_modified passes validate_phone_datetime as None after a soft assertion, as in production, and
    # the note names the editor whose save it was made over.
    assert bool(notes) == noted, notes
    assert {d.artifact for d in notes} <= {"soft_assert:proof4-case-processing@vellum@B"}, notes


def test_a_kept_traces_case_processing_notes_again_what_hq_noted_under_the_save_that_reused_it(hq, core_runner):
    # Two saves whose builds have the same files share one trace: the second's case processing is the kept
    # operation, run without its work, and HQ's notes from when it ran are noted in it again, so each save's
    # operation holds them whichever save ran the sessions.
    from proof.hq.boot import SoftAssertNote
    from proof.observe.record import ConfigurationRecords, DocumentRecords

    note = SoftAssertNote("phone datetime should never be empty", "''", "proof::probe", 1)
    with suite_b(CONFIGURATION, [], core_runner, None) as (ctx, _):
        observation = observed._Observation(ctx, observed.hq_order)
        # The kept trace is a probe no sessions gave, so this reads it as kept, whatever the run verifies.
        observation.verify = False
        with ctx.unit.fork():
            observation.prepare()
            kept = {"admission": {"admitted": True}, "trace": None, "processed": None}
            observation.traces[observed.files_key(ctx.build).decode()] = (kept, (b"probe", False, (note,)))
            found = observation.trace(ctx.build, over=observation.b, label=observed.processing_label("case list"))
            part = ctx.unit._log.recorded({"kind": "b"})
    assert found == kept and observation.counts.trace_hits == 1
    # B's own sessions' case processing is B's (``PROCESSING``); the kept one is the reusing save's.
    (entry,) = [entry for entry in part["operations"] if entry["label"] == "proof4-case-processing@case list"]
    assert entry["softAssertions"] == [{"message": note.message, "value": note.value, "where": note.where, "line": 1}]
    records = DocumentRecords(SUITE, "corpus")
    records.configurations["suite"] = ConfigurationRecords("suite", {}, a={}, b=part)
    (difference,) = [
        d for d in observations.soft_assertion_differences(records, "proof4") if d.after == entry["softAssertions"][0]
    ]
    assert difference.artifact == "soft_assert:proof4-case-processing@case list@B"


def _vellum_record(source, *, form_errors=(), questions=(), alerts=(), page_errors=(), loaded=True):
    # What a Vellum run records (proof.observe.proof4.vellum_report), for a form that opened and saved cleanly but
    # for what is given.
    record = {"loaded": loaded, "formErrors": list(form_errors), "questions": list(questions)}
    record.update({"serializationWarnings": [], "preSaveAlerts": list(alerts)})
    if not loaded:
        record["loadError"] = page_errors[0] if page_errors else ""
    return {
        "kind": "vellum",
        "source": source,
        "outputs": {
            "record": record,
            "save": {"saved": loaded},
            "after": {"saveButton": "saved", "modals": []},
            "pageErrors": list(page_errors),
        },
        "saves": [],
    }


def _question(path, attribute, key, message, kind="Text", level="error"):
    return {
        "path": path,
        "type": kind,
        "messages": [{"attribute": attribute, "key": key, "level": level, "message": message}],
    }


def _form_source(data):
    return (
        '<h:html xmlns:h="http://www.w3.org/1999/xhtml" xmlns="http://www.w3.org/2002/xforms"><h:head><model>'
        f'<instance><data xmlns="http://example.com/proof">{data}</data></instance></model></h:head><h:body/></h:html>'
    )


def _vellum_classes(report):
    return [d.path for d in proof4.vellum_report(report, document="-", editor="vellum", scope=proof4.Scope(0, 0))]


DISCARDED = "Bind Node [{}] found but has no associated Data node. This bind node will be discarded!"
NOT_AN_ID = (
    "{} is not a valid Question ID. It must start with a letter and contain only letters, numbers, and '-' or '_'"
    " characters."
)
CASE = 'xmlns="http://commcarehq.org/case/transaction/v2"'


def test_an_editors_message_is_keyed_by_what_it_says_with_the_apps_names_written_as_a_wildcard():
    # The classes the corpus run showed one path for, each holding several defects (the Vellum and pages
    # classifiers' H2): a message is keyed by what it says, so one sentence over one kind of node is one class on
    # any form, and two kinds of node are two classes.
    guard = "__nova_guard_1270f255_e852_4b1c_9a1e_0123456789ab_text"
    visits = _form_source(
        f"<visits><__nova_operations><{guard}><case {CASE}/></{guard}></__nova_operations></visits>"
        f"<records><__nova_subcases><__nova_subcase_0><case {CASE}><attachment><photo/></attachment></case>"
        "</__nova_subcase_0></__nova_subcases></records><items><item/></items>"
    )
    other_guard = guard.replace("1270f255", "99aa00bb")
    patients = _form_source(
        f"<patients><__nova_operations><{other_guard}><case {CASE}/></{other_guard}></__nova_operations></patients>"
        f"<people><__nova_subcases><__nova_subcase_3><case {CASE}><attachment><scan/></attachment></case>"
        "</__nova_subcase_3></__nova_subcases></people><rows><item/></rows>"
    )
    discarded = {
        "guard": (f"/data/visits/__nova_operations/{guard}/case/@case_id", visits),
        "guard elsewhere": (f"/data/patients/__nova_operations/{other_guard}/case/@case_id", patients),
        "attachment": ("/data/records/__nova_subcases/__nova_subcase_0/case/attachment/photo", visits),
        "attachment elsewhere": ("/data/people/__nova_subcases/__nova_subcase_3/case/attachment/scan", patients),
        "count": ("/data/items/@count", visits),
        "count by hashtag": ("#form/rows/@count", patients),
    }
    paths = {
        name: _vellum_classes(
            _vellum_record(source, form_errors=[{"level": "parse-warning", "message": DISCARDED.format(path)}])
        )
        for name, (path, source) in discarded.items()
    }
    assert paths["guard"] == paths["guard elsewhere"], paths
    assert paths["attachment"] == paths["attachment elsewhere"], paths
    assert paths["count"] == paths["count by hashtag"], paths
    assert len({tuple(paths[name]) for name in ("guard", "attachment", "count")}) == 3, paths
    (guard_class,) = paths["guard"]
    # Written as the comparisons write a guard block's node (compare.names), its minted uuid not in it.
    assert f"{names.nova_name(guard)}~1case~1@case_id" in guard_class and "1270f255" not in guard_class, guard_class

    # A question's message: Vellum names the question's own id in it, which is the app's, and Nova's reserved
    # container names are Nova's own; a duplicate choice value says something else again.
    def id_class(path, message, kind="DataBindOnly"):
        (found,) = _vellum_classes(
            _vellum_record(visits, questions=[_question(path, "nodeID", "mug-nodeID-error", message, kind)])
        )
        return found

    authored = {id_class(f"/data/{name}", NOT_AN_ID.format(name)) for name in ("1st_visit", "2nd_visit")}
    reserved = id_class("/data/visits/__nova_operations", NOT_AN_ID.format("__nova_operations"))
    guards = {id_class(f"/data/x/__nova_operations/{name}", NOT_AN_ID.format(name)) for name in (guard, other_guard)}
    duplicate = id_class(None, "This choice value has been used in the same question", "Choice")
    assert len(authored) == 1 and len(guards) == 1, (authored, guards)
    assert len({*authored, reserved, *guards, duplicate}) == 4
    assert reserved.endswith(NOT_AN_ID.replace("'-'", "'*'").replace("'_'", "'*'").format("/__nova_operations"))
    # Vellum writes the id only where its sentence opens with it: a question whose id is a word of another
    # sentence keeps that sentence whole, the same class as on a question whose id it does not hold.
    for sentence in (
        "You are referencing a node in this form. This can cause errors in the form",
        "Add at least one property to update, or deselect the Update action.",
    ):
        on = {id_class(f"/data/{name}", sentence) for name in ("form", "update", "q1")}
        assert len(on) == 1 and next(iter(on)).endswith(sentence), on

    # A logic warning, once for each unknown reference it names, by what the reference refers to.
    def logic(message):
        return _vellum_classes(
            _vellum_record(
                visits,
                questions=[
                    _question(
                        "/data/copied", "calculateAttr", "logic-bad-path-warning", message, "DataBindOnly", "warning"
                    )
                ],
            )
        )

    warning = "/modules/*/forms/*/questions/*/calculateAttr/logic-bad-path-warning/"
    assert (
        logic("Unknown question: #case/care_status")
        == logic("Unknown question: #case/allergen")
        == [f"{warning}#case~1*"]
    )
    assert logic("Unknown questions:\n- #case/parent/edd\n- /data/case/@case_id") == [
        f"{warning}#case~1parent~1*",
        f"{warning}~1data~1case~1@case_id",
    ]

    # What Vellum throws on a load is reported by its text.
    thrown = (
        "multiple unnamed instance elements found in the form! this is not allowed. please add id's to all but 1"
        " instance."
    )
    refused = _vellum_classes(_vellum_record(visits, loaded=False, page_errors=[thrown]))
    assert refused == [f"/modules/*/forms/*/load/{thrown}", f"/modules/*/forms/*/page_errors/{thrown}"]

    # A page's alert, and HQ's refusal of its save, by what HQ says: the search property HQ names is the app's.
    def page(name):
        text = f"The case search property '{name}' is missing the following lookup table attributes: sort"
        report = {
            "kind": "page",
            "save": {"status": 400, "messages": [], "body": f"\n    {text}\n", "urlName": "edit_module_detail_screens"},
            "exchanges": [],
            "alerts": [f"×\n            \n                {text}"],
            "barState": "savebtn-bar-retry",
            "pageErrors": [],
        }
        return [d.path for d in proof4.page_report(report, document="-", scope=proof4.Scope(0), editor="case list")]

    said = "The case search property '*' is missing the following lookup table attributes: sort"
    assert (
        page("region")
        == page("district")
        == [
            f"/modules/*/save/400/{said}",
            f"/modules/*/alerts/× {said}",
            "/modules/*/state/savebtn-bar-retry",
        ]
    )

    # A save the page answers with a dialog and never sends is that refusal alone, by what the dialog says; a
    # dialog beside a save HQ answered is reported by its type and text.
    common = (
        "There are errors in your configuration.\nSearch Properties and Default Search Filters can't have common"
        " properties. Please update following properties: _xpath_query"
    )
    dialog = {"type": "alert", "message": common}
    unsent = {
        "kind": "page",
        "save": None,
        "unsent": dialog,
        "exchanges": [],
        "alerts": [],
        "barState": "savebtn-bar-save",
        "pageErrors": [],
        "dialogs": [dialog],
    }
    reported = proof4.page_report(unsent, document="-", scope=proof4.Scope(0), editor="case list")
    assert [(d.path, d.kind) for d in reported] == [(f"/modules/*/save/unsent/{' '.join(common.split())}", "refused")]
    sent = {
        **unsent,
        "save": {"status": 200, "messages": [], "body": "{}", "urlName": "edit_module_detail_screens"},
        "unsent": None,
        "barState": "savebtn-bar-saved",
    }
    reported = proof4.page_report(sent, document="-", scope=proof4.Scope(0), editor="case list")
    assert [d.path for d in reported] == [f"/modules/*/dialogs/alert/{' '.join(common.split())}"]


# Pages HQ withholds or offers nothing to save -----------------------------------------------------


def _invalid_relevance(app):
    # A display condition Core cannot parse, so HQ's validation of the form fails.
    form = app.modules[0].forms[0]
    tree = etree.fromstring(form.source.encode("utf-8"))
    (bind,) = [element for element in tree.iter(f"{{{XFORMS}}}bind") if element.get("nodeset") == "/data/plain"]
    bind.set("relevant", "/data/date = = 'x'")
    form.source = etree.tostring(tree, encoding="unicode")


@pytest.mark.parametrize(
    ("prepares", "offered"),
    [
        pytest.param([], proof4.Offer.OFFERED, id="a form HQ validates: offered"),
        pytest.param([_invalid_relevance], proof4.Offer.WITHHELD, id="a form HQ cannot validate: withheld"),
    ],
)
def test_case_management_hq_withholds_is_a_difference(hq, core_runner, editor_driver, prepares, offered):
    record, found, _ = _observe(
        CONFIGURATION, prepares, core_runner, editor_driver, views=_view("view_form", 0, 0), forms=_nothing
    )
    # The offer is the one HQ's own render of the form page decided (view_generic's get_form_view_context).
    (view,) = record["views"]
    (offer,) = [entry for entry in view["offers"] if entry["section"] == "case management"]
    assert offer["offer"] == offered, offer
    withheld = [d.path for d in found if d.artifact == _artifact("editor:case management")]
    # The page names why HQ withheld it: the form's validation, which HQ's page found failing.
    cause = f"/modules/*/forms/*/offered/{proof4.withheld_cause(offer['reason'])}"
    assert withheld == ([cause] if offered == proof4.Offer.WITHHELD else [])
    assert offered != proof4.Offer.WITHHELD or cause.endswith("xform_validation_errored"), cause
    assert (offer["reason"] or {}).get("xform_validation_errored", False) == (offered == proof4.Offer.WITHHELD)


def test_the_offers_hqs_page_decides_are_the_ones_its_context_gives(hq, core_runner, editor_driver):
    # The context captured from view_generic's render and the same call made from Python give the same offers.
    with suite_b(CONFIGURATION, [_invalid_relevance], core_runner, editor_driver) as (ctx, mark):
        with ctx.unit.operation("probe-offers", b""):
            app = operations.held_app(ctx.unit, ctx.app_id)
            python = [observed.case_management_offer(ctx.unit, app, form) for form in app.modules[0].forms]
        ctx.unit.restore(mark)
        record = observed.observe_b(ctx, views=lambda view, _: view == "view_form", forms=_nothing)
    rendered = [
        next((entry["offer"], entry["reason"]) for entry in view["offers"] if entry["section"] == "case management")
        for view in record["views"]
    ]
    assert rendered == [(status, observed._json(reason)) for status, reason in python]
    assert [status for status, _ in rendered] == [proof4.Offer.WITHHELD, proof4.Offer.OFFERED]


def test_a_page_with_nothing_to_save_unchanged_is_skipped_without_a_difference(hq, core_runner, editor_driver):
    def no_translations(app):
        app.translations = {}

    record, found, saves = _observe(
        CONFIGURATION, [no_translations], core_runner, editor_driver, views=_view("app_settings"), forms=_nothing
    )
    assert [(save["editor"], save["offer"]) for save in saves if save["editor"] == "UI translations"] == [
        ("UI translations", proof4.Offer.SKIPPED)
    ]
    assert not [d for d in found if "UI translations" in d.artifact]
    (view,) = record["views"]
    assert "UI translations" not in [entry["section"] for entry in view["sections"]]


# What the pages report ---------------------------------------------------------------------------


def _search_condition(condition):
    def prepare(app):
        from corehq.apps.app_manager.models import CaseSearch, CaseSearchProperty

        app.modules[0].search_config = CaseSearch(
            properties=[CaseSearchProperty(name="name", label={"en": "Name"})],
            search_button_display_condition=condition,
        )

    return prepare


def test_an_alert_the_save_adds_is_reported_and_one_the_page_showed_before_is_not(hq, core_runner, editor_driver):
    # views/modules.py::_gather_and_update_search_properties refuses a display condition HQ's XPath validator
    # cannot parse (400), and hqwebapp's save button shows HQ's answer as an alert.
    configuration = Configuration(privileges={"CLOUDCARE"}, case_search_enabled=True)
    _, found, _ = _observe(
        configuration,
        [_search_condition("count(")],
        core_runner,
        editor_driver,
        views=_view("view_module", 0),
        forms=_nothing,
    )
    alerts = [d for d in found if d.artifact == _artifact("editor:case list") and "/alerts/" in d.path]
    assert any("count(" in d.after for d in alerts), summary(found)
    # HQ's refusal is keyed by its status and what HQ's answer says, the Save button by the state it ended in.
    case_list = _classes(found, "editor:case list")
    assert [path for path in case_list if path.startswith("/modules/*/save/400/")], summary(found)
    assert "/modules/*/state/savebtn-bar-retry" in case_list, summary(found)
    # The module settings save beside it, released into its own fork, adds no alert.
    assert not [d for d in found if d.artifact == _artifact("editor:module settings") and "/alerts/" in d.path]

    # The add-ons tab shows an upgrade notice for each add-on the plan lacks (add_ons.py, show_upgrade) before
    # any save; a save that adds nothing reports none of them.
    with suite_b(CONFIGURATION, [], core_runner, editor_driver) as (ctx, _):
        record = observed.observe_b(ctx, views=_view("app_settings"), forms=_nothing)
        found, _ = _judged(ctx, record)
        (view,) = record["views"]
        (add_ons,) = [entry for entry in view["sections"] if entry["section"] == "add-ons"]
        report = ctx.blobs.get_json(add_ons["report"])
    assert report["alertsShownBefore"], "the add-ons tab showed no upgrade notice, so this pairing shows nothing"
    assert report["alerts"] == []
    assert not [d for d in found if d.artifact == _artifact("editor:add-ons") and "/alerts/" in d.path]


def _child_under_a_shadowed_parent(app):
    # A child module of module 0, and a shadow of module 0 that has no shadow of the child yet. Saving the child's
    # settings has HQ give the shadow the child it lacks and answer with ``redirect``
    # (views/modules.py::edit_module_attr, ``handle_shadow_child_modules``), so the page reloads under the
    # sections still held, and each of those is saved from a load of its own (proof.editors.pages.run_view).
    from corehq.apps.app_manager.models import Module, ShadowModule

    parent = app.modules[0]
    child = app.add_module(Module.new_module("Child", "en"))
    child.case_type = parent.case_type
    child.root_module_id = parent.unique_id
    child.case_details = type(parent.case_details).wrap(parent.case_details.to_json())
    shadow = app.add_module(ShadowModule.new_module("Shadow", "en"))
    shadow.source_module_id = parent.unique_id
    shadow.shadow_module_version = 2
    app.ensure_module_unique_ids()


def test_the_notices_a_page_showed_are_kept_for_each_section_its_own_load_saved(hq, core_runner, editor_driver):
    # The module settings save is released from the view's one load and answered with a redirect; the sections
    # held after it are saved from loads of their own, whose notices the view's run does not keep. The record
    # keeps what the page showed before each release the one load made, and none for the others.
    refusal = {"why": "this view's saves are read for their reports; no sessions run"}
    prepares = [_child_under_a_shadowed_parent]
    with suite_b(CONFIGURATION, prepares, core_runner, editor_driver, restore_refusal=refusal) as (ctx, _):
        record = observed.observe_b(ctx, views=_view("view_module", 1), forms=_nothing)
        (view,) = record["views"]
        reports = [(entry["section"], ctx.blobs.get_json(entry["report"])) for entry in view["sections"]]
    assert reports[0][0] == "module settings" and len(reports) >= 2, [name for name, _ in reports]
    assert isinstance(reports[0][1]["alertsShownBefore"], list), reports[0][1]
    assert [report["alertsShownBefore"] for _, report in reports[1:]] == [None] * (len(reports) - 1)
    assert [report["barState"] for _, report in reports] == ["savebtn-bar-saved"] * len(reports)


def _meta_block(app):
    # A form whose data already holds a meta block: HQ's form page warns that it may be replaced
    # (views/forms.py::get_form_view_context, xform.py::XForm.already_has_meta).
    form = app.modules[0].forms[0]
    tree = etree.fromstring(form.source.encode("utf-8"))
    data = next(tree.iter(f"{{{XFORMS}}}instance"))[0]
    etree.SubElement(data, f"{{{ORX}}}meta")
    form.source = etree.tostring(tree, encoding="unicode")


@pytest.mark.parametrize(
    ("prepares", "warned"),
    [
        pytest.param([], False, id="a form HQ has nothing to say of"),
        pytest.param([_meta_block], True, id="a form HQ's page warns of"),
    ],
)
def test_a_message_hqs_page_view_leaves_is_reported(hq, core_runner, editor_driver, prepares, warned):
    _, found, _ = _observe(
        CONFIGURATION, prepares, core_runner, editor_driver, views=_view("view_form", 0, 0), forms=_nothing
    )
    messages = [d for d in found if d.artifact == _artifact("editor:form settings") and "/messages/" in d.path]
    assert len(messages) == (1 if warned else 0), summary(found)
    if warned:
        # Keyed by the HQ view that left it and what it says.
        assert (
            messages[0].path.startswith("/modules/*/forms/*/messages/view_form/") and "meta block" in messages[0].path
        )
        assert "meta block" in messages[0].after


# HQ raising, and the harness failing ----------------------------------------------------------------


def _multi_select_previous_screen(app):
    # A multi-select case list whose follow-up form returns to the previous screen. HQ's form page offers no
    # "Previous Screen" for a multi-select module (views/forms.py::get_form_view_context), so its workflow
    # control holds 'error' (forms/bootstrap5/form_workflow.js), which the save posts.
    app.modules[0].case_details.short.multi_select = True
    app.modules[0].forms[1].post_form_workflow = "previous_screen"


@pytest.mark.parametrize(
    ("prepares", "raised"),
    [
        pytest.param([], None, id="a workflow the page offers saves"),
        pytest.param(
            [_multi_select_previous_screen],
            "jsonobject.exceptions.BadValueError",
            id="a workflow the page does not offer raises in HQ's view",
        ),
    ],
)
def test_hq_raising_on_an_editors_request_is_a_difference(hq, core_runner, editor_driver, prepares, raised):
    _, found, _ = _observe(
        CONFIGURATION, prepares, core_runner, editor_driver, views=_view("view_form", 0, 1), forms=_nothing
    )
    reports = [d for d in found if d.artifact == _artifact("editor:form settings")]
    if raised is None:
        assert reports == [], summary(found)
        return
    assert [d.path for d in reports] == [f"/modules/*/forms/*/raised/edit_form_attr/{raised}"]
    assert reports[0].after["raised"] == raised
    # HQ took the case management save held beside it from the same load.
    assert not [d for d in found if d.artifact == _artifact("editor:case management") and "/raised/" in d.path]


def test_a_harness_failure_during_an_editors_run_ends_the_check(hq, core_runner, editor_driver):
    from corehq.apps.app_manager.models import Application
    from corehq.apps.app_manager.views import forms

    held = forms.get_app

    def get_app_reading_a_view_the_harness_does_not_answer(domain, app_id, *args, **kwargs):
        list(Application.get_db().view("proof/not_answered", reduce=False))
        return held(domain, app_id, *args, **kwargs)

    # A Couch view the harness's Couch does not compute, reached by HQ's save view, is the harness's refusal.
    with suite_b(CONFIGURATION, [], core_runner, editor_driver) as (ctx, _):
        with mock.patch.object(forms, "get_app", get_app_reading_a_view_the_harness_does_not_answer):
            with pytest.raises(HQRefusedPageRequest) as raised:
                observed.observe_b(ctx, views=_view("view_form", 0, 1), forms=_nothing)
    refusals = [exchange for exchange in raised.value.exchanges if exchange.refusal]
    # Both of the view's held saves reach a save view of views/forms.py, and each is refused. Where the in-band
    # audit reruns a section (``pages.AUDIT_ENVIRONMENT``), its fresh page's save is refused first, and that
    # refusal ends the check the same way.
    expected = {
        ("edit_form_attr", "proof.hq.couch.UnansweredView"),
        ("edit_form_actions", "proof.hq.couch.UnansweredView"),
    }
    found = {(e.url_name, e.raised) for e in refusals}
    assert found and found <= expected
    if not os.environ.get(pages.AUDIT_ENVIRONMENT):
        assert found == expected

    # The driver could not finish the run and no HQ view failed (a deadline): no broken run, the check ends.
    failure = EditorRunFailed(
        "The case list page's save", EditorDriverError("deadline", kind="deadline"), HQAnswers(None)
    )
    assert observed.broken(failure) is None


# The saves beside the editor driver's pages ------------------------------------------------------------


def _user_properties(app):
    # The follow-up form writes a user property from its answer, as HQ's User Properties tab stores one.
    from corehq.apps.app_manager.models import ConditionalCaseUpdate

    form = app.modules[0].forms[1]
    form.actions.usercase_update.update = {"proof_last_name": ConditionalCaseUpdate(question_path="/data/rename")}
    form.actions.usercase_update.condition.type = "always"


@pytest.mark.parametrize(
    ("page", "privileges", "prepares", "view", "own"),
    [
        pytest.param(
            pages.CASE_DETAIL,
            {"CLOUDCARE"},
            [],
            ("view_module", 0, None),
            "/modules/*/case_details/long/",
            id="case detail",
        ),
        pytest.param(
            pages.USER_PROPERTIES,
            {"CLOUDCARE", "USERCASE"},
            [_user_properties],
            ("view_form", 0, 1),
            "/modules/*/forms/*/actions/usercase_",
            id="user properties",
        ),
    ],
)
def test_the_saves_beside_the_driver_pages_reach_hqs_views_and_store_only_their_own_part(
    hq, core_runner, editor_driver, page, privileges, prepares, view, own, without_spelling_rules
):
    # Each is saved over B beside the view's other sections, from the same load: it reaches its own save view,
    # HQ takes it, and what it stores is its own part of the app (the case detail's long screen; the user case
    # actions, the only ones its Save button posts), not what the sections beside it saved.
    name, m, f = view
    with suite_b(Configuration(privileges=privileges), prepares, core_runner, editor_driver) as (ctx, _):
        record = observed.observe_b(ctx, views=_view(name, m, f), forms=_nothing)
        found, _ = _judged(ctx, record)
        (held,) = record["views"]
        (entry,) = [section for section in held["sections"] if section["section"] == page.name]
        report = ctx.blobs.get_json(entry["report"])
    assert (report["save"]["urlName"], report["save"]["status"]) == (page.save, 200)
    assert report["barState"] == "savebtn-bar-saved" and not report["pageErrors"]
    assert not _classes(found, f"editor:{page.name}"), summary(found)
    stored = _classes(found, f"app.json@{page.name}")
    assert stored and all(path.startswith(own) for path in stored), summary(found)


# Fork-from-B: order, transcripts and memos --------------------------------------------------------------


def _reversed(items):
    return list(reversed(list(items)))


def _judgment(differences):
    return sorted(repr(difference) for difference in differences)


def test_a_saves_judged_differences_do_not_depend_on_the_order_the_saves_ran_in(hq, core_runner, editor_driver):
    # Every view, section and Vellum form saves over B in a fork of its own, so running them in HQ's order and
    # reversed (each view's sections reversed too) gives one record and one judgment.
    with suite_b(CONFIGURATION, [_non_writing_followup], core_runner, editor_driver) as (ctx, _):
        in_order = observed.observe_b(ctx)
        reversed_order = observed.observe_b(ctx, order=_reversed)
        found_in_order, saves_in_order = _judged(ctx, in_order)
        found_reversed, saves_reversed = _judged(ctx, reversed_order)
    assert in_order == reversed_order
    assert _judgment(found_in_order) == _judgment(found_reversed)
    assert saves_in_order == saves_reversed
    # The comparison means something: saves changed B, were built and ran sessions.
    assert any(save["ran"] for save in saves_in_order) and any(
        d.artifact.startswith("case_blocks@") for d in found_in_order
    )


def _with_changed_answer(transcript):
    """The transcript with HQ's answer to its last request recorded differently, as if HQ answered otherwise."""
    from proof.editors import transcripts

    last = transcript.exchanges[-1]
    changed = replace(last, response=hashlib.sha256(b"another answer").hexdigest())
    return transcripts.Transcript(
        spec=transcript.spec,
        first=transcript.first,
        exchanges=(*transcript.exchanges[:-1], changed),
        outputs=transcript.outputs,
    )


@pytest.mark.under_determinism
def test_a_replayed_view_or_vellum_run_gives_the_live_runs_record(hq, core_runner, editor_driver, monkeypatch):
    monkeypatch.setenv(observed.TRANSCRIPTS_ENVIRONMENT, "on")
    held = observed.LocalTranscripts()
    with suite_b(CONFIGURATION, [_non_writing_followup], core_runner, editor_driver, store=_Store(held)) as (ctx, _):
        log = ctx.unit._log.log

        def observe():
            # The record, and the operations the part's log gained (each with the key and depth it ran under).
            first = len(log)
            record = observed.observe_b(ctx)
            return record, log[first:], observed.COUNTS[-1]

        live, live_log, live_counts = observe()
        assert live_counts["views_replayed"] == live_counts["vellum_replayed"] == 0
        assert held.held, "the live run kept no transcript"
        replayed, replayed_log, replayed_counts = observe()
        # Every view and Vellum run replayed, and the record and the part's log are the live run's.
        assert replayed_counts["views_replayed"] == replayed_counts["views"]
        assert replayed_counts["vellum_replayed"] == replayed_counts["vellum"]
        assert (replayed, replayed_log) == (live, live_log)
        # A transcript HQ no longer answers as recorded (its last answer here) falls back to the browser: what
        # the replay did up to there, saves built and traced included, is undone, the log's entries with it.
        for key, transcript in list(held.held.items()):
            held.held[key] = _with_changed_answer(transcript)
        fallen_back, fallen_log, fallen_counts = observe()
        monkeypatch.setenv(observed.TRANSCRIPTS_ENVIRONMENT, "off")
        off, off_log, _ = observe()
    assert fallen_counts["views_replayed"] == fallen_counts["vellum_replayed"] == 0
    assert fallen_counts["replay_misses"] == fallen_counts["views"] + fallen_counts["vellum"]
    assert (fallen_back, fallen_log) == (live, live_log)
    assert (off, off_log) == (live, live_log)
    assert any(entry["label"] == "proof4-build" for entry in live_log)


def _renamed_form(app):
    app.modules[0].forms[1].name["en"] = "Renamed in a save"


def test_a_kept_build_and_trace_are_made_again_under_verify_and_must_be_equal(
    hq, core_runner, editor_driver, monkeypatch
):
    monkeypatch.setenv(observed.VERIFY_ENVIRONMENT, "1")
    with suite_b(CONFIGURATION, [], core_runner, editor_driver) as (ctx, _):
        observation = observed._Observation(ctx, observed.hq_order)
        with ctx.unit.fork():
            observation.prepare()
            with ctx.unit.fork():
                # A save HQ's form settings would make: the stored app changes, so it is built.
                with ctx.unit.operation("probe-save", b"rename"):
                    app = operations.held_app(ctx.unit, ctx.app_id)
                    _renamed_form(app)
                    app.save()
                _, key = observed.stored_app(ctx.unit, ctx.app_id)
                built, _ = observation.build(key)
                again, _ = observation.build(key)
                label = observed.processing_label("form settings")
                trace = observation.trace(built, over=observation.b, label=label)
                trace_again = observation.trace(again, over=observation.b, label=label)
                counts = observation.counts.as_json()
                # A kept build that is not what HQ builds, or a kept trace that is not what the sessions give,
                # is caught when it is made again.
                held_build = next(iter(observation.builds))
                observation.builds[held_build] = (
                    replace(built, files={**built.files, "suite.xml": b"<suite/>"}),
                    False,
                )
                with pytest.raises(observed.MemoMismatch):
                    observation.build(key)
                held_trace = next(iter(observation.traces))
                kept, processing = observation.traces[held_trace]
                observation.traces[held_trace] = ({**kept, "trace": None}, processing)
                with pytest.raises(observed.MemoMismatch):
                    observation.trace(built, over=observation.b, label=label)
    assert (counts["builds"], counts["build_hits"], counts["traces"], counts["trace_hits"]) == (2, 1, 2, 1)
    assert trace == trace_again and "admission" in trace


# Attributes as Core reads them ----------------------------------------------------------------------------


def test_core_reads_a_respelled_expression_as_one_and_a_regrouped_one_as_another(core_runner):
    pairs = [
        ("xpath", "/data/a = 'x' and /data/b > 2", "/data/a='x'  and\n/data/b>2"),
        ("xpath", "(/data/a + /data/b) * 2", "/data/a + /data/b * 2"),
        ("xpath", "uuid()", " uuid( ) "),
        ("xpath", "uuid()", "random()"),
        ("xpath", "/data/a = = 'x'", "/data/a = = 'x' "),
        # An itemset label (ItemSetParsingUtils.setLabel): an itext by its opening and closing, then a path.
        ("itemsetLabel", "jr:itext(name)", "jr:itext( name )"),
        ("itemsetLabel", "jr:itext(name)", "jr:itext(name) "),
        ("itemsetLabel", "jr:itext(name)", "name"),
        ("itemsetLabel", "/data/a = = 'x'", "/data/a = = 'x' "),
        # The same text read as XPath: a trailing space is no difference to Core's XPath parser.
        ("xpath", "jr:itext(name)", "jr:itext(name) "),
    ]
    readings = observed.read_xpath(core_runner, pairs)
    assert [reading[:3] for reading in readings] == [list(pair) for pair in pairs]
    same = [result["same"] for *_, result in readings]
    assert same == [True, False, True, False, False, True, False, False, False, True]
    # Core's parser holds the grouping as structure: the two regrouped texts are two trees.
    regrouped = readings[1][3]["trees"]
    assert regrouped[0] != regrouped[1]
    # "jr:itext(name) " does not end with the itext's closing, so Core reads it as a path, and it is not one.
    assert readings[6][3]["errors"][0] is None and "Expected XPath path" in readings[6][3]["errors"][1]
    # A text Core cannot parse is its error, the same on every run (no identity hash in Core's "Bad node"), read
    # as XPath or as an itemset label's path (whose error names the text, so the two spellings' errors differ).
    errors = readings[4][3]["errors"]
    assert errors[0] and errors[0] == errors[1] and "@" not in errors[0], errors
    errors = readings[8][3]["errors"]
    assert all(error and "Bad node" in error and "@" not in error for error in errors), errors

    # The judge reads a stored or built form's attribute through what Core read, and nothing else.
    relevant = "/html/head[*]/model[*]/bind[@nodeset=*]/@relevant"

    def changed(before, after, artifact="source:form:0.0@vellum", path=relevant):
        return Difference("proof4", "-", artifact, path, path, "changed", before, after)

    label = "/html/body[*]/select1[*]/itemset[*]/label[*]/@ref"
    found = [
        changed(*pairs[0][1:]),
        changed(*pairs[1][1:]),
        changed(*pairs[0][1:], artifact="form:0.0@vellum"),
        changed(*pairs[0][1:], path="/html/head[*]/model[*]/bind[@nodeset=*]/@jr:constraintMsg"),
        changed(*pairs[0][1:], artifact="suite.xml@vellum"),
        changed(*pairs[5][1:], path=label),
        changed(*pairs[6][1:], path=label),
        # Core read this pair as XPath alike, but an itemset label is read as setLabel reads it.
        changed(*pairs[9][1:], path=label),
    ]
    kept = proof4.without_same_xpath(found, proof4.xpath_readings(readings))
    assert kept == [found[1], found[3], found[4], found[6], found[7]]


def _proof_form(relevant, label, hint, item_labels, group, repeat):
    """A form with an attribute of each kind Core reads: a bind's condition (XPath), a question's label and hint
    (text), two itemset labels (setLabel's reading), a group's ``ref`` and ``nodeset`` (XPath, and nothing Core
    reads) and a repeat's ``nodeset`` and ``ref`` (XPath, and nothing Core reads)."""
    itemsets = "".join(
        f'<select1 ref="/data/{node}"><label ref="jr:itext(\'s-label\')"/>'
        f'<itemset nodeset="instance(\'items\')/items/item"><label ref="{item_label}"/><value ref="id"/></itemset>'
        "</select1>"
        for node, item_label in zip(("s", "t"), item_labels, strict=True)
    )
    return (
        '<h:html xmlns:h="http://www.w3.org/1999/xhtml" xmlns="http://www.w3.org/2002/xforms"'
        ' xmlns:jr="http://openrosa.org/javarosa"><h:head><h:title>Proof</h:title><model><instance>'
        '<data xmlns="http://openrosa.org/formdesigner/proof-xpath"><q/><s/><t/><g><x/></g><r><y/></r></data>'
        '</instance><instance id="items" src="jr://fixture/items"/>'
        f'<bind nodeset="/data/q" relevant="{relevant}"/><bind nodeset="/data/s"/><bind nodeset="/data/t"/>'
        '<itext><translation lang="en" default=""><text id="q-label"><value>Q</value></text>'
        '<text id="q-hint"><value>Q, again</value></text><text id="s-label"><value>S</value></text>'
        "</translation></itext></model></h:head><h:body>"
        f'<input ref="/data/q"><label ref="{label}"/><hint ref="{hint}"/></input>{itemsets}'
        f'<group ref="{group}" nodeset="{group}"><input ref="/data/g/x"/></group>'
        f'<repeat nodeset="{repeat}" ref="{repeat}"><input ref="/data/r/y"/></repeat>'
        "</h:body></h:html>"
    )


def test_only_an_attribute_cores_parser_reads_is_compared_as_core_reads_it(core_runner):
    # A question's label and hint name their itext as text (XFormParser.getItextReference, parseHelperText: only
    # the exact jr:itext('...') opening and closing, anything else a "malformed ref"); an itemset's label is
    # ItemSetParsingUtils.setLabel's (an itext only where the text opens with jr:itext( and ends with ")"); a group
    # binds by its ref and a repeat by its nodeset (parseGroup), never the other. So of these respellings, each one
    # Core's XPath parser would read as one expression, the bind's, the first itemset label's, the group's ref and
    # the repeat's nodeset are no difference, and the label's, the hint's, the second itemset label's (which Core
    # refuses), the group's nodeset and the repeat's ref are.
    before = _proof_form(
        "/data/s='x'",
        "jr:itext('q-label')",
        "jr:itext('q-hint')",
        ("jr:itext(name)", "jr:itext(name)"),
        "/data/g",
        "/data/r",
    )
    after = _proof_form(
        "/data/s = 'x'",
        "jr:itext(&quot;q-label&quot;)",
        "jr:itext( 'q-hint' )",
        ("jr:itext( name )", "jr:itext(name) "),
        " /data/g",
        " /data/r",
    )
    read = [
        ("itemsetLabel", "jr:itext(name)", "jr:itext( name )"),
        ("itemsetLabel", "jr:itext(name)", "jr:itext(name) "),
        ("xpath", "/data/g", " /data/g"),
        ("xpath", "/data/r", " /data/r"),
        ("xpath", "/data/s='x'", "/data/s = 'x'"),
    ]

    def stored(source):
        return {"doc": {}, "langs": ["en"], "sources": {"0.0": source}, "attachments": {}}

    def built(source):
        return BuildOutcome("B", 1, [], {}, {"modules-0/forms-0.xml": source.encode("utf-8")})

    # The observation finds the pairs in a stored source a save changed, and in a built form whose stored source it
    # left alone, and only the attributes Core's parser reads, each with its reading.
    assert observed.xpath_pairs(stored(before), stored(after), None, None) == read
    assert observed.xpath_pairs(stored(before), stored(before), built(before), built(after)) == read
    readings = observed.read_xpath(core_runner, read)
    assert [result["same"] for *_, result in readings] == [True, False, True, True, True]

    reported = {
        ("/html/body[*]/input[*]/label[*]/@ref", "jr:itext('q-label')", 'jr:itext("q-label")'),
        ("/html/body[*]/input[*]/hint[*]/@ref", "jr:itext('q-hint')", "jr:itext( 'q-hint' )"),
        ("/html/body[*]/select1[*]/itemset[*]/label[*]/@ref", "jr:itext(name)", "jr:itext(name) "),
        ("/html/body[*]/group[*]/@nodeset", "/data/g", " /data/g"),
        ("/html/body[*]/repeat[*]/@ref", "/data/r", " /data/r"),
    }
    found = proof4.stored_differences(
        proof4.stored_from(stored(before)),
        proof4.stored_from(stored(after)),
        document="-",
        editor="vellum",
        readings=proof4.xpath_readings(readings),
    )
    assert {(d.path, d.before, d.after) for d in found} == reported, summary(found)
    found = proof4.build_differences(
        built(before), built(after), document="-", editor="vellum", readings=proof4.xpath_readings(readings)
    )
    assert {(d.path, d.before, d.after) for d in found} == reported, summary(found)


ITEMSET_LABEL = "jr:itext(name)"
LEDGERS = "count(instance('ledgerdb')/ledgerdb/ledger)"


def _an_itemset_label_and_an_instance_call(app):
    # On the suite app's first form: a question whose choices are the suite's cases, each labelled by the itext its
    # name names (an itemset label, ItemSetParsingUtils.setLabel; Core reads an itemset's instance only where the
    # form declares it, XFormParser.verifyItemsetBindings); and a hidden value counting the worker's ledgers, whose
    # instance the form does not declare, so HQ's build declares it (xform.py::XForm.add_missing_instances).
    form = app.modules[0].forms[0]
    tree = etree.fromstring(form.source.encode("utf-8"))
    model = next(tree.iter(f"{{{XFORMS}}}model"))
    instance = next(tree.iter(f"{{{XFORMS}}}instance"))
    instance.addnext(etree.Element(f"{{{XFORMS}}}instance", id="casedb", src="jr://instance/casedb"))
    data = instance[0]
    etree.SubElement(data, etree.QName(data, "proof_choice").text)
    etree.SubElement(data, etree.QName(data, "proof_ledgers").text)
    last = list(model.iter(f"{{{XFORMS}}}bind"))[-1]
    last.addnext(etree.Element(f"{{{XFORMS}}}bind", nodeset="/data/proof_ledgers", calculate=LEDGERS))
    last.addnext(etree.Element(f"{{{XFORMS}}}bind", nodeset="/data/proof_choice"))
    body = next(element for element in tree if etree.QName(element).localname == "body")
    select = etree.SubElement(body, f"{{{XFORMS}}}select1", ref="/data/proof_choice")
    etree.SubElement(select, f"{{{XFORMS}}}label").text = "Choice"
    itemset = etree.SubElement(
        select, f"{{{XFORMS}}}itemset", nodeset="instance('casedb')/casedb/case[@case_type='suite_test']"
    )
    etree.SubElement(itemset, f"{{{XFORMS}}}label", ref=ITEMSET_LABEL)
    etree.SubElement(itemset, f"{{{XFORMS}}}value", ref="@case_id")
    form.source = etree.tostring(tree, encoding="unicode")


def _respelled(element_name, attribute, old, new):
    """A save that respells one attribute of the first form's ``element_name`` whose value is ``old``."""

    def respell(source):
        tree = etree.fromstring(source.encode("utf-8"))
        (element,) = [element for element in tree.iter(f"{{{XFORMS}}}{element_name}") if element.get(attribute) == old]
        element.set(attribute, new)
        return etree.tostring(tree, encoding="unicode")

    return respell


RESPELLINGS = {
    # The same itext to Core: no difference.
    "itext spaced": _respelled("label", "ref", ITEMSET_LABEL, "jr:itext( name )"),
    # No longer the itext's closing last: a function call where Core reads a path, so Core refuses the form.
    "itext trailing": _respelled("label", "ref", ITEMSET_LABEL, ITEMSET_LABEL + " "),
    # The same expression to Core (its lexer drops the space), but HQ's build finds the instances a form reads by
    # a pattern over its text that wants "instance(" (suite_xml/post_process/instances.py::instance_re), so the
    # built form no longer declares ledgerdb.
    "instance spaced": _respelled("bind", "calculate", LEDGERS, LEDGERS.replace("instance(", "instance (")),
}


def _clean_page_report(url_name):
    # What a page reports for a save HQ took with nothing to say (proof.observe.proof4.page_report).
    return {
        "kind": "page",
        "save": {
            "method": "POST",
            "urlName": url_name,
            "status": 200,
            "messages": [],
            "raised": None,
            "refusal": None,
            "error": None,
            "body": "{}",
        },
        "exchanges": [],
        "alerts": [],
        "alertsShownBefore": [],
        "barState": "savebtn-bar-saved",
        "pageErrors": [],
        "dialogs": [],
    }


def test_a_saves_build_is_compared_wherever_it_changed_what_hq_stores_as_core_and_hq_read_it(hq, core_runner):
    # Three saves of the first form's source, each over B in a fork of its own, as an editor's save stores a form
    # (the form's source set, the app saved), each read by the observation and judged: an itemset label respelled
    # as Core reads alike is no difference; one Core refuses is a difference in the stored form, in validate_app
    # (Core's refusal, through HQ's build) and a refused trace; and an instance call re-spaced, which Core reads
    # alike, is no stored difference but a difference in HQ's build, which reads the form's text too.
    refusal = {"why": "these saves are judged by their builds; no sessions run"}
    prepares = [_an_itemset_label_and_an_instance_call]
    with suite_b(CONFIGURATION, prepares, core_runner, None, restore_refusal=refusal) as (ctx, _):
        assert ctx.build.errors == [], ctx.build.errors
        observation = observed._Observation(ctx, observed.hq_order)
        with ctx.unit.fork():
            record = observation.prepare()
            form_id = operations.held_app(ctx.unit, ctx.app_id).modules[0].forms[0].unique_id
            sections = []
            for name, respell in RESPELLINGS.items():
                with ctx.unit.fork():
                    with ctx.unit.operation("probe-save", name.encode()):
                        app = operations.held_app(ctx.unit, ctx.app_id)
                        app.modules[0].forms[0].source = respell(app.modules[0].forms[0].source)
                        app.save()
                    report = ctx.blobs.put_json(_clean_page_report("edit_form_attr"))
                    entry, _ = observation.after_save(observation.b, name)
                    sections.append({"section": name, "report": report, **entry})
        record["views"] = [
            {
                "view": "view_form",
                "target": form_id,
                "scope": [0, 0],
                "offers": [{"section": name, "offer": proof4.Offer.OFFERED, "reason": None} for name in RESPELLINGS],
                "sections": sections,
            }
        ]
        record["vellum"] = []
        found, saves = _judged(ctx, record)
    by_save = {name: [d for d in found if d.artifact.split("@")[1] == name] for name in RESPELLINGS}
    assert by_save["itext spaced"] == [], summary(found)
    # HQ's build validates each form with Core (validate_app lists the refusal, named where the bar names it) and
    # writes no file of an app whose form Core refuses (create_all_files raises it, named by what it raised), so no
    # session runs on it, and the refused trace names each cause as proof 3 names it: each validate_app error, and
    # the step that raised and what it raised.
    trailing = {(d.artifact.split("@")[0], d.path, d.kind) for d in by_save["itext trailing"]}
    label = "/html/body[*]/select1[*]/itemset[*]/label[*]/@ref"
    raised = next(d.after for d in by_save["itext trailing"] if d.artifact.startswith("build@"))
    refusals = {path for artifact, path, _ in trailing if artifact == "trace"}
    assert trailing - {("trace", path, "refused") for path in refusals} == {
        ("source:form:0.0", label, "changed"),
        ("validate_app", "/modules/*/forms/*/validation error", "added"),
        ("build", "/create_all_files/XFormValidationError", "added"),
    }, summary(found)
    assert [path for path in refusals if "create_all_files" in path and raised["class"] in path], summary(found)
    assert all(path.startswith("/unbuildable/") for path in refusals), summary(found)
    refused = [d for d in by_save["itext trailing"] if d.artifact.startswith(("validate_app@", "build@"))]
    assert all("Expected XPath path" in json.dumps(d.after) for d in refused), summary(found)
    spaced = {(d.artifact.split("@")[0], d.at, d.kind) for d in by_save["instance spaced"]}
    assert spaced == {
        ("form:0.0", "/html/head[1]/model[1]/instance[@id=ledgerdb]", "removed"),
        ("trace", "/lookups-not-served", "refused"),
    }, summary(found)
    assert [(save["editor"], save["stored_changed"], save["built"]) for save in saves] == [
        ("itext spaced", False, True),
        ("itext trailing", True, True),
        ("instance spaced", False, True),
    ]


def test_an_attachment_is_compared_by_its_content_whatever_it_shows_as():
    def stored(attachments):
        return proof4.stored_from({"doc": {}, "langs": ["en"], "sources": {}, "attachments": attachments})

    def png(last):
        # Bytes that are not UTF-8, which the record holds as base64 and a difference shows by length.
        return {"base64": base64.b64encode(b"\x89PNG\x00" + bytes([last])).decode("ascii")}

    changed = proof4.stored_differences(
        stored({"logo.png": png(1), "notes.txt": {"text": "a"}}),
        stored({"logo.png": png(2), "notes.txt": {"text": "b"}}),
        document="-",
        editor="vellum",
    )
    assert [(d.artifact, d.kind, d.before, d.after) for d in changed] == [
        ("attachment:logo.png@vellum", "changed", "6 bytes", "6 bytes"),
        ("attachment:notes.txt@vellum", "changed", "a", "b"),
    ]
    same = stored({"logo.png": png(1)})
    assert proof4.stored_differences(same, same, document="-", editor="vellum") == []


def test_a_stored_apps_patch_gives_back_the_stored_app():
    before = {"doc": {"a": 1, "b": [1, 2], "c": {"d": True}, "x/y": "~"}, "sources": {"0.0": "<f/>"}}
    afters = [
        before,
        {"doc": {"a": True, "b": [1, 2], "c": {"d": True}, "x/y": "~"}, "sources": {"0.0": "<f/>"}},
        {"doc": {"a": 1, "b": [2], "c": {}, "x/y": "~1"}, "sources": {"0.0": "<g/>", "0.1": ""}},
        {"doc": {"a": 1.0, "b": [1, 3], "e": None, "x/y": "~"}, "sources": {}},
    ]
    for after in afters:
        patch = observed.json_patch(before, after)
        found = observed.apply_patch(before, patch)
        assert observed.canonical(found) == observed.canonical(after), patch
    # A boolean is not the number it equals in Python, and the patch says so.
    assert observed.json_patch({"a": 1}, {"a": True}) == [{"op": "replace", "path": "/a", "value": True}]
    assert observed.json_patch(before, before) == []


# A saved app's build against build(B) -------------------------------------------------------------------------


def _form(version, label="Name"):
    return (
        f'<h:html xmlns:h="http://www.w3.org/1999/xhtml" xmlns="{XFORMS}"><h:head><model><instance>'
        f'<data xmlns="http://example.com/f" version="{version}"><name/></data></instance>'
        f'<bind nodeset="/data/name"/></model></h:head><h:body><input ref="/data/name"><label>{label}</label>'
        "</input></h:body></h:html>"
    ).encode()


def _build(app_version, *, form_version=None, label="Name", extra=None, strings="name=Name\n"):
    form_version = app_version if form_version is None else form_version
    files = {
        "profile.xml": (
            f'<profile version="{app_version}"><suite><resource id="suite" version="{app_version}"/></suite></profile>'
        ).encode(),
        "suite.xml": (
            f'<suite version="{app_version}"><xform><resource id="f0" version="{form_version}">'
            '<location authority="local">./modules-0/forms-0.xml</location></resource></xform></suite>'
        ).encode(),
        "modules-0/forms-0.xml": _form(form_version, label),
        "en/app_strings.txt": strings.encode(),
        **(extra or {}),
    }
    return BuildOutcome(state="-", app_version=app_version, errors=[], raised={}, files=files)


def test_a_saves_build_compared_with_build_b_parsed_once_is_compared_as_both_builds_whole():
    b = _build(5, form_version=3)
    base = observed.ParsedBuild(b)
    saves = {
        # Only the app's own version moved: what the version clause reads as the build's is the same.
        "version only": (_build(6, form_version=3), False),
        # A form's version moved with nothing else in it changed: HQ's decision the clause holds to the content.
        "form version without content": (_build(6, form_version=6), True),
        # The form's content changed, and its version with it.
        "form content": (_build(6, form_version=6, label="Named"), True),
        # An app string changed, every XML file the same but for the build's version.
        "app string": (_build(6, form_version=3, strings="name=Named\n"), True),
        "file added": (_build(6, form_version=3, extra={"fr/app_strings.txt": b"name=Nom\n"}), True),
        # The app's version moved and the profile and suite still name B's: each the bytes B's build wrote, and
        # each a difference, read as the build's own version on one side only.
        "build version not moved": (
            replace(
                _build(6, form_version=3),
                files={**_build(6, form_version=3).files, **{p: b.files[p] for p in ("profile.xml", "suite.xml")}},
            ),
            True,
        ),
    }
    for name, (after, expected) in saves.items():
        whole = observed.raw_builds_differ(b, after)
        assert whole == expected, name
        assert observed.raw_builds_differ(b, after, base, verify=True) == whole, name
    # A file of the same bytes in both builds that does not parse is a difference on both sides alike.
    broken = {"media_suite.xml": b"<suite"}
    b_broken = _build(5, form_version=3, extra=broken)
    after = _build(6, form_version=3, extra=broken)
    assert observed.raw_builds_differ(b_broken, after) is True
    assert observed.raw_builds_differ(b_broken, after, observed.ParsedBuild(b_broken), verify=True) is True
    # The narrowed comparison is held to the whole one: a base that misreads build(B) is caught.
    misread = observed.ParsedBuild(b)
    misread.flat = {**misread.flat, "en/app_strings.txt": (None, b"name=Named\n")}
    with pytest.raises(observed.MemoMismatch):
        observed.raw_builds_differ(b, saves["app string"][0], misread, verify=True)


def test_a_saves_language_strings_are_compared_as_read_over_the_default_file_in_both_comparisons():
    """A language's app strings are read over the default file's, so a key a save drops from a language's file
    alone is a difference only where the default's text is another; the narrowed comparison reads the default
    file beside a changed language file as the whole one does, whether or not the default's bytes changed."""

    def build(app_version, default, spanish):
        extra = {"default/app_strings.txt": default.encode(), "es/app_strings.txt": spanish.encode()}
        return _build(app_version, form_version=3, extra=extra)

    b = build(5, "name=Name\nempty=List is empty.\n", "name=Nombre\nempty=List is empty.\n")
    base = observed.ParsedBuild(b)
    saves = {
        # The language's file leaves out a key whose text the default file gives alike.
        "dropped, the default's text": (build(6, "name=Name\nempty=List is empty.\n", "name=Nombre\n"), False),
        # The language's own text went, and it now reads the default's.
        "dropped, another text": (build(6, "name=Name\nempty=List is empty.\n", "empty=List is empty.\n"), True),
        # The default's text changed under a key the language's file still gives.
        "the default changed": (build(6, "name=Named\nempty=List is empty.\n", "name=Nombre\n"), True),
    }
    for name, (after, expected) in saves.items():
        whole = observed.raw_builds_differ(b, after)
        assert whole == expected, name
        assert observed.raw_builds_differ(b, after, base, verify=True) == whole, name


def test_bs_app_read_once_is_read_only_while_hq_holds_its_document_and_verify_holds_each_reading_to_hqs(
    hq, core_runner, editor_driver
):
    from proof.editors import pages

    with suite_b(CONFIGURATION, [], core_runner, editor_driver) as (ctx, _):
        observation = observed._Observation(ctx, observed.hq_order)
        with ctx.unit.fork():
            observation.prepare()
            at_b = observation.offers("view_module", [0, None], {})
            with ctx.unit.fork():
                # A save that leaves the module's case list without a column the page shows.
                with ctx.unit.operation("probe-save", b"no columns"):
                    app = operations.held_app(ctx.unit, ctx.app_id)
                    app.modules[0].case_details.short.columns = []
                    app.save()
                changed = observation.offers("view_module", [0, None], {})
            # Back at B's state, B's app as read once is read again.
            again = observation.offers("view_module", [0, None], {})
        # B's app as read once, made to disagree with what HQ holds where each reading looks: the views and forms
        # proof 4 runs (a module's id), what a view offers (its case list's columns) and which forms Vellum opens
        # (a form's source). Read without verify, it is what proof 4 reads; under verify, each reading is caught.
        stale = operations.held_app(ctx.unit, ctx.app_id)
        form_id = stale.modules[0].forms[0].unique_id
        stale.modules[0].unique_id = "a module HQ does not hold"
        stale.modules[0].case_details.short.columns = []
        stale.lazy_put_attachment(b"", f"{form_id}.xml")
        observation.app_now = lambda: stale
        observation.verify = False
        stale_offers = observation.offers("view_module", [0, None], {})
        stale_vellum = observation.vellum(0, 0, form_id)
        observation.verify = True
        for reading, what in (
            (lambda: observation.offers("view_module", [0, None], {}), "what a view offers"),
            (lambda: observation.vellum(0, 0, form_id), "which forms Vellum opens"),
            (observation.observe, "the views and forms it runs"),
        ):
            with pytest.raises(observed.MemoMismatch, match=f"read {what} from B's app as read once"):
                reading()
    case_list = {page: offer for page, offer in at_b}[pages.CASE_LIST]
    assert case_list == (observed.OFFERED, None)
    assert {page: offer for page, offer in changed}[pages.CASE_LIST][0] == observed.SKIPPED
    assert again == at_b
    assert {page: offer for page, offer in stale_offers}[pages.CASE_LIST][0] == observed.SKIPPED
    assert (stale_vellum["offer"], stale_vellum["reason"]) == (observed.SKIPPED, "the form has no source")
