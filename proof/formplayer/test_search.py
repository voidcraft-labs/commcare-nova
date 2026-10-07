"""Formplayer's search screen over Nova's searches: what it hands Web Apps, and what it sends HQ.

Two register classes rest on what Formplayer does here, and each is observed
on HQ's build of a real Nova export:

- **Finding 48, a search answer holding both quote marks**
  (``targeted-search-hq-compile``). Contract: Formplayer queries only while
  the screen holds no error (``MenuSessionRunnerService.doQuery``), so the
  answer Nova's validation refuses never reaches HQ: Formplayer answers the
  search screen again with the validation's message on that prompt, and
  sends HQ nothing. Plausible failures: a search sent anyway (HQ would get
  Nova's fail-closed CSQL function), or a harness whose search never sends at
  all, which the accepted answer (one quote mark) rules out: it is sent, and
  HQ's own compiler compiles what Formplayer sent.
- **Finding 54, the search description the Case List save writes**
  (``search-browse``). Contract: the description Formplayer hands Web Apps
  (``QueryResponseBean.description``) is ``""`` for Nova's export and a
  non-breaking space for the app with the empty description HQ's Case List
  page saves. Plausible failures: both read alike (the difference would then
  be a spelling Formplayer does not read), or the second build never
  installed (Formplayer keeps an install by its id), which the suites'
  difference and the two ids rule out.
"""

from __future__ import annotations

from proof.formplayer import apps
from proof.formplayer.walk import screen_kind
from proof.observe.sessions import csql_compile

SEARCH = ["0", "action 0"]
MIXED = "it's \"x\""
ONE_MARK = "it's"


def _query_data(key, inputs):
    return {key: {"inputs": inputs, "execute": True}}


def test_formplayer_keeps_a_mixed_quote_answer_from_hq_and_sends_a_one_mark_answer(
    hq, core_runner, formplayer_runner, formplayer_documents, evidence
):
    with apps.published(formplayer_documents["targeted-search-hq-compile"], core_runner) as published:
        session = apps.installed(published)
        web = apps.web(formplayer_runner, session)
        screen = web.navigate(SEARCH)
        assert screen_kind(screen) == "query"
        key = screen["queryKey"]
        assert [display["id"] for display in screen["displays"]] == ["include_closed", "owner_id"]
        assert session.hq.searches == []

        refused = web.navigate(SEARCH, query_data=_query_data(key, {"owner_id": MIXED}))
        errors = {display["id"]: display["error"] for display in refused["displays"]}
        sent_for_refused = [list(search.params) for search in session.hq.searches]

        accepted = web.navigate(SEARCH, query_data=_query_data(key, {"owner_id": ONE_MARK}))
        sent = [search for search in session.hq.searches]
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
        assert errors["owner_id"] and errors["include_closed"] is None
        assert sent_for_refused == []
        # The accepted counterpart: the search runs, HQ receives the answer inside the CSQL, and compiles it.
        assert screen_kind(accepted) == "entities"
        assert len(sent) == 1
        assert sent[0].values("owner_id") == ()
        assert any(ONE_MARK in query for query in queries)
        assert not any("search-value-mixes-quote-marks" in query for query in queries)
        # HQ's own compiler takes the string that holds the answer (the search's two other strings are this
        # document's own symptoms, defect 6's, which the intent check reports).
        assert [result for query, result in zip(queries, compiled, strict=True) if ONE_MARK in query] == [
            {"compiled": True}
        ]


def test_formplayer_hands_web_apps_a_blank_description_for_nova_and_a_non_breaking_space_for_the_saved_app(
    hq, core_runner, formplayer_runner, formplayer_documents, evidence
):
    with apps.published(formplayer_documents["search-browse"], core_runner) as published:

        def save_empty_description(doc):
            """What HQ's Case List save stores for a search with no description: the page language's text, empty
            (``views/modules.py::_gather_and_update_search_properties``)."""
            (module,) = [module for module in doc["modules"] if module["search_config"]["properties"]]
            assert module["search_config"]["description"] == {}
            module["search_config"]["description"] = {"en": ""}

        saved = apps.spelled(published, save_empty_description)
        read = {}
        for name, files in (("nova", published.build.files), ("saved", saved.files)):
            session = apps.installed(published, files)
            trace = apps.walked(formplayer_runner, session)
            screens = [
                step["response"]
                for run in trace["runs"]
                for step in run["steps"]
                if screen_kind(step.get("response")) == "query"
            ]
            read[name] = {
                "appId": session.app_id,
                "descriptionElements": files["suite.xml"].count(b"<description>"),
                "descriptions": [screen["description"] for screen in screens],
                "ends": [run["end"] for run in trace["runs"]],
            }
        evidence("description", read)
        assert read["nova"]["appId"] != read["saved"]["appId"]
        assert (read["nova"]["descriptionElements"], read["saved"]["descriptionElements"]) == (0, 1)
        assert read["nova"]["descriptions"] == [""]
        assert read["saved"]["descriptions"] == [" "]
        # The sessions are otherwise the same: both reach the same screens and end alike.
        assert read["nova"]["ends"] == read["saved"]["ends"]
