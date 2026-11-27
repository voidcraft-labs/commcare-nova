"""The maxima that HQ's current Case List editor saves and builds."""

from __future__ import annotations

from urllib.parse import parse_qsl

from lxml import etree

from proof.editors import compare, pages
from proof.editors.conftest import write_evidence
from proof.editors.hq import HQAnswers, editor_build
from proof.editors.test_hq_own_settings_page import _case_list_app
from proof.hq import operations
from proof.hq.check import hq_check
from proof.hq.configuration import Configuration

MAXIMUM = 'input[name="max-select-value-input"]'
SET_MAXIMUM = """({ selector, maximum }) => {
    const input = document.querySelector(selector);
    const before = input.value;
    input.value = maximum;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return before;
}"""


def _edit_maximum(driver, state, app_id, module_id, prior, maximum):
    from django.urls import reverse

    page = pages.CASE_LIST
    args = [state.domain, app_id, module_id]
    path = reverse(page.view, args=args)
    save_path = reverse(page.save, args=args)
    save = {"method": "POST", "pathname": save_path}
    editor_build()
    answers = HQAnswers(state)
    run = driver.run(
        [
            {"goto": path},
            {"until": "pages/ready", "arg": {"bar": page.bar}},
            {"settle": True},
            {"eval": SET_MAXIMUM, "arg": {"selector": MAXIMUM, "maximum": str(maximum)}},
            {"click": f"{page.bar} > .btn:not(.disabled)"},
            {"awaitRequest": save},
            {"until": "pages/saved", "arg": page.bar},
            {"settle": True},
        ],
        answer=answers,
    )
    answers.check()
    assert not run["pageErrors"], run["pageErrors"]
    assert run["outcomes"][3]["value"] == str(prior)
    (sent,) = [exchange for exchange in answers.exchanges if exchange.method == "POST" and exchange.path == save_path]
    assert sent.status == 200, sent.response
    return sent


def _posted_maximum(save):
    fields = dict(parse_qsl(save.body.decode("utf-8")))
    assert fields["multi_select"] == "true"
    return int(fields["max_select_value"])


def test_current_case_list_editor_keeps_large_selection_maxima(hq, editor_driver):
    configuration = Configuration(privileges={"CLOUDCARE"}, flags={"CASE_SEARCH_ADVANCED"})
    with hq_check(configuration) as (state, record):
        app_id = _case_list_app(state, editor_driver)
        app = operations.held_app(state, app_id)
        module = app.modules[0]
        module_id = module.unique_id
        module.case_details.short.multi_select = True
        module.case_details.short.auto_select = False
        module.case_details.short.max_select_value = 100
        app.save()

        evidence = []
        prior = 100
        for maximum in (100, 101, 2_147_483_647):
            edited = None
            if maximum != prior:
                edited = _posted_maximum(_edit_maximum(editor_driver, state, app_id, module_id, prior, maximum))
                assert edited == maximum
                assert operations.held_app(state, app_id).modules[0].case_details.short.max_select_value == maximum

            reopened = pages.fresh_section_save(editor_driver, state, pages.CASE_LIST, app_id, module_id)
            assert reopened.save and reopened.save.status == 200 and not reopened.refused, reopened.alerts
            assert not reopened.run["pageErrors"], reopened.run["pageErrors"]
            assert _posted_maximum(reopened.save) == maximum
            held = operations.held_app(state, app_id).modules[0].case_details.short
            assert held.multi_select and not held.auto_select and held.max_select_value == maximum

            suite = etree.fromstring(compare.build(state, app_id, record).files["suite.xml"])
            built = suite.xpath("//*[local-name()='instance-datum']/@max-select-value")
            assert set(built) == {str(maximum)}, built
            evidence.append({"edited": edited, "reopened": maximum, "stored": held.max_select_value, "built": built})
            prior = maximum

    write_evidence("case-list-selection-maxima", evidence)
