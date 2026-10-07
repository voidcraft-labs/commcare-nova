"""The Connect judge reports a planted difference and only it, and nothing where Connect did the same.

Contract (``proof.checks.connect``): two states' records of what CommCare
Connect made of their submissions are compared as Connect's answers, tasks
and rows, run by run; a payload is never compared; one symptom is one
difference; and what stands on its own of a state (a payload Connect did not
take, a visit rejected for the task its own form completes, a unit Connect
made of its own, a task that completed nothing, an id that moved under the
opportunity) is reported by its own path.

The plausible failures: a difference in a row lost, or reported with the
rows that follow from a refusal; two spellings of a payload reported though
Connect read them alike; an id a run drew, or a build's version, read as a
difference; a run one side never made compared with nothing; a form that
holds no Connect block reported as refused; an added unit read as a moved
one. Each test plants one such change in a record shaped as the observation
writes it (``proof.observe.connect``) and holds the judge to exactly it,
beside the unchanged record it accepts.
"""

from __future__ import annotations

import copy

from proof.checks import connect

XMLNS = connect.CONNECT_XMLNS
CATALOG = {
    "learnModules": [],
    "deliverUnits": [{"slug": "home_visit", "name": "Home visit", "paymentUnit": "Visits"}],
    "taskTypes": [{"slug": "follow_up", "name": "Follow up", "description": ""}],
}


def _payload(*, deliver="home_visit", task=None, **more):
    form = {deliver: {"deliver": {"@id": deliver, "@xmlns": XMLNS, "entity_id": "e-1", "name": "Home visit"}}}
    if task is not None:
        form[task] = {"task": {"@id": task, "@xmlns": XMLNS, "name": "Follow up"}}
    return {"app_id": "@app", "build_id": "@build", "id": "@generated:uuid:3", "form": form, **more}


def _run(name="core-0", *, payload=None, status=200, body=None, raised=(), visit=None, tasks=(), assigned=()):
    visits = [
        {
            "xform": "@generated:uuid:3",
            "appBuildId": "@build",
            "appBuildVersion": 3,
            "deliverUnit": "home_visit",
            "status": "approved",
            "flags": None,
            "location": "12.9 77.5 920.0 5.0",
            **(visit or {}),
        }
    ]
    return {
        "run": name,
        "received": [{"status": 201}],
        "forwards": [{"form": "@generated:uuid:3", "state": "Success", "attempts": []}],
        "posts": [
            {"payload": payload or _payload(), "status": status, "body": body, "raised": list(raised)},
        ],
        "tasks": list(tasks),
        "state": {
            **copy.deepcopy(CATALOG),
            "access": {"paymentAccrued": 10 if status == 200 else 0},
            "visits": visits if status == 200 else [],
            "assignedTasks": list(assigned),
        },
    }


def _record(**readers):
    return {"runs": {reader.replace("_app", "@app"): runs for reader, runs in readers.items()}}


def _differences(before, after, **more):
    found = connect.differences(before, after, check="proof3", document="d", artifact="connect@x", **more)
    return sorted((d.path, d.kind, d.before, d.after) for d in found)


def _own(record, **more):
    found = connect.absolute_differences(record, CATALOG, check="proof3", document="d", artifact="connect@x", **more)
    return sorted((d.path, d.at) for d in found)


# Two states compared ---------------------------------------------------------------------------------------------


def test_the_same_rows_are_no_difference_whatever_names_the_submission_or_the_build():
    """An id a run drew is numbered by its place in its own record, and each build has its own version: neither
    is what a worker did."""
    before = _record(core=[_run()])
    other = _run(visit={"xform": "@generated:uuid:9", "appBuildVersion": 5})
    other["posts"][0]["payload"]["id"] = "@generated:uuid:9"
    assert _differences(before, _record(core=[other])) == []


def test_a_planted_row_difference_is_reported_and_only_it():
    before = _record(core=[_run(), _run("core-1")], formplayer=[_run("walk-0")])
    planted = _record(
        core=[_run(), _run("core-1", visit={"flags": [["gps", "GPS data is missing"]], "location": None})],
        formplayer=[_run("walk-0")],
    )
    assert _differences(before, planted) == [
        ("/runs/*/state/visits/*/flags", "changed", None, {"gps": "GPS data is missing"}),
        ("/runs/*/state/visits/*/location", "changed", "12.9 77.5 920.0 5.0", None),
    ]
    flagged = _record(core=[_run(visit={"flags": [["pending_task", "t"]]})])
    more = _record(core=[_run(visit={"flags": [["gps", "GPS data is missing"], ["pending_task", "t"]]})])
    assert _differences(flagged, more) == [("/runs/*/state/visits/*/flags/gps", "added", None, "GPS data is missing")]


def test_a_payload_connect_reads_alike_is_no_difference():
    """Two payloads that differ and that Connect answered and made the same rows of are two spellings to it."""
    spelled = _payload()
    spelled["form"]["home_visit"]["deliver"]["work_area_id"] = ""
    assert _differences(_record(core=[_run()]), _record(core=[_run(payload=spelled)])) == []


def test_a_refusal_is_one_difference_and_what_follows_from_it_is_not_reported_again():
    refused = _run(status=400, body={"app_id": ["This field may not be null."]}, payload=_payload(app_id=None))
    assert _differences(_record(core=[_run()]), _record(core=[refused])) == [
        ("/runs/*/posts/*/answer", "changed", "200", "400: app-id-this-field-may-not-be-null")
    ]


def test_a_run_only_one_side_made_or_hq_answered_otherwise_is_not_compared():
    """Formplayer's refusal of a submit and HQ's of a submission are the walks' and the case processing's to
    report: a run missing from one side, or one HQ's receiver answered differently, is left to them."""
    before = _record(formplayer=[_run("walk-0"), _run("walk-1")])
    assert _differences(before, _record(formplayer=[_run("walk-0")])) == []
    refused_by_hq = _run("walk-1", visit={"status": "rejected"})
    refused_by_hq["received"] = [{"status": 422}]
    assert _differences(before, _record(formplayer=[_run("walk-0"), refused_by_hq])) == []
    # The control: the same row difference in a run both sides made, HQ answering alike, is reported.
    assert _differences(before, _record(formplayer=[_run("walk-0"), _run("walk-1", visit={"status": "rejected"})]))


def test_a_reader_is_compared_with_the_reader_it_is_paired_with():
    """The local archive's submissions posted under the app's id (``core@app``) are held to A's from Core."""
    before = _record(core=[_run()])
    after = _record(core=[_run()], core_app=[_run(visit={"location": None})])
    found = _differences(before, after, readers={"core": "core", "core@app": "core"})
    assert found == [("/runs/*/state/visits/*/location", "changed", "12.9 77.5 920.0 5.0", None)]
    (difference,) = connect.differences(
        before, after, check="proof3", document="d", artifact="a", readers={"core": "core", "core@app": "core"}
    )
    assert difference.at == "/runs/core@app:core-0/state/visits/0/location"


def test_a_task_connect_ran_otherwise_is_a_difference():
    ran = {"task": "commcare_connect.opportunity.tasks.download_user_visit_attachments", "state": "SUCCESS"}
    failed = {**ran, "state": "FAILURE", "error": "ReadTimeout: slow"}
    assert _differences(_record(core=[_run(tasks=[ran])]), _record(core=[_run(tasks=[failed])])) == [
        ("/runs/*/tasks/*/error", "changed", None, "ReadTimeout: slow"),
        ("/runs/*/tasks/*/state", "changed", "SUCCESS", "FAILURE"),
    ]


# What stands on its own -------------------------------------------------------------------------------------------


def test_a_state_connect_took_whole_holds_nothing_of_its_own():
    assert _own(_record(core=[_run()], formplayer=[_run("walk-0")])) == []


def test_a_payload_connect_did_not_take_is_named_by_why():
    crashed = _run(status=500, raised=[{"class": "KeyError", "message": "'@xmlns'"}])
    unpaid = _run(
        "core-1", status=400, body={"detail": "Payment unit is not configured for the deliver unit: Home visit in x"}
    )
    unnamed = _run("core-2", status=400, body={"app_id": ["This field may not be null."]})
    assert _own(_record(core=[crashed, unpaid, unnamed])) == [
        (
            "/runs/*/refused/400/app-id-this-field-may-not-be-null",
            "/runs/core:core-2/refused/400/app-id-this-field-may-not-be-null",
        ),
        (
            "/runs/*/refused/400/payment-unit-is-not-configured-for-the-deliver-unit",
            "/runs/core:core-1/refused/400/payment-unit-is-not-configured-for-the-deliver-unit",
        ),
        ("/runs/*/refused/500/KeyError", "/runs/core:core-0/refused/500/KeyError"),
    ]


def test_a_form_with_no_connect_block_that_connect_answers_400_is_no_refusal():
    """HQ's repeater forwards every form of the project space, and Connect answers one that holds nothing of its
    own with 400; the same answer to a payload that holds a block is a refusal."""
    plain = _run(status=400, body={"form": ["This field is required."]}, payload={"app_id": "@app", "id": "x"})
    assert _own(_record(core=[plain])) == []
    held = _run(status=400, body={"form": ["This field is required."]})
    assert [path for path, _ in _own(_record(core=[held]))] == ["/runs/*/refused/400/form-this-field-is-required"]


def test_a_visit_rejected_for_the_task_its_own_form_completes_stands_on_its_own():
    done = [{"slug": "follow_up", "status": "completed", "xform": "@generated:uuid:3"}]
    rejected = {"status": "rejected", "flags": [["pending_task", "Worker has an incomplete assigned task."]]}
    both = _run(payload=_payload(task="follow_up"), visit=rejected, assigned=done)
    assert [path for path, _ in _own(_record(core=[both]))] == [
        "/runs/*/visit-rejected-for-the-task-its-form-completes"
    ]
    # A visit rejected for a task another form completes is Connect's rule, and no finding.
    other = [{"slug": "follow_up", "status": "assigned", "xform": None}]
    assert _own(_record(core=[_run(visit=rejected, assigned=other)])) == []


def test_a_task_that_completed_nothing_and_a_unit_connect_made_of_its_own_stand_on_their_own():
    assigned = [{"slug": "follow_up", "status": "assigned", "xform": None}]
    renamed = _run(payload=_payload(task="return_visit"), assigned=assigned)
    assert [path for path, _ in _own(_record(core=[renamed]))] == ["/runs/*/task-completed-nothing"]
    grown = _run()
    grown["state"]["learnModules"] = [{"slug": "washing_hands", "name": "W"}]
    assert [path for path, _ in _own(_record(core=[grown]))] == ["/runs/*/catalog/learnModules/added"]


def test_an_id_that_moved_is_one_the_opportunity_holds_gone_and_another_in_its_place():
    def moved(record):
        return connect.moved_ids(record, CATALOG)

    assert moved(_record(core=[_run(payload=_payload(task="follow_up"))])) == []
    renamed = _record(core=[_run(payload=_payload(deliver="household_visit", task="follow_up"))])
    assert moved(renamed) == [("/ids/deliver/moved", "/ids/deliver/moved", ["home_visit"], ["household_visit"])]
    # A unit an edit adds beside the ones the opportunity holds moved nothing.
    added = _run(payload=_payload(task="follow_up"))
    added["posts"][0]["payload"]["form"]["second"] = {"deliver": {"@id": "second", "@xmlns": XMLNS}}
    assert moved(_record(core=[added])) == []


def test_what_another_state_already_shows_is_not_reported_again_beyond_it():
    crashed = _record(core=[_run(status=500, raised=[{"class": "KeyError", "message": "'@xmlns'"}])])
    unpaid = _run(status=400, body={"detail": "Payment unit is not configured for the deliver unit: Home visit"})
    edited = _record(core=[copy.deepcopy(crashed["runs"]["core"][0]), {**unpaid, "run": "core-1"}])
    assert [path for path, _ in _own(edited, beyond=crashed)] == [
        "/runs/*/refused/400/payment-unit-is-not-configured-for-the-deliver-unit"
    ]
    assert len(_own(edited)) == 2
