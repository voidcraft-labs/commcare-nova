"""The reports HQ, CommCare or Connect make themselves leave a check only where a member of the closed set names
them and its condition holds.

Contract (``proof.checks.hq_own_reports``): ``HQ_OWN_REPORTS`` holds exactly
its three members, each with a proof test of its name in the module it
names, and every module the lane names a proof of HQ's own reports is a
member's; a check leaves out a report only where a member names its artifact
and path and the member's condition holds on what the check holds of the
state. The plausible failures: a member left out of the set while its proof
stays, or listed with no proof; a condition wider than the fact it rests on,
which drops a report Nova's export makes (a registration form that truly
lacks a name, a session that ends at another datum, a Connect refusal of
another cause or an id that moved with no block renamed); and a condition
narrower than the report, which leaves the report HQ's own app shows in the
register. Each test builds the record a check reads, as the observation
writes it, and holds the check to the report it makes.
"""

from __future__ import annotations

from pathlib import Path

from proof.checks import android, connect, hq_own_reports, proof4
from proof.checks.hq_own_reports import HQ_OWN_REPORTS, HqOwnReport, held, unproven
from proof.observe.outcome import BuildOutcome

MEMBERS = ("registration_alert_child_case", "android_grouped_tile_reopen", "connect_block_renamed")


# The set -----------------------------------------------------------------------------------------------------------


def test_the_set_holds_exactly_its_members_each_with_a_proof_test_of_its_name():
    assert tuple(member.id for member in HQ_OWN_REPORTS) == MEMBERS
    assert unproven() == []


def _stray(proof):
    return HqOwnReport(
        id="stray",
        artifacts=("editor:vellum",),
        paths=("/modules/*/forms/*/pre_save_alerts/stray",),
        applies=lambda *_: True,
        proof=proof,
        description="A member no proof shows.",
    )


def test_a_member_with_no_proof_and_a_proof_with_no_member_fail(tmp_path: Path):
    problems = unproven((*HQ_OWN_REPORTS, _stray("proof/editors/test_hq_own_stray.py")))
    assert problems == [
        "The member stray names proof/editors/test_hq_own_stray.py as its proof, and there is no such file. Its"
        " proof runs HQ's own editors, with no Nova export, to the report the member leaves out."
    ]
    proof = tmp_path / "proof" / "editors" / "test_hq_own_stray.py"
    proof.parent.mkdir(parents=True)
    proof.write_text("def test_something_else():\n    pass\n")
    assert unproven((_stray("proof/editors/test_hq_own_stray.py"),), worktree=tmp_path) == [
        "The member stray names proof/editors/test_hq_own_stray.py as its proof, which holds no test_stray. Name"
        " the test that shows the report on an app HQ's own editors made after the member."
    ]
    assert unproven((), worktree=tmp_path) == [
        "proof/editors/test_hq_own_stray.py proves a report HQ makes itself, and no member of HQ_OWN_REPORTS"
        " names it. List the member in proof/checks/hq_own_reports.py or remove the module."
    ]


def test_a_member_outside_the_set_leaves_out_nothing():
    stray = _stray("proof/editors/test_hq_own_stray.py")
    assert held("editor:vellum", stray.paths[0]) is None
    assert held("editor:vellum", stray.paths[0], members=(stray,)) is stray


# Finding 50: the registration alert on a follow-up form -----------------------------------------------------------

ALERT = (
    "This registration form is missing a case name. Assign the <code>name</code> property to a question.<div>\n"
    '  <button type="button" class="btn btn-default btn-xs fd-auto-assign-case-name">\n'
    "      Auto-assign case name\n  </button>\n</div>\n"
)
SOURCE = (
    '<h:html xmlns:h="http://www.w3.org/1999/xhtml" xmlns="http://www.w3.org/2002/xforms"><h:head><model><instance>'
    '<data xmlns="http://openrosa.org/formdesigner/proof"><default_label/></data></instance></model></h:head>'
    "<h:body/></h:html>"
)


def _subcase(repeat_context=""):
    return {"doc_type": "OpenSubCaseAction", "case_type": "child", "repeat_context": repeat_context}


def _form(*subcases, requires="case", opens=None):
    """A form as HQ's app document stores it: a follow-up (``requires`` a case) with its subcases, and its own
    case's open action under ``opens`` (a condition type)."""
    return {
        "doc_type": "Form",
        "requires": requires,
        "actions": {
            "open_case": {"condition": {"type": opens or "never"}},
            "subcases": list(subcases),
        },
    }


def _vellum(alerts, form, editor="vellum"):
    report = {
        "kind": "vellum",
        "source": SOURCE,
        "outputs": {
            "record": {
                "loaded": True,
                "formErrors": [],
                "questions": [],
                "serializationWarnings": [],
                "preSaveAlerts": list(alerts),
            },
            "save": {"saved": True},
            "after": {"saveButton": "saved", "modals": []},
            "pageErrors": [],
        },
        "saves": [],
    }
    found = proof4.vellum_report(report, document="-", editor=editor, scope=proof4.Scope(0, 1), form=form)
    return [difference.path for difference in found]


def test_the_alert_vellum_keys_is_the_one_the_member_names():
    assert _vellum([ALERT], None) == [hq_own_reports.REGISTRATION_ALERT]


def test_the_alert_on_a_follow_up_that_opens_one_child_case_outside_a_repeat_is_hqs_own():
    form = _form(_subcase())
    assert hq_own_reports.registers_one_child_case(form)
    assert _vellum([ALERT], form) == []
    assert _vellum([ALERT], form, editor="vellum again") == []


def test_the_alert_stays_where_hq_counts_the_form_otherwise():
    # A registration form that opens its own case and maps no name: the alert is the form's, and Nova's to mend.
    registration = _form(requires="none", opens="always")
    # A survey that opens its own case on a condition and one child case: two registrations, so no alert is HQ's.
    survey = _form(_subcase(), requires="none", opens="if")
    # Two child cases outside a repeat, or the one child case inside a repeat.
    two = _form(_subcase(), _subcase())
    repeated = _form(_subcase("/data/children"))
    for form in (registration, survey, two, repeated, None):
        assert not hq_own_reports.registers_one_child_case(form)
        assert _vellum([ALERT], form) == [hq_own_reports.REGISTRATION_ALERT]


def test_another_alert_on_the_same_form_is_still_reported():
    form = _form(_subcase())
    other = "This form has an output in a validation message."
    assert _vellum([other, ALERT], form) == [f"/modules/*/forms/*/pre_save_alerts/{other}"]


# Finding 67: grouped tiles and a reopened incomplete form ------------------------------------------------------------

GROUPED = "COMMAND_ID m0-f0 CASE_ID case_id visit-2 CASE_ID case_id_parent_ids"
OUT_OF_BOUNDS = {"class": "java.lang.ArrayIndexOutOfBoundsException", "message": "Index 7 out of bounds for length 7"}


def _update(descriptor, raised):
    saved = {
        "walk": {"steps": [{"screen": "FormEntryActivity", "loaded": True}]},
        "records": [{"status": "incomplete", "AndroidCommCarePlatform.getFormDefId": "held"}],
    }
    reopened = {
        "records": [{"status": "incomplete", "AndroidCommCarePlatform.getFormDefId": "held"}],
        "SessionStateDescriptor.getSessionDescriptor": descriptor,
        "homeRaised": {**raised, "stack": "..."},
    }
    return {"install": "Installed", "incompleteForms": {"m0-f0": saved}, "reopened": {"m0-f0": reopened}}


def _reopen_paths(descriptor, raised, artifact="android@B"):
    return [path for path, *_ in android.not_reopened(_update(descriptor, raised), artifact)]


def test_a_session_that_ends_at_empty_parent_ids_and_raises_out_of_bounds_is_commcares_own():
    assert _reopen_paths(GROUPED, OUT_OF_BOUNDS) == []
    assert _reopen_paths(GROUPED, OUT_OF_BOUNDS, artifact="android@local.ccz") == []
    computed = "COMMAND_ID m0-f0 CASE_ID case_id visit-2 COMPUTED_DATUM case_id_parent_ids"
    assert _reopen_paths(computed, OUT_OF_BOUNDS) == []
    # HQ names the datum after the case datum it reads the parents of (suite_xml/sections/entries.py::
    # EntriesHelper.get_extra_case_id_datums), so a multiple selection's ends at ``selected_cases_parent_ids``.
    selected = "COMMAND_ID m0-f0 SELECTED_ENTITIES COMPUTED_DATUM selected_cases_parent_ids"
    assert _reopen_paths(selected, OUT_OF_BOUNDS) == []


def test_a_session_that_ends_otherwise_or_raises_another_error_is_still_reported():
    session = [hq_own_reports.REOPENED_SESSION]
    # The parent ids carry a value, so the line ends elsewhere.
    assert _reopen_paths(f"{GROUPED} parent-1", OUT_OF_BOUNDS) == session
    # The line ends at another datum's id, or at one that is the suffix alone and so no case datum's.
    assert _reopen_paths("COMMAND_ID m0-f0 CASE_ID case_id", OUT_OF_BOUNDS) == session
    assert _reopen_paths("COMMAND_ID m0-f0 CASE_ID case_id_parents", OUT_OF_BOUNDS) == session
    assert _reopen_paths("COMMAND_ID m0-f0 CASE_ID _parent_ids", OUT_OF_BOUNDS) == session
    # The empty parent ids sit before another step.
    assert _reopen_paths(f"{GROUPED} COMMAND_ID m0-f1", OUT_OF_BOUNDS) == session
    # Home raised something else.
    assert _reopen_paths(GROUPED, {"class": "java.lang.NullPointerException", "message": "null"}) == session
    assert _reopen_paths(GROUPED, OUT_OF_BOUNDS, artifact="formplayer@B") == session


# Defect 15's Connect forwarding: what Connect does with a renamed block --------------------------------------------

CONNECT_XMLNS = "http://commcareconnect.com/data/v1/learn"


def _xform(*blocks):
    """A built form whose data holds each Connect block (kind, id) in a question of its own named by the id."""
    data = "".join(
        f'<{block_id}><{kind} xmlns="{CONNECT_XMLNS}" id="{block_id}"><name>{block_id}</name></{kind}></{block_id}>'
        for kind, block_id in blocks
    )
    return (
        '<h:html xmlns:h="http://www.w3.org/1999/xhtml" xmlns="http://www.w3.org/2002/xforms"><h:head><model>'
        f'<instance><data xmlns="http://openrosa.org/formdesigner/proof"><household/>{data}</data></instance>'
        "</model></h:head><h:body/></h:html>"
    )


def _forms(*blocks):
    return hq_own_reports.connect_forms(
        BuildOutcome("A", 1, [], {}, {"modules-0/forms-0.xml": _xform(*blocks).encode(), "suite.xml": b"<suite/>"})
    )


def _payload(*blocks):
    form = {block_id: {kind: {"@xmlns": CONNECT_XMLNS, "@id": block_id}} for kind, block_id in blocks}
    return {"id": "form-1", "form": form}


def _run(post, state=None):
    return {"run": "walk-0", "posts": [post], "state": state or {}}


DELIVER_A = (("deliver", "home_visit"), ("task", "follow_up"))
DELIVER_B = (("deliver", "household_visit"), ("task", "return_visit"))
DELIVER_CATALOG = {"learnModules": [], "deliverUnits": [{"slug": "home_visit"}], "taskTypes": [{"slug": "follow_up"}]}
REFUSED = {
    "status": 400,
    "body": {"detail": "Payment unit is not configured for the deliver unit: household_visit"},
    "raised": [],
}
LEARN_A = (("module", "hand_washing"),)
LEARN_B = (("module", "washing_hands"),)
LEARN_CATALOG = {"learnModules": [{"slug": "hand_washing"}], "deliverUnits": [], "taskTypes": []}
DELIVER_REPORTS = [
    "/runs/*/refused/400/payment-unit-is-not-configured-for-the-deliver-unit",
    "/ids/deliver/moved",
    "/ids/task/moved",
]
LEARN_REPORTS = ["/runs/*/catalog/learnModules/added", "/ids/module/moved"]


def _beyond(record, catalog, a, b, artifact="connect@B-edit@minimum"):
    found = connect.absolute_differences(
        record,
        catalog,
        check="proof4",
        document="-",
        artifact="connect",
        beyond={},
        moved=True,
        forms=(artifact, _forms(*a), _forms(*b)),
    )
    return [difference.path for difference in found]


def _deliver(post=REFUSED, blocks=DELIVER_B):
    return {"runs": {"android": [_run({**post, "payload": _payload(*blocks)})]}}


def _learn(blocks=LEARN_B):
    taken = {"status": 200, "body": {}, "raised": [], "payload": _payload(*blocks)}
    return {"runs": {"android": [_run(taken, {"learnModules": [{"slug": slug} for _, slug in blocks]})]}}


def test_the_five_reports_of_a_block_renamed_in_the_edit_are_connects_own():
    assert hq_own_reports.renamed_blocks(_forms(*DELIVER_A), _forms(*DELIVER_B)) == {
        ("deliver", "home_visit", "household_visit"),
        ("task", "follow_up", "return_visit"),
    }
    assert _beyond(_deliver(), DELIVER_CATALOG, DELIVER_A, DELIVER_B) == []
    assert _beyond(_learn(), LEARN_CATALOG, LEARN_A, LEARN_B) == []


def test_the_reports_stand_where_the_edit_renames_no_block():
    # The edit left the forms as they were, so the ids the payloads name moved with no block renamed.
    assert _beyond(_deliver(), DELIVER_CATALOG, DELIVER_B, DELIVER_B) == DELIVER_REPORTS
    assert _beyond(_learn(), LEARN_CATALOG, LEARN_B, LEARN_B) == LEARN_REPORTS
    # Another state than B-edit is no edit's.
    assert _beyond(_deliver(), DELIVER_CATALOG, DELIVER_A, DELIVER_B, artifact="connect@B@minimum") == DELIVER_REPORTS


def test_a_block_added_beside_the_old_one_is_no_rename():
    beside = (*DELIVER_A, *DELIVER_B)
    assert hq_own_reports.renamed_blocks(_forms(*DELIVER_A), _forms(*beside)) == frozenset()
    assert _beyond(_deliver(), DELIVER_CATALOG, DELIVER_A, beside) == DELIVER_REPORTS
    assert _beyond(_learn(), LEARN_CATALOG, LEARN_A, (*LEARN_A, *LEARN_B)) == LEARN_REPORTS


def test_a_refusal_of_another_cause_is_still_reported():
    other = {"status": 400, "body": {"detail": "Opportunity is not active"}, "raised": []}
    assert _beyond(_deliver(other), DELIVER_CATALOG, DELIVER_A, DELIVER_B) == [
        "/runs/*/refused/400/opportunity-is-not-active"
    ]


def test_a_report_that_names_a_block_no_rename_reached_is_still_reported():
    # The payload names a deliver unit the edit gave no block of A's form.
    stray = (("deliver", "home_visit_2"), ("task", "return_visit"))
    assert _beyond(_deliver(blocks=stray), DELIVER_CATALOG, DELIVER_A, DELIVER_B) == DELIVER_REPORTS[:2]


def test_a_place_where_more_than_one_block_of_a_kind_went_or_came_pairs_none():
    # The deliver unit went and two came in its place: which of the two is the renamed one the forms do not say,
    # and the other is a block added beside it.
    two_came = (("deliver", "household_visit"), ("deliver", "school_visit"), ("task", "return_visit"))
    assert hq_own_reports.renamed_blocks(_forms(*DELIVER_A), _forms(*two_came)) == {
        ("task", "follow_up", "return_visit")
    }
    assert _beyond(_deliver(), DELIVER_CATALOG, DELIVER_A, two_came) == DELIVER_REPORTS[:2]
    # Two learn modules went and one came.
    assert hq_own_reports.renamed_blocks(_forms(*LEARN_A, ("module", "drying")), _forms(*LEARN_B)) == frozenset()
    assert _beyond(_learn(), LEARN_CATALOG, (*LEARN_A, ("module", "drying")), LEARN_B) == LEARN_REPORTS


def _files(**forms):
    """A build of one form per file, each holding its Connect blocks (``forms-<n>``: blocks)."""
    files = {f"modules-0/{name.replace('_', '-')}.xml": _xform(*blocks).encode() for name, blocks in forms.items()}
    return hq_own_reports.connect_forms(BuildOutcome("A", 1, [], {}, {**files, "suite.xml": b"<suite/>"}))


def _task_run(task):
    """A run whose one post is a task form's payload Connect took, and which completed none of the worker's tasks."""
    taken = {"status": 200, "body": {}, "raised": [], "payload": _payload(("task", task))}
    return {"runs": {"android": [_run(taken, {"assignedTasks": [{"slug": "follow_up", "status": "assigned"}]})]}}


def _task_beyond(record, a, b):
    found = connect.absolute_differences(
        record,
        DELIVER_CATALOG,
        check="proof4",
        document="-",
        artifact="connect",
        beyond={},
        forms=("connect@B-edit@minimum", a, b),
    )
    return [difference.path for difference in found]


def test_a_renamed_task_in_a_form_of_its_own_completing_nothing_is_connects_own():
    # The task is in the deliver app's second form, as Nova writes it and as HQ's form builder does, and the edit
    # renames it there: Connect takes the payload and completes no task the worker was assigned under the old id.
    a = _files(forms_0=DELIVER_A[:1], forms_1=DELIVER_A[1:])
    b = _files(forms_0=DELIVER_B[:1], forms_1=DELIVER_B[1:])
    assert hq_own_reports.renamed_blocks(a, b) == {
        ("deliver", "home_visit", "household_visit"),
        ("task", "follow_up", "return_visit"),
    }
    assert _task_beyond(_task_run("return_visit"), a, b) == []


def test_a_task_the_edit_left_alone_that_completed_nothing_is_still_reported():
    a = _files(forms_0=DELIVER_A[:1], forms_1=DELIVER_A[1:])
    deliver_renamed = _files(forms_0=DELIVER_B[:1], forms_1=DELIVER_A[1:])
    assert _task_beyond(_task_run("follow_up"), a, deliver_renamed) == ["/runs/*/task-completed-nothing"]
    # A task payload naming an id no rename reached stands as well.
    b = _files(forms_0=DELIVER_B[:1], forms_1=DELIVER_B[1:])
    assert _task_beyond(_task_run("school_visit"), a, b) == ["/runs/*/task-completed-nothing"]


def test_a_block_whose_id_changed_at_another_place_is_no_rename():
    # The edit took the deliver unit's question out of the form's data and gave a group a new one.
    moved = (
        '<h:html xmlns:h="http://www.w3.org/1999/xhtml" xmlns="http://www.w3.org/2002/xforms"><h:head><model>'
        '<instance><data xmlns="http://openrosa.org/formdesigner/proof"><household/><visit>'
        f'<household_visit><deliver xmlns="{CONNECT_XMLNS}" id="household_visit"><name>v</name></deliver>'
        "</household_visit></visit></data></instance></model></h:head><h:body/></h:html>"
    )
    after = hq_own_reports.connect_forms(
        BuildOutcome("B", 1, [], {}, {"modules-0/forms-0.xml": moved.encode(), "suite.xml": b"<suite/>"})
    )
    assert hq_own_reports.renamed_blocks(_forms(("deliver", "home_visit")), after) == frozenset()
