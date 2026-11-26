"""What HQ's current Case List editor offers and will save for an Android lookup."""

from __future__ import annotations

import json
from urllib.parse import parse_qsl

import pytest

from proof.editors import pages
from proof.editors.conftest import write_evidence
from proof.editors.hq import HQAnswers, editor_build
from proof.editors.test_gated_pages import _offered
from proof.editors.test_hq_own_registration_alert import _hq
from proof.editors.test_hq_own_settings_page import _case_list_app
from proof.hq import operations
from proof.hq.check import hq_check
from proof.hq.configuration import Configuration

ACTION = "org.nova.proof.CASE_LOOKUP"
LOOKUP = {
    "lookup_enabled": True,
    "lookup_autolaunch": False,
    "lookup_action": ACTION,
    "lookup_name": "Find a visit",
    "lookup_extras": [
        {"key": "visit_mode", "value": "'followup'"},
        {"key": "visit_limit", "value": "1 + 2"},
    ],
    "lookup_responses": [{"key": "first"}, {"key": "second"}],
    "lookup_display_results": True,
    "lookup_field_header": "Match",
    "lookup_field_template": "@case_id",
}


def _lookup_case_list(state, editor_driver, *, name=LOOKUP["lookup_name"], icon=None, extras=None):
    app_id = _case_list_app(state, editor_driver)
    module = operations.held_app(state, app_id).modules[0]
    lookup = {**LOOKUP, "lookup_name": name}
    if extras is not None:
        lookup["lookup_extras"] = extras
    if icon is not None:
        lookup["lookup_image"] = icon
    _hq(
        state,
        "edit_module_detail_screens",
        app_id,
        module.unique_id,
        data=[
            ("type", json.dumps("case")),
            ("multi_select", json.dumps(False)),
            ("auto_select", json.dumps(False)),
            ("short", json.dumps([column.to_json() for column in module.case_details.short.columns])),
            ("case_list_lookup", json.dumps(lookup)),
        ],
    )
    held = operations.held_app(state, app_id).modules[0].case_details.short
    assert held.lookup_enabled and held.lookup_action == ACTION
    assert held.lookup_extras == lookup["lookup_extras"]
    assert [response["key"] for response in held.lookup_responses] == ["first", "second"]
    assert held.lookup_field_header["en"] == "Match"
    return app_id, module.unique_id


@pytest.mark.parametrize("flag", [None, "CASE_LIST_LOOKUP", "BIOMETRIC_INTEGRATION"])
def test_the_current_case_list_editor_offers_lookup_under_either_flag(hq, editor_driver, flag):
    configuration = Configuration(privileges={"CLOUDCARE"}, flags={flag} if flag else set())
    with hq_check(configuration) as (state, _):
        app_id, module_id = _lookup_case_list(state, editor_driver)
        control = 'input[data-bind="checked: lookup_enabled"]'
        offered = _offered(editor_driver, state, app_id, module_id, {"lookup": control})
        assert offered == {"lookup": flag is not None, "always": True}
        saved = pages.fresh_section_save(editor_driver, state, pages.CASE_LIST, app_id, module_id)
        assert saved.save and saved.save.status == 200 and not saved.refused, saved.alerts
        fields = dict(parse_qsl((saved.save.body or b"").decode("utf-8"), keep_blank_values=True))
        payload = fields.get("case_list_lookup")
        if flag is None:
            assert payload is None
            posted = None
        else:
            posted = json.loads(payload)
            assert {key: posted[key] for key in LOOKUP} == LOOKUP
        detail = operations.held_app(state, app_id).modules[0].case_details.short
        held = detail.to_json()
        assert all(held[key] == value for key, value in LOOKUP.items() if key != "lookup_field_header")
        assert held["lookup_field_header"]["en"] == "Match"
        write_evidence(f"case-list-lookup-editor-{flag}", {"offered": offered, "posted": posted})


def test_the_current_case_list_editor_keeps_the_uploaded_lookup_icon(hq, editor_driver):
    from contextlib import nullcontext

    from proof.matrix.authoring import Authoring
    from proof.matrix.bases import _pages

    icon = "jr://file/commcare/image/case-lookup.png"
    configuration = Configuration(privileges={"CLOUDCARE"}, flags={"CASE_LIST_LOOKUP"})
    with hq_check(configuration) as (state, _):
        app_id, module_id = _lookup_case_list(state, editor_driver, icon=icon)
        authoring = Authoring(state, {}, "case-lookup-icon", operation=lambda *_: nullcontext())
        _pages.upload_picture(authoring, app_id, icon)
        saved = pages.fresh_section_save(editor_driver, state, pages.CASE_LIST, app_id, module_id)
        assert saved.save and saved.save.status == 200 and not saved.refused, saved.alerts
        fields = dict(parse_qsl((saved.save.body or b"").decode("utf-8"), keep_blank_values=True))
        assert json.loads(fields["case_list_lookup"])["lookup_image"] == icon
        held = operations.held_app(state, app_id).modules[0].case_details.short
        assert held.lookup_image == icon


def test_the_current_editor_requires_a_lookup_button_name(hq, editor_driver):
    from django.urls import reverse

    configuration = Configuration(privileges={"CLOUDCARE"}, flags={"CASE_LIST_LOOKUP"})
    with hq_check(configuration) as (state, _):
        app_id, module_id = _lookup_case_list(state, editor_driver, name="")
        page = pages.CASE_LIST
        path = reverse(page.view, args=[state.domain, app_id, module_id])
        save_path = reverse(page.save, args=[state.domain, app_id, module_id])
        editor_build()
        answers = HQAnswers(state)
        action, selector = page.arm
        run = editor_driver.run(
            [
                {"goto": path},
                {"until": "pages/ready", "arg": {"bar": page.bar}},
                {"until": "pages/armed", "arg": {"action": action, "selector": selector, "bar": page.bar}},
                {"click": f"{page.bar} > .btn:not(.disabled)"},
                {
                    "waitFor": "() => { const help = document.querySelector("
                    "'input[data-bind=\"value: lookup_name\"] + .help-block');"
                    " return help && help.getClientRects().length > 0; }"
                },
                {"settle": True},
            ],
            answer=answers,
        )
        answers.check()
        assert not run["pageErrors"], run["pageErrors"]
        assert not any(exchange.method == "POST" and exchange.path == save_path for exchange in answers.exchanges)
        assert operations.held_app(state, app_id).modules[0].case_details.short.lookup_name is None
