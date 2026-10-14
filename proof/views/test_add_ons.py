"""Defect 4, add-ons: Nova's next publish puts back the add-ons a person changed in HQ, and HQ's page shows it.

Contract: Nova's upload writes ``add_ons`` whole, ten keys each ``true``
(``lib/commcare/hqShells.ts::applicationShell``), and an update replaces
what HQ holds. HQ's build reads no add-on (the spelling rule ``add-ons``
rests on that), so only HQ's app-manager pages show the loss: an add-on a
person turned on, which Nova's ten leave out, is offered no more, and one a
person turned off is back on. The plausible failures: a page that reads its
sections from something a publish does not replace, and a reading taken
from the stored document alone, which no person sees.

One document is published as Nova publishes it. HQ's module page, loaded
in Chromium, does not offer the Menu Mode setting. A person turns the Menu
Mode add-on on and the case detail overwrite add-on off, through HQ's own
add-ons save (``views/apps.py::edit_add_ons``), and the page offers Menu
Mode. Nova's next publish of the same document lands, and the page offers
it no more: the app holds Nova's ten again.
"""

from __future__ import annotations

from proof.editors import pages
from proof.hq import operations
from proof.observe import hqside, publish
from proof.views.conftest import offered

DOCUMENT = "search-multiple"
# The Menu Mode setting of a module's settings (``module_view_settings.html``, under ``add_ons.menu_mode``).
MENU_MODE = 'select-toggle[params*="put_in_root"]'
ALWAYS = '[name="module_filter"], #module-filter'


def _page(editor_driver, unit, app_id):
    module = operations.held_app(unit, app_id).modules[0]
    counted = offered(
        editor_driver,
        unit,
        "view_module",
        app_id,
        module.unique_id,
        pages.MODULE_SETTINGS.bar,
        {"menuMode": MENU_MODE, "always": ALWAYS},
    )
    assert counted["always"] > 0, "the module page offered nothing, so it says nothing of an add-on"
    return counted["menuMode"] > 0


def test_an_add_on_a_person_turned_on_in_hq_is_gone_from_hqs_page_after_novas_next_publish(
    hq, core_runner, editor_driver, view_documents, published
):
    with published(view_documents[DOCUMENT], "minimum", core_runner) as (unit, app_id, export):
        novas = dict(operations.held_app(unit, app_id).add_ons)
        assert "menu_mode" not in novas and novas["case_detail_overwrite"] is True, novas
        assert _page(editor_driver, unit, app_id) is False

        body, content_type = hqside._form([("menu_mode", "on"), ("case_detail_overwrite", "off")])
        hqside._answer(unit, "POST", "edit_add_ons", [unit.domain, app_id], body, content_type, "add-ons")
        saved = dict(operations.held_app(unit, app_id).add_ons)
        assert saved == {**novas, "menu_mode": True, "case_detail_overwrite": False}, saved
        assert _page(editor_driver, unit, app_id) is True

        refusal, _ = publish.update(unit, app_id, export.republish, "republish")
        assert refusal is None, refusal
        assert dict(operations.held_app(unit, app_id).add_ons) == novas
        assert _page(editor_driver, unit, app_id) is False
