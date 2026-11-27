"""Conditional owner leaves survive the editor and retain their distinct case effects."""

from uuid import UUID

import pytest
from lxml import etree

from proof.core.artifacts import TEMPLATE_RESTORE, XFORMS
from proof.core.client import load_answer_table
from proof.core.test_session import form_step, person_cases
from proof.editors import compare, vellum
from proof.editors.conftest import TWO_LANGUAGE_APP, publish_hq_app
from proof.formplayer.hq import sign_in
from proof.hq import operations
from proof.hq import redis as hq_redis
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


def _form_source(xmlns, action, *, owners=None, condition=CONDITION):
    casedb = ""
    owner_bind = f"""<bind nodeset="{PATH}/{action}/owner_id" calculate="'new-owner'" relevant="{condition}"/>"""
    if action == "create":
        update_owner = "<owner_id/>" if owners is not None else ""
        effects = (
            "<create><case_type/><case_name/><owner_id/></create>"
            f"<update><visits/>{update_owner}</update>"
        )
        case_id = "uuid()" if owners is not None else f"'{CASE_ID}'"
        identity = f'<setvalue event="xforms-ready" ref="{PATH}/@case_id" value="{case_id}"/>'
        fields = (
            f"""<bind nodeset="{PATH}/create/case_type" calculate="'person'"/>"""
            f"""<bind nodeset="{PATH}/create/case_name" calculate="'Known person'"/>"""
        )
        if owners is not None:
            initial_owner, next_owner = owners
            owner_bind = (
                f"""<bind nodeset="{PATH}/create/owner_id" calculate="'{initial_owner}'"/>"""
                f"""<bind nodeset="{PATH}/update/owner_id" calculate="'{next_owner}'" relevant="{CONDITION}"/>"""
            )
    else:
        effects = "<update><owner_id/><visits/></update>"
        existing = (
            "instance('casedb')/casedb/case"
            f"[@case_id = '{CASE_ID}' and @case_type = 'person']/@case_id"
        )
        casedb = '<instance src="jr://instance/casedb" id="casedb"/>'
        identity = f'<bind nodeset="{PATH}/@case_id" calculate="{existing}"/>'
        fields = ""
    return f"""<h:html xmlns:h="http://www.w3.org/1999/xhtml" xmlns="{XFORMS}"
      xmlns:jr="http://openrosa.org/javarosa" xmlns:vellum="{VELLUM}" xmlns:xsd="http://www.w3.org/2001/XMLSchema">
      <h:head><h:title>Visit</h:title><model>
        <instance><data xmlns="{xmlns}" name="Visit" version="1" uiVersion="1">
          <decision/><save_person vellum:role="SaveToCase" vellum:case_type="person">
            <case xmlns="{CASE}" case_id="" date_modified="" user_id="">{effects}</case>
          </save_person>
        </data></instance>{casedb}
        <bind nodeset="/data/decision" type="xsd:string"/>
        <bind nodeset="{PATH}/@date_modified" type="xsd:dateTime" calculate="/data/meta/timeEnd"/>
        <bind nodeset="{PATH}/@user_id" calculate="/data/meta/userID"/>
        <bind nodeset="{PATH}/update/visits" calculate="'2'"/>
        {owner_bind}
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


def _submitted(core_runner, app, form, decision, restore):
    table = load_answer_table()
    table["novaKinds"]["owner-decision"] = [decision]
    trace = core_runner.session(
        app,
        restore=restore,
        answer_table=table,
        question_kinds={"/data/decision": "owner-decision"},
    )
    run, = (
        run for run in trace["runs"]
        if (step := form_step(run)) and step.get("xmlns") == form.xmlns and run["end"] == "submitted"
    )
    return run, form_step(run)


def _observe(state, core_runner, app, form, decision, action):
    run, step = _submitted(core_runner, app, form, decision, _restore())
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


@pytest.mark.parametrize(
    ("action", "condition"),
    [("update", CONDITION), ("create", CONDITION), ("create", "true()")],
    ids=["update", "create", "always-owner-on-aliased-create"],
)
def test_vellum_keeps_conditional_owner_effects_and_core_and_hq_process_them(
    hq, core_runner, editor_driver, tmp_path, action, condition,
):
    with hq_check(Configuration(privileges={"VELLUM_SAVE_TO_CASE"})) as (state, record):
        app_id = publish_hq_app(state, TWO_LANGUAGE_APP)
        form = operations.held_app(state, app_id).modules[0].forms[0]
        _patched(state, app_id, form.unique_id, _form_source(form.xmlns, action, condition=condition), "conditional owner")
        run = vellum.fresh_open_and_save(editor_driver, state, app_id, form.unique_id)
        assert run.loaded and run.saved, (run.load_error, run.save_refusal)
        saved = etree.fromstring(run.stored_source.encode())
        bind, = [bind for bind in saved.iter(f"{{{XFORMS}}}bind")
                 if bind.get("nodeset") == f"{PATH}/{action}/owner_id"]
        assert bind.get("relevant") == condition
        assert bind.get("calculate") == "'new-owner'"

        built = compare.build(state, app_id, record)
        assert not built.errors, built.errors
        with admitted(core_runner, arrange(built.files, tmp_path)) as admission:
            assert admission["admitted"], admission["problems"]
            retained = _observe(state, core_runner, admission["app"], form, "keep", action)
            sent = _observe(state, core_runner, admission["app"], form, "transfer", action)
    assert sent == ("new-owner", "new-owner", "new-owner")
    if condition == "true()":
        assert retained == sent
    elif action == "update":
        assert retained == (None, "old-owner", "old-owner")
    else:
        assert retained[0] is None
        assert retained[1] != "old-owner" and retained[2] == "old-owner"


def test_fresh_create_applies_the_initial_owner_before_a_guarded_effect_in_the_same_block(
    hq, core_runner, editor_driver, tmp_path
):
    from corehq.apps.users.models import CommCareUser
    from corehq.apps.users.util import format_username

    with hq_check(Configuration(privileges={"VELLUM_SAVE_TO_CASE"})) as (state, record):
        # Use three HQ accounts to distinguish an omitted create owner
        # (defaults to the submitter) from the intended initial owner.
        password = "proof-owner-effects-worker"
        with hq_redis.shared(None), state.committing():
            with state.operation("owner-effects-workers", b"fresh-owner-effects-workers"):
                submitter, initial, next_owner = [
                    CommCareUser.create(
                        state.domain,
                        format_username(username, state.domain),
                        password,
                        created_by=None,
                        created_via=None,
                    )
                    for username in ("owner-effects-submitter", "owner-effects-initial", "owner-effects-next")
                ]
            for worker in (submitter, initial, next_owner):
                sign_in(state, worker, password, worker.raw_username)
        assert len({submitter._id, initial._id, next_owner._id}) == 3

        restore = etree.fromstring(TEMPLATE_RESTORE.read_bytes())
        registration, = restore.xpath("./*[local-name()='Registration']")
        registration.find("{*}username").text = submitter.raw_username
        registration.find("{*}uuid").text = submitter._id
        for existing in restore.findall(f"{{{CASE}}}case"):
            restore.remove(existing)
        restore_xml = etree.tostring(restore)

        app_id = publish_hq_app(state, TWO_LANGUAGE_APP)
        form = operations.held_app(state, app_id).modules[0].forms[0]
        authored = _form_source(form.xmlns, "create", owners=(initial._id, next_owner._id))
        _patched(state, app_id, form.unique_id, authored, "fresh create and guarded owner update")
        saved = vellum.fresh_open_and_save(editor_driver, state, app_id, form.unique_id)
        assert saved.loaded and saved.saved, (saved.load_error, saved.save_refusal)
        model = etree.fromstring(saved.stored_source.encode())
        binds = {
            bind.get("nodeset"): (bind.get("calculate"), bind.get("relevant"))
            for bind in model.iter(f"{{{XFORMS}}}bind")
        }
        assert binds[f"{PATH}/create/owner_id"] == (f"'{initial._id}'", None)
        assert binds[f"{PATH}/update/owner_id"] == (f"'{next_owner._id}'", CONDITION)
        allocation, = [node for node in model.iter(f"{{{XFORMS}}}setvalue") if node.get("ref") == f"{PATH}/@case_id"]
        assert (allocation.get("event"), allocation.get("value")) == ("xforms-ready", "uuid()")

        built = compare.build(state, app_id, record)
        assert not built.errors, built.errors
        with admitted(core_runner, arrange(built.files, tmp_path)) as admission:
            assert admission["admitted"], admission["problems"]
            for decision, updated_owner in (("keep", None), ("transfer", next_owner._id)):
                run, step = _submitted(core_runner, admission["app"], form, decision, restore_xml)
                # Match the marked case ID in the device's recorded store, then
                # hand HQ the unmarked XML containing the actual generated ID.
                marked, = etree.fromstring(step["submission"].encode()).iter(f"{{{CASE}}}case")
                case_mark = marked.get("case_id")
                device, = etree.fromstring(step["caseDb"].encode()).xpath(f"/*/case[@case_id='{case_mark}']")
                assert device.get("owner_id") == (updated_owner or initial._id)
                assert device.findtext("visits") == "2"
                submission, tokens = unmarked_submission(run)
                transaction, = etree.fromstring(submission).iter(f"{{{CASE}}}case")
                case_id = transaction.get("case_id")
                assert tokens[case_mark] == case_id and str(UUID(case_id)) == case_id
                assert transaction.get("user_id") == submitter._id
                assert [etree.QName(action).localname for action in transaction] == ["create", "update"]
                assert transaction.findtext(f"{{{CASE}}}create/{{{CASE}}}owner_id") == initial._id
                assert transaction.findtext(f"{{{CASE}}}update/{{{CASE}}}owner_id") == updated_owner
                assert transaction.findtext(f"{{{CASE}}}update/{{{CASE}}}visits") == "2"

                applied = operations.process_case_blocks(state, submission)
                assert applied.refusal is None
                assert list(applied.touched) == [case_id]
                effect = applied.touched[case_id]
                assert effect.is_creation
                assert effect.case.owner_id == (updated_owner or initial._id)
                assert effect.case.case_json["visits"] == "2"
