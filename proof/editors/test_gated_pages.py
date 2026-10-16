"""Defect 12: what HQ's Case List page offers, and what its save keeps, without each flag Nova's publish asks for.

Contract: Nova's publish asks a project space for ``CASE_SEARCH_ADVANCED``
before it sends a Search field with a starting value, a hidden Search value,
a search-first menu, a one-date Search field or a Search field it matches by
its own filter, or a multi-select case list; for
``CASE_SEARCH_RELATED_LOOKUPS`` before a search that reads related cases;
and for both ``CASE_LIST_TILE`` and ``CASE_LIST_TILE_CUSTOM`` before a tile
layout (``lib/commcare/projectSpaceCompatibility.ts``). HQ's Case List page,
loaded in Chromium with its own JavaScript, renders the control for each only
under its flag (``partials/modules/bootstrap5/case_search_properties.html``,
``case_search_property.html``, ``case_list_multi_select.html``), and a save
under ``CASE_LIST_TILE`` alone drops a custom tile
(``static/app_manager/js/details/bootstrap5/screen.js``). The plausible
failures: a control HQ offers without the flag (then Nova asks for a flag
nothing needs), a save without the flag that loses the inline search or the
multi-select list Nova sent (then the publish would change behavior on the
first save), and a tile kept under ``CASE_LIST_TILE`` alone (then the second
flag guards nothing). ``proof/views/test_case_list_offers.py`` holds that HQ
stores what Nova sends either way.
"""

from __future__ import annotations

import dataclasses
from contextlib import contextmanager

import pytest

from proof.editors import pages
from proof.editors.conftest import corpus_document, record_timing, write_evidence
from proof.hq import operations
from proof.hq.check import hq_check

ADVANCED = "CASE_SEARCH_ADVANCED"
RELATED = "CASE_SEARCH_RELATED_LOOKUPS"
TILE, CUSTOM_TILE = "CASE_LIST_TILE", "CASE_LIST_TILE_CUSTOM"
# The five controls of the Case List page HQ renders only under CASE_SEARCH_ADVANCED, and the page's own Save bar,
# which every module page holds.
ADVANCED_CONTROLS = {
    "available after search": 'input[data-bind="checked: inline_search"]',
    "hide in search screen": 'input[data-bind="checked: hidden"]',
    "exclude from search filters": 'input[data-bind="checked: exclude"]',
    "default value expression": 'input[data-bind="value: defaultValue"]',
    "choose several cases": 'input[data-bind="checked: multiSelectEnabled"]',
}
RELATED_CONTROL = {"include related cases": 'input[data-bind="checked: include_all_related_cases"]'}
ALWAYS = {"always": pages.CASE_LIST.bar}


def _with_flags(configuration, flags):
    return dataclasses.replace(configuration, flags=frozenset(flags))


@contextmanager
def _published(document, configuration):
    from proof.observe import publish

    with hq_check(configuration) as (state, _):
        app_id, refusal, _ = publish.create(state, document.exports["minimum"])
        assert refusal is None, refusal
        yield state, app_id


def _offered(driver, state, app_id, module_id, selectors):
    """How many of each selector the module's page holds, loaded in Chromium by HQ's own page view."""
    from django.urls import reverse

    from proof.editors.hq import HQAnswers, editor_build

    editor_build()
    answers = HQAnswers(state)
    run = driver.run(
        [
            {"goto": reverse("view_module", args=[state.domain, app_id, module_id])},
            {"until": "pages/ready", "arg": {"bar": pages.CASE_LIST.bar}},
            {"settle": True},
            {"call": "pages/offered", "arg": {**selectors, **ALWAYS}},
        ],
        answer=answers,
    )
    answers.check()
    return {name: counted["held"] > 0 for name, counted in run["outcomes"][-1]["value"].items()}


def _searching_module(state, app_id):
    return next(module for module in operations.held_app(state, app_id).modules if module.search_config.properties)


@pytest.mark.parametrize("document_id", ["prompt-widgets", "case-list-inline", "search-multiple"])
def test_the_case_list_page_offers_the_advanced_search_controls_only_under_the_flag_and_its_save_keeps_them(
    hq, core_runner, editor_driver, document_id
):
    document = corpus_document(document_id)
    minimum = document.exports["minimum"].configuration.hq()
    assert ADVANCED in minimum.flags, sorted(minimum.flags)
    found = {}
    for flagged in (True, False):
        flags = minimum.flags if flagged else minimum.flags - {ADVANCED}
        with _published(document, _with_flags(minimum, flags)) as (state, app_id):
            module = _searching_module(state, app_id)
            offered = _offered(editor_driver, state, app_id, module.unique_id, ADVANCED_CONTROLS)
            stored = (module.search_config.inline_search, module.case_details.short.multi_select)
            saved = pages.fresh_section_save(editor_driver, state, pages.CASE_LIST, app_id, module.unique_id)
            record_timing("page_save:case list", saved.seconds)
            assert saved.save is not None and saved.save.status == 200 and not saved.refused, saved.alerts
            after = operations.held_app(state, app_id).get_module_by_unique_id(module.unique_id)
            found[flagged] = {
                "offered": offered,
                "keptAfterSave": (after.search_config.inline_search, after.case_details.short.multi_select) == stored,
            }
    write_evidence(f"gated-pages-{document_id}", found)
    # Each of the five only under the flag; the page's own Save bar either way; and the save keeps what Nova sent.
    assert found == {
        True: {"offered": {**dict.fromkeys(ADVANCED_CONTROLS, True), "always": True}, "keptAfterSave": True},
        False: {"offered": {**dict.fromkeys(ADVANCED_CONTROLS, False), "always": True}, "keptAfterSave": True},
    }, found


def test_the_case_list_page_offers_related_cases_only_under_related_lookups(hq, core_runner, editor_driver):
    document = corpus_document("search-multiple")
    minimum = document.exports["minimum"].configuration.hq()
    found = {}
    for flagged in (True, False):
        flags = minimum.flags | {RELATED} if flagged else minimum.flags - {RELATED}
        with _published(document, _with_flags(minimum, flags)) as (state, app_id):
            module = _searching_module(state, app_id)
            found[flagged] = _offered(editor_driver, state, app_id, module.unique_id, RELATED_CONTROL)
    assert found == {
        True: {"include related cases": True, "always": True},
        False: {"include related cases": False, "always": True},
    }, found


def test_a_case_list_save_drops_a_custom_tile_under_case_list_tile_alone_and_keeps_it_under_both(
    hq, core_runner, editor_driver
):
    document = corpus_document("targeted-custom-tile")
    minimum = document.exports["minimum"].configuration.hq()
    assert {TILE, CUSTOM_TILE} <= minimum.flags, sorted(minimum.flags)
    found = {}
    for name, flags in (("both", minimum.flags), ("tile alone", minimum.flags - {CUSTOM_TILE})):
        with _published(document, _with_flags(minimum, flags)) as (state, app_id):
            module = operations.held_app(state, app_id).modules[0]
            assert module.case_details.short.case_tile_template == "custom"
            cells = [column.grid_x for column in module.case_details.short.columns if column.grid_x is not None]
            assert cells, "the stored tile holds no cell"
            saved = pages.fresh_section_save(editor_driver, state, pages.CASE_LIST, app_id, module.unique_id)
            record_timing("page_save:case list", saved.seconds)
            assert saved.save is not None and saved.save.status == 200 and not saved.refused, saved.alerts
            after = operations.held_app(state, app_id).modules[0].case_details.short
            found[name] = after.case_tile_template
    assert found == {"both": "custom", "tile alone": None}, found
