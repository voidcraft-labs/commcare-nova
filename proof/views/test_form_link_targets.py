"""Defect 26: HQ's form settings page lists as a link's target exactly the menus and forms Nova's validator admits,
so a save there keeps every link Nova writes.

Contract: for each form of ``targeted-form-link-otherwise`` that holds a link, the targets HQ's form settings page
lists in each link's target selector (``corehq/apps/app_manager/views/forms.py::_get_linkable_forms_context``: a
menu where it is top-level or where the form's menu's parent and the menu's parent have one case type, every menu
under ``FORM_LINK_ADVANCED_MODE``, and every form; drawn by
``templates/app_manager/partials/forms/form_workflow.html``, ``form_links_form_ids``, one selector beside each link
the page keeps, ``static/app_manager/js/forms/bootstrap3/form_workflow.js``) are the targets Nova's validator admits
from the same form (``lib/domain/formLinkTargets.ts::menuTargetOffered``), as
``lib/commcare/__tests__/formLinkTargets.test.ts`` writes them into ``fixtures/form-link-targets.json``.

The plausible failures: a submenu Nova refuses that HQ offers, or one Nova admits that HQ's page does not list (then
the page drops the link at the next save, as it dropped this defect's link to a nested menu); a form HQ lists that
Nova cannot link to; and a reading that finds nothing because the page drew no link. Each page is read with its link
selectors counted beside every candidate, so a page that drew none fails, and the page is read again with
``FORM_LINK_ADVANCED_MODE`` on, under which every menu is listed, so a reading that never distinguishes cannot pass.
"""

from __future__ import annotations

import dataclasses
import json
from pathlib import Path

from proof.editors import pages
from proof.hq import operations
from proof.views.conftest import offered

DOCUMENT = "targeted-form-link-otherwise"
FLAG = "FORM_LINK_ADVANCED_MODE"
FIXTURE = Path(__file__).resolve().parent / "fixtures" / "form-link-targets.json"
LINKS = 'select[name="form_links_form_ids"]'


def _name(item):
    """The name HQ holds for a menu or form, in the app's one language."""
    names = [name for name in item.name.values() if name]
    assert len(names) == 1, item.name
    return names[0]


def _candidates(app):
    """Every target HQ's page could list, by the value its selector's option carries: each menu by its unique id, and
    each form by its menu's and its own (``_get_linkable_forms_context``), each named as the fixture names it."""
    menus = {module.unique_id: _name(module) for module in app.get_modules()}
    forms = {
        f"{module.unique_id}.{form.unique_id}": (_name(module), _name(form))
        for module in app.get_modules()
        for form in module.get_suite_forms()
    }
    return menus, forms


def _listed(editor_driver, unit, app_id, form, menus, forms):
    """How many link selectors the form's page draws, and in how many of them each candidate is an option."""
    selectors = {"links": LINKS}
    selectors.update({f"menu:{value}": f'{LINKS} option[value="{value}"]' for value in menus})
    selectors.update({f"form:{value}": f'{LINKS} option[value="{value}"]' for value in forms})
    return offered(editor_driver, unit, "view_form", app_id, form.unique_id, pages.FORM_SETTINGS.bar, selectors)


def _read_every_form(editor_driver, unit, app_id, expected, key):
    app = operations.held_app(unit, app_id)
    menus, forms = _candidates(app)
    read = 0
    for module in app.get_modules():
        for form in module.get_suite_forms():
            entry = expected[(_name(module), _name(form))]
            if not entry["holdsLink"]:
                continue
            counted = _listed(editor_driver, unit, app_id, form, menus, forms)
            links = counted["links"]
            # One selector beside each link the page keeps, and every link it was sent is kept.
            assert links == len(form.form_links) > 0, (entry["form"], counted)
            targets = entry[key]
            listed_menus = sorted(name for value, name in menus.items() if counted[f"menu:{value}"])
            listed_forms = sorted(list(at) for value, at in forms.items() if counted[f"form:{value}"])
            assert listed_menus == sorted(targets["menus"]), (entry["form"], key)
            assert listed_forms == sorted(list(at) for at in targets["forms"]), (entry["form"], key)
            # A listed target is an option of every link's selector.
            assert all(count in (0, links) for name, count in counted.items() if name != "links"), counted
            read += 1
    return read


def test_hqs_form_settings_page_lists_the_targets_novas_validator_admits(
    hq, core_runner, editor_driver, view_documents, published
):
    fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))
    assert fixture["document"] == DOCUMENT
    expected = {(entry["menu"], entry["form"]): entry for entry in fixture["forms"]}
    # The document holds a submenu each way: offered from one form, refused from another.
    assert any("Round checks" in entry["offered"]["menus"] for entry in fixture["forms"])
    assert any("Round checks" not in entry["offered"]["menus"] for entry in fixture["forms"])
    document = view_documents[DOCUMENT]
    minimum = document.exports["minimum"].configuration.hq()
    without = dataclasses.replace(minimum, flags=frozenset(minimum.flags - {FLAG}))
    with published(document, "minimum", core_runner, configuration=without) as (unit, app_id, _):
        read = _read_every_form(editor_driver, unit, app_id, expected, "offered")
    assert read == sum(entry["holdsLink"] for entry in fixture["forms"]), read
    # The counterpart: with the flag on, the same pages list every menu.
    flagged = dataclasses.replace(minimum, flags=frozenset(minimum.flags | {FLAG}))
    with published(document, "minimum", core_runner, configuration=flagged) as (unit, app_id, _):
        assert _read_every_form(editor_driver, unit, app_id, expected, "offeredUnderAdvancedMode") == read
