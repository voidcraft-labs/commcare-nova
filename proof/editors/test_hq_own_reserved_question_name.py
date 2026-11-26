"""HQ's own form builder warns about a question named script or registration in a form HQ made.

Contract (``proof.checks.hq_own_reports``, member
``vellum_reserved_question_name``): Vellum's warning "The ID '…' may cause
problems with form parsing" on a question named ``script``, or ``registration``
in any capitalization, is what HQ's form builder says of any form that holds
one (``mugs/baseSpecs.js::RESERVED_NAMES``), and nothing Nova can spell
removes it while it keeps the name. Workers keep the answer of a ``script``
question on both platforms, and of a ``registration`` question on Android
(``proof/formplayer/test_receiving_answers.py``,
``proof/android/test_receiving_answers.py``), so the warning on those is HQ's
own; Web Apps reads any ``registration`` as a user registration and refuses
the form, so in an app whose Web Apps setting is on the warning on it stays the
export's. The app here holds no Nova byte: HQ's own views make it
(``default_new_app``, a survey menu by ``new_module``, whose form is HQ's blank
form), the form builder's save view stores the form with the two questions
(``edit_form_attr``), HQ's app attribute view turns Web Apps on and then off
(``edit_app_attr``, as the settings page's save does; a new app starts with it
off), and HQ's form builder,
Vellum in HQ's page, opens and saves the form.

The plausible failures: a member whose path is not the warning's as proof 4
keys it, so the register would still hold it; and one that holds for
``registration`` where the app runs in Web Apps, where the warning names a form
workers cannot submit.
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
XHTML = "http://www.w3.org/1999/xhtml"
NAMES = ("script", "Registration")
WARNING = "may cause problems with form parsing"


def _hq(state, name, *args, data=None, body=None):
    """HQ's view ``name`` answering the request its page sends: a GET, a POST of ``data`` (name, value) pairs, or
    a POST of the JSON ``body``."""
    from django.urls import resolve, reverse

    from proof.hq import requests as hq_requests

    path = reverse(name, args=[state.domain, *args])
    if body is not None:
        request = hq_requests.raw_post(state, path, json.dumps(body).encode(), "application/json")
    elif data is not None:
        request = hq_requests.form_post(state, path, data)
    else:
        request = hq_requests.get(state, path)
    match = resolve(path)
    response = match.func(request, *match.args, **match.kwargs)
    assert response.status_code < 400, (name, response.status_code, response.content[:600])
    return response


def _survey(state):
    """A new app with one survey menu, as HQ's own pages make them; returns (app id, its form's unique id)."""
    from corehq.apps.app_manager.dbaccessors import get_app_ids_in_domain

    _hq(state, "default_new_app")
    (app_id,) = get_app_ids_in_domain(state.domain)
    _hq(state, "new_module", app_id, data=[("name", "Visits"), ("module_type", "survey")])
    return app_id, operations.held_app(state, app_id).modules[0].forms[0].unique_id


def _with_questions(state, app_id, form_id):
    """The form builder's save of HQ's blank form with a text question for each of ``NAMES`` (``edit_form_attr``,
    the view Vellum's full save posts the form's source to)."""
    form = operations.held_app(state, app_id).get_form(form_id)
    root = etree.fromstring(form.source.encode("utf-8"))
    model = root.find(f".//{{{XFORMS}}}model")
    data = model.find(f"{{{XFORMS}}}instance")[0]
    namespace = etree.QName(data).namespace
    body = root.find(f"{{{XHTML}}}body")
    for name in NAMES:
        etree.SubElement(data, f"{{{namespace}}}{name}")
        etree.SubElement(model, f"{{{XFORMS}}}bind", nodeset=f"/data/{name}", type="xsd:string")
        control = etree.SubElement(body, f"{{{XFORMS}}}input", ref=f"/data/{name}")
        etree.SubElement(control, f"{{{XFORMS}}}label").text = name
    _hq(state, "edit_form_attr", app_id, form_id, "xform", data=[("xform", etree.tostring(root, encoding="unicode"))])


def _warnings(run):
    """Each reserved-name warning the run shows, by its question, keyed as proof 4 keys it
    (``proof.checks.proof4.vellum_report``)."""
    data = proof4.data_root(run.source)
    found = {}
    for question in run.questions:
        for message in question["messages"]:
            if WARNING not in str(message["message"]):
                continue
            step = f"{pointer_token(message['attribute'])}/{pointer_token(message['key'])}"
            text = proof4.message_key(message["message"], data_root=data, question=question["path"])
            found[question["path"]] = (f"/modules/*/forms/*/questions/*/{step}/{pointer_token(text)}", question)
    return found


def test_vellum_reserved_question_name(hq, editor_driver):
    """HQ's own form builder warns about both names on a form HQ made; the member holds the warning on script in
    any app, and on Registration only once HQ holds the app with Web Apps off."""
    with hq_check(CONFIGURATION) as (state, _):
        app_id, form_id = _survey(state)
        _with_questions(state, app_id, form_id)
        _hq(state, "edit_app_attr", app_id, "cloudcare_enabled", body={"hq": {"cloudcare_enabled": True}})
        web_apps = operations.held_app(state, app_id).to_json()
        _hq(state, "edit_app_attr", app_id, "cloudcare_enabled", body={"hq": {"cloudcare_enabled": False}})
        android_only = operations.held_app(state, app_id).to_json()
        run = vellum.open_and_save(editor_driver, state, app_id, form_id)
    record_timing("vellum_open", run.seconds["open"])
    assert run.loaded, run.load_error
    found = _warnings(run)
    write_evidence("hq-own-reserved-question-name", {"warnings": sorted(found), "questions": run.questions})
    assert sorted(found) == ["/data/Registration", "/data/script"], run.questions
    assert {path for path, _ in found.values()} == {hq_own_reports.RESERVED_NAME_WARNING}
    assert web_apps.get("cloudcare_enabled") is True and android_only.get("cloudcare_enabled") is False
    script, registration = found["/data/script"][1], found["/data/Registration"][1]
    for editor in ("editor:vellum", "editor:vellum again"):
        for app in (web_apps, android_only):
            member = hq_own_reports.held(editor, hq_own_reports.RESERVED_NAME_WARNING, script, app)
            assert member is not None and member.id == "vellum_reserved_question_name"
        assert hq_own_reports.held(editor, hq_own_reports.RESERVED_NAME_WARNING, registration, web_apps) is None
        member = hq_own_reports.held(editor, hq_own_reports.RESERVED_NAME_WARNING, registration, android_only)
        assert member is not None and member.id == "vellum_reserved_question_name"
