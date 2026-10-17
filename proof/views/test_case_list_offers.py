"""Defect 12: Nova's publish asks for ``CASE_SEARCH_ADVANCED`` before it sends what HQ's Case List page offers only
under it.

Contract: Nova's publish asks a project space for ``CASE_SEARCH_ADVANCED``
before it sends an inline search, a multi-select case list or a search
input a person excluded from the search (``lib/commcare/projectSpaceCompatibility.ts``,
the capabilities case search and choosing several cases at once), because
HQ's Case List page offers none of them without it: it renders each control
only under the flag (``partials/modules/bootstrap5/case_list_multi_select.html``,
``case_search_properties.html``, ``case_search_property.html``), so nobody
in a project space without it could have made, or can change, what Nova
sent. HQ's build and saves keep each without the flag (the lane's proofs 2
and 4 hold that). The plausible failures: a control HQ offers everyone
(then Nova asks for a flag nothing needs), a reading that finds no control
because the page never loaded its bindings, and a minimum configuration
without the flag (then Nova's publish no longer asks for it).

Each of three documents is published as Nova publishes it, under its own
minimum configuration with the flag taken away and with it. HQ stores the
value either way; HQ's own module page, loaded in Chromium with its own
JavaScript, holds the control for it only under the flag. The same page's
settings form, which every module page holds whatever the flags and the
app's add-ons, is held under both, so a page that offered nothing would not
pass. (The display condition control is no such sentinel: HQ's page offers
it only where the app holds the display conditions add-on, which Nova's
upload writes only for an app that holds a display condition.)
"""

from __future__ import annotations

import dataclasses

import pytest

from proof.editors import pages
from proof.hq import operations
from proof.views.conftest import offered

FLAG = "CASE_SEARCH_ADVANCED"
# What every module page offers whatever the flags and the add-ons are: its settings form
# (``proof/editors/pages.py::MODULE_SETTINGS``, whose Save bar the page's readiness waits on).
ALWAYS = "#module-settings-form"
CONTROLS = {
    "a multi-select case list": (
        "search-multiple",
        'input[data-bind="checked: multiSelectEnabled"]',
        lambda module: module.case_details.short.multi_select is True,
    ),
    "an inline search": (
        "case-list-inline",
        'input[data-bind="checked: inline_search"]',
        lambda module: module.search_config.inline_search is True,
    ),
    "a search input excluded from the search": (
        "expander-expanddoc-hq-json-projection-case-search-4d53ba11-0",
        'input[data-bind="checked: exclude"]',
        lambda module: any(prop.exclude for prop in module.search_config.properties),
    ),
}


@pytest.mark.parametrize("what", sorted(CONTROLS))
def test_nova_asks_for_the_flag_hqs_page_offers_the_control_under(
    hq, core_runner, editor_driver, view_documents, published, what
):
    document_id, selector, holds = CONTROLS[what]
    document = view_documents[document_id]
    minimum = document.exports["minimum"].configuration.hq()
    found = {}
    for flagged in (False, True):
        flags = minimum.flags | {FLAG} if flagged else minimum.flags - {FLAG}
        configuration = dataclasses.replace(minimum, flags=frozenset(flags))
        with published(document, "minimum", core_runner, configuration=configuration) as (unit, app_id, _):
            modules = [module for module in operations.held_app(unit, app_id).modules if holds(module)]
            assert modules, f"HQ stores no {what} for {document_id} with the flag {'on' if flagged else 'off'}"
            counted = offered(
                editor_driver,
                unit,
                "view_module",
                app_id,
                modules[0].unique_id,
                pages.MODULE_SETTINGS.bar,
                {"control": selector, "always": ALWAYS},
            )
            found[flagged] = (counted["control"] > 0, counted["always"] > 0)
    # HQ offers the control only where the flag is on, and Nova's publish asks for the flag.
    assert (found, FLAG in minimum.flags) == ({False: (False, True), True: (True, True)}, True), found
