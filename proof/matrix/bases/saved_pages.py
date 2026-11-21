"""``hq-saved-pages``: ``hq-new-app`` after every app-manager section is saved once with nothing changed.

The app ``hq-new-app`` makes, then each section HQ's pages offer saved as a
person saves it without changing a value, as proof 4 saves them
(``proof/editors/pages.py::run_view``, the driver's page): the app settings
view (app settings, add-ons, UI translations), the menu's view (its
settings, its case list, its case detail) and each form's view (its
settings, its case management, its user properties), each section offered
as HQ's page offers it (``proof/observe/proof4.py``'s offers); and each form
opened and saved in the form builder (``vellum``). What each page writes on
a save stays in the app: the tile cell keys a column's save writes off a
tile and the profile settings the settings page writes that no runtime
reads, each an INERT entry. A save of the Case List page at the pin leaves
no ``case_tile_field`` on a column (the ``""`` the page writes is no more stored than the page's ``False`` for
``show_border`` or its ``""`` for ``filter_xpath``, keys ``DetailColumn`` declares ``exclude_if_none``), so the
variant ``hq-saved-pages/case-tile-field-off-a-template-tile``, a slot's name on this list with no template,
shows that entry.
"""

from __future__ import annotations

from contextlib import nullcontext

from proof.hq.configuration import Configuration
from proof.matrix.bases import new_app
from proof.matrix.ops import MatrixChangeRefused
from proof.matrix.registry import Base

OFFERED = "offered"


def _offered(authoring, app_id, view, target):
    """The sections of ``view`` HQ's page offers for ``target`` (the menu's or form's unique id, None for the app
    settings view), decided as proof 4 decides them, in HQ's order."""
    from proof.editors import pages
    from proof.hq import operations
    from proof.observe import proof4

    state = authoring.state
    with authoring.step(f"build:offers:{view}:{target}"):
        app = operations.held_app(state, app_id)
        if view == "app_settings":
            offers = [
                (pages.APP_SETTINGS, (OFFERED, None)),
                (pages.ADD_ONS, proof4.add_ons_offer(state, app)),
                (pages.UI_TRANSLATIONS, proof4.ui_translations_offer(state, app)),
            ]
        elif view == "view_module":
            module = app.get_module_by_unique_id(target)
            offers = [
                (pages.MODULE_SETTINGS, (OFFERED, None)),
                (pages.CASE_LIST, proof4.case_list_offer(module)),
                (pages.CASE_DETAIL, proof4.case_detail_offer(module)),
            ]
        else:
            form = app.get_form(target)
            offers = [
                (pages.FORM_SETTINGS, (OFFERED, None)),
                (pages.CASE_MANAGEMENT, proof4.case_management_offer(state, app, form)),
                (pages.USER_PROPERTIES, proof4.user_properties_offer(state, app, form)),
            ]
    return tuple(page for page, (offer, _why) in offers if offer == OFFERED)


def save_view(authoring, app_id, view, target):
    """Save each offered section against the app left by its predecessor, as a person reopening the page does."""
    from proof.editors import pages
    from proof.editors.hq import HQAnswers

    # Each save stays in the app and advances its version. A one-section view and its independently audited
    # fresh save therefore both start from the app left by every earlier section.
    for page in _offered(authoring, app_id, view, target):
        spec = pages.ViewSpec(view, app_id, target, sections=(page,))
        run = pages.run_view(
            authoring.driver, HQAnswers(authoring.state), spec, on_section=lambda _index: nullcontext()
        )
        (saved,) = run.sections
        if saved.save is None or saved.refused:
            raise MatrixChangeRefused(
                f"HQ's {page.name} section did not take the save the lane makes with nothing changed while it"
                f" authors {authoring.base} ({saved.unsent or saved.response}). The lane saves it as a person does;"
                " look at what the page now holds of the app."
            )


def build(authoring) -> str:
    from proof.hq import operations

    app_id = new_app.build_new_app(authoring)
    save_view(authoring, app_id, "app_settings", None)
    app = operations.held_app(authoring.state, app_id)
    for module in app.get_modules():
        save_view(authoring, app_id, "view_module", module.unique_id)
        for form in module.get_forms():
            save_view(authoring, app_id, "view_form", form.unique_id)
    return app_id


BASE = Base(
    id="hq-saved-pages",
    build=build,
    configuration=Configuration(),
    exhibits=(
        "menus-and-case-lists/tile-cell-keys-on-a-list-that-is-not-a-tile",
        "application-and-settings/3-properties-purge-freq",
        "application-and-settings/6-properties-log-prop-weekly-within-its-choices",
        "application-and-settings/7-properties-log-prop-daily-within-its-choices",
        "application-and-settings/12-properties-user-reg-server",
        "application-and-settings/14-properties-restore-tolerance",
        "application-and-settings/16-properties-loose-media",
    ),
    vellum=((0, 0), (0, 1)),
)
