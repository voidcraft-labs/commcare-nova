"""Defect 4, add-ons: an add-on a person turned on in HQ is still offered by HQ's page after Nova's next publish.

Contract: Nova's upload writes only the add-ons the app needs, each
``true``, over the target's own map, and leaves ``add_ons`` out of the body
where that is the map HQ holds (``lib/commcare/targetOverlay.ts``), so an
update keeps every add-on a person set. HQ's build reads no add-on (the
spelling rule ``add-ons`` rests on that), so only HQ's app-manager pages
show what a publish does to them. The plausible failures: a publish that
replaces the map whole, so the add-on is offered no more, a page that reads
its sections from something a publish does not replace, and a reading taken
from the stored document alone, which no person sees.

``targeted-hq-side-state`` is published as Nova publishes it. HQ's module
page, loaded in Chromium, does not offer the Menu Mode setting: Nova's app
needs no add-on and holds none. A person makes the document's own saves
(``hq-side.json``), its add-ons save among them (``addOns``: every add-on
as the section posts it, Menu Mode alone on, through HQ's own
``views/apps.py::edit_add_ons``), and the page offers Menu Mode. Nova's
next publish of the same document, captured over all of those saves, lands,
and the page still offers it: the app holds the person's map.
"""

from __future__ import annotations

from proof.editors import pages
from proof.hq import operations
from proof.observe import hqside, publish
from proof.views.conftest import offered

DOCUMENT = "targeted-hq-side-state"
# The Menu Mode setting of a module's settings (``module_view_settings.html``, under ``add_ons.menu_mode``).
MENU_MODE = 'select-toggle[params*="put_in_root"]'
# What every module page offers whatever the add-ons are: its settings form.
ALWAYS = "#module-settings-form"


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


def test_an_add_on_a_person_turned_on_in_hq_is_still_on_hqs_page_after_novas_next_publish(
    hq, core_runner, editor_driver, view_documents, published
):
    document = view_documents[DOCUMENT]
    switches = document.hq_side["addOns"]
    assert [slug for slug, on in switches.items() if on] == ["menu_mode"], switches
    with published(document, "minimum", core_runner) as (unit, app_id, export):
        novas = dict(operations.held_app(unit, app_id).add_ons)
        assert "menu_mode" not in novas, novas
        assert _page(editor_driver, unit, app_id) is False

        hqside.save(unit, lambda label, digest: unit.operation(label, digest), app_id, document.hq_side)
        saved = dict(operations.held_app(unit, app_id).add_ons)
        assert saved == {**novas, **switches}, saved
        assert _page(editor_driver, unit, app_id) is True

        refusal, _ = publish.update(unit, app_id, export.republish, "republish")
        assert refusal is None, refusal
        assert dict(operations.held_app(unit, app_id).add_ons) == saved
        assert _page(editor_driver, unit, app_id) is True
