"""Formplayer's search screen over a Nova search: what it sends HQ for an answer holding both quote marks.

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

What the Case List save does to a search's description (finding 54) is the
rule ``search-description-empty``'s, whose test serves both spellings to
Formplayer and the Web Apps client.
"""

from __future__ import annotations

from proof.formplayer import apps
from proof.formplayer.walk import screen_kind
from proof.observe.sessions import csql_compile

SEARCH = ["0", "action 0"]
# HQ's case search views (``ota/urls.py``).
SEARCH_VIEWS = ("remote_search", "app_aware_remote_search")
MIXED = 'it\'s "x"'
ONE_MARK = "it's"


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
            assert [display["id"] for display in screen["displays"]] == ["include_closed", "owner_id"]
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
        assert errors["owner_id"] and errors["include_closed"] is None
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
