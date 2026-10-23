"""Apps HQ's own pages made meet what Connect does with a block renamed under an opportunity that holds its old id.

Contract (``proof.checks.hq_own_reports``, member ``connect_block_renamed``): what Connect does with a Connect
block whose id changed under an opportunity made before the change is what Connect does itself, whoever renamed
the block. Connect keys an opportunity's rows by each block's id (commcare-connect
``form_receiver/processor.py::get_or_create_learn_module``, ``get_or_create_deliver_unit``,
``process_task_modules``), so a renamed deliver unit is a new unit with no payment unit, whose delivery Connect
refuses (``process_deliver_unit``: "Payment unit is not configured for the deliver unit"); a renamed learn module is
a second learn module; and a renamed task completes no task assigned under its old id: in a form of its own, as
the deliver app here holds it, Connect takes the task form and completes nothing with it. HQ's Connect repeater
marks a forward Connect refused ``PayloadRejected`` and does not send it again (``motech/repeaters/models.py``).

The apps hold no Nova byte. HQ's own views make each (``default_new_app``, a survey menu by ``new_module``, and the
deliver app's second form, its task's, by ``new_form``), each form's source is the one HQ's form builder writes of
its Connect questions under ``COMMCARE_CONNECT`` (Vellum's ``commcareConnect.js``: a question of each block's id
holding the block, its children as Vellum writes them),
saved through HQ's form source save (``views/forms.py::edit_form_attr``) and opened and saved in HQ's form
builder, Vellum in HQ's page, with the Connect plugin HQ's form designer gives it
(``views/formdesigner.py::_get_vellum_plugins``). HQ releases the app as its Releases page does
(``proof.formplayer.hq.serve``), an opportunity is made from the release as a manager makes one
(``proof.observe.connect.open_opportunity``), each block's id is changed in the form builder in the same way, the
app is released again, and a worker's device walks each release, its forms taken by HQ's receiver and forwarded
by HQ's own Connect repeater (``proof.observe.connect.forwarded``, ``proof.android.observe.app``).

The plausible failures: an allowance that holds where Connect does not do this to HQ's own app (a refusal of
another cause, no second learn module), and one whose condition does not hold on the forms of the two releases a
person's own renaming leaves, so the register would still hold the reports.
"""

from __future__ import annotations

import io
import zipfile

import pytest

from proof.checks import casedata
from proof.checks import connect as judge
from proof.hq import operations
from proof.hq.check import hq_check
from proof.hq.configuration import Configuration
from proof.observe.outcome import BuildOutcome

# The Connect runtime fixture starts Connect; a device's walks send each state's forms.
pytestmark = pytest.mark.reader("android")

CONFIGURATION = Configuration(flags={"COMMCARE_CONNECT"}, privileges={"CLOUDCARE", "DATA_FORWARDING"})
CONNECT_XMLNS = "http://commcareconnect.com/data/v1/learn"
# A worker with no cases: both apps are surveys.
WORKER = casedata.CaseDatabase(user_id=casedata.USER_ID, username=casedata.USERNAME, user_data=(), cases=())
DELIVER = {"before": ("home_visit", "follow_up"), "after": ("household_visit", "return_visit")}
LEARN = {"before": ("hand_washing",), "after": ("washing_hands",)}
PAYMENT_UNIT_REFUSAL = "payment-unit-is-not-configured-for-the-deliver-unit"
# The artifact the judge names B-edit's Connect reports by, under the configuration the lane calls minimum.
B_EDIT = "connect@B-edit@minimum"
HEAD = (
    '<?xml version="1.0" encoding="UTF-8"?>'
    '<h:html xmlns:h="http://www.w3.org/1999/xhtml" xmlns:orx="http://openrosa.org/jr/xforms"'
    ' xmlns="http://www.w3.org/2002/xforms" xmlns:xsd="http://www.w3.org/2001/XMLSchema"'
    ' xmlns:jr="http://openrosa.org/javarosa" xmlns:vellum="http://commcarehq.org/xforms/vellum">'
)


def _deliver_source(xmlns, deliver, _task):
    """A deliver form as HQ's form builder writes it: the household asked, and a Deliver Unit whose entity is the
    household."""
    return (
        f"{HEAD}<h:head><h:title>Home visit</h:title><model><instance>"
        f'<data xmlns:jrm="http://dev.commcarehq.org/jr/xforms" xmlns="{xmlns}" uiVersion="1" version="1"'
        ' name="Home visit"><household/>'
        f'<{deliver} vellum:role="ConnectDeliverUnit"><deliver xmlns="{CONNECT_XMLNS}" id="{deliver}">'
        f"<name>Home visit</name><entity_id/><entity_name/><work_area_id/></deliver></{deliver}></data></instance>"
        '<bind vellum:nodeset="#form/household" nodeset="/data/household" type="xsd:string"/>'
        f'<bind vellum:nodeset="#form/{deliver}" nodeset="/data/{deliver}"/>'
        f'<bind nodeset="/data/{deliver}/deliver/entity_id" calculate="/data/household"/>'
        f'<bind nodeset="/data/{deliver}/deliver/entity_name" calculate="/data/household"/>'
        '<itext><translation lang="en" default=""><text id="household-label"><value>Household</value></text>'
        "</translation></itext></model></h:head><h:body>"
        '<input vellum:ref="#form/household" ref="/data/household">'
        "<label ref=\"jr:itext('household-label')\"/></input></h:body></h:html>"
    )


def _task_source(xmlns, _deliver, task):
    """A task's form as HQ's form builder writes it: a label, and a Task. Connect checks a delivery before it
    completes a task, so the task is in a form of its own (finding 61)."""
    return (
        f"{HEAD}<h:head><h:title>Follow up</h:title><model><instance>"
        f'<data xmlns:jrm="http://dev.commcarehq.org/jr/xforms" xmlns="{xmlns}" uiVersion="1" version="1"'
        ' name="Follow up"><note/>'
        f'<{task} vellum:role="ConnectTask"><task xmlns="{CONNECT_XMLNS}" id="{task}"><name>Follow up</name>'
        f"<description>Return within a week.</description></task></{task}></data></instance>"
        '<bind vellum:nodeset="#form/note" nodeset="/data/note"/>'
        f'<bind vellum:nodeset="#form/{task}" nodeset="/data/{task}"/>'
        '<itext><translation lang="en" default=""><text id="note-label"><value>Return within a week.</value>'
        "</text></translation></itext></model></h:head><h:body>"
        '<trigger vellum:ref="#form/note" ref="/data/note" appearance="minimal">'
        "<label ref=\"jr:itext('note-label')\"/></trigger></h:body></h:html>"
    )


def _learn_source(xmlns, module):
    """A learn form as HQ's form builder writes it: a score asked, and a Learn Module."""
    return (
        f"{HEAD}<h:head><h:title>Hand washing</h:title><model><instance>"
        f'<data xmlns:jrm="http://dev.commcarehq.org/jr/xforms" xmlns="{xmlns}" uiVersion="1" version="1"'
        ' name="Hand washing"><score/>'
        f'<{module} vellum:role="ConnectLearnModule"><module xmlns="{CONNECT_XMLNS}" id="{module}">'
        "<name>Hand washing</name><description>Wash for twenty seconds.</description>"
        f"<time_estimate>5</time_estimate></module></{module}></data></instance>"
        '<bind vellum:nodeset="#form/score" nodeset="/data/score" type="xsd:int"/>'
        f'<bind vellum:nodeset="#form/{module}" nodeset="/data/{module}"/>'
        '<itext><translation lang="en" default=""><text id="score-label"><value>Score</value></text>'
        "</translation></itext></model></h:head><h:body>"
        '<input vellum:ref="#form/score" ref="/data/score">'
        "<label ref=\"jr:itext('score-label')\"/></input></h:body></h:html>"
    )


def _hq(state, name, *args, data=None):
    """HQ's view ``name`` answering the request its page sends: a GET, or a POST of ``data`` (name, value) pairs."""
    from django.urls import resolve, reverse

    from proof.hq import requests as hq_requests

    path = reverse(name, args=[state.domain, *args])
    request = hq_requests.get(state, path) if data is None else hq_requests.form_post(state, path, data)
    match = resolve(path)
    response = match.func(request, *match.args, **match.kwargs)
    assert response.status_code < 400, (name, response.status_code, response.content[:600])
    return response


def _survey(state, forms):
    """A new app with one survey menu of ``forms`` forms, as HQ's own pages make them; returns (app id, its forms'
    unique ids)."""
    from corehq.apps.app_manager.dbaccessors import get_app_ids_in_domain

    _hq(state, "default_new_app")
    (app_id,) = get_app_ids_in_domain(state.domain)
    _hq(state, "new_module", app_id, data=[("name", "Connect"), ("module_type", "survey")])
    module = operations.held_app(state, app_id).modules[0]
    for _ in range(forms - 1):
        _hq(state, "new_form", app_id, module.unique_id, data=[("form_type", "form"), ("case_action", "none")])
    held = operations.held_app(state, app_id).modules[0].forms
    assert len(held) == forms, [form.unique_id for form in held]
    return app_id, [form.unique_id for form in held]


def _built(state, editor_driver, app_id, form_id, source):
    """The form's Connect questions written by HQ's form builder: its source saved through HQ's form source save,
    then the form opened and saved in Vellum."""
    from proof.editors import vellum

    xmlns = operations.held_app(state, app_id).get_form(form_id).xmlns
    _hq(state, "edit_form_attr", app_id, form_id, "xform", data=[("xform", source(xmlns))])
    run = vellum.open_and_save(editor_driver, state, app_id, form_id)
    assert run.loaded and run.saved, (run.load_error, run.save_refusal, run.form_errors)


def _files(archive: bytes) -> BuildOutcome:
    """A release's files as a build's outcome holds them, for the judge's reading of its forms."""
    with zipfile.ZipFile(io.BytesIO(archive)) as held:
        files = {name: held.read(name) for name in held.namelist()}
    return BuildOutcome("release", 0, [], {}, files)


def _renamed(editor_driver, runtime, blobs, sources, ids):
    """One HQ-made app released (``sources``: each form's, in order), an opportunity made from the release, every
    block renamed in the form builder and the app released again, each release walked by a worker's device: what
    the judge reads of the two."""
    from proof.android import observe as android
    from proof.formplayer import hq as formplayer_hq
    from proof.observe import connect

    def build(side):
        for form_id, source in zip(form_ids, sources, strict=True):
            _built(state, editor_driver, app_id, form_id, lambda xmlns, source=source: source(xmlns, *ids[side]))

    with hq_check(CONFIGURATION) as (state, _):
        app_id, form_ids = _survey(state, len(sources))
        build("before")
        with formplayer_hq.serve(state, None, app_id, database=WORKER, label="A") as served:
            first = android.release_archive(served)
            opportunity = connect.open_opportunity(served, runtime=runtime)
            try:
                with connect.forwarded(served, opportunity, "A") as forwarder:
                    android.app(served, blobs, label="A", archive=first)
                    a = blobs.get_json(forwarder.take(blobs))
            except BaseException:
                opportunity.close()
                raise
        try:
            build("after")
            with formplayer_hq.serve(state, None, app_id, database=WORKER, label="B-edit") as served:
                second = android.release_archive(served)
                with connect.forwarded(served, opportunity, "B-edit") as forwarder:
                    android.app(served, blobs, label="B-edit", archive=second)
                    b_edit = blobs.get_json(forwarder.take(blobs))
            catalog = opportunity.catalog
        finally:
            opportunity.close()
    return {"A": a, "B-edit": b_edit, "catalog": catalog, "first": _files(first), "second": _files(second)}


@pytest.fixture(scope="module")
def renamed(hq, connect_runtime, editor_driver, lane_services):
    """A deliver app and a learn app HQ's own pages made, each renamed under its opportunity."""
    from proof.observe.record import Blobs

    blobs = Blobs()
    return {
        "deliver": _renamed(editor_driver, connect_runtime, blobs, (_deliver_source, _task_source), DELIVER),
        "learn": _renamed(editor_driver, connect_runtime, blobs, (_learn_source,), LEARN),
    }


def _reported(app, *, own):
    """What the Connect judge reports of B-edit beyond A (``proof.checks.proof4.connect_beyond_a``), with the two
    releases' forms where ``own``."""
    forms = (B_EDIT, judge.connect_forms(app["first"]), judge.connect_forms(app["second"])) if own else None
    found = judge.absolute_differences(
        app["B-edit"],
        app["catalog"],
        check="proof4",
        document="-",
        artifact="connect",
        beyond=app["A"],
        moved=True,
        forms=forms,
    )
    return [difference.path for difference in found]


def _runs(record):
    """The runs of a device's walks that reached HQ's receiver, by name: one for each form (``m0/m0-f<n>``)."""
    return {run["run"]: run for run in record["runs"]["android"]}


def test_connect_block_renamed(renamed):
    """The renaming HQ's own form builder made is the member's: the judge reports what Connect did of each app's
    renamed blocks, and leaves every report out once it reads the two releases' forms."""
    deliver, learn = renamed["deliver"], renamed["learn"]
    assert judge.renamed_blocks(judge.connect_forms(deliver["first"]), judge.connect_forms(deliver["second"])) == {
        ("deliver", "home_visit", "household_visit"),
        ("task", "follow_up", "return_visit"),
    }
    assert sorted(_reported(deliver, own=False)) == [
        "/ids/deliver/moved",
        "/ids/task/moved",
        f"/runs/*/refused/400/{PAYMENT_UNIT_REFUSAL}",
        "/runs/*/task-completed-nothing",
    ]
    assert _reported(learn, own=False) == ["/runs/*/catalog/learnModules/added", "/ids/module/moved"]
    assert _reported(deliver, own=True) == []
    assert _reported(learn, own=True) == []


def test_connect_takes_each_apps_first_release(renamed):
    """The control: before the rename, Connect takes the deliver form, the task's form and the learn form a device
    sent, and the task's form completes the task the worker was assigned."""
    deliver, learn = _runs(renamed["deliver"]["A"]), _runs(renamed["learn"]["A"])
    assert sorted(deliver) == ["m0/m0-f0", "m0/m0-f1"] and sorted(learn) == ["m0/m0-f0"]
    for name, run in [*deliver.items(), *learn.items()]:
        assert [post["status"] for post in run["posts"]] == [200], (name, run["posts"])
    completed = [
        task["slug"] for task in deliver["m0/m0-f1"]["state"]["assignedTasks"] if task["status"] == "completed"
    ]
    assert completed == ["follow_up"], completed


def test_connect_refuses_the_renamed_deliver_unit_and_hq_gives_the_forward_up(renamed):
    """Connect refuses the delivery of the renamed deliver unit for its missing payment unit; HQ marks the forward
    rejected and sends it once."""
    run = _runs(renamed["deliver"]["B-edit"])["m0/m0-f0"]
    (post,) = run["posts"]
    assert (post["status"], judge.refusal_cause(post)) == (400, PAYMENT_UNIT_REFUSAL), post
    (forward,) = run["forwards"]
    assert forward["state"] == "PayloadRejected" and len(forward["attempts"]) == 1, forward


def test_connect_takes_the_renamed_tasks_form_and_completes_nothing_with_it(renamed):
    """The renamed task's form, in a form of its own, reaches Connect, which takes it, makes no visit and completes
    no task the worker was assigned under the old id."""
    run = _runs(renamed["deliver"]["B-edit"])["m0/m0-f1"]
    (post,) = run["posts"]
    assert post["status"] == 200, post
    assert "return_visit" in post["payload"]["form"]
    assert run["state"]["visits"] == []
    completed = [task for task in run["state"].get("assignedTasks") or [] if task.get("status") == "completed"]
    assert completed == [], completed


def test_connect_makes_a_second_learn_module_of_the_renamed_one(renamed):
    """Connect takes the learn form under its renamed module, and holds a learn module of each id."""
    run = _runs(renamed["learn"]["B-edit"])["m0/m0-f0"]
    assert [post["status"] for post in run["posts"]] == [200], run["posts"]
    assert sorted(module["slug"] for module in run["state"]["learnModules"]) == ["hand_washing", "washing_hands"]
