"""Stock worker meaning of the retained own-row inline Results column."""

import json

import pytest

from proof.formplayer import apps
from proof.formplayer.hq import serve
from proof.formplayer.test_search import _query_data
from proof.formplayer.walk import screen_kind
from proof.hq import operations
from proof.hq.check import hq_check
from proof.hq.configuration import Configuration
from proof.matrix.authoring import Authoring
from proof.matrix.registry import HQ_APPS, load_variants, named_change
from proof.observe import casedata
from proof.webapps.hq import ReleaseRefused

FORMULA = (
    "instance('results:inline')/results/case[not(commcare_is_related_case = true())]"
    "[@case_id = current()/@case_id]/village"
)


def _ordinary_column(field, title):
    return {
        "doc_type": "DetailColumn", "model": "case", "format": "plain", "field": field, "header": {"en": title},
    }


def _with_inline_columns(body):
    body["cloudcare_enabled"] = True
    menu = body["modules"][0]
    assert menu["search_config"]["inline_search"] is True
    for side in ("short", "long"):
        detail = menu["case_details"][side]
        # This emitted base's original sort refers to its eighth column.
        detail["sort_elements"] = []
        detail["columns"] = [
            _ordinary_column("name", "Name"),
            {**_ordinary_column(FORMULA, "Found in"), "useXpathExpression": True},
            _ordinary_column("village", "Recorded village"),
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
        with apps.served(published, formplayer_runner, label="inline-results-column", change=_with_inline_columns,
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
    shown = ["Name", "Found in", "Recorded village"]
    for state in taken.values():
        assert state["results"]["headers"] == shown, state
    keep = taken["keep"]
    assert keep["results"]["entities"][0]["data"] == ["served", "primary-value", "primary-value"], keep
    detail, = keep["details"]["details"]
    assert detail["headers"] == shown and detail["details"] == ["served", "primary-value", "primary-value"], detail
    without = taken["without"]
    assert without["results"]["entities"][0]["data"] == ["missing", "", ""], without
    detail, = without["details"]["details"]
    assert detail["headers"] == ["Name"] and detail["details"] == ["missing"], detail
    assert "details" not in taken["no-match"], taken["no-match"]


@pytest.mark.parametrize("route", ["retained", "parent-first", "ordinary-casedb"])
def test_the_retained_visits_projection_needs_its_actual_inline_instance(
    hq, core_runner, formplayer_runner, evidence, route,
):
    row = next(row for row in load_variants() if row.id == "hq-search/visits-list-reads-the-inline-results")
    directory = HQ_APPS / row.base
    source = json.loads((directory / "app.json").read_bytes())
    menus = source["modules"]
    visits = menus[2]
    source["cloudcare_enabled"] = True
    if route == "parent-first":
        parents = menus[1]
        parents["case_type"] = "household"
        parents["case_details"]["short"]["filter"] = None
        parents["search_config"] = {}
        visits["parent_select"].update(active=True, module_id=parents["unique_id"])
    elif route == "ordinary-casedb":
        visits["search_config"] = {}

    stamp = "2025-12-01T08:00:00.000Z"

    def case(identity, kind, village, parent=None):
        return casedata.CaseRecord(
            identity, kind, identity, casedata.USER_ID, stamp, stamp, None,
            (("standing", "open"), ("village", village)),
            (("parent", "household", parent, "child"),) if parent else (),
        )

    database = casedata.CaseDatabase(casedata.USER_ID, casedata.USERNAME, (), (
        case("first-home", "household", "wrong-parent-value"),
        case("second-home", "household", "another-parent-value"),
        case("served-client", "client", "north", "first-home"),
        case("other-client", "client", "north", "second-home"),
        case("outside-results", "client", "east", "first-home"),
    ))
    configuration = Configuration(
        flags={"CASE_SEARCH_ADVANCED", "CASE_SEARCH_RELATED_LOOKUPS", "FOLLOWUP_FORMS_AS_CASE_LIST_FORM",
               "SYNC_SEARCH_CASE_CLAIM"},
        privileges={"CLOUDCARE", "LOOKUP_TABLES"},
        case_search_enabled=True,
    )
    def with_comparison_columns(body):
        details = body["modules"][2]["case_details"]
        projected = details["short"]["columns"][1]
        assert projected["field"] == FORMULA and projected["useXpathExpression"]
        details["short"]["columns"].append(_ordinary_column("village", "Recorded village"))
        details["long"]["columns"].extend([projected, _ordinary_column("village", "Recorded village")])

    with hq_check(configuration) as (unit, _):
        with unit.operation("inline-results:authored", row.id.encode()):
            operations.save_authored_tables(unit, json.loads((directory / "tables.json").read_bytes()))
            app_id = operations.save_authored_app(unit, source, ())
        assert row.change["op"] == "named"
        authoring = Authoring(unit, {}, base=row.base, operation=unit.operation)
        named_change(row.change["name"])(authoring, app_id)
        if route == "ordinary-casedb":
            with pytest.raises(ReleaseRefused, match="case search instance used in casedb case details") as refused:
                with serve(unit, None, app_id, runner=formplayer_runner, database=database):
                    pytest.fail("HQ released ordinary casedb details depending on unattached Search results")
            evidence("retained-inline-columns", {"refusal": str(refused.value)})
            return
        with serve(unit, None, app_id, runner=formplayer_runner, database=database,
                   change=with_comparison_columns) as served, served.run(route):
            web = apps.web(formplayer_runner, served)
            opening = web.navigate(["2"])
            screens = {"opening": opening}
            evidence("retained-inline-columns", screens)
            path = opening["selections"]
            if route == "parent-first":
                assert screen_kind(opening) == "entities", opening
                assert {item["id"] for item in opening["entities"]} == {"first-home", "second-home"}, opening
                assert not served.hq.searches
                path = [*path, "first-home"]
                opening = web.navigate(path)
                screens["afterParent"] = opening
                evidence("retained-inline-columns", screens)
            query = {}
            if screen_kind(opening) == "query":
                query = _query_data(opening["queryKey"], {})
                results = web.navigate(path, query_data=query)
            else:
                results = opening
            screens["results"] = results
            row_ids = [item["id"] for item in results.get("entities") or []]
            screens["rows"] = row_ids
            evidence("retained-inline-columns", screens)
            if "served-client" in row_ids:
                screens["details"] = web.navigate(
                    [*results["selections"], "served-client"], query_data=query, route="get_details",
                )
            screens["requested"] = [item.params for item in served.hq.searches]
            evidence("retained-inline-columns", screens)
            expected = {"served-client"} if route == "parent-first" else {"served-client", "other-client"}
            assert set(row_ids) == expected, screens
            assert results["headers"] == ["Name", "Found in", "Recorded village"], screens
            assert all(item["data"] == [item["id"], "north", "north"] for item in results["entities"]), screens
            detail, = screens["details"]["details"]
            assert detail["headers"] == results["headers"] and detail["details"] == ["served-client", "north", "north"]
            request, = served.hq.searches
            expected_filters = ("village = 'north'",)
            if route == "parent-first":
                expected_filters += ("ancestor-exists(parent, @case_type='household')",)
            assert request.values("_xpath_query") == expected_filters, screens
            assert not served.hq.failures(), served.hq.failures()
