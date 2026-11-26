"""A conditional owner leaf survives the editor and has a distinct case effect."""

import pytest
from lxml import etree

from proof.core.artifacts import TEMPLATE_RESTORE, XFORMS
from proof.core.client import load_answer_table
from proof.core.test_session import form_step, person_cases
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
VELLUM = "http://commcarehq.org/xforms/vellum"
CASE_ID = "owner-condition-case"
PATH = "/data/save_person/case"
CONDITION = "/data/decision = 'transfer'"


def _form_source(xmlns, action):
    if action == "create":
        effects = "<create><case_type/><case_name/><owner_id/></create><update><visits/></update>"
        identity = f'<setvalue event="xforms-ready" ref="{PATH}/@case_id" value="\'{CASE_ID}\'"/>'
        fields = (
            f'<bind nodeset="{PATH}/create/case_type" calculate="\'person\'"/>'
            f'<bind nodeset="{PATH}/create/case_name" calculate="\'Known person\'"/>'
        )
    else:
        effects = "<update><visits/><owner_id/></update>"
        identity = f'<bind nodeset="{PATH}/@case_id" calculate="\'{CASE_ID}\'"/>'
        fields = ""
    return f"""<h:html xmlns:h="http://www.w3.org/1999/xhtml" xmlns="{XFORMS}"
      xmlns:jr="http://openrosa.org/javarosa" xmlns:vellum="{VELLUM}" xmlns:xsd="http://www.w3.org/2001/XMLSchema">
      <h:head><h:title>Visit</h:title><model>
        <instance><data xmlns="{xmlns}" name="Visit" version="1" uiVersion="1">
          <decision/><save_person vellum:role="SaveToCase" vellum:case_type="person">
            <case xmlns="{CASE}" case_id="" date_modified="" user_id="">{effects}</case>
          </save_person>
        </data></instance>
        <bind nodeset="/data/decision" type="xsd:string"/>
        <bind nodeset="{PATH}/@date_modified" type="xsd:dateTime" calculate="/data/meta/timeEnd"/>
        <bind nodeset="{PATH}/@user_id" calculate="/data/meta/userID"/>
        <bind nodeset="{PATH}/update/visits" calculate="'2'"/>
        <bind nodeset="{PATH}/{action}/owner_id" calculate="'new-owner'" relevant="{CONDITION}"/>
        {fields}{identity}
        <itext><translation lang="en" default=""><text id="decision-label"><value>Decision</value></text></translation></itext>
      </model></h:head>
      <h:body><input ref="/data/decision"><label ref="jr:itext('decision-label')"/></input></h:body>
    </h:html>"""


def _restore():
    root = etree.fromstring(person_cases(TEMPLATE_RESTORE.read_bytes(), [CASE_ID]))
    case, = (case for case in root.iter(f"{{{CASE}}}case") if case.get("case_id") == CASE_ID)
    case.find(f"{{{CASE}}}create/{{{CASE}}}owner_id").text = "old-owner"
    return etree.tostring(root)


def _observe(state, core_runner, app, form, decision, action):
    table = load_answer_table()
    table["novaKinds"]["owner-decision"] = [decision]
    trace = core_runner.session(
        app,
        restore=_restore(),
        answer_table=table,
        question_kinds={"/data/decision": "owner-decision"},
    )
    run, = (
        run for run in trace["runs"]
        if (step := form_step(run)) and step.get("xmlns") == form.xmlns and run["end"] == "submitted"
    )
    step = form_step(run)
    transaction, = etree.fromstring(step["submission"].encode()).iter(f"{{{CASE}}}case")
    assert transaction.get("case_id") == CASE_ID
    assert transaction.findtext(f"{{{CASE}}}update/{{{CASE}}}visits") == "2"

    device, = etree.fromstring(step["caseDb"].encode()).xpath(f"/*/case[@case_id='{CASE_ID}']")
    assert device.findtext("visits") == "2"
    initial = (
        "<create><case_type>person</case_type><case_name>Known person</case_name>"
        "<owner_id>old-owner</owner_id></create>"
    )
    known = operations.process_case_blocks(
        state, _submission(_case(CASE_ID, initial, "2025-09-30T10:00:00.000000Z"))
    )
    assert known.refusal is None
    submission, _ = unmarked_submission(run)
    applied = operations.process_case_blocks(state, submission, cases=[known.touched[CASE_ID].case])
    assert applied.refusal is None
    server = applied.touched[CASE_ID].case
    assert server.case_json["visits"] == "2"
    return (
        transaction.findtext(f"{{{CASE}}}{action}/{{{CASE}}}owner_id"),
        device.get("owner_id"),
        server.owner_id,
    )


@pytest.mark.parametrize("action", ["update", "create"])
def test_vellum_keeps_conditional_owner_effects_and_core_and_hq_process_them(
    hq, core_runner, editor_driver, tmp_path, action
):
    with hq_check(Configuration(privileges={"VELLUM_SAVE_TO_CASE"})) as (state, record):
        app_id = publish_hq_app(state, TWO_LANGUAGE_APP)
        form = operations.held_app(state, app_id).modules[0].forms[0]
        _patched(state, app_id, form.unique_id, _form_source(form.xmlns, action), "conditional owner")
        run = vellum.fresh_open_and_save(editor_driver, state, app_id, form.unique_id)
        assert run.loaded and run.saved, (run.load_error, run.save_refusal)
        saved = etree.fromstring(run.stored_source.encode())
        bind, = [bind for bind in saved.iter(f"{{{XFORMS}}}bind")
                 if bind.get("nodeset") == f"{PATH}/{action}/owner_id"]
        assert bind.get("relevant") == CONDITION
        assert bind.get("calculate") == "'new-owner'"

        built = compare.build(state, app_id, record)
        assert not built.errors, built.errors
        with admitted(core_runner, arrange(built.files, tmp_path)) as admission:
            assert admission["admitted"], admission["problems"]
            retained = _observe(state, core_runner, admission["app"], form, "keep", action)
            sent = _observe(state, core_runner, admission["app"], form, "transfer", action)
    assert sent == ("new-owner", "new-owner", "new-owner")
    if action == "update":
        assert retained == (None, "old-owner", "old-owner")
    else:
        assert retained[0] is None
        assert retained[1] != "old-owner" and retained[2] == "old-owner"
