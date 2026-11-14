"""What a worker sees in Web Apps of a search with no title, beside a search with one.

``targeted-search-no-title``: two menus of clients, each opening on Search. The
first menu's search holds no title (``searchScreenTitle: { kind: "none" }``),
which Nova writes as a blank ``title_label`` in every language, the text CommCare
HQ's Case List page saves where nothing was typed
(``views/modules.py::_gather_and_update_search_properties``); HQ's build writes
that app string as a non-breaking space (``commcare_translations.py::dumps``).
The second's holds the title "Find a client". Formplayer hands the client the
title as the search screen's (``QueryResponseBean``, ``QueryScreen.getScreenTitle``).

The client draws that title in one of two places. Where it shows its navigation
(Web Apps' own page) a search with prompts is laid out beside its results, in the
sidebar region, whose form draws no heading, and the title is the heading of the
results' header (``formplayer/menus/controller.js::showMenu`` and
``showSplitScreenQuery``, ``menus/utils.js::isSidebarEnabled``,
``menus/views.js`` the case list's ``templateContext``,
``cloudcare/partials/case_list/menu_header.html``). App Preview shows no
navigation, and there the search stands alone and its form's own heading is the
title (``formplayer/menus/views/query.js::templateContext``,
``cloudcare/partials/query/list.html``). Both trim the title and draw the heading
only where something is left.

Contract: on HQ's build, opening the first menu shows its Search with no heading,
and opening the second shows Search under the heading "Find a client", in Web
Apps and in App Preview alike. Plausible failures: a heading drawn for the search
with no title (the non-breaking space read as text, or a default title written
for it), and a reading that finds no heading at all, which the titled search
rules out in each layout, read from the same place as the untitled one.
"""

from __future__ import annotations

from proof.webapps import hq as webapps_hq
from proof.webapps import steps
from proof.webapps.session import PREVIEW_FRAME, Session

DOCUMENT = "targeted-search-no-title"
APP = "Client search titles"
# The menus, and the heading each search shows: none, then the authored title (``searchNoTitle.ts::SEARCH_TITLE``).
MENUS = {"Clients": None, "Clients by title": "Find a client"}


def _menu(index: int, name: str) -> list[dict]:
    """The menu's row, then the client's arrival at the screen it opens: the menu's selection in its route and
    nothing in flight (``steps.arrive``)."""
    return steps.navigate(steps.MENU_ROW, steps.arrive([str(index)]), name)


def test_web_apps_draws_no_heading_for_a_search_with_no_title_and_the_title_for_one_with_one(
    hq, core_runner, formplayer_runner, editor_driver, webapps_documents, evidence
):
    from corehq.apps.users.util import raw_username

    observed = {"webApps": {}, "appPreview": {}}
    with webapps_hq.project(webapps_documents[DOCUMENT]) as project:
        with project.released(formplayer_runner, driver=editor_driver) as release:
            for index, menu in enumerate(MENUS):
                run = Session(release, editor_driver).run([*steps.open_app(APP), *_menu(index, menu), steps.SCREEN])
                observed["webApps"][menu] = {"search": run.screens[-1].get("query"), "pageErrors": run.page_errors}
                run = Session(release, editor_driver, preview=True).run(
                    [
                        *steps.preview_started(),
                        *steps.log_in_as(raw_username(release.username)),
                        *steps.navigate(steps.START_APP, steps.arrive([])),
                        *_menu(index, menu),
                        steps.SCREEN,
                    ],
                    viewport=PREVIEW_FRAME,
                )
                observed["appPreview"][menu] = {
                    "search": run.screens[-1].get("query"),
                    "pageErrors": run.page_errors,
                }
    evidence("search-titles", observed)
    # Web Apps lays each search out beside its results, App Preview each on its own.
    for window, beside in (("webApps", True), ("appPreview", False)):
        for menu, title in MENUS.items():
            seen = observed[window][menu]
            assert seen["pageErrors"] == [], (window, menu, seen)
            search = seen["search"]
            # The menu opens on Search: the search's own prompt is drawn either way.
            assert search is not None and [prompt["label"] for prompt in search["prompts"]] == ["Name"], (
                window,
                menu,
                search,
            )
            assert search["beside"] is beside, (window, menu, search)
            assert search["title"] == title, (window, menu, search)
