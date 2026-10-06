"""Intent checks: what HQ builds and what Core runs, against what the Nova document states (decision 16).

Contract (plan work item 11): on every corpus document, HQ holds each
module's case type the document names, learns the custom properties each
form writes, writes the data dictionary rows its save writes for the slots
the document's writes go in, builds each case attachment the document stores
and no other, and builds a profile at the configuration's version, with the
document's name and no settings the document does not state; Core's parse of
what HQ built creates the case types each form creates, writes each
property, and holds a constraint on each field the document validates, and
so does its parse of each of Nova's local archives. On a targeted document,
Core's evaluate gives the values ``expected.json`` fixes by hand.

The plausible failures: a defect present on both sides of a comparison (a
validation Nova drops from every export, defect 8; a case type HQ never
holds, defect 14; properties HQ's save never learns, defect 3); a check that
reads its expected value from Nova's emitter, which would agree with the
defect; a check that expects what HQ never keeps for any app (a data
dictionary row for a child case's write, which HQ's refresh never reads), so
no fix could clear it; and a comparator that reads the wrong side or the
wrong file, so it passes whatever HQ built. Expected values come from the
document alone; each reader below is pinned against an independent one (HQ's
own build, save and refresh of an app for the HQ-side comparators, Core's own
parse for case blocks and constraints), and each refusal is paired with an
accepted case.

The check is split in two: the observation (``proof.observe.intent``) reads
HQ's data dictionary and Core's parse of every form, and the judge
(``proof.checks.intent``) reads only the records and the document. The
plausible failures there: a judge that reaches HQ, so records cannot be
judged again without it; an observation that names the state it ran at, so
B-edit's record could not stand for B's; a judgment that reads something
the records lose when written to disk; an expectation run at the wrong state
or under the wrong configuration, which a comparison of values alone would
not show; an observation that reads a file it does not declare (an
expectation's restore), so a stored record keyed without it would be judged
again over a changed file; and a failure of the harness (the runner's JVM
exiting) recorded as if Core had raised it, which a store would then serve
on every later run; and a structural comparator that stops the judge on a
form Core's parser refuses, though the bar already reports it through Core's
admission of the same build or archive, so the document's other differences
go unreported. The judge is run in a process that refuses HQ over
records read back from disk; the observation at B-edit is compared with B's
where their inputs agree; a targeted copy of a corpus document runs an
expectation at A under one configuration, one at B under the other and one
on the local archive's case list, and each is held to where it ran; a
restore with a case fewer changes both Core's count and what the observation
declares; what Core raises is paired with each failure around it, the
first recorded and the others raised; and one HQ build is judged with its
form refused by Core's parser and with it parsed.
"""

from __future__ import annotations

import base64
import copy
import hashlib
import json
import os
import shutil
import zipfile
from pathlib import Path

import pytest
from lxml import etree

from proof.checks import cases, intent, observations, sharding
from proof.checks.corpus import CorpusLayoutError, Document
from proof.checks.manifest_usage import load_manifest
from proof.core.client import CoreDeadlineError, CoreRunnerError
from proof.observe import intent as observed_intent
from proof.observe import unit
from proof.observe.record import Blobs, DocumentRecords, canonical


@pytest.mark.parametrize("document", cases.document_params() + cases.control_params("intent"))
def test_hq_and_core_hold_what_the_document_states(document, hq, core_runner, editor_driver):
    records = observations.records_for(document, core_runner, editor_driver=editor_driver)
    found = intent.intent_differences(document, records, load_manifest().items)
    cases.hold("intent", document, found, cases.load_register(), configurations=sorted(document.exports))


def _field(uuid, kind, ident, **extra):
    return uuid, {"uuid": uuid, "kind": kind, "id": ident, **extra}


def _document():
    """A document as Nova persists it: three modules, a form with nested containers, writes and operations."""
    fields = dict(
        [
            _field("f-name", "text", "name", caseWrite={"caseType": "patient", "property": "case_name"}),
            _field("f-group", "group", "details"),
            _field("f-age", "int", "age", caseWrite={"caseType": "patient", "property": "age"}, validate={"parts": []}),
            _field(
                "f-photo",
                "image",
                "photo",
                caseWrite={"caseType": "patient", "property": "photo", "mode": "attachment"},
            ),
            _field("f-repeat", "repeat", "visits", repeat_mode="query_bound"),
            _field(
                "f-note", "text", "note", caseWrite={"caseType": "visit", "property": "note"}, validate={"parts": []}
            ),
            _field("f-plain", "text", "plain", validate={"parts": []}),
            _field("f-mood", "text", "mood", caseWrite={"caseType": "commcare-user", "property": "mood"}),
            _field("f-weight", "int", "weight", caseWrite={"caseType": "patient", "property": "weight"}),
        ]
    )
    doc = {
        "appName": "Clinic",
        "modules": {
            "m-patients": {"uuid": "m-patients", "id": "patients", "name": "Patients", "caseType": "patient"},
            "m-survey": {"uuid": "m-survey", "id": "survey", "name": "Survey"},
            "m-batch": {
                "uuid": "m-batch",
                "id": "batch",
                "name": "Batch",
                "caseType": "patient",
                "caseListConfig": {"selection": {"kind": "multiple", "maximum": 10}},
            },
        },
        "forms": {
            "form-register": {
                "uuid": "form-register",
                "id": "register",
                "name": "Register",
                "type": "registration",
                "caseOperations": [
                    {
                        "uuid": "op",
                        "id": "o",
                        "action": "create",
                        "caseType": "household",
                        "target": {"kind": "new"},
                        "writes": [{"property": "size"}, {"property": "owner_id"}, {"property": "parent/x"}],
                    }
                ],
            },
            "form-survey": {"uuid": "form-survey", "id": "s", "name": "S", "type": "survey"},
            "form-batch": {"uuid": "form-batch", "id": "b", "name": "B", "type": "followup"},
        },
        "fields": fields,
        "formOrder": {"m-patients": ["form-register"], "m-survey": ["form-survey"], "m-batch": ["form-batch"]},
        "fieldOrder": {
            "form-register": ["f-name", "f-group", "f-plain", "f-mood"],
            "f-group": ["f-age", "f-photo", "f-repeat"],
            "f-repeat": ["f-note"],
            "form-batch": ["f-weight"],
        },
    }
    wire = {
        "modules": [
            {"uuid": "m-patients", "forms": ["form-register"]},
            {"uuid": "m-survey", "forms": ["form-survey"]},
            {"uuid": "m-batch", "forms": ["form-batch"]},
            {"uuid": "m-synthetic", "forms": ["form-register"], "synthetic": {"hostModuleUuid": "m-batch"}},
        ]
    }
    return {"doc": doc, "wire": wire}


def test_the_intent_is_read_from_the_document_alone():
    read = intent.document_intent(_document())
    assert read.app_name == "Clinic"
    assert [case_type for case_type, _ in read.modules] == ["patient", "", "patient", "patient"]
    register = read.modules[0][1][0]
    # Standard properties (case_name, owner_id) and another case's (parent/x) are not custom writes.
    assert register.writes == {
        "patient": {"age": "value", "photo": "attachment"},
        "visit": {"note": "value"},
        "household": {"size": "value"},
        "commcare-user": {"mood": "value"},
    }
    # Field writes and case operations are told apart, since HQ keeps them in different slots.
    assert register.field_writes == {
        "patient": {"age": "value", "photo": "attachment"},
        "visit": {"note": "value"},
        "commcare-user": {"mood": "value"},
    }
    assert register.operation_writes == {"household": {"size"}}
    # A registration creates its module's type; a write naming another type creates it (but the worker's own
    # case, which is only ever updated); so does a create operation.
    assert register.creates == {"patient", "visit", "household"}
    # A query-bound repeat's rows are its <item> children.
    assert register.validations == {"f-age": "/details/age", "f-note": "/details/visits/item/note", "f-plain": "/plain"}
    assert (register.form_type, register.multiple) == ("registration", False)
    assert read.modules[1][1][0].writes == {} and read.modules[1][1][0].creates == set()
    # The menu HQ holds a form in selects several cases where the document's module selects several; a
    # synthetic module, holding one form outside its host's case list, selects none.
    assert [forms[0].multiple for _, forms in read.modules] == [False, False, True, False]
    assert intent.written_properties(read) == {
        "patient": {"age", "photo", "weight"},
        "visit": {"note"},
        "household": {"size"},
        "commcare-user": {"mood"},
    }

    broken = _document()
    broken["wire"]["modules"][0]["forms"].append("form-missing")
    with pytest.raises(CorpusLayoutError, match="form-missing"):
        intent.document_intent(broken)


def _form(position, module_type, form_type="followup", *, multiple=False, fields=None, operations=None):
    form = intent.FormIntent(uuid=position, module_type=module_type, form_type=form_type, multiple=multiple)
    for case_type, props in (fields or {}).items():
        form.field_writes[case_type] = dict.fromkeys(props, "value")
        form.writes.setdefault(case_type, {}).update(form.field_writes[case_type])
    for case_type, props in (operations or {}).items():
        form.operation_writes[case_type] = set(props)
        form.writes.setdefault(case_type, {}).update(dict.fromkeys(props, "value"))
    return form


SAVE_TO_CASE = {"VELLUM_SAVE_TO_CASE"}


def test_the_expected_data_dictionary_follows_the_slots_hqs_refresh_reads():
    """tasks.py::_refresh_data_dictionary_from_app: Save to Case (under the privilege, last form wins per case
    type), then a case-named menu's updates of its case and of the worker's; never a child case's."""
    modules = [
        (
            "patient",
            [
                _form(
                    "0.0",
                    "patient",
                    "registration",
                    fields={"patient": {"age"}, "commcare-user": {"visits"}, "visit": {"note"}},
                    operations={"household": {"size"}},
                ),
                _form("0.1", "patient", operations={"household": {"rooms"}}),
            ],
        ),
        ("", [_form("1.0", None, "survey", fields={"commcare-user": {"mood"}}, operations={"place": {"kind"}})]),
        (
            "patient",
            [
                _form("2.0", "patient", multiple=True, fields={"patient": {"weight"}, "commcare-user": {"steps"}}),
                _form("2.1", "patient", "registration", multiple=True, fields={"patient": {"height"}}),
            ],
        ),
    ]
    read = intent.Intent(app_name="Clinic", modules=modules)
    assert intent.expected_dictionary(read, SAVE_TO_CASE) == {
        # The menu's own case: field writes outside a multi-select menu, and a multi-select menu's
        # registration (a form that opens a case keeps its case management there); the multi-select
        # follow-up's write is Save to Case, which is the last form writing patient there.
        "patient": {"age", "height", "weight"},
        # Save to Case merges each form's set over the last one's: form 0.1 replaces form 0.0's.
        "household": {"rooms"},
        # Save to Case reads every form, a survey menu's too.
        "place": {"kind"},
        # The worker's own case only from a menu that names a case type, multi-select or not.
        "commcare-user": {"visits", "steps"},
    }
    # Without the privilege the refresh reads no Save to Case at all.
    assert intent.expected_dictionary(read, set()) == {
        "patient": {"age", "height"},
        "commcare-user": {"visits", "steps"},
    }


SUITE_PRIVILEGES = frozenset({"CLOUDCARE", "USERCASE", "VELLUM_SAVE_TO_CASE"})
SUITE_PROPERTIES = ("address", "enum", "filter", "invisible", "late-flag", "my_date", "phone", "plain", "time-ago")
ONE_QUESTION = """<h:html xmlns:h="http://www.w3.org/1999/xhtml" xmlns="http://www.w3.org/2002/xforms"
 xmlns:jr="http://openrosa.org/javarosa" xmlns:xsd="http://www.w3.org/2001/XMLSchema"><h:head><h:title>NAME</h:title>
 <model><instance><data xmlns="http://openrosa.org/formdesigner/proof-intent-NAME" uiVersion="1" version="1"
 name="NAME"><NAME/></data></instance><bind nodeset="/data/NAME" type="xsd:string"/></model></h:head>
 <h:body><input ref="/data/NAME"><label>NAME</label></input></h:body></h:html>"""
XFORMS = "http://www.w3.org/2002/xforms"


def _update(path):
    return {"question_path": path, "update_mode": "always"}


def _saved(path, case_type, prop):
    """A form's Save to Case reference, as Vellum writes it to HQ (``CaseReferences.save``)."""
    return {"load": {}, "save": {path: {"case_type": case_type, "properties": [prop]}}}


def _with_photo(source):
    """The suite app's first form with an image question, which HQ builds as a case attachment."""
    tree = etree.fromstring(source.encode())
    model = tree.find(f".//{{{XFORMS}}}model")
    data = model.find(f"{{{XFORMS}}}instance")[0]
    etree.SubElement(data, f"{{{etree.QName(data).namespace}}}photo")
    etree.SubElement(model, f"{{{XFORMS}}}bind", nodeset="/data/photo", type="binary")
    body = tree.find("{http://www.w3.org/1999/xhtml}body")
    upload = etree.SubElement(body, f"{{{XFORMS}}}upload", ref="/data/photo", mediatype="image/*")
    etree.SubElement(upload, f"{{{XFORMS}}}label").text = "Photo"
    return etree.tostring(tree, encoding="unicode")


def _one_question_module(template, case_type, name, actions, requires):
    """A menu of ``case_type`` holding one form with one question ``name`` (``ONE_QUESTION``)."""
    form = copy.deepcopy(template["forms"][1])
    form.update(
        unique_id=f"proof-intent-{name}",
        xmlns=f"http://openrosa.org/formdesigner/proof-intent-{name}",
        requires=requires,
        name={"en": name},
        case_references_data={"load": {}, "save": {}},
        actions=actions,
    )
    module = copy.deepcopy(template)
    module.update(case_type=case_type, name={"en": name}, forms=[form])
    return module, ONE_QUESTION.replace("NAME", name)


def _suite_app():
    """HQ's suite-test app with writes in every slot HQ's refresh reads and one it does not, and a set setting.

    Its first form (a registration) also updates the worker's case, opens a
    ``visit`` child case and saves a ``household`` through Save to Case; its
    second form saves another ``household`` property the same way; a survey
    menu's form updates the worker's case; a ``visit`` menu (HQ builds a child
    case only of a type some menu holds) follows up a visit; and the app sets
    ``cc-show-saved``.
    """
    from proof.hq.conftest import hq_test_app

    app = hq_test_app()
    module = app["modules"][0]
    register, followup = module["forms"]
    sources = app["_attachments"]
    sources[f"{register['unique_id']}.xml"] = _with_photo(sources[f"{register['unique_id']}.xml"])
    actions = register["actions"]
    actions["update_case"]["update"]["photo"] = _update("/data/photo")
    actions["usercase_update"] = {"update": {"visits": _update("/data/plain")}, "condition": {"type": "always"}}
    actions["subcases"] = [
        {
            "doc_type": "OpenSubCaseAction",
            "case_type": "visit",
            "name_update": _update("/data/plain"),
            "case_properties": {"note": _update("/data/plain")},
            "condition": {"type": "always"},
        }
    ]
    register["case_references_data"] = _saved("/data/plain", "household", "size")
    followup["case_references_data"] = _saved("/data/rename", "household", "rooms")
    usercase = {"usercase_update": {"update": {"mood": _update("/data/mood")}, "condition": {"type": "always"}}}
    for case_type, name, actions, requires in (("", "mood", usercase, "none"), ("visit", "check", {}, "case")):
        added, source = _one_question_module(module, case_type, name, actions, requires)
        sources[f"{added['forms'][0]['unique_id']}.xml"] = source
        app["modules"].append(added)
    app["profile"] = {"properties": {"cc-show-saved": "yes"}, "features": {}}
    return app


def _shapes(core_runner, files):
    """Core's parse of each form among ``files``, as the observation makes it (``form_shape``)."""
    return {name: observed_intent.form_shape(core_runner, files[name]) for name in observed_intent.form_files(files)}


def _held(core_runner, privileges):
    """HQ's state after Nova's publish of the suite app under ``privileges``: built, read and refreshed, with
    what the intent observation reads there (HQ's data dictionary, Core's parse of each form HQ built)."""
    from proof.hq import operations
    from proof.hq.check import hq_check
    from proof.hq.configuration import Configuration
    from proof.hq.conftest import nova_shaped_upload
    from proof.hq.seams import build_seams
    from proof.observe.build import build_state
    from proof.observe.identity import app_identity

    configuration = Configuration(privileges=privileges)
    with hq_check(configuration, validate=core_runner.validate_form) as (state, record):
        app_id, _ = operations.publish(state, [nova_shaped_upload(_suite_app(), "Suite app")])
        app = operations.held_app(state, app_id)
        with build_seams(previous=None):
            outcome, _ = build_state(app, record, "A")
            identities = app_identity(app, outcome.files, state.domain)
        # The comparators read HQ's whole build; one HQ refused would let them pass on nothing.
        assert outcome.complete and not outcome.errors, (outcome.raised, outcome.errors)
        rows = observed_intent.data_dictionary_rows(state.domain)
        doc = json.loads(json.dumps(app.to_json(), default=str))
        held = intent.HeldState("A", doc, identities, outcome, rows, _shapes(core_runner, outcome.files))
    return configuration, held


@pytest.fixture(scope="module")
def suite_held(hq, core_runner):
    return _held(core_runner, SUITE_PRIVILEGES)


def _suite_intent():
    """What a Nova document stating the suite app's writes says, form by form in HQ's order."""
    register = _form(
        "0.0",
        "suite_test",
        "registration",
        fields={"suite_test": set(SUITE_PROPERTIES), "commcare-user": {"visits"}, "visit": {"note"}},
        operations={"household": {"size"}},
    )
    register.field_writes["suite_test"]["photo"] = "attachment"
    register.writes["suite_test"]["photo"] = "attachment"
    followup = _form("0.1", "suite_test", operations={"household": {"rooms"}})
    mood = _form("1.0", None, "survey", fields={"commcare-user": {"mood"}})
    check = _form("2.0", "visit")
    modules = [("suite_test", [register, followup]), ("", [mood]), ("visit", [check])]
    return intent.Intent(app_name="Suite app", modules=modules)


def _found(differences):
    return sorted((d.artifact, d.path, d.at, d.kind, d.before, d.after) for d in differences)


def test_hqs_refresh_writes_the_rows_the_expected_dictionary_names(suite_held, core_runner):
    """HQ's own save and refresh are the oracle for the slot rule: what it wrote for an app stating writes in
    every slot is exactly what ``expected_dictionary`` expects, and a privilege the target lacks drops Save to
    Case."""
    configuration, held = suite_held
    rows = {case_type: set(props) for case_type, props in held.data_dictionary.items() if props}
    expected = intent.expected_dictionary(_suite_intent(), configuration.privileges)
    assert expected == {
        "suite_test": {*SUITE_PROPERTIES, "photo"},
        "commcare-user": {"visits"},
        "household": {"rooms"},
    }
    # HQ writes what the rule expects, and beyond it only the case name its second form updates; the child
    # case's note, the survey menu's mood and the first form's Save to Case size never reach it.
    assert rows == {**expected, "suite_test": expected["suite_test"] | {"name"}}
    assert intent.data_dictionary("doc", _suite_intent(), held, configuration.privileges) == []

    without, plain = _held(core_runner, SUITE_PRIVILEGES - {"VELLUM_SAVE_TO_CASE"})
    assert "household" not in {case_type for case_type, props in plain.data_dictionary.items() if props}
    assert intent.data_dictionary("doc", _suite_intent(), plain, without.privileges) == []
    # The same state held to the privileged expectation misses exactly the Save to Case row.
    assert _found(intent.data_dictionary("doc", _suite_intent(), plain, configuration.privileges)) == [
        ("data_dictionary@A", "/*/*", "/household/rooms", "removed", "rooms", None)
    ]


def test_each_hq_comparator_reports_exactly_what_the_document_states_otherwise(suite_held, core_runner):
    """A document stating what HQ holds gives nothing but the setting the app sets; each statement changed gives
    exactly its difference."""
    configuration, held = suite_held
    items = load_manifest().items
    stated = _suite_intent()
    assert intent.module_case_types("doc", stated, held) == []
    assert intent.learned_properties("doc", stated, held) == []
    assert intent.attachment_paths("doc", stated, held) == []
    # The app sets cc-show-saved, which a Nova document never states: HQ writes "yes" where an app stating no
    # setting gets the settings file's default, "no".
    setting = ("profile.ccpr@A", "/profile/property[@key=cc-show-saved]/@value")
    assert _found(intent.profile_settings("doc", stated, held, configuration, items)) == [
        (*setting, setting[1], "changed", "no", "yes")
    ]

    other = _suite_intent()
    other.modules[0] = ("patient", other.modules[0][1])
    assert _found(intent.module_case_types("doc", other, held)) == [
        ("app.json@A", "/modules/*/case_type", "/modules/0/case_type", "changed", "patient", "suite_test")
    ]

    other = _suite_intent()
    register, followup = other.modules[0][1]
    register.writes["suite_test"]["weight"] = "value"
    del followup.writes["household"]
    assert _found(intent.learned_properties("doc", other, held)) == [
        ("form:0.0@A", "/case_updates/*/*", "/case_updates/suite_test/weight", "removed", "weight", None),
        ("form:0.1@A", "/case_updates/*/*", "/case_updates/household/rooms", "added", None, "rooms"),
    ]

    other = _suite_intent()
    register = other.modules[0][1][0]
    register.writes["suite_test"].update(photo="value", plain="attachment")
    assert _found(intent.attachment_paths("doc", other, held)) == [
        ("form:0.0@A", "/attachments/*/*", "/attachments/suite_test/photo", "added", None, "photo"),
        ("form:0.0@A", "/attachments/*/*", "/attachments/suite_test/plain", "removed", "plain", None),
    ]

    other = _suite_intent()
    other.modules[0][1][1].operation_writes["household"].add("floors")
    assert _found(intent.data_dictionary("doc", other, held, configuration.privileges)) == [
        ("data_dictionary@A", "/*/*", "/household/floors", "removed", "floors", None)
    ]

    other = _suite_intent()
    other.app_name = "Clinic"
    assert _found(intent.profile_settings("doc", other, held, configuration, items)) == [
        ("profile.ccpr@A", "/profile/@name", "/profile/@name", "changed", "Clinic", "Suite app"),
        (*setting, setting[1], "changed", "no", "yes"),
    ]


def _shape(core_runner, xml):
    shape = observed_intent.form_shape(core_runner, xml)
    assert isinstance(shape, list), shape
    return shape


def vars_of(block):
    return (block.path, block.case_type, sorted(block.updates), sorted(block.attachments))


VALIDATED = b"""<h:html xmlns="http://www.w3.org/2002/xforms" xmlns:h="http://www.w3.org/1999/xhtml"
 xmlns:xsd="http://www.w3.org/2001/XMLSchema"><h:head><h:title>F</h:title><model>
 <instance><data xmlns="http://example.org/f"><plain/><details><age/></details>
  <case xmlns="http://commcarehq.org/case/transaction/v2" case_id=""><create><case_type>patient</case_type></create>
  <update><age/></update></case></data></instance>
 <bind nodeset="/data/details/age" type="xsd:int" constraint=". &gt; 0"/>
 <bind nodeset="/data/plain" type="xsd:string" CONSTRAINT/>
 </model></h:head><h:body><input ref="/data/plain"><label>P</label></input>
 <group ref="/data/details"><input ref="/data/details/age"><label>A</label></input></group></h:body></h:html>"""


def test_core_holds_each_validation_creation_and_write_the_document_states(core_runner):
    form = intent.FormIntent(uuid="form-register", module_type="patient")
    form.validations = {"f-age": "/details/age", "f-plain": "/plain"}
    form.writes = {"patient": {"age": "value"}}
    form.creates = {"patient"}
    kept = _shape(core_runner, VALIDATED.replace(b"CONSTRAINT", b'constraint="string-length(.) &lt; 9"'))
    assert intent.core_form("doc", form, kept, "core:form:0.0@A") == []

    dropped = _shape(core_runner, VALIDATED.replace(b"CONSTRAINT", b""))
    found = intent.core_form("doc", form, dropped, "core:form:0.0@A")
    assert [(d.path, d.at, d.kind, d.after) for d in found] == [
        ("/constraints/*", "/constraints/plain", "removed", None)
    ]
    # A validated field the form holds no node for is a difference too, not a pass.
    form.validations["f-gone"] = "/details/gone"
    found = intent.core_form("doc", form, kept, "core:form:0.0@A")
    assert [(d.at, d.after) for d in found] == [("/constraints/details/gone", "no node")]
    del form.validations["f-gone"]

    form.writes = {"patient": {"age": "value", "weight": "value"}, "visit": {"photo": "attachment"}}
    form.creates = {"patient", "visit"}
    found = intent.core_form("doc", form, kept, "core:form:0.0@A")
    assert sorted((d.at, d.kind) for d in found) == [
        ("/creates/visit", "removed"),
        ("/writes/patient/weight", "removed"),
        ("/writes/visit/photo", "removed"),
    ]


NUMBER_FORM = b"""<h:html xmlns="http://www.w3.org/2002/xforms" xmlns:h="http://www.w3.org/1999/xhtml"
 xmlns:xsd="http://www.w3.org/2001/XMLSchema"><h:head><h:title>N</h:title><model>
 <instance><data xmlns="http://example.org/n"><n/></data></instance>
 <bind nodeset="/data/n" type="xsd:int" CONSTRAINT/></model></h:head>
 <h:body><input ref="/data/n"><label>N</label></input></h:body></h:html>"""
NUMBER_DOC = {
    "doc": {
        "appName": "N",
        "modules": {"m": {"uuid": "m", "id": "m", "name": "M"}},
        "forms": {"form-n": {"uuid": "form-n", "id": "n", "name": "N", "type": "survey"}},
        "fields": {"f-n": {"uuid": "f-n", "kind": "int", "id": "n", "validate": {"parts": []}}},
        "formOrder": {"m": ["form-n"]},
        "fieldOrder": {"form-n": ["f-n"]},
    },
    "wire": {"modules": [{"uuid": "m", "forms": ["form-n"]}]},
}


def _archive(path, constraint):
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("modules-0/forms-0.xml", NUMBER_FORM.replace(b"CONSTRAINT", constraint))


def _targeted(tmp_path, constraint, expected):
    """A targeted document in the corpus layout: its document, its local export, and hand-fixed expectations."""
    root = tmp_path / "targeted"
    root.mkdir(parents=True)
    (root / "document.json").write_text(json.dumps(NUMBER_DOC))
    _archive(root / "local.ccz", constraint)
    (root / "expected.json").write_text(json.dumps(expected))
    return Document(id="targeted.number", source="targeted", root=root)


def _local_records(document, core_runner):
    """A document's records holding only what the intent observation reads over its local archives."""
    records = DocumentRecords(document.id, document.kind)
    ctx = unit.LocalContext(document, unit.local_archives(document), core_runner, records.blobs)
    records.local = {"kind": "local", "hooks": {"intent": observed_intent.observe_local(ctx)}}
    return records


def test_each_local_archive_is_held_under_its_own_name(tmp_path, core_runner):
    """Two local exports of one document are two artifacts: a constraint only the second drops is the second's."""
    root = tmp_path / "two-archives"
    root.mkdir()
    (root / "document.json").write_text(json.dumps(NUMBER_DOC))
    _archive(root / "local.ccz", b'constraint=". &gt; 10"')
    _archive(root / "local-again.ccz", b"")
    document = Document(id="two-archives", source="test", root=root)
    found = intent.intent_differences(document, _local_records(document, core_runner), {})
    assert _found(found) == [
        ("core:local-again.ccz/form:0.0", "/constraints/*", "/constraints/n", "removed", "/n", None)
    ]


EXPECTED = {
    "intent": [
        {
            "id": "authored-minimum",
            "export": "local",
            "form": "form-n",
            "request": {"constraintChecks": [{"path": "/data/n", "value": "7"}, {"path": "/data/n", "value": "25"}]},
            # The document authors "more than ten": seven breaks it, twenty-five meets it.
            "expect": [
                {"pointer": "/constraints/0/result", "value": "constraint"},
                {"pointer": "/constraints/1/result", "value": "ok"},
            ],
        }
    ]
}


def test_a_targeted_documents_values_are_core_s(tmp_path, core_runner):
    held = _targeted(tmp_path / "held", b'constraint=". &gt; 10"', EXPECTED)
    assert intent.value_differences(held, _local_records(held, core_runner)) == []

    dropped = _targeted(tmp_path / "dropped", b"", EXPECTED)
    found = intent.value_differences(dropped, _local_records(dropped, core_runner))
    assert [(d.artifact, d.path, d.at, d.before, d.after) for d in found] == [
        ("evaluate:authored-minimum@local", "/constraints/*/result", "/constraints/0/result", "constraint", "ok")
    ]
    # What the observation reads beyond the local part's archives is the expectations' requests and the file each
    # one's form is at: a changed expected value is the judge's alone, a changed request is observed again, and
    # so is a form the wire layout places elsewhere (the expectation then runs in another file).
    changed_value = copy.deepcopy(EXPECTED)
    changed_value["intent"][0]["expect"][0]["value"] = "ok"
    changed_request = copy.deepcopy(EXPECTED)
    changed_request["intent"][0]["request"]["constraintChecks"][0]["value"] = "8"
    declared = [
        observed_intent.inputs(_targeted(tmp_path / name, b"", expected), "local")
        for name, expected in (("one", EXPECTED), ("value", changed_value), ("request", changed_request))
    ]
    moved = _targeted(tmp_path / "moved", b"", EXPECTED)
    placed = copy.deepcopy(NUMBER_DOC)
    placed["wire"]["modules"].insert(0, {"uuid": "m-first", "forms": []})
    (moved.root / "document.json").write_text(json.dumps(placed))
    assert declared[0] == declared[1] != declared[2]
    assert observed_intent.inputs(moved, "local") not in declared
    assert observed_intent.inputs(held, "A") == {} and observed_intent.inputs(held, "B-edit") == {}


CASES_FORM = NUMBER_FORM.replace(
    b"</data></instance>", b'</data></instance><instance id="casedb" src="jr://instance/casedb"/>'
).replace(b"CONSTRAINT", b"")
COUNTED = {
    "intent": [
        {
            "id": "counted",
            "export": "local",
            "form": "form-n",
            "restore": "restore.xml",
            "request": {"expressions": ["count(instance('casedb')/casedb/case)"]},
            # The worker's restore holds two cases.
            "expect": [{"pointer": "/values/0/value", "value": "2"}],
        }
    ]
}


def _restore(cases):
    """Core's template restore (one worker, one case) holding ``cases`` cases: its case, copied under new ids."""
    from proof.core.artifacts import TEMPLATE_RESTORE

    tree = etree.fromstring(TEMPLATE_RESTORE.read_bytes())
    (template,) = tree.findall("{http://commcarehq.org/case/transaction/v2}case")
    for index in range(1, cases):
        added = copy.deepcopy(template)
        added.set("case_id", f"case-{index}")
        template.addnext(added)
    return etree.tostring(tree)


def _counted(root, restore):
    """A targeted document whose expectation counts the cases of the restore it names, ``restore`` its bytes."""
    root.mkdir(parents=True)
    (root / "document.json").write_text(json.dumps(NUMBER_DOC))
    with zipfile.ZipFile(root / "local.ccz", "w") as archive:
        archive.writestr("modules-0/forms-0.xml", CASES_FORM)
    (root / "expected.json").write_text(json.dumps(COUNTED))
    (root / "restore.xml").write_bytes(restore)
    return Document(id="targeted.counted", source="targeted", root=root)


def test_the_restore_an_expectation_names_is_read_and_declared(tmp_path, core_runner):
    """A restore in the document's directory is what Core's evaluate reads the expectation's cases from, and what
    the observation declares it reads: a restore with a case fewer gives Core's count as the difference and is
    observed again (it moves what the local part is keyed by), and the same bytes again move nothing."""
    two = _counted(tmp_path / "two", _restore(2))
    assert intent.value_differences(two, _local_records(two, core_runner)) == []

    one = _counted(tmp_path / "one", _restore(1))
    found = intent.value_differences(one, _local_records(one, core_runner))
    assert _found(found) == [("evaluate:counted@local", "/values/*/value", "/values/0/value", "changed", "2", "1")]
    again = _counted(tmp_path / "again", _restore(2))
    declared = observed_intent.inputs(two, "local")
    assert declared.get("files") == {"restore.xml": "sha256:" + hashlib.sha256(_restore(2)).hexdigest()}
    assert observed_intent.inputs(one, "local") != declared == observed_intent.inputs(again, "local")


@pytest.mark.parametrize(
    ("change", "refusal"),
    [
        ({"export": "C"}, "export is local, A or B"),
        ({"request": {"appHandle": "x"}}, "which Core's evaluate does not take"),
        ({"expect": [{"pointer": "constraints", "value": 1}]}, "a JSON Pointer each"),
        ({"request": {"caseList": {}}, "export": "A"}, "only the local export is one here"),
        ({"surprise": 1}, "which no expectation reads"),
    ],
    ids=["unknown-export", "unknown-request-key", "relative-pointer", "case-list-on-hq", "unknown-key"],
)
def test_an_expectation_the_check_cannot_run_is_refused(tmp_path, core_runner, change, refusal):
    accepted = _targeted(tmp_path / "accepted", b'constraint=". &gt; 10"', EXPECTED)
    assert intent.value_differences(accepted, _local_records(accepted, core_runner)) == []
    entry = {**EXPECTED["intent"][0], **change}
    refused = _targeted(tmp_path / "refused", b'constraint=". &gt; 10"', {"intent": [entry]})
    # Refused before anything runs: by what the observation declares it reads, and by the judge.
    with pytest.raises(CorpusLayoutError, match=refusal):
        observed_intent.inputs(refused, "local")
    with pytest.raises(CorpusLayoutError, match=refusal):
        intent.value_differences(refused, DocumentRecords(refused.id, refused.kind))


def _targetable():
    """The cheapest corpus document exported under minimum and maximum that holds a survey form and a follow-up
    form whose local entry selects one ``case_id`` from its menu's short detail:
    ``(document, the survey's uuid, (module, form, the follow-up's uuid))``, positions as the wire places them."""
    from proof.core.artifacts import read_archive_entry

    found = []
    for document in cases.load_corpus().emitted:
        if not {"minimum", "maximum"} <= set(document.exports) or document.local_ccz is None:
            continue
        forms = document.document["doc"]["forms"]
        placed = [
            (m, f, uuid) for m, module in enumerate(document.wire_modules) for f, uuid in enumerate(module["forms"])
        ]
        surveys = [uuid for _, _, uuid in placed if forms[uuid].get("type") == "survey"]
        suite = etree.fromstring(read_archive_entry(document.local_ccz, "suite.xml"))
        selecting = []
        for m, f, uuid in placed:
            if forms[uuid].get("type") != "followup":
                continue
            for entry in suite.iter("entry"):
                if entry.find(f"command[@id='m{m}-f{f}']") is None:
                    continue
                datums = entry.findall("session/datum")
                if [(d.get("id"), d.get("detail-select")) for d in datums] == [("case_id", f"m{m}_case_short")]:
                    selecting.append((m, f, uuid))
        if surveys and selecting:
            found.append((document, surveys[0], selecting[0]))
    assert found, "No corpus document holds a survey form and a follow-up selecting one case, so nothing runs here."
    estimate = sharding.estimate(sharding.load_timings())
    return min(found, key=lambda chosen: (estimate(chosen[0].group), chosen[0].id))


def _intent_hooks_alone(monkeypatch):
    """The unit calls the intent observation's hooks and no other. What these tests read is the intent hook's
    record, which no other hook's work changes (each hook runs from its state's mark and leaves the unit there);
    proof 4's hook would save in HQ's editors through the browser for nothing they read."""
    monkeypatch.setattr(unit, "HOOKS", tuple(hook for hook in unit.HOOKS if hook[0] == "intent"))


def test_each_expectation_runs_where_its_export_is_under_its_configuration(tmp_path, hq, core_runner, monkeypatch):
    """Expectations at A under minimum, at B under maximum, and on the local archive's case list each run there
    and nowhere else (one run under another configuration, or at B-edit, would land in that part's record), and
    the judge reads each where it ran: the ones that hold give nothing, the one fixed otherwise gives its value,
    a form a build of A does not hold is a refusal naming that cause, and a build of nothing is the bar's to
    explain."""
    source, survey, (m, f, followup) = _targetable()
    root = tmp_path / source.id
    shutil.copytree(source.root, root)
    expected = [
        {
            "id": "sum-at-a",
            "export": "A",
            "configuration": "minimum",
            "form": survey,
            "request": {"expressions": ["1 + 1"]},
            "expect": [{"pointer": "/values/0/value", "value": "2"}],
        },
        {
            "id": "sum-at-b",
            "export": "B",
            "configuration": "maximum",
            "form": survey,
            "request": {"expressions": ["2 + 2"]},
            # Two and two make four; the five fixed here is the difference the judge must find.
            "expect": [{"pointer": "/values/0/value", "value": "5"}],
        },
        {
            "id": "case-list",
            "export": "local",
            "form": followup,
            "request": {"session": {"command": f"m{m}-f{f}"}, "caseList": {}},
            "expect": [
                {"pointer": "/caseList/datum", "value": "case_id"},
                {"pointer": "/caseList/detail", "value": f"m{m}_case_short"},
            ],
        },
    ]
    (root / "expected.json").write_text(json.dumps({"intent": expected}), encoding="utf-8")
    document = Document(id=source.id, source="test", root=root)
    _intent_hooks_alone(monkeypatch)
    records = unit.observe_document(document, core_runner=core_runner, configurations={"minimum", "maximum"})

    ran = {
        f"{name}/{part}": sorted(
            ((getattr(held, part) or {}).get("hooks") or {}).get("intent", {}).get("evaluations", {})
        )
        for name, held in records.configurations.items()
        for part in ("a", "b", "b_edit")
    }
    assert {part: ids for part, ids in ran.items() if ids} == {"minimum/a": ["sum-at-a"], "maximum/b": ["sum-at-b"]}
    assert sorted(records.local["hooks"]["intent"]["evaluations"]) == ["case-list"]
    changed = ("evaluate:sum-at-b@B", "/values/*/value", "/values/0/value", "changed", "5", "4")
    assert _found(intent.value_differences(document, records)) == [changed]

    position = observed_intent.form_position(document.wire_modules, survey)
    name = f"modules-{position[0]}/forms-{position[1]}.xml"
    held = records.configurations["minimum"]
    unbuilt = copy.deepcopy(held.a)
    del unbuilt["state"]["build"]["files"][name]
    held.a = unbuilt
    missing = f"HQ's build of A holds no {name}, the form {survey}."
    assert _found(intent.value_differences(document, records)) == [
        ("evaluate:sum-at-a@A", "/no-form-file", "/no-form-file", "refused", None, missing),
        changed,
    ]
    # Where HQ built nothing for A (its publish refused, or a step raised), the bar says why, and the
    # expectation adds nothing.
    nothing = copy.deepcopy(held.a)
    nothing["state"]["build"]["files"] = None
    held.a = nothing
    assert _found(intent.value_differences(document, records)) == [changed]


def test_an_expectation_cores_evaluate_raises_on_is_named_with_what_core_said(tmp_path, core_runner):
    """Where Core's evaluate raises on an expectation's request (here a form whose calculate calls a function
    Core cannot handle), the record holds what Core said, and the judge names the expectation, where its request
    ran and Core's message, and points at the request, rather than reporting a missing observation. Where the
    form the request runs in is one Core's parser refuses, the evaluate raises the same refusal, and the judge
    leaves it to the bar (``admission@local.ccz``): no difference and no raise."""
    refused = _targeted(tmp_path / "refused", b'constraint=". &gt; "', EXPECTED)
    records = _local_records(refused, core_runner)
    failed = records.local["hooks"]["intent"]["evaluations"]["authored-minimum"]["failed"]
    assert failed["class"] == "org.javarosa.xform.parse.XFormParseException"
    assert intent.value_differences(refused, records) == []

    failing = _targeted(tmp_path / "failing", b'calculate="frobnicate(1)"', EXPECTED)
    records = _local_records(failing, core_runner)
    failed = records.local["hooks"]["intent"]["evaluations"]["authored-minimum"]["failed"]
    assert failed["class"] == "org.javarosa.xpath.XPathUnhandledException"
    with pytest.raises(intent.CoreRaised) as raised:
        intent.value_differences(failing, records)
    message = str(raised.value)
    for said in (
        "authored-minimum",
        "modules-0/forms-0.xml of local.ccz",
        "cannot handle function 'frobnicate'",
        str(failing.root / "expected.json"),
    ):
        assert said in message, (said, message)


class _Failing:
    """A Core runner whose every request fails as its client reports ``error``."""

    def __init__(self, error):
        self.error = error

    def request(self, op, **args):
        raise self.error

    def evaluate(self, **args):
        raise self.error

    def holds(self, app):
        return False


def _thrown(name, message, *, trace=True):
    """What the runner reports where something threw ``name`` (``Runner.java::handle``): its class and message
    and, for an op's own throwable, its stack trace; the runner's own wait being interrupted carries none."""
    detail = {"kind": "internal", "class": name, "message": message}
    if trace:
        detail["trace"] = f"{name}: {message}\n\tat nova.proof.core.Ops.dispatch(Ops.java)"
    return CoreRunnerError(message, detail=detail)


# The failures around Core, as the runner's client reports them (proof/core/client.py::CoreRunner._send).
HARNESS_FAILURES = {
    "jvm-exit": CoreRunnerError("The Core runner's JVM exited (status 137) while answering the formShape request."),
    "protocol": CoreRunnerError(
        "The Core runner answered request 7 while the client waited for 8; the protocol is out of step, so the"
        " client stopped the JVM."
    ),
    "request": CoreRunnerError(
        "The formShape request needs formBase64.",
        kind="request",
        detail={"kind": "request", "message": "The formShape request needs formBase64."},
    ),
    "deadline": CoreDeadlineError("The formShape request did not finish within its deadline.", kind="deadline"),
    "interrupted": _thrown(
        "java.lang.InterruptedException",
        "The runner was interrupted while waiting for the formShape request.",
        trace=False,
    ),
    "out-of-memory": _thrown(
        "java.lang.OutOfMemoryError", "The formShape request raised OutOfMemoryError: Java heap space"
    ),
}


def test_what_core_raises_is_recorded_and_every_failure_around_it_is_raised(tmp_path, core_runner):
    """A form Core's parser raises on is recorded with what Core said, its parser node's identity hash dropped
    (the hash differs from run to run, the record must not), and the judge leaves it to the bar, which reports
    Core's admission of the archive, while it still judges a form Core parses. The
    runner's JVM exiting, its protocol out of step, a request it refuses, a deadline, its wait interrupted and an
    error of the JVM's own are the harness's: each is raised, by the parse and by the evaluate alike, so no
    record holds it and no store serves it again."""
    bad = NUMBER_FORM.replace(b"CONSTRAINT", b'constraint=". &gt; "')
    with pytest.raises(CoreRunnerError) as raw:
        core_runner.request("formShape", deadline=60.0, formBase64=base64.b64encode(bad).decode("ascii"))
    assert observed_intent.IDENTITY_HASH.search(raw.value.detail["message"]), raw.value.detail
    refused = observed_intent.form_shape(core_runner, bad)
    assert refused == observed_intent.form_shape(core_runner, bad)
    said = refused["refused"]
    assert said["class"] == "org.javarosa.xform.parse.XFormParseException"
    assert "Bad node: org.javarosa.xpath.parser.ast.ASTNodeAbstractExpr" in said["message"]
    assert not observed_intent.IDENTITY_HASH.search(said["message"])
    shapes = {"modules-0/forms-0.xml": refused}
    assert intent.core_local("doc", intent.document_intent(NUMBER_DOC), shapes, "local.ccz") == []
    shapes = {"modules-0/forms-0.xml": observed_intent.form_shape(core_runner, NUMBER_FORM.replace(b"CONSTRAINT", b""))}
    judged = intent.core_local("doc", intent.document_intent(NUMBER_DOC), shapes, "local.ccz")
    assert [difference.path for difference in judged] == ["/constraints/*"]

    # A request the runner refuses is the harness's as the runner itself reports it, not only as written here.
    with pytest.raises(CoreRunnerError) as request:
        core_runner.request("formShape", deadline=60.0)
    assert request.value.kind == "request" and observed_intent.core_raised(request.value) is None

    document = _targeted(tmp_path, b"", EXPECTED)
    entry = EXPECTED["intent"][0]
    for name, error in HARNESS_FAILURES.items():
        assert observed_intent.core_raised(error) is None, name
        with pytest.raises(CoreRunnerError) as shape:
            observed_intent.form_shape(_Failing(error), bad)
        with pytest.raises(CoreRunnerError) as evaluated:
            observed_intent.evaluation(_Failing(error), document, entry, Blobs(), form=bad)
        assert shape.value is error and evaluated.value is error, name


def test_every_structural_check_leaves_a_form_cores_parser_refuses_to_the_bar(core_runner):
    """One HQ build of the number form, judged as a state: with the form Core's parser refuses, no comparator reads
    it (the attachments', the case blocks', the constraints') and none raises, since the bar holds Core's
    admission of that build; with the form Core parses, its dropped constraint is still reported."""
    from proof.observe.outcome import BuildOutcome

    name = "modules-0/forms-0.xml"
    bad = NUMBER_FORM.replace(b"CONSTRAINT", b'constraint=". &gt; "')
    stated = intent.document_intent(NUMBER_DOC)
    configuration = intent.JudgedConfiguration("minimum", "2.53.0", frozenset())

    def judged(xml):
        state = intent.HeldState(
            "A",
            {"modules": [{"case_type": ""}]},
            {"form:0.0": {"case_updates": {}}},
            BuildOutcome("A", 1, [], {}, {name: xml}),
            {},
            {name: observed_intent.form_shape(core_runner, xml)},
        )
        return [(d.artifact, d.path) for d in intent.state_differences("doc", stated, state, configuration, {})]

    assert "refused" in observed_intent.form_shape(core_runner, bad)
    assert judged(bad) == []
    assert judged(NUMBER_FORM.replace(b"CONSTRAINT", b"")) == [("core:form:0.0@A", "/constraints/*")]


def test_case_blocks_are_read_from_cores_parse(core_runner):
    """A block's type is its template's, or a calculate Core reads as a constant; its writes are its children.

    HQ writes a case attachment as case/attachment/<name> (xform.py::CaseBlock.add_case_updates), and Nova's
    Save to Case blocks set their type by a calculate.
    """
    xml = VALIDATED.replace(b"CONSTRAINT", b"")
    assert [vars_of(block) for block in intent.case_blocks(_shape(core_runner, xml))] == [
        ("/data/case", "patient", ["age"], [])
    ]
    attached = xml.replace(b"</update>", b'</update><attachment><photo src="" from="local"/></attachment>')
    assert [vars_of(block) for block in intent.case_blocks(_shape(core_runner, attached))] == [
        ("/data/case", "patient", ["age"], ["photo"])
    ]
    computed = xml.replace(b"<case_type>patient</case_type>", b"<case_type/>")
    constant = computed.replace(
        b"</model>", b'<bind nodeset="/data/case/create/case_type" calculate="\'visit\'"/></model>'
    )
    runtime = computed.replace(
        b"</model>", b'<bind nodeset="/data/case/create/case_type" calculate="/data/plain"/></model>'
    )
    assert [block.case_type for block in intent.case_blocks(_shape(core_runner, constant))] == ["visit"]
    assert [block.case_type for block in intent.case_blocks(_shape(core_runner, runtime))] == [None]


# The observation and the judge ----------------------------------------------------------

JUDGMENT = """
import json, sys
from pathlib import Path
from proof.checks import intent
from proof.checks.corpus import Document
from proof.checks.manifest_usage import load_manifest
from proof.observe.record import DocumentRecords

records = DocumentRecords.load(sys.argv[2])
items = load_manifest().items
found = {}
for root in sys.argv[3:]:
    document = Document(id=records.document, source="test", root=Path(root))
    judged = intent.intent_differences(document, records, items)
    found[root] = sorted(json.dumps(d.as_json(), sort_keys=True) for d in judged)
print(json.dumps(found))
"""


def _renamed(document, root):
    """A copy of the document's directory at ``root`` whose document names another case type for every module."""
    shutil.copytree(document.root, root)
    value = json.loads((root / "document.json").read_text(encoding="utf-8"))
    for module in value["doc"]["modules"].values():
        module["caseType"] = "proof-renamed"
    (root / "document.json").write_text(json.dumps(value), encoding="utf-8")
    return root


def test_the_judge_gives_records_read_back_where_hq_cannot_be_imported_what_it_gives_them_here(
    hq, core_runner, editor_driver, tmp_path
):
    """The intent judge reads records and the document alone: in a process that refuses HQ, over records written
    to disk and read back, it finds what it finds here, for the document as stated and for one stating another
    case type for every module (so the comparison holds differences)."""
    from proof.checks.test_judge_purity import _cheapest_edited, _refusing

    document = _cheapest_edited()
    records = observations.records_for(document, core_runner, editor_driver=editor_driver)
    items = load_manifest().items
    roots = [document.root, _renamed(document, tmp_path / "renamed")]
    here = {
        str(root): sorted(
            json.dumps(d.as_json(), sort_keys=True)
            for d in intent.intent_differences(Document(document.id, "test", root), records, items)
        )
        for root in roots
    }
    ran = _refusing(JUDGMENT, str(records.save(tmp_path / "records")), *map(str, roots))
    assert ran.returncode == 0, ran.stderr
    assert json.loads(ran.stdout) == here
    assert here[str(roots[1])], "Renaming every module's case type gives the judge no difference to compare."


@pytest.mark.under_determinism
def test_the_observation_at_b_edit_is_bs_where_their_inputs_agree(hq, core_runner, monkeypatch, tmp_path):
    """The intent observation names no state: a B-edit observed with B's inputs records B's observation byte for
    byte (HQ's data dictionary and Core's parse of each form), so the unit may record it as B's."""
    _intent_hooks_alone(monkeypatch)
    document = cases.load_corpus().document("targeted-wire-equal-republish")
    name = "minimum"
    keys = unit.part_keys(
        unit.document_inputs(document), name, unit.case_databases(document), unit.hook_inputs(document)
    )
    assert keys["b_edit"] == keys["b"], f"{document.id}'s B-edit and B do not have the same inputs."
    own = unit.observe_document(document, core_runner=core_runner, configurations={name}, same_as=False)
    own.save(Path(os.environ.get("PROOF_OUT", tmp_path)) / "witnesses" / "wire-equal-intent")
    held = own.configurations[name]
    assert held.keys["b_edit"] == held.keys["b"] == keys["b"]
    assert "same_as" not in held.b_edit and {f"{name}/b", f"{name}/b_edit"} <= set(own.observed)
    observed = [held.part(part)["hooks"]["intent"] for part in ("b", "b_edit")]
    assert observed[0]["forms"], f"{document.id}'s B holds no form Core parsed, so the comparison is empty."
    for shape in observed[0]["forms"].values():
        assert isinstance(shape, str), f"{document.id}'s B holds a form Core refused: {shape}."
        nodes = own.blobs.get_json(shape)
        assert isinstance(nodes, list) and nodes, f"{document.id}'s B holds a form Core parsed as no nodes: {nodes}."
    assert "note" in observed[0]["dataDictionary"].get("patient", []), (
        f"{document.id}'s B holds no authored note in HQ's data dictionary, so that comparison is empty."
    )
    assert canonical(observed[0]) == canonical(observed[1])
