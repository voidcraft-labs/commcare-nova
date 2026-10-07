"""What Web Apps shows of a search and of a case list's hidden columns, over Nova's exports.

- **Finding 54, the empty search description the Case List save writes**
  (``case-list-browse``). The register holds the difference as an
  equivalence that only Web Apps' client settles. Contract: Formplayer
  hands the client ``""`` for Nova's export and a non-breaking space for the
  app after HQ's own Case List page saved it, and the client shows no
  description element for either, where it shows one, with the text, for a
  search that has a description (the accepted counterpart, which shows the
  reading would see one). Plausible failures: a client that renders the
  non-breaking space as a blank description (a difference a worker sees),
  or a reading that never finds a description at all.

  The same save moves the worker from the case list to the search screen
  (the stored ``auto_launch`` turns true), which the register already holds
  as defect 21; here it shows on the real client: the menu that opened the
  list for Nova's export opens the search for the saved app.

- **Defect 16, a column hidden from a list and the list's search**
  (``targeted-hidden-column``, with the restore the document fixes). Nova
  leaves a column hidden from Results out of the list it uploads. Contract:
  in Web Apps on HQ's build a search of the list for that column's value
  finds no case, and a search for a shown value finds the case, so the harm
  the register states for Core reaches a worker in Web Apps. The plausible
  failure is a search that finds nothing at all, which the shown value
  rules out.

- **A sort-only column** (``case-list-browse``'s ``Hidden order``).
  Contract: Formplayer hands the client the column with an empty header and
  a width hint of 0, and the client shows neither a header nor a cell for
  it. The plausible failure is a client that shows an empty ninth column.
"""

from __future__ import annotations

from proof.editors import pages
from proof.webapps import hq as webapps_hq
from proof.webapps import steps
from proof.webapps.session import Session

BROWSE = "case-list-browse"
TO_THE_MENU = steps.path(steps.open_app("Case list proof"), steps.choose("Patients & visits"))
DESCRIPTION = "Find a patient by code."
NBSP = "\u00a0"


def _describe(doc):
    doc["modules"][0]["search_config"]["description"] = {"en": DESCRIPTION}


def _query_answers(run):
    """Formplayer's search screens of a run, as it answered them."""
    answers = [exchange.json() for exchange in run.answered("navigate_menu")]
    return [answer for answer in answers if answer.get("type") == "query"]


def test_web_apps_shows_no_description_for_an_empty_one_or_a_non_breaking_space_and_shows_a_real_one(
    hq, core_runner, formplayer_runner, editor_driver, webapps_documents, evidence
):
    with webapps_hq.project(webapps_documents[BROWSE], core_runner) as project:
        to_the_search = [*TO_THE_MENU, steps.SCREEN, *steps.list_action("Search"), steps.SCREEN]
        sides = {
            # Nova's export: the menu opens the list, and its Search button the search.
            "nova": ({}, to_the_search),
            # After HQ's Case List page saved it: the menu opens the search itself (defect 21).
            "saved": ({"saves": ((pages.CASE_LIST, project.module_id(0)),)}, [*TO_THE_MENU, steps.SCREEN]),
            "described": ({"change": _describe}, to_the_search),
        }
        observed = {}
        for name, (made, path) in sides.items():
            with project.released(driver=editor_driver, label=name, **made) as release:
                run = Session(project, release, formplayer_runner, editor_driver).run(path)
                search = release.doc["modules"][0]["search_config"]
                observed[name] = {
                    "stored": {"description": search.get("description"), "auto_launch": search.get("auto_launch")},
                    "formplayer": [answer.get("description") for answer in _query_answers(run)],
                    "afterTheMenu": {key: key in run.screens[0] for key in ("list", "query")},
                    "search": run.screens[-1].get("query"),
                    "pageErrors": run.page_errors,
                }
        evidence("search-description", observed)
        nova, saved, described = observed["nova"], observed["saved"], observed["described"]
        assert [side["pageErrors"] for side in observed.values()] == [[], [], []]

        # What each app stores, and what Formplayer hands the client for it.
        assert nova["stored"] == {"description": {}, "auto_launch": False}
        assert saved["stored"] == {"description": {"en": ""}, "auto_launch": True}
        assert nova["formplayer"] == [""] and saved["formplayer"] == [NBSP]
        assert described["formplayer"] == [DESCRIPTION]

        # The client shows no description for either, and shows the one that has text.
        assert nova["search"] is not None and saved["search"] is not None
        assert nova["search"]["description"] is None
        assert saved["search"]["description"] is None
        assert described["search"]["description"]["text"].strip() == DESCRIPTION
        assert described["search"]["description"]["visible"] is True
        # The same prompts either way.
        assert nova["search"]["prompts"] == saved["search"]["prompts"] == described["search"]["prompts"]

        # Defect 21 on the client: the menu opens the list for Nova's export and the search for the saved app.
        assert nova["afterTheMenu"]["list"] and not nova["afterTheMenu"]["query"]
        assert saved["afterTheMenu"]["query"]


def test_web_apps_shows_no_description_on_an_inline_search_before_or_after_the_case_list_save(
    hq, core_runner, formplayer_runner, editor_driver, webapps_documents, evidence
):
    """The same equivalence where the search is part of the form's own entry (``case-list-inline``), the third
    class the register holds for finding 54: the menu opens the search itself on both builds."""
    with webapps_hq.project(webapps_documents["case-list-inline"], core_runner) as project:
        observed = {}
        for name, saves in (("nova", ()), ("saved", ((pages.CASE_LIST, project.module_id(0)),))):
            with project.released(saves=saves, driver=editor_driver, label=name) as release:
                run = Session(project, release, formplayer_runner, editor_driver).run([*TO_THE_MENU, steps.SCREEN])
                observed[name] = {
                    "stored": release.doc["modules"][0]["search_config"].get("description"),
                    "formplayer": [answer.get("description") for answer in _query_answers(run)],
                    "search": run.screens[0].get("query"),
                    "pageErrors": run.page_errors,
                }
        evidence("inline-search-description", observed)
        nova, saved = observed["nova"], observed["saved"]
        assert nova["pageErrors"] == [] and saved["pageErrors"] == []
        assert nova["stored"] == {} and saved["stored"] == {"en": ""}
        assert nova["formplayer"] == [""] and saved["formplayer"] == [NBSP]
        assert nova["search"] is not None and nova["search"]["prompts"]
        assert nova["search"]["description"] is None and saved["search"]["description"] is None
        assert nova["search"]["prompts"] == saved["search"]["prompts"]


def test_a_list_search_in_web_apps_misses_a_hidden_columns_value_and_finds_a_shown_one(
    hq, core_runner, formplayer_runner, editor_driver, webapps_documents, evidence
):
    document = webapps_documents["targeted-hidden-column"]
    restore = (document.root / "restore.xml").read_bytes()
    with webapps_hq.project(document, core_runner, restore=restore) as project:
        with project.released() as release:
            run = Session(project, release, formplayer_runner, editor_driver).run(
                [
                    *steps.open_app("Client villages"),
                    *steps.choose("Clients"),
                    steps.SCREEN,
                    *steps.search_list("Riverside"),
                    steps.SCREEN,
                    *steps.search_list("Amina"),
                    steps.SCREEN,
                ]
            )
    listed, by_village, by_name = (screen["list"] for screen in run.screens)
    evidence("hidden-column", {"listed": listed, "Riverside": by_village, "Amina": by_name})
    assert run.page_errors == []
    assert [header["text"] for header in listed["headers"]] == ["Name"]
    assert [row["id"] for row in listed["rows"]] == ["row-targeted-amina", "row-targeted-baraka"]
    # Amina lives in Riverside, and the list no longer holds her village: the search finds no one.
    assert by_village["rows"] == [] and by_village["empty"] is not None
    # The accepted counterpart: a shown value finds her.
    assert [row["id"] for row in by_name["rows"]] == ["row-targeted-amina"] and by_name["empty"] is None


def test_web_apps_shows_no_header_and_no_cell_for_a_sort_only_column(
    hq, core_runner, formplayer_runner, editor_driver, webapps_documents, evidence
):
    with webapps_hq.project(webapps_documents[BROWSE], core_runner) as project:
        with project.released() as release:
            run = Session(project, release, formplayer_runner, editor_driver).run([*TO_THE_MENU, steps.SCREEN])
    handed = run.answered("navigate_menu")[-1].json()
    shown = run.screens[0]["list"]
    evidence("sort-only-column", {"headers": handed["headers"], "widthHints": handed["widthHints"], "shown": shown})
    # Formplayer hands the client nine columns, the last with no header and no width.
    assert len(handed["headers"]) == 9 and handed["headers"][-1] == "" and handed["widthHints"][-1] == 0
    assert all(hint > 0 for hint in handed["widthHints"][:-1])
    assert all(len(entity["data"]) == 9 for entity in handed["entities"])
    # The client shows the eight that have one, in order, and eight cells a row.
    assert [header["text"] for header in shown["headers"]] == handed["headers"][:-1]
    assert shown["rows"] and all(len(row["cells"]) == 8 for row in shown["rows"])
