"""Defect 12: what Nova exports without ``CASE_SEARCH_ADVANCED``, HQ's Case List page does not offer there.

Contract: Nova's publish asks a project space for no flag before it sends an
inline search, a multi-select case list or a search input a person excluded
from the search, and HQ's build and saves keep each without the flag (the
lane's proofs 2 and 4 hold that). What they do not say is whether a person
in that project space could have made, or can now change, what Nova sent:
HQ's Case List page renders each of those controls only under
``CASE_SEARCH_ADVANCED`` (``partials/modules/bootstrap3/case_list_multi_select.html``,
``case_search_properties.html``, ``case_search_property.html``). The
plausible failures: a control HQ offers everyone (then no gate is missed),
and a reading that finds no control because the page never loaded its
bindings.

Each of three documents is published as Nova publishes it, under its own
minimum configuration and under its maximum, which holds the flag. HQ stores
the value either way; HQ's own module page, loaded in Chromium with its own
JavaScript, holds the control for it only under the flag. The same page's
display condition control, which no flag gates, is held under both, so a
page that offered nothing would not pass.
"""

from __future__ import annotations

import pytest

from proof.editors import pages
from proof.hq import operations
from proof.views.conftest import offered

FLAG = "CASE_SEARCH_ADVANCED"
# What every module page offers whatever the flags are (``module_filter.html``, under the display conditions
# add-on, which Nova's upload turns on).
ALWAYS = '[name="module_filter"], #module-filter'
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
def test_hq_stores_what_nova_sends_and_its_page_offers_the_control_only_under_the_flag(
    hq, core_runner, editor_driver, view_documents, published, what
):
    document_id, selector, holds = CONTROLS[what]
    document = view_documents[document_id]
    found = {}
    for name in ("minimum", "maximum"):
        with published(document, name, core_runner) as (unit, app_id, export):
            flags = export.configuration.hq().flags
            modules = [module for module in operations.held_app(unit, app_id).modules if holds(module)]
            assert modules, f"HQ stores no {what} for {document_id} under {name}"
            counted = offered(
                editor_driver,
                unit,
                "view_module",
                app_id,
                modules[0].unique_id,
                pages.MODULE_SETTINGS.bar,
                {"control": selector, "always": ALWAYS},
            )
            found[name] = (FLAG in flags, counted["control"] > 0, counted["always"] > 0)
    # Nova's publish asks for no flag for it; HQ offers its control only where the flag is on.
    assert found == {"minimum": (False, False, True), "maximum": (True, True, True)}, found
