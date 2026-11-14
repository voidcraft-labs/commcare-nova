"""What a worker sees in Web Apps of a search with no title, beside a search with one.

``targeted-search-no-title``: two menus of clients, each opening on Search. The
first menu's search holds no title (``searchScreenTitle: { kind: "none" }``),
which Nova writes as a blank ``title_label`` in every language, the text CommCare
HQ's Case List page saves where nothing was typed
(``views/modules.py::_gather_and_update_search_properties``); HQ's build writes
that app string as a non-breaking space (``commcare_translations.py::dumps``).
The second's holds the title "Find a client". The client trims the title it is
handed and draws its heading only where something is left
(``formplayer/menus/views/query.js::templateContext``,
``cloudcare/partials/query/list.html``).

Contract: on HQ's build, opening the first menu shows its Search with no
heading, and opening the second shows Search under the heading "Find a client".
Plausible failures: a heading drawn for the search with no title (the
non-breaking space read as text, or a default title written for it), and a
reading that finds no heading at all, which the titled search rules out.
"""

from __future__ import annotations

from proof.webapps import hq as webapps_hq
from proof.webapps import steps
from proof.webapps.session import Session

DOCUMENT = "targeted-search-no-title"
APP = "Client search titles"
# The menus, and the heading each search shows: none, then the authored title (``searchNoTitle.ts::SEARCH_TITLE``).
MENUS = {"Clients": None, "Clients by title": "Find a client"}


def test_web_apps_draws_no_heading_for_a_search_with_no_title_and_the_title_for_one_with_one(
    hq, core_runner, formplayer_runner, editor_driver, webapps_documents, evidence
):
    observed = {}
    with webapps_hq.project(webapps_documents[DOCUMENT]) as project:
        with project.released(formplayer_runner, driver=editor_driver) as release:
            for menu in MENUS:
                run = Session(release, editor_driver).run(
                    [*steps.path(steps.open_app(APP), steps.choose(menu)), steps.SCREEN]
                )
                observed[menu] = {"search": run.screens[-1].get("query"), "pageErrors": run.page_errors}
    evidence("search-titles", observed)
    for menu, title in MENUS.items():
        assert observed[menu]["pageErrors"] == [], (menu, observed[menu])
        search = observed[menu]["search"]
        # The menu opens on Search: the search's own prompt is drawn either way.
        assert search is not None and [prompt["label"] for prompt in search["prompts"]] == ["Name"], (menu, search)
        assert search["title"] == title, (menu, search)
