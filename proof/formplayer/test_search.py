"""Formplayer's search screen over a Nova search: what it sends HQ for an answer holding both quote marks, and the
description it hands the client.

Finding 48 (``targeted-search-hq-compile``), on HQ's release of a real Nova
export served to Formplayer by HQ's own views (``proof.formplayer.hq``).
Contract: Formplayer queries only while the screen holds no error
(``MenuSessionRunnerService.doQuery``), so the answer Nova's validation
refuses never reaches HQ: Formplayer answers the search screen again with
the validation's message on that prompt, and sends HQ nothing. Plausible
failures: a search sent anyway (HQ would get Nova's fail-closed CSQL
function), or a harness whose search never sends at all, which the accepted
answer (one quote mark) rules out: it is sent, HQ's own search view takes
it whole (its reading of the request and its compile of the query), and
HQ's compiler compiles the string that holds the answer.

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

from proof.formplayer import apps
from proof.formplayer.walk import screen_kind
from proof.hq.operations import with_runtime_app_id
from proof.observe.sessions import csql_compile

SEARCH = ["0", "action 0"]
# HQ's case search views (``ota/urls.py``).
SEARCH_VIEWS = ("remote_search", "app_aware_remote_search")
MIXED = 'it\'s "x"'
ONE_MARK = "it's"
NBSP = "\u00a0"
# The search maps the Case List save writes for the page's language.
SEARCH_MAPS = ("description", "title_label")


def _query_data(key, inputs):
    return {key: {"inputs": inputs, "execute": True}}


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
        # HQ's own search view read the request and compiled the whole query, and refused it for this document's
        # own date comparison (defect 6, which the register holds as ``formplayer@A``); Formplayer then leaves the
        # search screen (no validation message holds it there).
        assert answered == [("app_aware_remote_search", 400)], answered
        assert screen_kind(accepted) != "query", accepted
        assert sent[0].values("owner_id") == ()
        assert any(ONE_MARK in query for query in queries)
        assert not any("search-value-mixes-quote-marks" in query for query in queries)
        # HQ's own compiler takes the string that holds the answer (the search's two other strings are this
        # document's own symptoms, defect 6's, which the intent check reports).
        assert [result for query, result in zip(queries, compiled, strict=True) if ONE_MARK in query] == [
            {"compiled": True}
        ]


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
