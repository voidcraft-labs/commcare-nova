"""A worker's search inherits lookup declarations from its request alone on both native clients."""

from __future__ import annotations

import json
import os
from contextlib import contextmanager
from pathlib import Path

import pytest
from lxml import etree

from proof.formplayer import hq as formplayer
from proof.hq import operations
from proof.hq.check import hq_check
from proof.hq.configuration import Configuration
from proof.hq.conftest import hq_test_app_with_menu_ids, nova_shaped_upload
from proof.hq.test_lookup_upload import workbook
from proof.observe.casedata import CaseDatabase, CaseRecord, USER_ID, USERNAME

LOOKUP_ID = "item-list:zones"
CANONICAL = f"jr://fixture/{LOOKUP_ID}"
ALTERNATE = "jr://fixture/item-list:other-zones"
GROUPED = f"string(instance((('{LOOKUP_ID}')))/zones_list/zones[1]/code)"
ORDINARY = f"string(instance('{LOOKUP_ID}')/zones_list/zones[1]/code)"
MATCH = "Garden"
MISSING = f'The instance "{LOOKUP_ID}"'


@contextmanager
def _released(has_sibling, runner=None):
    from corehq.apps.app_manager.models import CaseSearch, CaseSearchProperty, DefaultCaseSearchProperty

    app = hq_test_app_with_menu_ids()
    menu = app["modules"][0]
    create, follow = menu["forms"]
    menu["name"] = {"en": "Visits"}
    menu["forms"] = [follow]
    menu["module_filter"] = f"{ORDINARY} != ''"
    follow["form_filter"] = f"{ORDINARY} != ''"
    create["custom_instances"] = [{
        "doc_type": "CustomInstance", "instance_id": LOOKUP_ID, "instance_path": ALTERNATE,
    }]
    other = {**menu, "unique_id": "2".zfill(32), "name": {"en": "Outreach"}, "forms": [create]}
    other.pop("module_filter")
    app["modules"].append(other)
    for screen in ("short", "long"):
        detail = menu["case_details"][screen]
        first = detail["columns"][0]
        detail["columns"] = [
            {**first, "field": "name", "header": {"en": "Name"}},
            {**first, "field": GROUPED, "useXpathExpression": True, "header": {"en": "Home zone"}},
        ]
    menu["search_config"] = CaseSearch(
        auto_launch=True,
        properties=[CaseSearchProperty(name="zone", label={"en": "Zone"}, default_value=GROUPED)],
        default_properties=(
            [DefaultCaseSearchProperty(property="zone_source_check", defaultValue=ORDINARY)] if has_sibling else []
        ),
    ).to_json()
    lookup = workbook([
        ("types", ("Delete(Y/N)", "table_id", "is_global?", "field 1"), [
            ("N", "zones", "yes", "code"), ("N", "other-zones", "yes", "code"),
        ]),
        ("zones", ("UID", "Delete(Y/N)", "field: code"), [(None, "N", MATCH)]),
        ("other-zones", ("UID", "Delete(Y/N)", "field: code"), [(None, "N", "Wrong fixture")]),
    ])
    date = "2026-01-10T00:00:00.000Z"
    database = CaseDatabase(USER_ID, USERNAME, (), (
        CaseRecord("lookup-zone-case", "suite_test", "Aster household", USER_ID, date, date, None,
                   (("zone", MATCH), ("zone_source_check", MATCH))),
        CaseRecord("lookup-other-case", "suite_test", "Outside household", USER_ID, date, date, None,
                   (("zone", "Elsewhere"), ("zone_source_check", MATCH))),
    ))
    configuration = Configuration(
        domain="nova-navigation-source",
        privileges={"CLOUDCARE", "LOOKUP_TABLES"},
        flags={"CASE_SEARCH_ADVANCED"},
        case_search_enabled=True,
    )
    with hq_check(configuration) as (state, _):
        with state.committing():
            assert operations.upload_lookup_workbook(state, lookup, replace=False).errors == []
        app_id, _ = operations.publish(state, [nova_shaped_upload(app, "Navigation lookups")])
        with formplayer.serve(state, None, app_id, runner=runner, database=database) as served:
            suite = etree.fromstring(operations.held_app(state, served.build_id).fetch_attachment("files/suite.xml"))

            def source(element):
                return element.xpath("./instance[@id=$id]/@src", id=LOOKUP_ID)

            (menu_entry,) = suite.xpath("./menu[@id='m0']")
            assert source(menu_entry) == [CANONICAL]
            entries = {entry.findtext("form"): entry for entry in suite.findall("entry")}
            assert source(entries[follow["xmlns"]]) == [CANONICAL]
            assert source(entries[create["xmlns"]]) == [ALTERNATE]
            (detail_id,) = entries[follow["xmlns"]].xpath("./session/*/@detail-select")
            assert GROUPED in suite.xpath("./detail[@id=$detail]//@function", detail=detail_id)
            (request,) = suite.xpath("./remote-request[session/query/prompt[@key='zone']]")
            assert source(request) == ([CANONICAL] if has_sibling else [])
            assert request.xpath("./session/query/prompt[@key='zone']/@default") == [GROUPED]
            yield served


def _record(request, result):
    directory = Path(os.environ.get("PROOF_OUT") or "/tmp") / "navigation-lookups"
    directory.mkdir(parents=True, exist_ok=True)
    (directory / f"{request.node.name}.json").write_text(json.dumps(result, ensure_ascii=False, indent=2))


@pytest.mark.reader("formplayer")
@pytest.mark.parametrize("has_sibling", [True, False], ids=["bound", "absent"])
def test_formplayer_search_default_reads_only_its_request(hq, formplayer_runner, request, has_sibling):
    from proof.formplayer import apps
    from proof.formplayer.walk import screen_kind

    with _released(has_sibling, formplayer_runner) as served, served.run("navigation-lookup"):
        web = apps.web(formplayer_runner, served)
        if not has_sibling:
            refusal = web.navigate(["0"])
            _record(request, {"response": refusal})
            assert refusal.get("status") == "error", refusal
            assert MISSING in refusal["exception"], refusal
            assert served.hq.searches == []
            return

        screen = web.navigate(["0"])
        _record(request, {"screen": screen})
        assert screen_kind(screen) == "query", screen
        (prompt,) = screen["displays"]
        assert (prompt["id"], prompt["value"]) == ("zone", MATCH), prompt
        results = web.navigate(["0"], query_data={screen["queryKey"]: {"inputs": {"zone": MATCH}, "execute": True}})
        (received,) = served.hq.searches
        _record(request, {"screen": screen, "results": results, "search": list(received.params)})
        assert received.values("zone") == (MATCH,)
        assert screen_kind(results) == "entities", results
        assert [row["id"] for row in results["entities"]] == ["lookup-zone-case"], results


@pytest.mark.reader("android")
@pytest.mark.parametrize("has_sibling", [True, False], ids=["bound", "absent"])
def test_android_search_default_reads_only_its_request(hq, request, has_sibling):
    from proof.android import observe
    from proof.observe.record import Blobs

    with _released(has_sibling) as served:
        blobs = Blobs()
        result = observe.app(served, blobs, label="navigation-lookup", archive=observe.release_archive(served))
        answer = blobs.get_json(result["answer"])
        _record(request, {"answer": answer, "hq": blobs.get_json(result["hq"])})
        assert answer["install"] == "Installed", answer
        assert answer["signIn"].startswith("Success("), answer
        # Android may expose Search as a list action even when Web Apps auto-launches it.
        search_walks = [walk for name, walk in answer["walks"].items() if name in ("m0", "m0/@action:0")]
        assert search_walks, answer["walks"]
        queries = [
            step["query"] for walk in search_walks for step in walk.get("steps", []) if "query" in step
        ]
        if not has_sibling:
            assert queries, search_walks
            for query in queries:
                assert query["opened"] is False, query
                alert = query.get("openingAlert", {})
                assert alert.get("class") == "StandardAlertDialog" and MISSING in alert.get("msg", ""), query
            assert served.hq.searches == []
            return

        assert queries, search_walks
        for query in queries:
            assert query["opened"], query
            assert query["RemoteQuerySessionManager.getRawQueryParams"]["zone"] == [MATCH], query
        assert any(search.values("zone") == (MATCH,) for search in served.hq.searches), served.hq.searches
