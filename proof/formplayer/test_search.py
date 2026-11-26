"""Formplayer's search screen over a Nova search: what it sends HQ for an answer holding both quote marks, and the
description it hands the client.

Finding 48 (``targeted-search-hq-compile``), on HQ's release of a real Nova
export served to Formplayer by HQ's own views (``proof.formplayer.hq``).
Contract: Formplayer queries only while the screen holds no error
(``MenuSessionRunnerService.doQuery``), so the answer Nova's validation
refuses never reaches HQ: Formplayer answers the search screen again with
the validation's message on that prompt, and sends HQ nothing. Plausible
failures: a search sent anyway (HQ would get Nova's fail-closed
``match-none()``), or a harness whose search never sends at all, which the
accepted answer (one quote mark) rules out: it is sent, HQ's own search view
answers it whole (its reading of the request, its compile of the query and
its results), and HQ's compiler compiles every string of the request, the
one that holds the answer and the document's default filter on
``date_opened`` (defect 6).

Finding 54, on the same document. HQ's Case List save writes a search
description of no text for the page's language, and HQ's build then writes a
``<description>`` whose app string is a non-breaking space. Nova now stores
that description and writes the element on both paths. Contract: Nova's
export stores ``description`` as ``{en: ""}``, the Case List page saved
without a change leaves it and ``title_label`` as they were, and Formplayer
hands the client the non-breaking space on HQ's build of Nova's export, on
the build after the save and on Nova's local archive. Plausible failures: a
save that still writes the maps (Nova's would differ from what it stores),
and an archive whose search writes no description (Formplayer would hand
``""``, as it did before).

A menu that skips to the results of its default search runs that search only
until the worker asks for the search again (``targeted-search-workflow``'s
"Recent patients", a visible field and no hidden one). Contract
(``MenuSessionRunnerService.handleQueryScreen``: ``autoSearch = replay ||
(doDefaultSearch && !forceManualSearch)``, and a search runs where its query
data says ``execute`` or where ``autoSearch`` holds): entering the menu with
no query data answers its results and sends HQ one search, the default one,
which holds nothing a worker typed, and hands the results the search beside
them (``EntityListResponse``'s ``queryResponse``, set where the screen before
the list was the query, which the client's ``menus/utils.js::
isSidebarEnabled`` reads); the same entry with ``force_manual_search`` and no
``execute`` (what the client sends to check the prompts as the worker types
in the search beside the results, ``query.js::_updateModelsForValidation``,
and ``router.js``'s ``menu:select`` with no index) answers the Search screen
and sends HQ nothing; and with the worker's
answer and ``execute`` (the client's Search beside the list, ``menu:query``,
which forces the manual search there) answers the results again with one more
search, the one that carries the answer. Preview's ``manual`` search state
(``lib/preview/searchStanding.ts::previewSearchReopened``) plays this switch.
Plausible failures: a default search that still runs under
``force_manual_search`` (the Search screen never shows), or one that runs
again with the worker's search (two searches where one was asked).

A lookup-backed Search question lists its choices in the order of their
labels (``prompt-widgets``): each itemset holds a ``<sort>`` on its label
column, which HQ's Case List save requires (``views/modules.py::
_update_search_properties``), and Core orders the choices by it
(``ItemsetBinding.sortChoices``). Contract: Formplayer hands the client the
choices of both of the document's lookup prompts in label order, where the
table's row order differs. The plausible failure: an itemset without its
sort, whose choices Formplayer hands in row order.
"""

from __future__ import annotations

import dataclasses
import json

import pytest
from lxml import etree

from proof.formplayer import apps
from proof.formplayer.walk import screen_kind
from proof.hq.operations import with_runtime_app_id
from proof.observe.sessions import csql_compile

# Search first is the default workflow; opening the menu opens its prompts.
SEARCH = ["0"]
# HQ's case search views (``ota/urls.py``).
SEARCH_VIEWS = ("remote_search", "app_aware_remote_search")
MIXED = 'it\'s "x"'
ONE_MARK = "it's"
NBSP = "\u00a0"
# The search maps the Case List save writes for the page's language.
SEARCH_MAPS = ("description", "title_label")


# "Recent patients", the third menu of ``targeted-search-workflow``, skips to the results of its default search.
SKIPS_TO_RESULTS = ["2"]
TYPED = "Amina"


def _query_data(key, inputs):
    return {key: {"inputs": inputs, "execute": True}}


def _carries(search, text):
    """Whether any parameter of the search HQ received holds ``text``."""
    return any(text in value for _, values in search.params for value in values)


def test_formplayer_keeps_a_mixed_quote_answer_from_hq_and_sends_a_one_mark_answer(
    hq, core_runner, formplayer_runner, formplayer_documents, evidence
):
    with apps.published(formplayer_documents["targeted-search-hq-compile"], core_runner) as published:
        with apps.served(published, formplayer_runner) as served, served.run("search"):
            web = apps.web(formplayer_runner, served)
            screen = web.navigate(SEARCH)
            assert screen_kind(screen) == "query"
            key = screen["queryKey"]
            assert [display["id"] for display in screen["displays"]] == ["owner_id"]
            assert served.hq.searches == []

            refused = web.navigate(SEARCH, query_data=_query_data(key, {"owner_id": MIXED}))
            errors = {display["id"]: display["error"] for display in refused["displays"]}
            sent_for_refused = [list(search.params) for search in served.hq.searches]

            accepted = web.navigate(SEARCH, query_data=_query_data(key, {"owner_id": ONE_MARK}))
            sent = list(served.hq.searches)
            answered = [
                (asked.url_name, asked.status) for asked in served.hq.exchanges if asked.url_name in SEARCH_VIEWS
            ]
        queries = list(sent[-1].values("_xpath_query")) if sent else []
        compiled = [csql_compile(published.unit, query, ("patient",)) for query in queries]
        evidence(
            "mixed-quote",
            {
                "refused": {"screen": screen_kind(refused), "errors": errors, "sentHq": sent_for_refused},
                "accepted": {
                    "screen": screen_kind(accepted),
                    "sentHq": [list(search.params) for search in sent],
                    "hqCompile": compiled,
                },
            },
        )
        # The refusal: the search screen again, the message on the prompt, and nothing sent to HQ.
        assert screen_kind(refused) == "query"
        assert list(errors) == ["owner_id"] and errors["owner_id"]
        assert sent_for_refused == []
        # The accepted counterpart: the search is sent, HQ receives the answer inside the CSQL, and compiles it.
        assert len(sent) == 1
        # HQ's own search view read the request, compiled the whole query and answered it (the document's default
        # filter compares ``date_opened`` with a date turned into a date and time, which HQ's compiler takes;
        # defect 6), and Formplayer shows the results.
        assert answered == [("app_aware_remote_search", 200)], answered
        assert screen_kind(accepted) != "query", accepted
        assert sent[0].values("owner_id") == ()
        assert any(ONE_MARK in query for query in queries)
        assert "date_opened >= datetime('2026-01-01')" in queries, queries
        assert not any("search-value-mixes-quote-marks" in query or "match-none()" in query for query in queries)
        # HQ's own compiler takes every string of the request.
        assert compiled == [{"compiled": True}] * len(queries), compiled


def _stored_maps(published):
    """The first menu's search description and title as HQ stores them."""
    from proof.hq import operations

    search = operations.held_app(published.unit, published.app_id).to_json()["modules"][0]["search_config"]
    return {key: search.get(key) for key in SEARCH_MAPS}


def _description(web):
    """The description Formplayer hands the client on the search screen."""
    screen = web.navigate(SEARCH)
    assert screen_kind(screen) == "query", screen
    return screen.get("description")


def test_formplayer_hands_a_non_breaking_space_for_the_empty_description_on_every_build(
    hq, core_runner, formplayer_runner, editor_driver, formplayer_documents, evidence
):
    from proof.editors import pages

    document = formplayer_documents["targeted-search-hq-compile"]
    with apps.published(document, core_runner) as published:
        nova_stored = _stored_maps(published)
        local = with_runtime_app_id(document.local_ccz.read_bytes(), published.app_id)
        local_id = apps.build_id(published.app_id, local)
        handed = {}
        with apps.served(published, formplayer_runner, label="nova") as served:
            served.hq.archives[local_id] = local
            with served.run("build"):
                handed["build"] = _description(apps.web(formplayer_runner, served))
            with served.run("local"):
                handed["local"] = _description(apps.web(formplayer_runner, served, app_id=local_id))
        with published.unit.fork():
            apps.saved_page(published, editor_driver, pages.CASE_LIST, published.module_id(0))
            saved_stored = _stored_maps(published)
            with apps.served(published, formplayer_runner, label="saved") as served, served.run("saved"):
                handed["saved"] = _description(apps.web(formplayer_runner, served))
    evidence("search-description", {"stored": {"nova": nova_stored, "saved": saved_stored}, "handed": handed})

    assert nova_stored["description"] == {"en": ""}
    # The Case List save writes nothing new into either map.
    assert saved_stored == nova_stored
    assert handed == {"build": NBSP, "local": NBSP, "saved": NBSP}


def test_formplayer_hands_a_lookup_prompts_choices_in_label_order(
    hq, core_runner, formplayer_runner, formplayer_documents, evidence
):
    from proof.observe import casedata

    document = formplayer_documents["prompt-widgets"]
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
    with apps.published(document, core_runner) as published:
        with apps.served(published, formplayer_runner, database=database) as served, served.run("choices"):
            screen = apps.web(formplayer_runner, served).navigate(SEARCH)
    assert screen_kind(screen) == "query", screen
    choices = {
        display["id"]: {"labels": display.get("itemsetChoices"), "keys": display.get("itemsetChoicesKey")}
        for display in screen["displays"]
        if display["id"] in ("region", "regions")
    }
    evidence("lookup-choices", choices)
    assert choices == {
        prompt: {"labels": ["East", "North & coast"], "keys": ["east", "north"]} for prompt in ("region", "regions")
    }


def test_formplayer_runs_the_default_search_unless_search_again_forces_its_screen(
    hq, core_runner, formplayer_runner, formplayer_documents, evidence
):
    with apps.published(formplayer_documents["targeted-search-workflow"], core_runner) as published:
        with apps.served(published, formplayer_runner) as served, served.run("manual-search"):
            web = apps.web(formplayer_runner, served)
            # (a) The menu entered with no query data: its default search runs.
            defaulted = web.navigate(SKIPS_TO_RESULTS)
            sent_by_default = list(served.hq.searches)
            key = defaulted.get("queryKey")
            beside = defaulted.get("queryResponse") or {}
            prompts = [display["id"] for display in beside.get("displays") or ()]
            # (b) The same entry with the search forced to wait for the worker, and nothing to run.
            forced = web.navigate(
                SKIPS_TO_RESULTS,
                query_data={
                    key: {
                        "inputs": None,
                        "execute": False,
                        "force_manual_search": True,
                        "selections": SKIPS_TO_RESULTS,
                    }
                },
            )
            sent_when_forced = list(served.hq.searches)
            # (c) The worker's answer, searched, with the search still forced to be the worker's.
            searched = web.navigate(
                SKIPS_TO_RESULTS,
                query_data={
                    key: {
                        "inputs": {prompt: TYPED for prompt in prompts},
                        "execute": True,
                        "force_manual_search": True,
                        "selections": SKIPS_TO_RESULTS,
                    }
                },
            )
            sent_when_searched = list(served.hq.searches)
    evidence(
        "forced-manual-search",
        {
            "defaulted": {
                "screen": screen_kind(defaulted),
                "queryKey": key,
                "beside": prompts,
                "sentHq": [list(search.params) for search in sent_by_default],
            },
            "forced": {"screen": screen_kind(forced), "sentHq": len(sent_when_forced)},
            "searched": {
                "screen": screen_kind(searched),
                "sentHq": [list(search.params) for search in sent_when_searched],
            },
        },
    )
    # (a) The results of the one default search, which carries nothing typed, with the search beside them.
    assert screen_kind(defaulted) == "entities", defaulted
    assert key, defaulted
    assert len(sent_by_default) == 1
    assert not _carries(sent_by_default[0], TYPED)
    assert len(prompts) == 1, beside
    # (b) The Search screen, and no search sent.
    assert screen_kind(forced) == "query", forced
    assert forced.get("queryKey") == key
    assert len(sent_when_forced) == 1
    # (c) The results again, and exactly one more search: the worker's.
    assert screen_kind(searched) == "entities", searched
    assert len(sent_when_searched) == 2
    assert _carries(sent_when_searched[1], TYPED)


def _register_from_an_empty_search(web, served, *, prefilled):
    """Search for a name no case holds, take the list's one action into "Register patient", submit it under another
    name, and return the case HQ's receiver created and the screen Formplayer answers the submission with. Where
    ``prefilled``, the form's Name starts as the name searched for."""
    search = web.navigate(SEARCH)
    assert screen_kind(search) == "query", search
    given = "Empty search patient"
    data = _query_data(search["queryKey"], {"patient_name": given})
    results = web.navigate(SEARCH, query_data=data)
    assert screen_kind(results) == "entities" and results["entities"] == [], results
    assert len(results["actions"]) == 1, results
    form = web.navigate([*results["selections"], "action 0"], query_data=data)
    assert screen_kind(form) == "form" and form["title"] == "Register patient", form
    (name,) = [node for node in form["tree"] if node.get("caption") == "Name"]
    if prefilled:
        assert name.get("answer") == given, name
    corrected = "Name on the case"
    submitted = web.submit(form["session_id"], {name["ix"]: corrected})
    assert submitted["status"] == "success", submitted
    (receipt,) = served.hq.submissions
    case_ns = "{http://commcarehq.org/case/transaction/v2}"
    (created,) = etree.fromstring(receipt.instance).findall(f"{case_ns}case")
    assert created.findtext(f"{case_ns}create/{case_ns}case_name") == corrected
    return created.attrib["case_id"], submitted["nextScreen"]


def _asked(served):
    """Every request Formplayer made of HQ in the run, with the status HQ answered."""
    return "\n".join(
        f"{exchange.method} {exchange.path} {exchange.status} {exchange.refusal or ''}" for exchange in served.hq.exchanges
    )


@pytest.mark.parametrize(("scenario", "landing"), [("basic", "entities"), ("new-case", "commands")])
def test_empty_search_registration_returns_to_its_results_or_selects_its_created_case(
    hq, core_runner, formplayer_runner, formplayer_documents, evidence, scenario, landing
):
    """The two case-list settings on the same hidden physical form, through real submission and HQ's case fixture."""
    with apps.published(formplayer_documents[f"no-matches-{scenario}"], core_runner) as published:
        with apps.served(published, formplayer_runner) as served, served.run("empty-search"):
            web = apps.web(formplayer_runner, served)
            case_id, next_screen = _register_from_an_empty_search(web, served, prefilled=True)
            # Every request Formplayer made of HQ in the run, with the status HQ answered, so a landing that
            # differs says what the return frame asked (the case fixture keyed to the created case).
            landed = f"{json.dumps(next_screen)[:1500]}\nFormplayer asked HQ:\n{_asked(served)}"
            assert screen_kind(next_screen) == landing, landed
            if landing == "entities":
                assert [row["id"] for row in next_screen["entities"]] == [case_id], landed
            else:
                assert case_id in next_screen["selections"], next_screen
                assert [command["displayText"] for command in next_screen["commands"]] == ["Visit"], next_screen
            fixture_reads = [asked.status for asked in served.hq.exchanges if asked.url_name == "case_fixture"]
            assert fixture_reads and all(status == 200 for status in fixture_reads), fixture_reads
            evidence("registered-case", {"case": case_id, "landing": landing, "caseFixture": fixture_reads})


def _landing(screen):
    """What a worker lands on: the screen's kind, the rows it lists and the commands it offers."""
    return {
        "kind": screen_kind(screen),
        "rows": [row["id"] for row in screen.get("entities") or []],
        "commands": [command["displayText"] for command in screen.get("commands") or []],
    }


def test_an_app_made_in_hq_lands_where_novas_publish_lands_after_registering_from_an_empty_search(
    hq, core_runner, formplayer_runner, formplayer_documents, evidence
):
    """``hq-empty-search`` is the journey of ``no-matches-basic`` made on CommCare HQ's own pages
    (``proof/matrix/bases/empty_search.py``): a search that finds nothing offers "Register patient", which returns to
    the case list. Contract: after the registration, Formplayer lands a worker on the same screen, listing the same
    rows, on HQ's build of either, the created case standing where the other's does. Plausible failure: a landing
    that differs, which names a member of the two apps Nova writes otherwise than HQ's pages save it."""
    from proof.hq.check import hq_check
    from proof.observe import publish
    from proof.webapps import hq as webapps_hq

    landed = {}
    document = formplayer_documents["hq-empty-search"]
    export = document.exports["minimum"]
    with hq_check(export.configuration.hq()) as (unit, _):
        with unit.operation("formplayer:authored", document.id.encode()):
            app_id, _, _ = publish.create_authored(unit, document)
        project = webapps_hq.Project(document, export, unit, app_id)
        with project.released(formplayer_runner, label="hq-made") as served, served.run("empty-search"):
            web = apps.web(formplayer_runner, served)
            case_id, screen = _register_from_an_empty_search(web, served, prefilled=False)
            landed["hq"] = {"created": case_id, **_landing(screen), "asked": _asked(served)}
    with apps.published(formplayer_documents["no-matches-basic"], core_runner) as published:
        with apps.served(published, formplayer_runner) as served, served.run("empty-search"):
            web = apps.web(formplayer_runner, served)
            case_id, screen = _register_from_an_empty_search(web, served, prefilled=True)
            landed["nova"] = {"created": case_id, **_landing(screen), "asked": _asked(served)}
    evidence("landings", landed)

    def shown(one):
        return {
            "kind": one["kind"],
            "rows": ["the created case" if row == one["created"] else row for row in one["rows"]],
            "commands": one["commands"],
        }

    assert shown(landed["hq"]) == shown(landed["nova"]), json.dumps(landed, indent=1)


def test_a_list_button_updates_the_selected_household_and_a_second_button_creates_the_member(
    hq, core_runner, formplayer_runner, formplayer_documents, evidence
):
    case_ns = "{http://commcarehq.org/case/transaction/v2}"
    with apps.published(formplayer_documents["case-list-action-basic"], core_runner) as published:
        with apps.served(published, formplayer_runner) as served:
            records = {}
            for index, title in [("2", "Edit household"), ("1", "Register household and member")]:
                with served.run(title):
                    web = apps.web(formplayer_runner, served)
                    parents = web.navigate([index])
                    assert screen_kind(parents) == "entities", parents
                    assert any(row["id"] == "household-2" for row in parents["entities"]), parents
                    members = web.navigate([*parents["selections"], "household-2"])
                    assert screen_kind(members) == "entities" and len(members["actions"]) == 1, members
                    form = web.navigate([*members["selections"], "action 0"])
                    assert screen_kind(form) == "form" and form["title"] == title, form
                    answers = {node["ix"]: node["caption"] for node in form["tree"] if node["type"] == "question"}
                    posted = len(served.hq.submissions)
                    result = web.submit(form["session_id"], answers)
                    assert result["status"] == "success", result
                    (saved,) = served.hq.submissions[posted:]
                    cases = list(etree.fromstring(saved.instance).iter(f"{case_ns}case"))
                    records[title] = [row.attrib["case_id"] for row in cases]
                    if index == "2":
                        assert records[title] == ["household-2"], records
                        assert cases[0].findtext(f"{case_ns}update/{case_ns}last_note") == "Note"
                        assert cases[0].find(f"{case_ns}create") is None
                    else:
                        types = {row.findtext(f"{case_ns}create/{case_ns}case_type"):row.attrib["case_id"] for row in cases}
                        assert set(types) == {"household","person"}, types
                        assert types["person"] in result["nextScreen"]["selections"], result
                        # The return opens the members of the household the form created, not the one chosen
                        # before the list (``workflow.py::_find_best_match`` keys the household datum to it).
                        assert types["household"] in result["nextScreen"]["selections"], result
                        assert "household-2" not in result["nextScreen"]["selections"], result
            evidence("list-action-records", records)
