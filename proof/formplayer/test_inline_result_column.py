"""Stock worker meaning of the retained own-row inline Results column."""

from proof.formplayer import apps
from proof.formplayer.test_search import _query_data
from proof.formplayer.walk import screen_kind
from proof.observe import casedata

FORMULA = (
    "instance('results:inline')/results/case[not(commcare_is_related_case = true())]"
    "[@case_id = current()/@case_id]/village"
)


def _source(body):
    body["cloudcare_enabled"] = True
    menu = body["modules"][0]
    assert menu["search_config"]["inline_search"] is True
    for side in ("short", "long"):
        menu["case_details"][side]["columns"] = [
            {"doc_type": "DetailColumn", "model": "case", "format": "plain",
             "field": "name", "header": {"en": "Name"}},
            {"doc_type": "DetailColumn", "model": "case", "format": "plain",
             "field": FORMULA, "header": {"en": "Found in"}, "useXpathExpression": True},
        ]
    return body


def test_inline_results_own_row_reads_on_the_signed_worker_route(
    hq, core_runner, formplayer_runner, formplayer_documents, evidence,
):
    stamp = "2025-12-01T08:00:00.000Z"
    database = casedata.CaseDatabase(
        casedata.USER_ID, casedata.USERNAME, (), tuple(
            casedata.CaseRecord(
                identity, "patient", identity, casedata.USER_ID, stamp, stamp, None, props,
            )
            for identity, props in (
                ("served", (("code", "keep"), ("village", "primary-value"))),
                ("missing", (("code", "without"),)),
                ("decoy", (("code", "unused"), ("village", "unsearched-value"))),
            )
        ),
    )
    taken = {}
    with apps.published(formplayer_documents["case-list-inline"], core_runner) as published:
        with apps.served(published, formplayer_runner, label="inline-results-column", change=_source,
                         database=database) as served:
            for code in ("keep", "without", "no-match"):
                with served.run(code):
                    web = apps.web(formplayer_runner, served)
                    opening = web.navigate(["0"])
                    assert screen_kind(opening) == "query", opening
                    query = _query_data(opening["queryKey"], {"code": code})
                    results = web.navigate(["0"], query_data=query)
                    row_ids = [row["id"] for row in results.get("entities") or []]
                    study = {"opening": opening, "results": results, "rows": row_ids}
                    if row_ids:
                        study["details"] = web.navigate(
                            [*results["selections"], row_ids[0]], query_data=query, route="get_details",
                        )
                    taken[code] = study
                    evidence("inline-result-columns", taken)
            assert not served.hq.failures(), served.hq.failures()
    assert taken["keep"]["rows"] == ["served"], taken
    assert taken["without"]["rows"] == ["missing"], taken
    assert taken["no-match"]["rows"] == [], taken
