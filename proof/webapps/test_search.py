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
import io
import json
from pathlib import Path
import zipfile

import pytest
from lxml import etree

from proof.editors import pages
from proof.observe import casedata
from proof.webapps import hq as webapps_hq
from proof.webapps import steps
from proof.webapps.session import Session

BROWSE = "case-list-browse"
TO_THE_MENU = steps.path(steps.open_app("Case list proof"), steps.choose("Patients & visits"))
DESCRIPTION = "Find a patient by code."
NBSP = "\u00a0"


def test_authored_search_keeps_its_list_filter_out_of_the_request(
    hq, formplayer_runner, editor_driver, webapps_documents, evidence
):
    """The same Web-only Visits route keeps the device clause on its list in A and B."""
    folder = Path(__file__).with_name("fixtures")
    witness = json.loads((folder / "web-apps-search-filter.json").read_text(encoding="utf-8"))
    database = casedata.database_of_restore((folder / witness["restore"]).read_bytes())
    document = webapps_documents["hq-search"]

    def enable_web_apps(app):
        # On A this corresponds to enabling the project’s existing Web Apps
        # setting before serving the authored app. Its Search stays untouched.
        app["cloudcare_enabled"] = True

    for publication in ("A", "B"):
        with (
            webapps_hq.authored_project(document, publication) as project,
            project.released(
                formplayer_runner,
                change=enable_web_apps if publication == "A" else None,
                database=database,
                label=publication,
            ) as release,
        ):
            run = Session(release, editor_driver).run([
                *steps.open_app("Client search"),
                *steps.choose(witness["menu"]),
                *steps.arrive(any_screen=True),
                steps.SCREEN,
                *steps.click(steps.SEARCH_BUTTON, visible=True, within=steps.WITHIN_MS),
                *steps.arrive(any_screen=True),
                steps.SCREEN,
            ])
            requests = [search.values("_xpath_query") for search in release.hq.searches]
            orders = [search.values("commcare_sort") for search in release.hq.searches]
        evidence(f"authored-visits-filter-{publication}", {
            "requests": requests, "orders": orders, "screens": run.screens, "queryAnswers": _query_answers(run),
            "stepOutcomes": run.outcomes,
        })
        assert run.page_errors == [] and run.dialogs == []
        query, results = run.screens
        assert "query-submit-button" in query["query"]["buttons"], query
        assert not any(outcome.get("missed") for outcome in run.outcomes), run.outcomes
        assert requests == [(witness["query"],)], requests
        expected_order = {
            "A": ("+-client_code:exact,-dob:date", "+name:exact:obsolete"),
            "B": ("+client_code:exact,-dob:date", "+name:exact"),
        }
        assert orders == [expected_order[publication]], orders
        assert [row["id"] for row in results["list"]["rows"]] == [f"row-{case_id}" for case_id in witness["rows"]]


def test_authored_blank_comparison_resets_sort_without_the_explicit_orders_missing_rule(
    hq, formplayer_runner, editor_driver, webapps_documents, evidence, monkeypatch,
):
    """The retained reset and an explicit three-comparison spelling select different capped matches."""
    from corehq import privileges
    from corehq.apps.case_search import utils as case_search
    from django.core.files.uploadedfile import SimpleUploadedFile
    from django.test.client import BOUNDARY, MULTIPART_CONTENT, encode_multipart

    from proof.hq import operations
    from proof.hq import redis as hq_redis
    from proof.hq.seams import also_granted, api_rate_limits
    from proof.matrix import ops, registry, retain
    from proof.matrix.authoring import Authoring

    document = webapps_documents["hq-search"]
    factory = casedata.database_of_restore(
        (Path(__file__).with_name("fixtures") / "restore-search-filter.xml").read_bytes()
    )
    cases = (
        ("two-earlier", "2", "2024-01-01"),
        ("two-later", "2", "2025-01-01"),
        ("ten", "10", "2027-01-01"),
        ("letter", "alpha", "2026-01-01"),
        ("other-district", "1", "2028-01-01"),
        ("not-active", "1", "2028-01-01"),
    )
    database = dataclasses.replace(factory, cases=tuple(
        dataclasses.replace(
            factory.cases[0], case_id=case_id, name=case_id,
            properties=(
                ("standing", "inactive" if case_id == "not-active" else "active"),
                ("district", "d2" if case_id == "other-district" else "d1"),
                ("priority", priority), ("visit", visit),
            ),
        )
        for case_id, priority, visit in cases
    ))
    # Keep the real HQ receiver and index. A small cap makes the records
    # selected by the query observable even if the worker list sorts again.
    monkeypatch.setattr(case_search, "CASE_SEARCH_MAX_RESULTS", 2)
    controls = (
        ("retained-reset", ("-visit:date", "+priority::ignored", "-visit:date"), ("two-later", "two-earlier")),
        ("masked-comparison", ("++priority:unknown", "+priority::ignored", "-visit:date"), ("two-later", "two-earlier")),
        ("republished-masked-comparison", ("++priority:unknown", "+priority::ignored", "-visit:date"), ("two-later", "two-earlier")),
        ("nova-republish", ("-visit:date", "+priority::ignored", "-visit:date"), ("two-later", "two-earlier")),
        ("mixed-index-reset", ("-visit:date,+priority::obsolete",), ("two-earlier", "two-later")),
        ("explicit-order", ("+priority:numeric,+priority:date,+priority:exact,-visit:date",), ("letter", "two-later")),
    )
    for label, terms, expected in controls:
        with webapps_hq.authored_project(document, "A") as project:
            author = Authoring(project.unit, webapps_documents, document.id, operation=project.unit.operation)
            if label in ("retained-reset", "nova-republish"):
                registry.named_change("default_filter_resets_earlier_sort")(author, project.app_id)
            elif label in ("masked-comparison", "republished-masked-comparison"):
                registry.named_change("default_filter_reset_masks_an_unknown_comparison")(author, project.app_id)
            else:
                ops.set_json(author, project.app_id, "/modules/1/search_config/default_properties/-", {
                    "property": "commcare_sort", "doc_type": "DefaultCaseSearchProperty", "defaultValue": f"'{terms[0]}'",
                })
            with project.unit.operation("enable-web-apps", b"enabled"):
                app = operations.held_app(project.unit, project.app_id)
                app.cloudcare_enabled = True
                app.save()
            if label in ("nova-republish", "republished-masked-comparison"):
                state = project.unit
                with hq_redis.shared(None), state.committing(), also_granted(privileges.API_ACCESS), api_rate_limits(state):
                    with state.operation("read-first-publish", b"retained-search-reset"):
                        credential = operations.seed_api_user(
                            state, f"api-{project.domain}@example.com", edit_locations=True
                        )
                    answers = retain.app_reads(author, project.app_id, credential)
                    project_answers, media = retain.project_data_reads(author, project.app_id, credential)
                source = retain.reading_input(answers, project_answers, media, registry.base(document.id), claims="full")
                [read] = retain.run_bundle([{
                    "id": ("hq-search/default-filter-reset-masks-an-unknown-comparison"
                           if label == "republished-masked-comparison" else "hq-search/default-filter-resets-earlier-sort"),
                    "mode": "first-read", "input": source,
                    "emitApplication": {"appId": project.app_id, "domain": project.domain},
                }])
                assert read["kind"] == "read", read
                order_changes = [
                    path for change in read["firstPublishPlaces"] if change["id"].startswith("search-order-")
                    for path in change["places"] if path.startswith("/menu/1/search_config/default_properties/")
                ]
                assert order_changes == [], order_changes
                application = read["application"]
                upload = operations.Upload(encode_multipart(BOUNDARY, {
                    "app_id": project.app_id,
                    "app_name": application["name"],
                    "app_file": SimpleUploadedFile("app.json", json.dumps(application).encode(), "application/json"),
                }), MULTIPART_CONTENT)
                with project.unit.operation("first-publish", b"retained-search-reset"):
                    result = operations.apply_upload(project.unit, upload)
                assert result.status == 200 and result.response["success"], result
            with project.released(
                formplayer_runner, driver=editor_driver, saves=((pages.CASE_SEARCH, project.module_id(1)),),
                database=database, label=label,
            ) as release:
                defaults = release.doc["modules"][1]["search_config"]["default_properties"]
                saved = tuple(row["defaultValue"] for row in defaults if row["property"] == "commcare_sort")
                with zipfile.ZipFile(io.BytesIO(release.archive())) as archive:
                    suite = etree.fromstring(archive.read("suite.xml"))
                query = suite.xpath("//query[data[@key='commcare_sort'] and data[@key='_xpath_query']]")
                built = [tuple(each.xpath("data[@key='commcare_sort']/@ref")) for each in query]
                assert saved == tuple(f"'{term}'" for term in terms)
                assert saved in built, built
                release.hq.capture_search_fixtures = True
                run = Session(release, editor_driver).run([
                    *steps.open_app("Client search"), *steps.choose("Active clients"),
                    *steps.arrive(any_screen=True), steps.SCREEN,
                ], deadline=75)
                request, = [item for item in release.hq.searches if item.values("commcare_sort")]
                returned = tuple(etree.fromstring(request.fixture).xpath("//*[local-name()='case']/@case_id"))
            screen, = run.screens
            evidence(label, {"saved": saved, "built": built, "parameters": request.params,
                             "matches": returned, "screen": screen})
            assert request.values("commcare_sort") == terms
            if label == "mixed-index-reset":
                assert set(returned) == set(expected), returned
            else:
                assert returned == expected, returned
            assert {row["id"] for row in screen["list"]["rows"]} == {f"row-{case_id}" for case_id in expected}
            assert not run.page_errors and not run.dialogs


def test_retained_guarded_name_search_messages(
    hq, formplayer_runner, editor_driver, webapps_documents, evidence
):
    """Keep the retained Clients assertion in pinned native Web Apps, including its worker message."""
    from dataclasses import replace
    from io import BytesIO
    from types import SimpleNamespace
    from zipfile import ZipFile

    from proof.checks import changes, proof2
    from proof.checks.compare.xml_tree import compare_xml
    from proof.checks.xpath_tree import same
    from proof.matrix import registry

    variant = next(
        variant for variant in registry.load_variants()
        if variant.id == "hq-search/check-with-no-message-on-a-guarded-field"
    )
    [assertion] = variant.change["value"]
    document = webapps_documents["hq-search"]
    folder = Path(__file__).with_name("fixtures")
    restore = (folder / "restore-search-filter.xml").read_bytes()
    database = casedata.database_of_restore(restore.replace(b"Matching client", b"amina"))
    guard_message = (
        "This search can't use both single and double quotation marks. Remove one kind and try again"
    )
    observations = {}
    suites = {}
    stored = {}
    for label in ("authored", "merged-without-message", "guard-only", "guard-without-message"):
        publication = "A" if label == "authored" else "B"
        with webapps_hq.authored_project(document, publication) as project:
            def apply(app):
                app["cloudcare_enabled"] = True
                field = app["modules"][0]["search_config"]["properties"][0]
                if label == "authored":
                    field["validations"] = [dict(assertion)]
                elif label == "guard-without-message":
                    [guard] = field["validations"]
                    field["validations"] = [{"test": guard["test"], "text": {}, "doc_type": "Assertion"}]
                elif label == "merged-without-message":
                    [guard] = field["validations"]
                    # B supplies the actual compiler's guard and its protected
                    # query wrapper. This reconstructs the narrow reader proof's
                    # authorized change to the stored validation.
                    field["validations"] = [{
                        **assertion, "test": f"({assertion['test']}) and ({guard['test']})",
                    }]
            with project.released(formplayer_runner, change=apply, database=database, label=label) as release:
                run = Session(release, editor_driver).run([
                    *steps.open_app("Client search"),
                    *steps.choose("Clients"),
                    *steps.choose("Followup Form"),
                    *steps.arrive(any_screen=True),
                    steps.SCREEN,
                    *steps.type_prompt(0, "Amina"),
                    steps.SCREEN,
                    *steps.type_prompt(0, "a'\""),
                    steps.SCREEN,
                    *steps.click(steps.SEARCH_BUTTON, visible=True, within=steps.WITHIN_MS),
                    steps.SCREEN,
                    *steps.type_prompt(0, ""),
                    steps.SCREEN,
                    *steps.type_prompt(0, "amina"),
                    steps.SCREEN,
                    *steps.run_search(),
                    *steps.arrive(any_screen=True),
                    steps.SCREEN,
                ])
                with ZipFile(BytesIO(release.archive())) as archive:
                    suites[label] = archive.read("suite.xml")
                stored[label] = release.doc
                requests = [search.values("_xpath_query") for search in release.hq.searches]
            observation = {
                "requests": requests, "screens": run.screens, "queryAnswers": _query_answers(run),
                "menuRequests": _menu_requests(run), "outcomes": run.outcomes,
                "pageErrors": run.page_errors, "dialogs": run.dialogs,
            }
            evidence(f"retained-name-search-{label}", observation)
            observations[label] = observation

    for label, observed in observations.items():
        assert observed["pageErrors"] == [] and observed["dialogs"] == [], observed
        assert not any(outcome.get("missed") for outcome in observed["outcomes"]), observed
        initial, upper, quotes, refused, blank, lower, results = observed["screens"]
        assert initial["query"]["prompts"][0]["label"] == "Name", initial
        errors = [screen["query"]["prompts"][0]["error"] for screen in (initial, upper, quotes, refused, blank, lower)]
        assert not errors[0] and not errors[4] and not errors[5], errors
        expected = guard_message if label == "guard-only" else "Sorry, this response is invalid!"
        if label in ("guard-only", "guard-without-message"):
            assert not errors[1], errors
        else:
            assert errors[1] == expected, errors
        assert errors[2:4] == [expected, expected], errors
        expected_clause = "case_name = 'amina'" if label == "authored" else 'case_name = "amina"'
        [request] = observed["requests"]
        assert expected_clause in request, request
        assert [row["id"] for row in results["list"]["rows"]] == ["row-client-both"], results


    # A and B both already carry one native validation. The suite comparator
    # sees the changed @test at that object's position rather than a new node.
    before, after = (suites[side] for side in ("authored", "merged-without-message"))
    exact_changes = [
        diff for diff in compare_xml(before, after, check="proof2", document=variant.id, artifact="suite.xml")
        if diff.kind == "changed" and diff.path.endswith("/validation[*]/@test")
        and isinstance(diff.before, str) and same(diff.before, assertion["test"])
    ]
    evidence("retained-name-search-native-validation-changes", [diff.as_json() for diff in exact_changes])
    assert exact_changes
    sites = proof2.build_sites({"suite.xml": before}, stored["authored"])
    document_under_change = SimpleNamespace(
        id=variant.id, hq_authored=True,
        first_publish_places={"search-value-guards": ("/menu/0/search_config/properties/0/validations",)},
    )
    allowed, named = changes.declared(document_under_change, "proof2", exact_changes, sites=sites)
    assert allowed == exact_changes and named == {"search-value-guards"}

    original = exact_changes[0]
    unsafe_changes = [
        replace(original, after=original.before.replace("^[a-z]+$", "^.+$")),
        replace(original, after=original.after.replace("^[a-z]+$", "^.+$")),
        replace(original, after=original.after.replace("client_name", "village")),
        replace(original, after=f"({original.after}) and true()"),
    ]
    allowed, _ = changes.declared(document_under_change, "proof2", unsafe_changes, sites=sites)
    assert allowed == []
    neighboring_field = SimpleNamespace(
        id=variant.id, hq_authored=True,
        first_publish_places={"search-value-guards": ("/menu/0/search_config/properties/1/validations",)},
    )
    assert changes.declared(neighboring_field, "proof2", exact_changes, sites=sites)[0] == []



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


def test_search_lookup_filter_orders_text_as_numbers(
    hq, formplayer_runner, editor_driver, webapps_documents, evidence
):
    from corehq.apps.fixtures.models import Field, LookupTable, LookupTableRow

    from proof.editors import pages
    from proof.matrix import ops, registry
    from proof.matrix.authoring import Authoring
    from proof.observe.search_address import enable_address_search

    document = webapps_documents["hq-search"]
    variant = next(row for row in registry.load_variants()
                   if row.id == "hq-search/choices-filtered-by-an-ordered-text")
    observed = {}
    for label, predicate, expected in (
        ("lexical-right", "name > 'm'", []),
        ("explicit-number", "number(name) > number('m')", []),
        ("numeric-right", "name > '1'", ["2"]),
        ("text-column-right", "name > id", ["10"]),
        ("two-numbers", "number(name) > number(id)", ["10"]),
        ("text-column-below", "name < id", ["2"]),
        ("text-column-below-or-equal", "name <= id", ["2"]),
        ("text-column-above-or-equal", "name >= id", ["10"]),
    ):
        with webapps_hq.authored_project(document, "A", configure=enable_address_search) as project:
            authoring = Authoring(project.unit, {}, document.id, operation=project.unit.operation)
            source = variant.change["value"]
            itemset = {**source["itemset"], "nodeset": source["itemset"]["nodeset"].replace("name > 'm'", predicate)}
            ops.set_json(authoring, project.app_id, variant.change["pointer"], {**source, "itemset": itemset})
            table = LookupTable.objects.get(domain=project.unit.domain, tag="districts")
            with project.unit.operation("search-choice-value-controls", label.encode()):
                rows = LookupTableRow.objects.filter(domain=project.unit.domain, table=table).order_by("sort_key", "id")
                for index, row in enumerate(rows):
                    if label.startswith("text-column-") or label == "two-numbers":
                        row.fields["id"] = [Field(value=["2", "10"][index], properties={})]
                        names = ["10", "2"]
                        if label == "text-column-below-or-equal":
                            names = ["2", "11"]
                        if label == "text-column-above-or-equal":
                            names = ["1", "10"]
                        row.fields["name"] = [Field(value=names[index], properties={})]
                    else:
                        row.fields["name"] = [Field(value=str(2 * index), properties={})]
                    row.save()
            from proof.hq import operations
            app = operations.held_app(project.unit, project.app_id)
            app.cloudcare_enabled = True
            app.save()
            menu_id = project.module_id(0)
            saved = pages.fresh_section_save(editor_driver, project.unit, pages.CASE_LIST, project.app_id, menu_id)
            assert saved.save and saved.save.status == 200 and not saved.refused
            with project.released(formplayer_runner) as release:
                run = Session(release, editor_driver).run([
                    *steps.open_app("Client search"), *steps.choose("Clients"), *steps.choose("Followup Form"),
                    *steps.arrive(any_screen=True), steps.SCREEN, {"eval": PROMPT_CHOICES},
                ])
        prompts = {row["label"]: row["choices"] for row in run.value(-1)}
        observed[label] = {"choices": prompts, "errors": run.page_errors}
        assert not run.page_errors and prompts["District"] == expected, observed[label]
    evidence("lookup-number-order", observed)


def test_a_stored_search_choice_reads_open_cases_from_the_worker_restore(
    hq, formplayer_runner, editor_driver, webapps_documents, evidence,
):
    from proof.hq import operations
    from proof.matrix import ops, registry
    from proof.matrix.authoring import Authoring
    from proof.observe.search_address import enable_address_search

    document = webapps_documents["hq-search"]
    variant = next(row for row in registry.load_variants() if row.id == "hq-search/choices-read-from-open-cases")
    seed = casedata.document_case_database(document)
    client = next(case for case in seed.cases if case.case_type == "client")
    cases = tuple(
        dataclasses.replace(client, case_id=key, name=name, case_type=case_type, owner_id=owner, indices=())
        for key, name, case_type, owner in (
            ("open-z", "Zebra", "client", seed.user_id),
            ("other-type", "Beta", "household", seed.user_id),
            ("open-a", "Alpha", "client", seed.user_id),
            ("other-worker", "Gamma", "client", "somebody-else"),
        )
    )
    with webapps_hq.authored_project(document, "A", configure=enable_address_search) as project:
        author = Authoring(project.unit, {}, document.id, operation=project.unit.operation)
        ops.set_json(author, project.app_id, variant.change["pointer"], variant.change["value"])
        app = operations.held_app(project.unit, project.app_id)
        app.cloudcare_enabled = True
        app.save()
        with project.released(
            formplayer_runner, database=dataclasses.replace(seed, cases=cases),
            label="search-choices-from-case-data",
        ) as release:
            run = Session(release, editor_driver).run([
                *steps.open_app("Client search"), *steps.choose("Clients"), *steps.choose("Followup Form"),
                *steps.arrive(any_screen=True), steps.SCREEN, {"eval": PROMPT_CHOICES},
            ])
            observed = {
                "prompts": run.value(-1), "screens": run.screens, "errors": run.page_errors, "dialogs": run.dialogs,
                "stored": release.doc["modules"][0]["search_config"]["properties"][5]["itemset"],
            }
            evidence("search-choices-from-case-data", observed)
            prompts = {row["label"]: row["choices"] for row in observed["prompts"]}
            assert not run.page_errors and not run.dialogs, observed
            assert observed["stored"]["nodeset"] == variant.change["value"]["itemset"]["nodeset"], observed
            assert prompts.get("District") == ["Alpha", "Zebra"], observed


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

def test_web_apps_opens_the_form_with_both_named_search_answers(
    hq, core_runner, formplayer_runner, editor_driver, webapps_documents, evidence
):
    """The form reads two completed searches. The same prompt key has different answers."""
    document = webapps_documents["search-named-parent"]
    database = casedata.document_case_database(document)
    parent = next(row for row in database.cases if row.case_type == "parent_case")
    child = next(row for row in database.cases if row.case_type == "patient")
    parent = dataclasses.replace(parent, name="North")
    child = dataclasses.replace(child, name="River", properties=(("first_name", "West"),),
                                indices=(("parent", parent.case_type, parent.case_id, "child"),))
    database = dataclasses.replace(database, cases=(parent, child))
    observed = {}
    with webapps_hq.project(document) as project:
        for name, saves in (("published", ()), ("saved", tuple(
            (pages.CASE_LIST, project.module_id(index)) for index in (0, 1)
        ))):
            with project.released(formplayer_runner, database=database, saves=saves, driver=editor_driver, label=name) as release:
                path = [*steps.open_app("Inline"), *steps.choose("Followup")]
                for record, answer in ((parent, "North"), (child, "West")):
                    path.extend([
                        *steps.type_prompt(0, answer), *steps.run_search(), steps.SCREEN,
                        *steps.click(f"#menu-region [id='row-{record.case_id}']"),
                        *steps.click(steps.CONTINUE, visible=True, within=steps.WITHIN_MS),
                    ])
                # A menu with form selection after its cases may still offer the form by name.
                path.extend(steps.click(steps.MENU_ROW, "Untitled Form", visible=True, within=steps.WITHIN_MS))
                run = Session(release, editor_driver).run([*path, steps.SCREEN])
                observed[name] = {
                    "answers": [question["answer"] for question in run.screens[-1]["form"]["questions"]],
                    "caseLists": [[row["id"] for row in screen["list"]["rows"]] for screen in run.screens[:-1]],
                    "names": [menu["search_config"]["instance_name"] for menu in release.doc["modules"]],
                    "pageErrors": run.page_errors,
                }
    evidence("named-search-answers", observed)
    for result in observed.values():
        assert result["pageErrors"] == []
        assert result["caseLists"] == [[f"row-{parent.case_id}"], [f"row-{child.case_id}"]]
        assert result["names"] == ["MemberLookup", "FamilyLookup"]
        assert result["answers"] == ["North/West"]


def test_web_apps_keeps_grouped_search_headings_and_answers_after_hq_save(
    hq, core_runner, formplayer_runner, editor_driver, webapps_documents, evidence
):
    document = webapps_documents["search-grouped-prompts"]
    headings = """() => [...document.querySelectorAll('.search-query-group-header-label')]
        .map(label => label.textContent.trim())"""
    collapse_second = """async () => {
        const content = document.getElementById('group-group_header_2');
        const closed = new Promise(resolve => content.addEventListener('hidden.bs.collapse', resolve, {once: true}));
        document.querySelector('[data-bs-target="#group-group_header_2"]').click();
        await closed;
        return getComputedStyle(content).display === 'none';
    }"""
    observed = {}
    with webapps_hq.project(document) as project:
        for name, saves in (("published", ()), ("saved", ((pages.CASE_LIST, project.module_id(0)),))):
            with project.released(formplayer_runner, saves=saves, driver=editor_driver, label=name) as release:
                opening = [*steps.open_app("Inline"), *steps.choose("Followup"), steps.SCREEN]
                path = [
                    *opening,
                    {"eval": headings},
                    *steps.type_prompt(0, "North"),
                    *steps.type_prompt(1, "River"),
                    {"eval": collapse_second},
                    *steps.run_search(),
                    steps.SCREEN,
                ]
                run = Session(release, editor_driver).run(path)
                sent = [
                    entry["inputs"]
                    for request in _menu_requests(run)
                    if request["searched"]
                    for entry in request["queryData"].values()
                    if isinstance(entry, dict) and entry.get("execute")
                ]
                observed[name] = {
                    "headings": run.value(len(opening)),
                    "collapsed": run.value(len(opening) + 1 + 2 * len(steps.type_prompt(0, ""))),
                    "inputs": sent,
                    "pageErrors": run.page_errors,
                }
    evidence("grouped-search-headings", observed)
    for side in observed.values():
        assert side["headings"] == ["Personal details", "Case details"]
        assert side["collapsed"] is True
        assert side["inputs"] == [{"first_name": "North", "case_name": "River"}]
        assert side["pageErrors"] == []



@pytest.mark.parametrize("group_key", ["group_header_0", "g"], ids=["current", "saved-legacy"])
def test_web_apps_shows_the_uploaded_search_group_heading_after_hq_save(
    hq, formplayer_runner, editor_driver, webapps_documents, evidence, group_key
):
    from proof.hq import operations
    from proof.matrix import ops
    from proof.matrix.authoring import Authoring

    document = webapps_documents["search-grouped-prompts"]
    current_group = "group_header_0"
    key = f"search_property.m0.{group_key}"
    text = "Find a client"
    with webapps_hq.project(document) as project:
        state = project.unit
        if group_key != current_group:
            # Reopen the same representable saved group shape as the matrix's
            # grouped-fields control, whose legacy name is independent of row order.
            app = operations.held_app(state, project.app_id)
            properties = [prop.to_json() for prop in app.get_module(0).search_config.properties]
            for prop in properties:
                if prop.get("group_key") == current_group:
                    prop["group_key"] = group_key
                    if prop.get("is_group"):
                        prop["name"] = group_key
            authoring = Authoring(state, {}, "saved-legacy-search-group", operation=state.operation)
            ops.set_json(authoring, project.app_id, "/modules/0/search_config/properties", properties)
        with state.operation("search-group-heading-upload", document.id.encode()):
            messages = ops.upload_commcare_translation(state, project.app_id, key, text)
        with project.released(
            formplayer_runner, saves=((pages.CASE_LIST, project.module_id(0)),), driver=editor_driver,
        ) as release:
            app = operations.held_app(state, project.app_id)
            heading = app.get_module(0).search_config.properties[0]
            assert heading.group_key == group_key and heading.name == group_key
            assert heading.label["en"] == "Personal details"
            assert app.translations["en"][key] == text
            opening = [*steps.open_app("Inline"), *steps.choose("Followup"), steps.SCREEN]
            run = Session(release, editor_driver).run([
                *opening,
                {"eval": """() => [...document.querySelectorAll('.search-query-group-header-label')]
                    .map(label => label.textContent.trim())"""},
                *steps.type_prompt(0, "North"),
                *steps.type_prompt(1, "River"),
                *steps.run_search(),
                steps.SCREEN,
            ])
        sent = [
            entry["inputs"]
            for request in _menu_requests(run)
            if request["searched"]
            for entry in request["queryData"].values()
            if isinstance(entry, dict) and entry.get("execute")
        ]
        result = {"groupKey": group_key, "headings": run.value(len(opening)), "inputs": sent,
                  "messages": messages, "errors": run.page_errors}
        evidence("uploaded-search-group-heading", result)
        assert result["headings"] == [text, "Case details"]
        assert sent == [{"first_name": "North", "case_name": "River"}]
        assert run.page_errors == []


@pytest.mark.parametrize(
    "dormant_heading", [None, "Previously saved words", "Find a client"],
    ids=["fallback", "dormant-override", "same-override"],
)
def test_canonical_search_group_save_leaves_the_legacy_override_behind(
    hq, formplayer_runner, editor_driver, webapps_documents, evidence, dormant_heading,
):
    from urllib.parse import parse_qsl

    from django.urls import resolve

    from proof.checks import changes, source
    from proof.checks.compare.app_strings import parse_app_strings
    from proof.hq import operations, requests
    from proof.matrix import ops
    from proof.matrix.authoring import Authoring

    document = webapps_documents["search-grouped-prompts"]
    old_group = "g"
    current_group = "group_header_0"
    old_key = f"search_property.m0.{old_group}"
    current_key = f"search_property.m0.{current_group}"
    old_heading = "Find a client"
    database = casedata.document_case_database(document)
    case = next(row for row in database.cases if row.case_type == "patient")
    wanted = dataclasses.replace(case, name="River", properties=(("first_name", "North"),))
    excluded = dataclasses.replace(
        wanted, case_id="55810dad8a87487bb8f49d3a35e8ce4c", name="Other",
    )
    database = dataclasses.replace(database, cases=(wanted, excluded))

    def worker_search(project, label):
        opening = [*steps.open_app("Inline"), *steps.choose("Followup"), steps.SCREEN]
        with project.released(formplayer_runner, label=label, database=database) as release:
            run = Session(release, editor_driver).run([
                *opening,
                {"eval": """() => [...document.querySelectorAll('.search-query-group-header-label')]
                    .map(label => label.textContent.trim())"""},
                *steps.type_prompt(0, "North"),
                *steps.type_prompt(1, "River"),
                *steps.run_search(),
                steps.SCREEN,
            ])
        assert not run.page_errors and not run.dialogs
        inputs = [
            entry["inputs"]
            for request in _menu_requests(run)
            if request["searched"]
            for entry in request["queryData"].values()
            if isinstance(entry, dict) and entry.get("execute")
        ]
        return {
            "headings": run.value(len(opening)),
            "inputs": inputs,
            "matches": [row["id"] for row in run.screens[-1]["list"]["rows"]],
        }

    with webapps_hq.project(document) as project:
        state, app_id = project.unit, project.app_id
        app = operations.held_app(state, app_id)
        properties = [prop.to_json() for prop in app.get_module(0).search_config.properties]
        assert properties[0]["name"] == properties[1]["group_key"] == current_group
        properties[0].update({"name": old_group, "group_key": old_group})
        properties[1]["group_key"] = old_group
        authoring = Authoring(state, {}, "legacy-search-group-canonical-save", operation=state.operation)
        ops.set_json(authoring, app_id, "/modules/0/search_config/properties", properties)
        with state.operation("upload-legacy-search-heading", document.id.encode()):
            ops.upload_commcare_translation(state, app_id, old_key, old_heading)
        if dormant_heading:
            with state.operation("upload-dormant-search-heading", document.id.encode()):
                ops.upload_commcare_translation(state, app_id, current_key, dormant_heading)
        before_app = operations.held_app(state, app_id)
        before = dict(before_app.translations["en"])
        source_before = before_app.to_json()
        assert before[old_key] == old_heading and before.get(current_key) == dormant_heading
        before_strings = parse_app_strings(before_app.create_app_strings("en"))
        assert before_strings[old_key] == old_heading
        assert before_strings.get(current_key) == dormant_heading
        original = worker_search(project, "legacy-search-heading")

        # Use the actual saved Case List request as the starting point.
        # Apply only the key update its sortable array emits for this group.
        page = pages.CASE_LIST
        stable = pages.fresh_section_save(editor_driver, state, page, app_id, project.module_id(0))
        assert stable.save and stable.save.status == 200 and not stable.refused, stable.alerts
        pairs = parse_qsl(stable.save.body.decode("utf-8"), keep_blank_values=True)
        fields = dict(pairs)
        search = json.loads(fields["search_properties"])
        posted = search["properties"]
        assert posted[0]["name"] == posted[1]["group_key"] == old_group
        posted[0].update({"name": current_group, "group_key": current_group})
        posted[1]["group_key"] = current_group
        save_path = stable.save_path
        body = [(name, json.dumps(search) if name == "search_properties" else value) for name, value in pairs]
        request = requests.form_post(state, save_path, body, lang="en")
        view = resolve(save_path)
        result = view.func(request, *view.args, **view.kwargs)
        assert result.status_code == 200, result.content
        saved = operations.held_app(state, app_id)
        actual = [(row.name, row.group_key, row.is_group) for row in saved.get_module(0).search_config.properties]
        expected = [(row["name"], row["group_key"], row["is_group"]) for row in properties]
        expected[0] = (current_group, current_group, True)
        expected[1] = (expected[1][0], current_group, False)
        assert actual == expected
        assert [(row["name"], row["group_key"], row["is_group"]) for row in posted] == expected
        assert dict(saved.translations["en"]) == before
        saved_heading = worker_search(project, "canonical-search-heading")
        # Keep the live heading's words and remove the old address.
        translations = dict(saved.translations)
        canonical_words = dict(translations["en"])
        canonical_words[current_key] = canonical_words.pop(old_key)
        translations["en"] = canonical_words
        ops.set_json(authoring, app_id, "/translations", translations)
        rekeyed = operations.held_app(state, app_id)
        assert dict(rekeyed.translations["en"]) == canonical_words
        assert old_key not in rekeyed.translations["en"]
        after_strings = parse_app_strings(rekeyed.create_app_strings("en"))
        assert old_key not in after_strings
        assert after_strings[current_key] == old_heading
        migrated_heading = worker_search(project, "rekeyed-search-heading")
        register = changes.load()
        capture = {changes.LEGACY_SEARCH_GROUP_WORDING: (
            "/menu/0/search_config/properties/0/group_key",
            f"/app/translations/en/{old_key}",
            f"/app/translations/en/{current_key}",
        )}
        source_changes = source.compare_sources(document.id, source_before, rekeyed.to_json())
        rekey_differences = [
            row.at for row in source_changes if changes.holders(row, register, capture, siblings=source_changes)
        ]
        if dormant_heading is None:
            assert rekey_differences == [f"/translations/en/{old_key}", f"/translations/en/{current_key}"]
        elif dormant_heading == old_heading:
            assert rekey_differences == [f"/translations/en/{old_key}"]
        else:
            assert rekey_differences == [f"/translations/en/{old_key}", f"/translations/en/{current_key}"]

    evidence("canonical-search-heading", {
        "before": original, "afterStockSave": saved_heading, "afterRekey": migrated_heading, "oldKey": old_key,
        "canonicalKey": current_key, "translations": before, "savedRows": actual, "firstPublishPair": rekey_differences,
    })
    expected_query = {
        "inputs": [{"first_name": "North", "case_name": "River"}],
        "matches": [f"row-{wanted.case_id}"],
    }
    assert original == {**expected_query, "headings": [old_heading, "Case details"]}
    assert saved_heading == {
        **expected_query, "headings": [dormant_heading or "Personal details", "Case details"],
    }
    assert migrated_heading == original


@pytest.mark.parametrize("hidden_member", [False, True], ids=["shown-member", "hidden-only-group"])
def test_a_saved_search_group_and_prompt_can_share_one_generated_locale(
    hq, formplayer_runner, editor_driver, webapps_documents, evidence, hidden_member,
):
    from lxml import etree

    from proof.checks.compare.app_strings import parse_app_strings
    from proof.hq import operations
    from proof.matrix import ops
    from proof.matrix.authoring import Authoring

    document = webapps_documents["search-grouped-prompts"]
    group_name, prop_label = "g", "Account code"
    key = f"search_property.m0.{group_name}"
    with webapps_hq.project(document) as project:
        state, app_id = project.unit, project.app_id
        app = operations.held_app(state, app_id)
        properties = [prop.to_json() for prop in app.get_module(0).search_config.properties]
        properties[0].update({"name": group_name, "group_key": group_name})
        properties[1].update({"group_key": group_name, "hidden": hidden_member})
        properties.append({
            "doc_type": "CaseSearchProperty",
            "name": group_name, "label": {"en": prop_label},
            "group_key": properties[-1]["group_key"], "exclude": True,
        })
        authoring = Authoring(state, {}, "shared-search-group-locale", operation=state.operation)
        ops.set_json(authoring, app_id, "/modules/0/search_config/properties", properties)
        app = operations.held_app(state, app_id)
        assert key not in app.translations.get("en", {})
        assert parse_app_strings(app.create_app_strings("en"))[key] == prop_label
        suite = etree.fromstring(app.create_suite())
        assert suite.xpath(f".//group[@key='{group_name}']/display/text/locale[@id='{key}']")
        assert suite.xpath(f".//prompt[@key='{group_name}']/display/text/locale[@id='{key}']")
        opening = [*steps.open_app("Inline"), *steps.choose("Followup"), steps.SCREEN]
        with project.released(formplayer_runner) as release:
            run = Session(release, editor_driver).run([
                *opening,
                {"eval": """() => {
                    const text = (selector) => [...document.querySelectorAll(selector)]
                        .filter(label => label.getClientRects().length !== 0)
                        .map(label => label.textContent.trim());
                    return {
                        headings: text('#query-list-contents .search-query-group-header-label'),
                        prompts: text('#query-list-contents [id="query-group-content"] .query-caption label'),
                    };
                }"""},
            ])
    read = run.value(len(opening))
    labels, prompts = read["headings"], read["prompts"]
    evidence("shared-search-group-locale", {
        "headings": labels, "prompts": prompts, "locale": key, "hiddenMember": hidden_member,
    })
    assert not run.page_errors and not run.dialogs
    assert labels == [prop_label, "Case details"]
    assert prompts == ([] if hidden_member else ["Name"]) + ["Record name", prop_label]


def test_standalone_search_detail_with_a_missing_prompt_keeps_fixed_text(
    hq, formplayer_runner, editor_driver, webapps_documents,
):
    from proof.hq import operations
    from proof.matrix import ops, registry
    from proof.matrix.authoring import Authoring
    from proof.matrix.variants.expressions_and_data import _calculated_column
    from proof.observe.search_address import enable_address_search

    document = webapps_documents["hq-search"]
    data = casedata.document_case_database(document)
    client = next(case for case in data.cases if case.case_type == "client")
    client = dataclasses.replace(client, name="Fixed detail witness",
                                 properties=(("village", "north"), ("last_visit", "2025-01-01")))
    data = dataclasses.replace(data, cases=(client,))
    for label in ("original", "fixed"):
        with webapps_hq.authored_project(document, "A", configure=enable_address_search) as project:
            authoring = Authoring(project.unit, {}, document.id, operation=project.unit.operation)
            if label == "original":
                registry.named_change("standalone_search_detail_with_wrong_prompt")(authoring, project.app_id)
            else:
                app = operations.held_app(project.unit, project.app_id)
                app.cloudcare_enabled = True
                app.save()
                ops.set_json(
                    authoring, project.app_id, "/modules/0/case_details/long/columns/-",
                    _calculated_column(
                        "Submitted village",
                        "if(count(current()/../../results) > 0, 'Entered []', 'Unsearched case')",
                    ),
                )
            with project.released(
                formplayer_runner, database=data, driver=editor_driver,
                saves=((pages.CASE_LIST, project.module_id(0)),), label=label,
            ) as release:
                run = Session(release, editor_driver).run([
                    *steps.open_app("Client search"), *steps.choose("Clients"), *steps.choose("Followup Form"),
                    *steps.type_prompt(0, "Fixed detail witness"), *steps.run_search(),
                    *steps.click(f"#menu-region [id='row-{client.case_id}']"),
                    {"until": "webapps/detail", "arg": {"selections": ["0", None]}},
                    steps.SCREEN,
                ])
                assert not run.page_errors, (label, run.page_errors)
                assert {"header": "Submitted village", "value": "Entered []"} in run.screens[-1]["detail"]["rows"], (
                    label, run.screens,
                )


@pytest.mark.parametrize("village_answer", ["north", ""], ids=["answered", "missing"])
def test_an_unguarded_answer_on_a_search_first_result_list(
    hq, formplayer_runner, editor_driver, webapps_documents, evidence, village_answer,
):
    from proof.hq import operations
    from proof.matrix import ops, registry
    from proof.matrix.authoring import Authoring
    from proof.observe.search_address import enable_address_search

    document = webapps_documents["hq-search"]
    variant = next(row for row in registry.load_variants() if row.id == "hq-search/search-input-in-the-results-detail")
    data = casedata.document_case_database(document)
    client = next(case for case in data.cases if case.case_type == "client")
    client = dataclasses.replace(client, name="Result details witness", properties=(
        ("village", "north"), ("last_visit", "2025-01-01"),
    ))
    data = dataclasses.replace(data, cases=(client,))
    with webapps_hq.authored_project(document, "A", configure=enable_address_search) as project:
        authoring = Authoring(project.unit, {}, document.id, operation=project.unit.operation)
        ops.set_json(authoring, project.app_id, variant.change["pointer"], variant.change["value"])
        app = operations.held_app(project.unit, project.app_id)
        app.cloudcare_enabled = True
        app.save()
        module = app.modules[0]
        assert module.search_config.auto_launch and not module.search_config.inline_search
        assert module.case_details.short.columns[1].field == variant.change["value"]
        with project.released(
            formplayer_runner, database=data, driver=editor_driver,
            saves=((pages.CASE_LIST, project.module_id(0)),), label="search-first-result-prompt",
        ) as release:
            run = Session(release, editor_driver).run([
                *steps.open_app("Client search"), *steps.choose("Clients"),
                *steps.choose("Followup Form"), *steps.arrive(any_screen=True),
                steps.SCREEN, *steps.type_prompt(0, "Result details witness"),
                *(steps.type_prompt(1, village_answer) if village_answer else []), *steps.run_search(),
                *steps.arrive(any_screen=True), steps.SCREEN,
            ])
            observed = {
                "stored": release.doc["modules"][0]["case_details"]["short"]["columns"][1],
                "screens": run.screens, "pageErrors": run.page_errors,
                "dialogs": run.dialogs, "outcomes": run.outcomes,
            }
            evidence("search-first-result-prompt", observed)
            assert not run.page_errors and not run.dialogs, observed
            assert observed["stored"]["field"] == variant.change["value"], observed
            row, = run.screens[-1]["list"]["rows"]
            assert row["id"] == f"row-{client.case_id}", observed
            assert row["cells"][1]["text"] == village_answer, observed


@pytest.mark.parametrize("answer", [True, False], ids=["answered", "unanswered"])
@pytest.mark.parametrize("calendar", ["date", "date-range"])
def test_standalone_search_detail_displays_the_submitted_date(
    hq, formplayer_runner, editor_driver, webapps_documents, evidence, answer, calendar,
):
    from proof.matrix import registry
    from proof.matrix.authoring import Authoring
    from proof.observe.search_address import enable_address_search

    document = webapps_documents["hq-search"]
    data = casedata.document_case_database(document)
    sample = next(case for case in data.cases if case.case_type == "client")
    day = "2025-03-09"
    date_range = "__range__2025-03-01__2025-03-31"
    prompt = "last_visit" if calendar == "date-range" else "dob"
    submitted_value = date_range if calendar == "date-range" else day
    client = dataclasses.replace(sample, name="Date detail witness", properties=(
        ("village", "north"), ("last_visit", day), ("dob", day),
    ))
    data = dataclasses.replace(data, cases=(client,))
    date_entry = [
        {"mark": True},
        {"eval": """() => {
            const field = document.querySelector('#query-list-contents input.date');
            if (!field) throw new Error('The Search date did not open');
            field.focus();
            field.value = '03/09/2025';
            field.dispatchEvent(new Event('input', {bubbles: true}));
            field.dispatchEvent(new Event('change', {bubbles: true}));
            field.blur();
        }"""},
        {"awaitRequest": {"method": "POST", "pathname": steps.NAVIGATE}, "sinceMark": True},
        steps.SETTLE,
    ]
    if calendar == "date-range":
        date_entry = [{"eval": """() => {
            const field = document.querySelector('#query-list-contents input.daterange');
            if (!field) throw new Error('The Search date range did not open');
            field.value = '3/1/2025 to 3/31/2025';
            field.dispatchEvent(new Event('change', {bubbles: true}));
        }"""}]
    with webapps_hq.authored_project(document, "A", configure=enable_address_search) as project:
        authoring = Authoring(project.unit, {}, document.id, operation=project.unit.operation)
        change = calendar.replace("-", "_")
        registry.named_change(f"standalone_search_detail_with_{change}_prompt")(authoring, project.app_id)
        with project.released(
            formplayer_runner, database=data, driver=editor_driver,
            saves=((pages.CASE_LIST, project.module_id(0)),), label="standalone-date-detail",
        ) as release:
            run = Session(release, editor_driver).run([
                *steps.open_app("Client search"), *steps.choose("Clients"), *steps.choose("Followup Form"),
                *steps.type_prompt(0, "Date detail witness"), *(date_entry if answer else []), *steps.run_search(),
                *steps.click(f"#menu-region [id='row-{client.case_id}']"),
                {"until": "webapps/detail", "arg": {"selections": ["0", None]}},
                steps.SCREEN,
            ])
    requests = _menu_requests(run)
    submitted = [entry["inputs"].get(prompt) for request in requests if request["searched"]
                 for entry in request["queryData"].values() if isinstance(entry, dict) and entry.get("execute")]
    observed = {"screens": run.screens, "requests": requests, "errors": run.page_errors, "dialogs": run.dialogs}
    evidence("standalone-date-result", observed)
    assert not run.page_errors and not run.dialogs, observed
    assert submitted == ([submitted_value] if answer else [None]), observed
    expected = f"Entered [{submitted_value if answer else ''}]"
    assert {"header": "Submitted village", "value": expected} in run.screens[-1]["detail"]["rows"], observed
