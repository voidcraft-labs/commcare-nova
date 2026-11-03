"""Defect 21: HQ's Case List page offers each search workflow Nova writes for an app that declares Web Apps, and shows
the stored one, so a save there keeps it.

Contract: a searching menu of an app that declares Web Apps holds search first or skip to results, never list first
(``lib/domain/platforms.ts``, ``list-first``), because HQ's Case List page, wherever it draws its Web Apps search
workflow selector, offers those two and list first only under ``CASE_SEARCH_DEPRECATED_NORMAL_CASE_LIST``: the
selector is drawn where the app's ``cloudcare_enabled``, the ``CLOUDCARE`` privilege and ``SYNC_SEARCH_CASE_CLAIM``
all hold (``corehq/apps/app_manager/views/modules.py::get_module_view_context``, ``show_search_workflow``), and its
options are Search First (``auto_launch``), Skip to Default Case Search Results (``es_only``) and, under that flag
alone, Legacy Case Search (``classic``)
(``templates/app_manager/partials/modules/bootstrap5/case_search_properties.html``). The selector shows the stored
workflow (``static/app_manager/js/details/case_claim.js``, ``workflow`` read from ``auto_launch`` and
``default_search``), and a value it holds no option for is replaced at the next save, which is how a list-first menu
turned search first. An app that declares Android only is no Web App (``cloudcare_enabled`` false), so its page draws
no selector and its save keeps list first.

The plausible failures: a workflow Nova writes that the selector does not offer (then a save changes it); a selector
that offers it but shows another value; a list first Nova writes where the page draws a selector; and a reading that
finds no option because the page never drew its search section. Each page's module settings form, which every module
page holds, is read beside the selector, and the legacy choice is read with its flag on and off, so a page that
offered nothing cannot pass.
"""

from __future__ import annotations

import dataclasses

from proof.editors import pages
from proof.hq import operations
from proof.views.conftest import offered

FLAG = "CASE_SEARCH_DEPRECATED_NORMAL_CASE_LIST"
# What every module page offers whatever the flags and the app's add-ons are: its settings form.
ALWAYS = "#module-settings-form"
SELECTOR = "#search-workflow"
# The selector's options, by the workflow HQ stores: (auto_launch, default_search) to the option's value.
OPTION = {(True, False): "auto_launch", (True, True): "es_only", (False, False): "classic"}


def _searching_modules(app):
    """Each module of the app HQ holds that searches (``util.py::module_offers_search``), with its stored workflow."""
    from corehq.apps.app_manager.util import module_offers_search

    return [
        (module, OPTION[(bool(module.search_config.auto_launch), bool(module.search_config.default_search))])
        for module in app.get_modules()
        if module_offers_search(module)
    ]


def _read(editor_driver, unit, app_id, module, stored):
    """What the module's page offers: each option, the stored option shown as chosen, and the settings form."""
    selectors = {
        "selector": SELECTOR,
        "search first": f'{SELECTOR} option[value="auto_launch"]',
        "skip to results": f'{SELECTOR} option[value="es_only"]',
        "legacy": f'{SELECTOR} option[value="classic"]',
        "shown": f'{SELECTOR} option[value="{stored}"]:checked',
        "always": ALWAYS,
    }
    return offered(editor_driver, unit, "view_module", app_id, module.unique_id, pages.CASE_LIST.bar, selectors)


def test_hqs_case_list_page_offers_and_shows_each_workflow_nova_writes_for_web_apps(
    hq, core_runner, editor_driver, view_documents, published
):
    document = view_documents["targeted-search-workflow"]
    minimum = document.exports["minimum"].configuration.hq()
    assert {"CLOUDCARE"} <= minimum.privileges and "SYNC_SEARCH_CASE_CLAIM" in minimum.flags, minimum
    without = dataclasses.replace(minimum, flags=frozenset(minimum.flags - {FLAG}))
    with published(document, "minimum", core_runner, configuration=without) as (unit, app_id, _):
        app = operations.held_app(unit, app_id)
        assert app.cloudcare_enabled is True
        modules = _searching_modules(app)
        # The document holds both workflows HQ offers, and no list first.
        assert sorted(stored for _, stored in modules) == ["auto_launch", "auto_launch", "es_only"], modules
        for module, stored in modules:
            counted = _read(editor_driver, unit, app_id, module, stored)
            assert counted == {
                "selector": 1,
                "search first": 1,
                "skip to results": 1,
                "legacy": 0,
                "shown": 1,
                "always": 1,
            }, (module.unique_id, stored, counted)
    # The counterpart: with the flag on, the same page offers the legacy choice too.
    flagged = dataclasses.replace(minimum, flags=frozenset(minimum.flags | {FLAG}))
    with published(document, "minimum", core_runner, configuration=flagged) as (unit, app_id, _):
        module, stored = _searching_modules(operations.held_app(unit, app_id))[0]
        counted = _read(editor_driver, unit, app_id, module, stored)
        assert (counted["legacy"], counted["shown"], counted["always"]) == (1, 1, 1), counted


def test_hqs_case_list_page_draws_no_workflow_selector_for_an_app_that_declares_android_only(
    hq, core_runner, editor_driver, view_documents, published
):
    document = view_documents["targeted-search-workflow-android"]
    minimum = document.exports["minimum"].configuration.hq()
    # Grant the privilege and the flag the selector also needs, so the app's own cloudcare_enabled is what decides.
    granted = dataclasses.replace(
        minimum,
        privileges=frozenset(minimum.privileges | {"CLOUDCARE"}),
        flags=frozenset(minimum.flags | {"SYNC_SEARCH_CASE_CLAIM", FLAG}),
    )
    with published(document, "minimum", core_runner, configuration=granted) as (unit, app_id, _):
        app = operations.held_app(unit, app_id)
        assert app.cloudcare_enabled is False
        modules = _searching_modules(app)
        assert [stored for _, stored in modules] == ["classic"], modules
        module, stored = modules[0]
        counted = _read(editor_driver, unit, app_id, module, stored)
        # No selector, so the save posts the list first the module holds; the settings form says the page loaded.
        assert (counted["selector"], counted["always"]) == (0, 1), counted
