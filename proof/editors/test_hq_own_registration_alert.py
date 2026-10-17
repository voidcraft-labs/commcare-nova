"""HQ's own editors raise the registration alert on a follow-up form HQ made, given one child case by HQ's save.

Contract (``proof.checks.hq_own_reports``, member
``registration_alert_child_case``): Vellum's pre-save alert "This
registration form is missing a case name" on a follow-up form that opens one
child case outside a repeat is what HQ does itself. HQ counts such a form a
registration form (``models/forms.py::Form.get_registration_actions``,
``is_registration_form``) and maps a case name only from the form's own case
(``form_action_diff.py::get_case_mappings``), so its form designer hands
Vellum a registration form with no name mapped, and Vellum's case management
raises the alert (Vellum ``caseManagement.js::preSaveValidation``). The app
here holds no Nova byte: HQ's own views make it (``default_new_app``, a case
menu by ``new_module``, whose follow-up form is HQ's own), HQ's Case
Management save (``views/forms.py::edit_form_actions``) gives the follow-up
form its child cases with the actions its page sends
(``case_config_ui.js``: the form's own actions as HQ holds them,
``form_action_diff.py::make_multi``, and each child case as
``HQOpenSubCaseAction.from_case_transaction`` writes it), and HQ's form
builder, Vellum in HQ's page, opens and saves the form.

The plausible failures: an allowance that holds where HQ's own app shows no
alert (two child cases, or the one child case inside a repeat, which HQ
counts no registration), and one whose path is not the alert's as proof 4
keys it, so the register would still hold it.
"""

from __future__ import annotations

import json

from lxml import etree

from proof.checks import hq_own_reports, proof4
from proof.checks.differences import pointer_token
from proof.editors import vellum
from proof.editors.conftest import record_timing, write_evidence
from proof.hq import operations
from proof.hq.check import hq_check
from proof.hq.configuration import Configuration

CONFIGURATION = Configuration(privileges={"CLOUDCARE"})
XFORMS = "http://www.w3.org/2002/xforms"
JR = "http://openrosa.org/javarosa"
# The question HQ's own follow-up form holds (``templates/app_manager/default_followup_form.xml``), and the repeat
# the form builder adds for the child case kept inside one.
LABEL = "/data/default_label"
REPEAT = "/data/children"
REPEATED_NAME = "/data/children/child_name"
REGISTRATION = "This registration form is missing a case name."


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


def _case_menu(state):
    """A new app with one case menu, as HQ's own pages make them; returns (app id, its follow-up form's unique id)."""
    from corehq.apps.app_manager.dbaccessors import get_app_ids_in_domain

    _hq(state, "default_new_app")
    (app_id,) = get_app_ids_in_domain(state.domain)
    _hq(state, "new_module", app_id, data=[("name", "Visits"), ("module_type", "case"), ("case_type", "visit")])
    module = operations.held_app(state, app_id).modules[0]
    # HQ's new case menu: a registration form, then its follow-up form.
    followup = module.forms[1]
    assert followup.requires == "case"
    return app_id, followup.unique_id


def _with_repeat(state, app_id, form_id):
    """The form builder's save of HQ's follow-up form with a repeat of child names added (``edit_form_attr``, the
    view Vellum's full save posts the form's source to)."""
    form = operations.held_app(state, app_id).get_form(form_id)
    root = etree.fromstring(form.source.encode("utf-8"))
    model = root.find(f".//{{{XFORMS}}}model")
    data = model.find(f"{{{XFORMS}}}instance")[0]
    namespace = etree.QName(data).namespace
    children = etree.SubElement(data, f"{{{namespace}}}children", {f"{{{JR}}}template": ""})
    etree.SubElement(children, f"{{{namespace}}}child_name")
    etree.SubElement(model, f"{{{XFORMS}}}bind", nodeset=REPEATED_NAME, type="xsd:string")
    body = root.find("{http://www.w3.org/1999/xhtml}body")
    group = etree.SubElement(body, f"{{{XFORMS}}}group")
    repeat = etree.SubElement(group, f"{{{XFORMS}}}repeat", nodeset=REPEAT)
    etree.SubElement(repeat, f"{{{XFORMS}}}input", ref=REPEATED_NAME)
    _hq(state, "edit_form_attr", app_id, form_id, "xform", data=[("xform", etree.tostring(root, encoding="unicode"))])


def _child_case(name_path, repeat_context=""):
    """One child case as HQ's Case Management page sends it (``HQOpenSubCaseAction.from_case_transaction``)."""
    return {
        "name_update": {"question_path": name_path, "update_mode": "always"},
        "case_type": "child",
        "case_properties": {},
        "reference_id": None,
        "condition": {"type": "always", "question": None, "answer": None, "operator": None},
        "close_condition": {"type": "never", "question": None, "answer": None, "operator": None},
        "repeat_context": repeat_context,
    }


def _save_case_management(state, app_id, form_id, subcases):
    """HQ's Case Management save of the follow-up form with ``subcases`` (``views/forms.py::edit_form_actions``)."""
    from corehq.apps.app_manager.form_action_diff import make_multi

    form = operations.held_app(state, app_id).get_form(form_id)
    actions = {**make_multi(form.actions.to_json()), "subcases": list(subcases)}
    _hq(
        state,
        "edit_form_actions",
        app_id,
        form_id,
        data=[("requires", "case"), ("actions", json.dumps(actions)), ("case_mapping_diff", "{}")],
    )


def _opened(editor_driver, subcases, *, repeat=False):
    """HQ's follow-up form given ``subcases`` by HQ's Case Management save, opened and saved in HQ's form builder:
    (Vellum's run, the stored form as HQ's app document holds it)."""
    with hq_check(CONFIGURATION) as (state, _):
        app_id, form_id = _case_menu(state)
        if repeat:
            _with_repeat(state, app_id, form_id)
        _save_case_management(state, app_id, form_id, subcases)
        stored = operations.held_app(state, app_id).get_form(form_id).to_json()
        run = vellum.open_and_save(editor_driver, state, app_id, form_id)
    record_timing("vellum_open", run.seconds["open"])
    assert run.loaded, run.load_error
    return run, stored


def _registration_alerts(run):
    """Each pre-save alert the run shows that is the registration alert, keyed as proof 4 keys it
    (``proof.checks.proof4.vellum_report``)."""
    data = proof4.data_root(run.source)
    return [
        f"/modules/*/forms/*/pre_save_alerts/{pointer_token(proof4.message_key(str(alert), data_root=data))}"
        for alert in run.pre_save_alerts
        if str(alert).startswith(REGISTRATION)
    ]


def test_registration_alert_child_case(hq, editor_driver):
    """One child case outside a repeat: HQ's own form builder raises the alert the member names, on a form HQ made
    whose stored actions meet the member's condition."""
    run, stored = _opened(editor_driver, [_child_case(LABEL)])
    write_evidence("hq-own-registration-alert", {"alerts": run.pre_save_alerts, "actions": stored["actions"]})
    assert _registration_alerts(run) == [hq_own_reports.REGISTRATION_ALERT], run.pre_save_alerts
    assert hq_own_reports.registers_one_child_case(stored)
    member = hq_own_reports.held("editor:vellum", hq_own_reports.REGISTRATION_ALERT, stored)
    assert member is not None and member.id == "registration_alert_child_case"


def test_a_second_child_case_or_the_one_inside_a_repeat_raises_no_alert(hq, editor_driver):
    """HQ counts a form with two child cases outside a repeat, or its one child case inside a repeat, no
    registration form, and its form builder raises no alert: the member's condition holds on neither."""
    two, two_stored = _opened(editor_driver, [_child_case(LABEL), _child_case(LABEL)])
    repeated, repeated_stored = _opened(editor_driver, [_child_case(REPEATED_NAME, REPEAT)], repeat=True)
    for run, stored in ((two, two_stored), (repeated, repeated_stored)):
        assert _registration_alerts(run) == [], run.pre_save_alerts
        assert not hq_own_reports.registers_one_child_case(stored)
