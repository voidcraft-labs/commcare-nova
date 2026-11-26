"""What Web Apps shows of a search and of a case list's hidden columns, over Nova's exports.

- **Finding 54, the empty search description** (``case-list-browse``). HQ's
  Case List save writes a search description of no text for the page's
  language, and Nova's export now stores the same. Contract: Formplayer
  hands the client a non-breaking space for Nova's export and for the app
  after HQ's own Case List page saved it, and the client shows no
  description element for either, where it shows one, with the text, for a
  search that has a description (the accepted counterpart, which shows the
  reading would see one). Plausible failures: a client that renders the
  non-breaking space as a blank description (a difference a worker sees),
  or a reading that never finds a description at all.

  Search first is Nova's default workflow, and the same save must keep it:
  opening the menu reaches Search both before and after the save.

- **Defect 16, a column hidden from a list and the list's search**
  (``targeted-hidden-column``, with the cases the document's restore
  fixes, made by HQ's receiver). A column hidden from Results is a field of
  the list Nova uploads, HQ's ``invisible`` column. Contract: in Web Apps on
  HQ's build a search of the list for that column's value finds the case
  that holds it and no other, and the list still shows no header and no
  cell for the column. The plausible failures are a search that finds every
  case whatever it is asked, which the one row rules out, and a hidden
  column the client draws.

- **A sort-only column** (``case-list-browse``'s ``Hidden order``, and its
  calculated column hidden from Results). Contract: Formplayer hands the
  client each with an empty header and a width hint of 0, and the client
  shows neither a header nor a cell for them. The plausible failure is a
  client that shows an empty column.

- **A lookup-backed Search question's choices** (``prompt-widgets``, its
  worker in the table's group ``A``). Each itemset holds a ``<sort>`` on its
  label column, which HQ's Case List save requires. Contract: the client's
  drop-down for each of the two lookup prompts lists the choices in label
  order, where the table's row order differs. The plausible failure: a
  drop-down in row order, which a sort-less itemset gives.

- **A default search, and the worker's own search beside its results**
  (``targeted-search-workflow``'s "Recent patients", which skips to the
  results of its default search, with one visible field). Contract: the
  client enters the menu with no query data and Formplayer runs the default
  search; the client lays the search beside the results
  (``menus/utils.js::isSidebarEnabled``, from the ``queryResponse``
  Formplayer hands with them) and sends the worker's Search there with the
  search forced to be the worker's (``router.js``'s ``menu:query``,
  ``force_manual_search`` where the sidebar is enabled), which runs the one
  search that carries the answer; and Home drops the query data (the Home
  crumb, ``menus/views.js::BreadcrumbListView.onClickHome``, triggers
  ``app.js``'s ``navigateHome``, whose ``urlObject.clearExceptApp()``,
  ``utils/utils.js``, sets ``queryData`` to null before the app list
  shows), so entering the menu again runs the default search again. Plausible failures: a client
  that sends the sidebar's search without forcing it (Formplayer would run
  the default search instead), or query data that outlives Home (the menu
  would open on the worker's last search). Preview's ``manual`` search state
  and its standing rules (``lib/preview/searchStanding.ts``) play these.

The Search screen opens with the menu. Results are read only after the worker
submits that screen, as the search workflow requires.
"""

from __future__ import annotations

import dataclasses

import pytest

from proof.editors import pages
from proof.observe import casedata
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
    with webapps_hq.project(webapps_documents[BROWSE]) as project:
        to_the_search = [*TO_THE_MENU, steps.SCREEN]
        sides = {
            # Nova's export and HQ's Case List save both open Search directly.
            "nova": ({}, to_the_search),
            "saved": ({"saves": ((pages.CASE_LIST, project.module_id(0)),)}, [*TO_THE_MENU, steps.SCREEN]),
            "described": ({"change": _describe}, to_the_search),
        }
        observed = {}
        for name, (made, path) in sides.items():
            with project.released(formplayer_runner, driver=editor_driver, label=name, **made) as release:
                run = Session(release, editor_driver).run(path)
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
        assert nova["stored"] == {"description": {"en": ""}, "auto_launch": True}
        assert saved["stored"] == {"description": {"en": ""}, "auto_launch": True}
        assert nova["formplayer"] == [NBSP] and saved["formplayer"] == [NBSP]
        assert described["formplayer"] == [DESCRIPTION]

        # The client shows no description for either, and shows the one that has text.
        assert nova["search"] is not None and saved["search"] is not None
        assert nova["search"]["description"] is None
        assert saved["search"]["description"] is None
        assert described["search"]["description"]["text"].strip() == DESCRIPTION
        assert described["search"]["description"]["visible"] is True
        # The same prompts either way.
        assert nova["search"]["prompts"] == saved["search"]["prompts"] == described["search"]["prompts"]

        assert all(side["afterTheMenu"]["query"] for side in observed.values())


def test_web_apps_shows_no_description_on_an_inline_search_before_or_after_the_case_list_save(
    hq, core_runner, formplayer_runner, editor_driver, webapps_documents, evidence
):
    """The same equivalence where the search is part of the form's own entry (``case-list-inline``), the third
    class the register holds for finding 54: the menu opens the search itself on both builds."""
    with webapps_hq.project(webapps_documents["case-list-inline"]) as project:
        observed = {}
        for name, saves in (("nova", ()), ("saved", ((pages.CASE_LIST, project.module_id(0)),))):
            with project.released(formplayer_runner, saves=saves, driver=editor_driver, label=name) as release:
                run = Session(release, editor_driver).run([*TO_THE_MENU, steps.SCREEN])
                observed[name] = {
                    "stored": release.doc["modules"][0]["search_config"].get("description"),
                    "formplayer": [answer.get("description") for answer in _query_answers(run)],
                    "search": run.screens[0].get("query"),
                    "pageErrors": run.page_errors,
                }
        evidence("inline-search-description", observed)
        nova, saved = observed["nova"], observed["saved"]
        assert nova["pageErrors"] == [] and saved["pageErrors"] == []
        assert nova["stored"] == {"en": ""} and saved["stored"] == {"en": ""}
        assert nova["formplayer"] == [NBSP] and saved["formplayer"] == [NBSP]
        assert nova["search"] is not None and nova["search"]["prompts"]
        assert nova["search"]["description"] is None and saved["search"]["description"] is None
        assert nova["search"]["prompts"] == saved["search"]["prompts"]


def test_a_list_search_in_web_apps_finds_a_hidden_columns_value_and_shows_no_column_for_it(
    hq, core_runner, formplayer_runner, editor_driver, webapps_documents, evidence
):
    document = webapps_documents["targeted-hidden-column"]
    # The worker's cases are the ones the document's own restore fixes, made by HQ's receiver.
    database = casedata.database_of_restore((document.root / "restore.xml").read_bytes())
    with webapps_hq.project(document) as project:
        with project.released(formplayer_runner, database=database) as release:
            run = Session(release, editor_driver).run(
                [
                    *steps.open_app("Client villages"),
                    *steps.choose("Clients"),
                    steps.SCREEN,
                    *steps.search_list("Riverside"),
                    steps.SCREEN,
                ]
            )
    listed, by_village = (screen["list"] for screen in run.screens)
    evidence("hidden-column", {"listed": listed, "Riverside": by_village})
    assert run.page_errors == []
    assert [row["id"] for row in listed["rows"]] == ["row-targeted-amina", "row-targeted-baraka"]
    # Amina lives in Riverside, which only the hidden column holds: the search finds her alone.
    assert [row["id"] for row in by_village["rows"]] == ["row-targeted-amina"] and by_village["empty"] is None
    # The hidden column draws nothing: one header, Name, and one cell a row, before the search and after it.
    for shown in (listed, by_village):
        assert [header["text"] for header in shown["headers"]] == ["Name"]
        assert all(len(row["cells"]) == 1 for row in shown["rows"])


def test_a_saved_choice_and_its_label_show_in_default_order(
    hq, core_runner, formplayer_runner, editor_driver, webapps_documents, evidence
):
    document = webapps_documents["targeted-case-choice-values"]
    database = casedata.database_of_restore((document.root / "restore.xml").read_bytes())
    with webapps_hq.project(document) as project:
        with project.released(formplayer_runner, database=database) as release:
            run = Session(release, editor_driver).run([
                *steps.open_app("Village visits"), *steps.choose("Members"), steps.SCREEN,
            ])
    assert run.page_errors == []
    listed = run.screens[0]["list"]
    evidence("saved-choice-and-label", listed)
    assert [header["text"] for header in listed["headers"]] == ["Name", "Village", "Village code", "Unassigned", "Zone", "Visit priority", "Visit image", "Visit label"]
    assert [[cell["text"] for cell in row["cells"]] for row in listed["rows"]] == [
        ["Ana", "West", "a", "", "River zone", "Priority", "", "Visit Ana"],
        ["Cy", "past", "past", "Unassigned", "", "Routine", "", "Visit Cy"],
        ["Bea", "East", "z", "", "", "Routine", "", "Visit Bea"],
    ]
    image_cells = [row["cells"][6] for row in listed["rows"]]
    assert [cell["drawn"] for cell in image_cells] == [True, False, False]
    assert image_cells[0]["alt"] == "Assigned to east bank"


def test_reached_choice_columns_show_both_paths_in_each_web_apps_language(
    hq, core_runner, formplayer_runner, editor_driver, webapps_documents, evidence
):
    document = webapps_documents["targeted-reached-choice-columns"]
    database = casedata.database_of_restore((document.root / "restore.xml").read_bytes())
    with webapps_hq.project(document) as project:
        with project.released(formplayer_runner, database=database) as release:
            run = Session(release, editor_driver).run([
                *steps.open_app("Related areas"),
                *steps.choose("Members"),
                steps.SCREEN,
                *steps.choose_language("fr", steps.arrive(any_screen=True)),
                steps.SCREEN,
            ])
    assert run.page_errors == []
    observations = [
        [[cell["text"] for cell in row["cells"]] for row in screen["list"]["rows"]]
        for screen in run.screens
    ]
    evidence("web-apps-reached-choice-columns", observations)
    assert observations == [
        [["Ada", "East bank", "West bank", "Hello!"], ["Bea", "", "", "Hello!"]],
        [["Ada", "East bank", "West bank", "Bonjour!"], ["Bea", "", "", "Bonjour!"]],
    ]


def test_web_apps_shows_signed_relative_case_dates(
    hq, core_runner, formplayer_runner, editor_driver, webapps_documents, evidence
):
    document = webapps_documents["targeted-relative-case-dates"]
    database = casedata.database_of_restore((document.root / "restore.xml").read_bytes())
    with webapps_hq.project(document) as project:
        with project.released(formplayer_runner, database=database) as release:
            run = Session(release, editor_driver).run([
                *steps.open_app("Visit reminders"), *steps.choose("Members"), steps.SCREEN,
            ])
    assert run.page_errors == []
    listed = run.screens[0]["list"]
    evidence("relative-case-dates", listed)
    assert [header["text"] for header in listed["headers"]] == ["Name", "Months until", "Weeks since", "", "Message"]
    assert [[cell["text"] for cell in row["cells"]] for row in listed["rows"]] == [
        ["Ana", "1", "-4", "", "Bring the card"], ["Bea", "0", "0", "*", ""], ["Cy", "", "", "*", ""],
    ]


def test_an_independent_order_calculation_orders_the_visible_cases(
    hq, core_runner, formplayer_runner, editor_driver, webapps_documents, evidence
):
    document = webapps_documents["targeted-independent-case-order"]
    database = casedata.database_of_restore((document.root / "restore.xml").read_bytes())
    with webapps_hq.project(document) as project:
        with project.released(formplayer_runner, database=database) as release:
            run = Session(release, editor_driver).run([*steps.open_app("Appointments"), *steps.choose("Visits"), steps.SCREEN])
    (screen,) = run.screens
    shown = screen["list"]
    evidence("independent-order", shown)
    assert run.page_errors == []
    assert [header["text"] for header in shown["headers"]] == ["Name"]
    assert [row["id"] for row in shown["rows"]] == ["row-earlier-c", "row-earlier-z", "row-later", "row-missing"]
    assert all(len(row["cells"]) == 1 for row in shown["rows"])


def test_web_apps_shows_no_header_and_no_cell_for_a_sort_only_column(
    hq, core_runner, formplayer_runner, editor_driver, webapps_documents, evidence
):
    with webapps_hq.project(webapps_documents[BROWSE]) as project:
        with project.released(formplayer_runner) as release:
            run = Session(release, editor_driver).run(
                [*TO_THE_MENU, *steps.fill("#query-properties input", "a"), *steps.run_search(), steps.SCREEN]
            )
    handed = run.answered("navigate_menu")[-1].json()
    shown = run.screens[0]["list"]
    evidence("sort-only-column", {"headers": handed["headers"], "widthHints": handed["widthHints"], "shown": shown})
    # Formplayer hands the client ten columns, the last two (the hidden order column and the calculated column
    # hidden from Results) with no header and no width.
    assert len(handed["headers"]) == 10 and handed["headers"][-2:] == ["", ""] and handed["widthHints"][-2:] == [0, 0]
    assert all(hint > 0 for hint in handed["widthHints"][:-2])
    assert all(len(entity["data"]) == 10 for entity in handed["entities"])
    # The client shows the eight that have one, in order, and eight cells a row.
    assert [header["text"] for header in shown["headers"]] == handed["headers"][:-2]
    assert shown["rows"] and all(len(row["cells"]) == 8 for row in shown["rows"])


# Each Search question's label, and the text of each choice its drop-down lists, as the page holds them.
PROMPT_CHOICES = """() => [...document.querySelectorAll("#query-properties > tr")].map((row) => ({
    label: row.querySelector(".query-caption label")?.textContent.trim() ?? null,
    choices: [...row.querySelectorAll("select option")].map((option) => option.textContent.trim()).filter(Boolean),
}))"""


def test_web_apps_lists_a_lookup_prompts_choices_in_label_order(
    hq, core_runner, formplayer_runner, editor_driver, webapps_documents, evidence
):
    document = webapps_documents["prompt-widgets"]
    # The prompts list the table's rows of the worker's group (``group_name`` against their ``region_group``):
    # "North & coast" and then "East" in the table's row order.
    database = casedata.document_case_database(document)
    database = dataclasses.replace(
        database,
        user_data=(
            *((key, value) for key, value in database.user_data if key != "region_group"),
            ("region_group", "A"),
        ),
    )
    with webapps_hq.project(document) as project:
        with project.released(formplayer_runner, database=database) as release:
            run = Session(release, editor_driver).run(
                [
                    *steps.open_app("Inline"),
                    *steps.choose("Followup"),
                    steps.SCREEN,
                    {"eval": PROMPT_CHOICES},
                ]
            )
    prompts = {prompt["label"]: prompt["choices"] for prompt in run.value(-1)}
    evidence("lookup-choices", {"prompts": prompts, "query": run.screens[-1].get("query")})
    assert run.page_errors == [] and run.screens[-1].get("query") is not None
    assert prompts["Region"] == prompts["Regions"] == ["East", "North & coast"]


CHECKED_REGIONS = """() => [...document.querySelectorAll("fieldset.query-field input[type=checkbox]")].map(box =>
    [box.value, box.labels[0].textContent.trim(), box.checked])"""


def test_web_apps_submits_the_checked_regions_in_their_displayed_order(
    hq, core_runner, formplayer_runner, editor_driver, webapps_documents, evidence
):
    document = webapps_documents["prompt-checkboxes"]
    database = casedata.document_case_database(document)
    database = dataclasses.replace(
        database, user_data=(*((k, v) for k, v in database.user_data if k != "region_group"), ("region_group", "A"))
    )
    opening = [*steps.open_app("Inline"), *steps.choose("Followup"), steps.SCREEN]
    checking = steps.type_prompt(0, "east#,#north")
    with webapps_hq.project(document) as project:
        with project.released(formplayer_runner, database=database) as release:
            run = Session(release, editor_driver).run([
                *opening, {"eval": CHECKED_REGIONS}, *checking, {"eval": CHECKED_REGIONS},
                *steps.run_search(), steps.SCREEN,
            ])
    boxes = [run.value(len(opening)), run.value(len(opening) + 1 + len(checking))]
    requests = _menu_requests(run)
    submitted = [entry["inputs"]["regions"] for request in requests if request["searched"]
                 for entry in request["queryData"].values() if isinstance(entry, dict) and entry.get("execute")]
    evidence("checkbox-search", {"boxes": boxes, "submitted": submitted})
    assert run.page_errors == []
    assert boxes == [
        [["east", "East", False], ["north", "North & coast", True]],
        [["east", "East", True], ["north", "North & coast", True]],
    ]
    assert submitted == ["east#,#north"], requests


def test_search_shows_both_starting_ranges_and_sends_the_dates(hq, core_runner, formplayer_runner, editor_driver, webapps_documents, evidence):
    document = webapps_documents["prompt-periods"]
    opening = [*steps.open_app("Inline"), *steps.choose("Followup"), steps.SCREEN]
    observe = {"eval": "() => [...document.querySelectorAll('input.daterange')].map(field => field.value)"}
    with webapps_hq.project(document) as project:
        with project.released(formplayer_runner, database=casedata.document_case_database(document)) as release:
            run = Session(release, editor_driver).run([*opening, observe, *steps.run_search(), steps.SCREEN])
    displayed = run.value(len(opening))
    submitted = [entry["inputs"] for request in _menu_requests(run) if request["searched"]
                 for entry in request["queryData"].values() if isinstance(entry, dict) and entry.get("execute")]
    evidence("starting-search-ranges", {"displayed": displayed, "submitted": submitted})
    assert run.page_errors == []
    assert displayed == ["1/1/2024 to 12/31/2024", "3/10/2024 to 3/11/2024"]
    assert [(input["period"], input["visit_date"]) for input in submitted] == [
        ("__range__2024-01-01__2024-12-31", "__range__2024-03-10__2024-03-11")
    ]


def test_web_apps_shows_each_readable_date_before_the_worker_replaces_the_range(
    hq, core_runner, formplayer_runner, editor_driver, webapps_documents, evidence
):
    document = webapps_documents["prompt-period-spellings"]
    fields = "document.querySelectorAll('input.daterange')"
    opening = [*steps.open_app("Inline"), *steps.choose("Followup"), steps.SCREEN]
    read = {"eval": f"() => [...{fields}].map(field => field.value)"}
    # Setting a new pair and firing change runs the page's own date formatter
    # and query model handlers before its real Search button gathers the fields.
    replace = {"eval": f"""() => {{
        for (const input of {fields}) {{
            input.value = '6/1/2024 to 6/30/2024';
            input.dispatchEvent(new Event('change', {{bubbles: true}}));
        }}
    }}"""}
    with webapps_hq.project(document) as project:
        with project.released(formplayer_runner, database=casedata.document_case_database(document)) as release:
            run = Session(release, editor_driver).run([*opening, read, replace, *steps.run_search(), steps.SCREEN])
    displayed = run.value(len(opening))
    submitted = [entry["inputs"] for request in _menu_requests(run) if request["searched"]
                 for entry in request["queryData"].values() if isinstance(entry, dict) and entry.get("execute")]
    evidence("readable-search-dates", {"displayed": displayed, "submitted": submitted})
    assert run.page_errors == []
    assert displayed == ["1/2/2024 to 2/12/2024 to 5/21/2024", "3/10/2024"]
    assert [(item["period"], item["visit_date"]) for item in submitted] == [
        ("__range__2024-06-01__2024-06-30", "__range__2024-06-01__2024-06-30")
    ]


def test_web_apps_submits_a_workers_range_with_midnight_rollover_and_hour_offset(
    hq, core_runner, formplayer_runner, editor_driver, webapps_documents, evidence
):
    document = webapps_documents["prompt-period-held"]
    database = casedata.document_case_database(document)
    raw = "__range__2024-01-02T24:00:00Z__2024-01-04T00:00:00+00"
    database = dataclasses.replace(database, user_data=(
        *((key, value) for key, value in database.user_data if key != "region_group"),
        ("region_group", raw),
    ))
    opening = [*steps.open_app("Inline"), *steps.choose("Followup"), steps.SCREEN]
    observe = {"eval": "() => document.querySelector('input.daterange').value"}
    with webapps_hq.project(document) as project:
        with project.released(formplayer_runner, database=database) as release:
            run = Session(release, editor_driver).run([*opening, observe, *steps.run_search(), steps.SCREEN])
    shown = run.value(len(opening))
    submitted = [entry["inputs"]["period"] for request in _menu_requests(run) if request["searched"]
                 for entry in request["queryData"].values() if isinstance(entry, dict) and entry.get("execute")]
    evidence("midnight-starting-dates", {"raw": raw, "displayed": shown, "submitted": submitted})
    assert run.page_errors == []
    assert shown == "1/3/2024 to 1/4/2024"
    assert submitted == ["__range__2024-01-03__2024-01-04"]


BLANK_BOX = """() => [...document.querySelectorAll("input.search-for-blank")].map(box =>
    [box.id, box.labels[0].textContent.trim(), box.checked])"""


def test_web_apps_sends_a_ticked_search_for_blank_before_the_answer(
    hq, core_runner, formplayer_runner, editor_driver, webapps_documents, evidence
):
    """Nova's Name field allows a search for blank: Web Apps draws HQ's box under it and sends the blank before the
    answer (``query.js::encodeValue``), the value Nova's Preview sends for the same answers
    (``completedSearchRequest.test.ts``)."""
    document = webapps_documents["prompt-checkboxes"]
    database = casedata.document_case_database(document)
    database = dataclasses.replace(
        database, user_data=(*((k, v) for k, v in database.user_data if k != "region_group"), ("region_group", "A"))
    )
    opening = [*steps.open_app("Inline"), *steps.choose("Followup"), steps.SCREEN]
    naming = steps.type_prompt(1, "Amina")
    ticking = steps.click("input.search-for-blank")
    with webapps_hq.project(document) as project:
        with project.released(formplayer_runner, database=database) as release:
            run = Session(release, editor_driver).run([
                *opening, {"eval": BLANK_BOX}, *naming, *ticking, {"eval": BLANK_BOX},
                *steps.run_search(), steps.SCREEN,
            ])
    boxes = [run.value(len(opening)), run.value(len(opening) + 1 + len(naming) + len(ticking))]
    requests = _menu_requests(run)
    submitted = [entry["inputs"].get("first_name") for request in requests if request["searched"]
                 for entry in request["queryData"].values() if isinstance(entry, dict) and entry.get("execute")]
    evidence("search-for-blank", {"boxes": boxes, "submitted": submitted})
    assert run.page_errors == []
    assert [[label for _, label, _ in shown] for shown in boxes] == [
        ["Include results where 'Name' is blank"]
    ] * 2
    assert [[checked for _, _, checked in shown] for shown in boxes] == [[False], [True]]
    assert submitted == ["#,#Amina"], requests


DEFAULT_SEARCH = "targeted-search-workflow"
TO_RECENT = steps.path(steps.open_app("Search workflows"), steps.choose("Recent patients"))
TYPED = "Amina"
# Where HQ's case search views answer Formplayer (``ota/urls.py``, under ``/a/<domain>/phone/``).
HQ_SEARCH = "/phone/search/"


def _menu_requests(run):
    """Each menu navigation the client asked of Formplayer: its query data, what Formplayer answered, and whether
    Formplayer searched HQ to answer it."""
    found = []
    for exchange in run.answered("navigate_menu"):
        asked = exchange.request_json() or {}
        found.append(
            {
                "selections": asked.get("selections"),
                "queryData": asked.get("query_data") or {},
                "screen": exchange.json().get("type"),
                "searched": any(HQ_SEARCH in path for _, path in exchange.asked),
            }
        )
    return found


def test_web_apps_forces_the_sidebars_search_and_runs_the_default_search_again_after_home(
    hq, core_runner, formplayer_runner, editor_driver, webapps_documents, evidence
):
    with webapps_hq.project(webapps_documents[DEFAULT_SEARCH]) as project:
        with project.released(formplayer_runner) as release:
            run = Session(release, editor_driver).run(
                [
                    *TO_RECENT,
                    steps.SCREEN,
                    *steps.type_prompt(0, TYPED),
                    *steps.run_search(),
                    steps.SCREEN,
                    *steps.click(steps.HOME),
                    *TO_RECENT,
                    steps.SCREEN,
                ]
            )
    requests = _menu_requests(run)
    defaulted, searched, again = run.screens
    evidence(
        "default-search-sidebar",
        {
            "requests": requests,
            "screens": [{key: screen.get(key) for key in ("list", "query")} for screen in run.screens],
        },
    )
    assert run.page_errors == []
    # Each time the menu is entered it runs its default search, with no query data, and the search shows beside
    # the results.
    entered = [request for request in requests if request["selections"] == ["2"] and not request["queryData"]]
    assert [(request["screen"], request["searched"]) for request in entered] == [("entities", True)] * 2, requests
    for screen in (defaulted, again):
        assert screen.get("list") is not None and screen.get("query") is not None, screen
        assert screen["query"]["beside"] is True, screen["query"]
    # The worker's Search beside the results: one request that runs a search, forced to be the worker's, with the
    # answer typed, answered with the results.
    executed = [
        request
        for request in requests
        if any(isinstance(entry, dict) and entry.get("execute") for entry in request["queryData"].values())
    ]
    assert len(executed) == 1, requests
    [entry] = executed[0]["queryData"].values()
    assert entry.get("force_manual_search") is True, entry
    assert TYPED in (entry.get("inputs") or {}).values(), entry
    assert (executed[0]["screen"], executed[0]["searched"]) == ("entities", True)
    assert searched.get("list") is not None, searched
    # Asking whether the typed prompt holds sends HQ no search.
    checked = [
        request
        for request in requests
        if request["queryData"] and request not in executed and request["selections"] == ["2"]
    ]
    assert checked and not any(request["searched"] for request in checked), requests

@pytest.mark.parametrize("enabled", [False, True])
def test_web_apps_case_map_follows_the_project_space_toggle(
    enabled, hq, core_runner, webapps_documents, formplayer_runner, editor_driver, evidence,
):
    document = webapps_documents["targeted-case-map"]
    database = casedata.database_of_restore((document.root / "restore.xml").read_bytes())
    with webapps_hq.project(document, case_list_map=enabled) as project:
        with project.released(formplayer_runner, database=database) as release:
            run = Session(release, editor_driver).run([
                *steps.open_app("Coverage map"), *steps.choose("Places"), steps.SCREEN,
            ])
    assert run.page_errors == []
    listed = run.screens[0]["list"]
    evidence("project-map-enabled" if enabled else "project-map-disabled", listed)
    assert listed["mapOffered"] is enabled
    assert len(listed["rows"]) == 2

def test_clear_search_requests_new_results_only_from_a_desktop_query(
    hq, core_runner, formplayer_runner, editor_driver, webapps_documents, evidence
):
    with webapps_hq.project(webapps_documents[DEFAULT_SEARCH]) as project:
        with project.released(formplayer_runner) as release:
            for width in (991, 992):
                small = steps.open_sidebar() if width < 992 else []
                run = Session(release, editor_driver).run(
                    [
                        *TO_RECENT,
                        *small,
                        *steps.type_prompt(0, TYPED),
                        *steps.run_search(),
                        *small,
                        *steps.clear_prompts(),
                        steps.SCREEN,
                    ],
                    viewport={"width": width, "height": 760},
                )
                searched = [request for request in _menu_requests(run) if request["searched"]]
                evidence(f"clear-search-{width}", {"requests": searched, "screen": run.screens[-1]})
                # One default search as the menu opens, one explicit submission with the named patient,
                # and a separate cleared request only on the wide screen.
                assert len(searched) == (3 if width == 992 else 2), searched
                sent = next(entry for entry in searched[1]["queryData"].values() if entry.get("execute"))
                assert TYPED in sent["inputs"].values(), sent
                if width == 992:
                    cleared = next(entry for entry in searched[2]["queryData"].values() if entry.get("execute"))
                    assert not any((cleared.get("inputs") or {}).values()), cleared
                assert not run.page_errors, run.page_errors
