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


def _lookup_case_list(
    state, editor_driver, *, name=LOOKUP["lookup_name"], icon=None, extras=None,
    result_heading=LOOKUP["lookup_field_header"], result_template=LOOKUP["lookup_field_template"],
):
    app_id = _case_list_app(state, editor_driver)
    module = operations.held_app(state, app_id).modules[0]
    lookup = {**LOOKUP, "lookup_name": name, "lookup_field_template": result_template}
    if result_heading is None:
        del lookup["lookup_field_header"]
    else:
        lookup["lookup_field_header"] = result_heading
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
    assert held.lookup_field_header == ({} if result_heading is None else {"en": result_heading})
    assert held.lookup_field_template == result_template
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


def test_a_fallback_confidence_heading_builds_as_its_explicit_translation(hq, editor_driver, core_runner):
    """The added translation key changes the stored source without changing the built heading."""
    from django.urls import resolve
    from lxml import etree

    from proof.checks.source import compare_sources
    from proof.editors import compare
    from proof.hq import requests
    from proof.matrix.authoring import Authoring
    from proof.matrix.bases import _pages

    heading = "Confidence"
    configuration = Configuration(privileges={"CLOUDCARE"}, flags={"CASE_LIST_LOOKUP"})
    with hq_check(configuration) as (state, record):
        app_id, module_id = _lookup_case_list(
            state, editor_driver, result_heading=heading,
            extras=[{"key": "visit_mode", "value": "'followup'"}],
        )
        _pages.set_languages(Authoring(state, {}, "lookup-confidence", operation=state.operation), app_id, ("en", "fr"))
        saved = pages.fresh_section_save(editor_driver, state, pages.CASE_LIST, app_id, module_id, cookies={"lang": "en"})
        assert saved.save and saved.save.status == 200 and not saved.refused, saved.alerts
        source = operations.held_app(state, app_id).to_json()
        assert source["modules"][0]["case_details"]["short"]["lookup_field_header"] == {"en": heading}
        before = compare.build(state, app_id, record)

        fields = dict(parse_qsl(saved.save.body.decode("utf-8"), keep_blank_values=True))
        lookup = json.loads(fields["case_list_lookup"])
        lookup["lookup_field_header"] = heading
        data = [(name, fields[name]) for name in (
            "type", "short", "multi_select", "auto_select", "max_select_value",
        ) if name in fields]
        request = requests.form_post(
            state, saved.save_path, [*data, ("case_list_lookup", json.dumps(lookup))], lang="fr",
        )
        view = resolve(saved.save_path)
        response = view.func(request, *view.args, **view.kwargs)
        assert response.status_code == 200, response.content
        published = operations.held_app(state, app_id).to_json()
        assert published["modules"][0]["case_details"]["short"]["lookup_field_header"] == {"en": heading, "fr": heading}
        after = compare.build(state, app_id, record, version=before.app.version)

    differences = [
        item.as_json() for item in compare_sources("lookup-confidence", source, published)
        if "/lookup_field_header" in item.at
    ]
    suite = etree.fromstring(before.files["suite.xml"])
    (locale,) = suite.findall(".//lookup/field/header/text/locale")
    key = locale.get("id")
    assert key
    built = {
        label: {
            lang: compare._parsed(f"{lang}/app_strings.txt", build.files[f"{lang}/app_strings.txt"])[key]
            for lang in ("default", "en", "fr")
        }
        for label, build in (("fallback", before), ("explicit", after))
    }
    build_differences = compare.differences(before.files, after.files)
    restore = compare.case_restore([("lookup-juniper", "visit", "Juniper", {})])
    traces = [compare.core_trace(core_runner, build, restore) for build in (before, after)]
    write_evidence("lookup-confidence-heading-respelled", {
        "sourceDifferences": differences,
        "localeKey": key,
        "headings": built,
        "buildDifferences": build_differences,
        "coreDifference": compare.first_difference(*traces),
        "listedCases": [sorted(compare.listed_cases(trace)) for trace in traces],
    })
    assert [(item["at"], item["kind"], item["before"], item["after"]) for item in differences] == [
        ("/modules/0/case_details/short/lookup_field_header/fr", "added", None, heading),
    ]
    assert all(text == heading for headings in built.values() for text in headings.values())
    assert build_differences == []
    assert compare.first_difference(*traces) is None
    assert all(compare.listed_cases(trace) == {"lookup-juniper"} for trace in traces)


def test_the_lookup_icon_can_move_to_another_path_for_the_same_image(hq, editor_driver, core_runner):
    """Both paths are real HQ media, and the Case List save keeps the exact new lookup image path."""
    from lxml import etree

    from proof.checks.compare.xml_tree import compare_xml
    from proof.checks.source import compare_sources
    from proof.editors import compare
    from proof.matrix.authoring import Authoring
    from proof.matrix.bases import _pages

    alias = "jr://file/commcare/image/visit-lookup.png"
    kept = "jr://file/commcare/image/lookup.png"
    configuration = Configuration(privileges={"CLOUDCARE"}, flags={"CASE_LIST_LOOKUP"})
    with hq_check(configuration) as (state, record):
        app_id, module_id = _lookup_case_list(
            state, editor_driver, icon=alias,
            extras=[{"key": "visit_mode", "value": "'followup'"}],
        )
        authoring = Authoring(state, {}, "lookup-icon-path", operation=state.operation)
        _pages.upload_picture(authoring, app_id, kept)
        _pages.attach_media(authoring, app_id, alias, like=kept)
        _pages.save_menu_media(authoring, app_id, 0, image=kept)
        saved = pages.fresh_section_save(editor_driver, state, pages.CASE_LIST, app_id, module_id)
        assert saved.save and saved.save.status == 200 and not saved.refused, saved.alerts
        source = operations.app_source(state, app_id)
        before = compare.build(state, app_id, record)

        fields = dict(parse_qsl(saved.save.body.decode("utf-8"), keep_blank_values=True))
        lookup = json.loads(fields["case_list_lookup"])
        assert lookup["lookup_image"] == alias
        lookup["lookup_image"] = kept
        data = [(name, fields[name]) for name in (
            "type", "short", "multi_select", "auto_select", "max_select_value",
        ) if name in fields]
        _hq(
            state, "edit_module_detail_screens", app_id, module_id,
            data=[*data, ("case_list_lookup", json.dumps(lookup))],
        )
        published = operations.app_source(state, app_id)
        after = compare.build(state, app_id, record, version=before.app.version)

    diff = [
        item.as_json() for item in compare_sources("lookup-icon-path", source, published)
        if item.at.endswith("/lookup_image")
    ]
    suites = [build.files["suite.xml"] for build in (before, after)]
    built = [etree.fromstring(suite).find(".//lookup").get("image") for suite in suites]
    suite_diff = [
        item.as_json() for item in compare_xml(*suites, check="proof2", document="lookup-icon-path", artifact="suite.xml")
        if "lookup" in item.at
    ]
    restore = compare.case_restore([("lookup-juniper", "visit", "Juniper", {})])
    traces = [compare.core_trace(core_runner, build, restore) for build in (before, after)]
    write_evidence("lookup-icon-source-path", {
        "sourceDifferences": diff,
        "suiteDifferences": suite_diff,
        "buildDifferences": compare.differences(before.files, after.files),
        "coreDifference": compare.first_difference(*traces),
        "listedCases": [sorted(compare.listed_cases(trace)) for trace in traces],
    })
    assert [(item["at"], item["before"], item["after"]) for item in diff] == [
        ("/modules/0/case_details/short/lookup_image", alias, kept),
    ]
    assert built == [alias, kept]
    assert compare.first_difference(*traces) is None
    assert all(compare.listed_cases(trace) == {"lookup-juniper"} for trace in traces)
