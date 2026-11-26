"""A root user case update is saved by Vellum and submitted only on its condition."""

import pytest
from lxml import etree

from proof.core.artifacts import TEMPLATE_RESTORE, XFORMS
from proof.core.client import load_answer_table
from proof.core.test_session import form_step
from proof.editors import compare, vellum
from proof.editors.conftest import TWO_LANGUAGE_APP, publish_hq_app
from proof.hq import operations
from proof.hq.check import hq_check
from proof.hq.configuration import Configuration
from proof.hq.test_case_processing import _case, _submission
from proof.observe.build import arrange
from proof.observe.hqside import _patched
from proof.observe.sessions import admitted, unmarked_submission

CASE = "http://commcarehq.org/case/transaction/v2"
WORKER = "test_uuid"
WORKER_CASE = "worker-actual-case-id"
WRAPPER = "/data/nova_operations/nova_condition_worker"
PATH = f"{WRAPPER}/worker/case"
CONDITION = "/data/decision = 'save'"
TARGET = ("instance('casedb')/casedb/case[@case_type = 'commcare-user']"
          "[hq_user_id = instance('commcaresession')/session/context/userid]/@case_id")


def _form_source(xmlns):
    return f'''<h:html xmlns:h="http://www.w3.org/1999/xhtml" xmlns="{XFORMS}"
      xmlns:jr="http://openrosa.org/javarosa" xmlns:vellum="http://commcarehq.org/xforms/vellum"
      xmlns:xsd="http://www.w3.org/2001/XMLSchema">
      <h:head><h:title>Visit</h:title><model>
        <instance><data xmlns="{xmlns}" name="Visit" version="1" uiVersion="1">
          <decision/><nova_operations><nova_condition_worker><worker vellum:role="SaveToCase" vellum:case_type="commcare-user">
            <case xmlns="{CASE}" case_id="" date_modified="" user_id=""><update><visits/></update></case>
          </worker></nova_condition_worker></nova_operations>
        </data></instance>
        <instance src="jr://instance/casedb" id="casedb"/>
        <instance src="jr://instance/session" id="commcaresession"/>
        <bind nodeset="/data/decision" type="xsd:string"/>
        <bind nodeset="{WRAPPER}" relevant="{CONDITION}"/>
        <bind nodeset="{PATH}/@date_modified" type="xsd:dateTime" calculate="/data/meta/timeEnd"/>
        <bind nodeset="{PATH}/@user_id" calculate="/data/meta/userID"/>
        <bind nodeset="{PATH}/@case_id" calculate="{TARGET}"/>
        <bind nodeset="{PATH}/update/visits" calculate="'updated'"/>
        <itext><translation lang="en" default=""><text id="decision-label"><value>Decision</value></text></translation></itext>
      </model></h:head>
      <h:body><input ref="/data/decision"><label ref="jr:itext('decision-label')"/></input>
        <group ref="/data/nova_operations"><group ref="{WRAPPER}"/></group></h:body>
    </h:html>'''


def _initial():
    return _case(WORKER_CASE, f'''<create><case_type>commcare-user</case_type>
        <case_name>Worker</case_name><owner_id>{WORKER}</owner_id></create>
        <update><hq_user_id>{WORKER}</hq_user_id><visits>before</visits></update>''').replace('user_id="u-1"', f'user_id="{WORKER}"')


def _observe(state, core_runner, app, form, decision, worker_present):
    restore = etree.fromstring(TEMPLATE_RESTORE.read_bytes())
    initial = None
    if worker_present:
        restore.append(etree.fromstring(_initial().encode()))
        known = operations.process_case_blocks(state, _submission(_initial()))
        assert known.refusal is None
        initial = known.touched[WORKER_CASE].case
    table = load_answer_table()
    table["novaKinds"]["worker-decision"] = [decision]
    trace = core_runner.session(app, restore=etree.tostring(restore), answer_table=table,
                                question_kinds={"/data/decision": "worker-decision"})
    run, = (run for run in trace["runs"]
            if (step := form_step(run)) and step.get("xmlns") == form.xmlns and run["end"] == "submitted")
    step = form_step(run)
    submitted = list(etree.fromstring(step["submission"].encode()).iter(f"{{{CASE}}}case"))
    device = etree.fromstring(step["caseDb"].encode()).xpath(f"/*/case[@case_id='{WORKER_CASE}']")
    submission, _ = unmarked_submission(run)
    applied = operations.process_case_blocks(state, submission, cases=[] if initial is None else [initial])
    assert applied.refusal is None
    if decision == "save":
        case, = submitted
        assert case.get("case_id") == WORKER_CASE
        assert case.findtext(f"{{{CASE}}}update/{{{CASE}}}visits") == "updated"
        assert len(device) == 1 and device[0].findtext("visits") == "updated"
        assert applied.touched[WORKER_CASE].case.case_json["visits"] == "updated"
    else:
        assert not submitted
        assert not applied.touched
        if worker_present:
            assert len(device) == 1 and device[0].findtext("visits") == "before"
        else:
            assert not device


def test_vellum_and_native_workers_keep_one_conditional_worker_record_update(hq, core_runner, editor_driver, tmp_path):
    with hq_check(Configuration(privileges={"VELLUM_SAVE_TO_CASE", "USERCASE"})) as (state, record):
        app_id = publish_hq_app(state, TWO_LANGUAGE_APP)
        form = operations.held_app(state, app_id).modules[0].forms[0]
        _patched(state, app_id, form.unique_id, _form_source(form.xmlns), "conditional worker save")
        run = vellum.fresh_open_and_save(editor_driver, state, app_id, form.unique_id)
        assert run.loaded and run.saved, (run.load_error, run.save_refusal, run.form_errors)
        saved = etree.fromstring(run.stored_source.encode())
        binds = {bind.get("nodeset"): bind for bind in saved.iter(f"{{{XFORMS}}}bind")}
        assert binds[WRAPPER].get("relevant") == CONDITION
        assert binds[f"{PATH}/@case_id"].get("calculate") == TARGET
        built = compare.build(state, app_id, record)
        assert not built.errors, built.errors
        with admitted(core_runner, arrange(built.files, tmp_path)) as admission:
            assert admission["admitted"], admission["problems"]
            for decision, worker_present in (("keep", False), ("keep", True), ("save", True)):
                _observe(state, core_runner, admission["app"], form, decision, worker_present)


REPEATED_WORKER_PATH = "/data/members/nova_operations/worker/case"
MEMBER_NAME = "current()/../../../../../member_name"


def _repeated_worker_form_source(xmlns, counted):
    count_node = "<count/>" if counted else ""
    count_bind = '<bind nodeset="/data/count" type="xsd:int"/>' if counted else ""
    count_input = '''<input ref="/data/count"><label ref="jr:itext('count-label')"/></input>''' if counted else ""
    count_attributes = ' jr:count="/data/count" jr:noAddRemove="true()"' if counted else ""
    return f'''<h:html xmlns:h="http://www.w3.org/1999/xhtml" xmlns="{XFORMS}"
      xmlns:jr="http://openrosa.org/javarosa" xmlns:vellum="http://commcarehq.org/xforms/vellum"
      xmlns:xsd="http://www.w3.org/2001/XMLSchema">
      <h:head><h:title>Members</h:title><model>
        <instance><data xmlns="{xmlns}" name="Members" version="1" uiVersion="1">
          {count_node}<members jr:template=""><note/><member_name/>
            <nova_operations><worker vellum:role="SaveToCase" vellum:case_type="commcare-user">
              <case xmlns="{CASE}" case_id="" date_modified="" user_id=""><update><visits/></update></case>
            </worker></nova_operations>
          </members>
        </data></instance>
        <instance src="jr://instance/casedb" id="casedb"/>
        <instance src="jr://instance/session" id="commcaresession"/>
        {count_bind}<bind nodeset="/data/members/note" type="xsd:string"/>
        <bind nodeset="/data/members/member_name" calculate="concat('member-', position(..))"/>
        <bind nodeset="{REPEATED_WORKER_PATH}/@date_modified" type="xsd:dateTime" calculate="/data/meta/timeEnd"/>
        <bind nodeset="{REPEATED_WORKER_PATH}/@user_id" calculate="/data/meta/userID"/>
        <bind nodeset="{REPEATED_WORKER_PATH}/@case_id" calculate="{TARGET}"/>
        <bind nodeset="{REPEATED_WORKER_PATH}/update/visits" calculate="{MEMBER_NAME}" relevant="count({MEMBER_NAME}) &gt; 0"/>
        <itext><translation lang="en" default="">
          <text id="count-label"><value>Number of members</value></text>
          <text id="members-label"><value>Members</value></text>
          <text id="note-label"><value>Note</value></text>
        </translation></itext>
      </model></h:head>
      <h:body>{count_input}<group ref="/data/members"><label ref="jr:itext('members-label')"/>
        <repeat nodeset="/data/members"{count_attributes}>
          <input ref="/data/members/note"><label ref="jr:itext('note-label')"/></input>
          <group ref="/data/members/nova_operations"/>
        </repeat></group></h:body>
    </h:html>'''


@pytest.mark.parametrize("counted", [False, True], ids=["user-controlled", "count-bound"])
def test_vellum_and_native_workers_apply_one_worker_update_per_repeat_row(
    hq, core_runner, editor_driver, tmp_path, counted
):
    with hq_check(Configuration(privileges={"VELLUM_SAVE_TO_CASE", "USERCASE"})) as (state, record):
        app_id = publish_hq_app(state, TWO_LANGUAGE_APP)
        form = operations.held_app(state, app_id).modules[0].forms[0]
        _patched(state, app_id, form.unique_id, _repeated_worker_form_source(form.xmlns, counted), "repeated worker save")
        saved = vellum.fresh_open_and_save(editor_driver, state, app_id, form.unique_id)
        assert saved.loaded and saved.saved, (saved.load_error, saved.save_refusal, saved.form_errors)
        root = etree.fromstring(saved.stored_source.encode())
        binds = {bind.get("nodeset"): bind for bind in root.iter(f"{{{XFORMS}}}bind")}
        assert binds[f"{REPEATED_WORKER_PATH}/@case_id"].get("calculate") == TARGET
        row = binds[f"{REPEATED_WORKER_PATH}/update/visits"]
        assert row.get("calculate") == MEMBER_NAME
        assert row.get("relevant") == f"count({MEMBER_NAME}) > 0"
        built = compare.build(state, app_id, record)
        assert not built.errors, built.errors
        with admitted(core_runner, arrange(built.files, tmp_path)) as admission:
            assert admission["admitted"], admission["problems"]
            for number, worker_present in ((0, False), (0, True), (2, True)):
                restore = etree.fromstring(TEMPLATE_RESTORE.read_bytes())
                known = []
                if worker_present:
                    restore.append(etree.fromstring(_initial().encode()))
                    initial = operations.process_case_blocks(state, _submission(_initial()))
                    assert initial.refusal is None
                    known = [initial.touched[WORKER_CASE].case]
                table = load_answer_table()
                table["repeats"]["add"] = 0 if counted else number
                kinds = None
                if counted:
                    table["novaKinds"]["worker-repeat-count"] = [str(number)]
                    kinds = {"/data/count": "worker-repeat-count"}
                trace = core_runner.session(
                    admission["app"],
                    restore=etree.tostring(restore),
                    answer_table=table,
                    question_kinds=kinds,
                )
                run, = (run for run in trace["runs"]
                        if (step := form_step(run)) and step.get("xmlns") == form.xmlns and run["end"] == "submitted")
                step = form_step(run)
                submitted = list(etree.fromstring(step["submission"].encode()).iter(f"{{{CASE}}}case"))
                # Core position(node) returns the selected reference’s zero-based multiplicity.
                expected = [f"member-{index}" for index in range(number)]
                assert [case.get("case_id") for case in submitted] == [WORKER_CASE] * number
                assert [case.findtext(f"{{{CASE}}}update/{{{CASE}}}visits") for case in submitted] == expected
                device = etree.fromstring(step["caseDb"].encode()).xpath(f"/*/case[@case_id='{WORKER_CASE}']")
                assert [case.findtext("visits") for case in device] == (expected[-1:] or (["before"] if worker_present else []))
                submission, _ = unmarked_submission(run)
                applied = operations.process_case_blocks(state, submission, cases=known)
                assert applied.refusal is None
                if number:
                    assert list(applied.touched) == [WORKER_CASE]
                    assert applied.touched[WORKER_CASE].case.case_json["visits"] == expected[-1]
                else:
                    assert not applied.touched
