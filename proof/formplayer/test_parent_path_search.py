"""The retained HQ ancestor Search keys survive its editor and worker request unchanged."""

import json

import pytest

from proof.editors import pages
from proof.formplayer import apps
from proof.formplayer.hq import serve
from proof.formplayer.walk import screen_kind
from proof.hq import operations
from proof.hq.check import hq_check
from proof.hq.configuration import Configuration
from proof.hq.conftest import nova_shaped_upload
from proof.hq.test_lookup_upload import workbook
from proof.matrix.registry import HQ_APPS, load_variants
from proof.observe import casedata

VALUE = "Dyer's crossing"
ENTERED = "Dyer's cross!ing"


@pytest.mark.parametrize(("variant", "key", "reverse_link_id", "expected"), [
    pytest.param("field-named-by-a-parent-path", "parent/village", "target-house", "direct",
                 id="direct-parent"),
    pytest.param("field-named-by-a-nested-parent-path", "parent/parent/village", "middle-house", "linked",
                 id="nested-parent"),
])
def test_hq_editor_and_worker_keep_the_parent_path_search_key(
    hq, core_runner, editor_driver, formplayer_runner, evidence, variant, key, reverse_link_id, expected,
):
    from corehq.apps.case_search.models import CaseSearchConfig, IgnorePatterns

    row = next(candidate for candidate in load_variants() if candidate.id == f"hq-search/{variant}")
    source = json.loads((HQ_APPS / row.base / "app.json").read_bytes())
    fields = source["modules"][0]["search_config"]["properties"]
    assert fields[1]["name"] == "village"
    pointer = "/modules/0/search_config/properties/1"
    if row.change["pointer"] == pointer:
        fields[1] = dict(row.change["value"])
    else:
        assert row.change["pointer"] == f"{pointer}/name"
        fields[1]["name"] = row.change["value"]
    assert fields[1]["name"] == key
    source["cloudcare_enabled"] = True
    stamp = "2025-12-01T08:00:00.000Z"

    def case(case_id, kind, village, parent=None, owner=casedata.USER_ID):
        return casedata.CaseRecord(
            case_id, kind, case_id, owner, stamp, stamp, None,
            (("village", village), ("last_visit", "2024-01-01")),
            (("parent", "household", parent, "child"),) if parent else (),
        )

    database = casedata.CaseDatabase(casedata.USER_ID, casedata.USERNAME, (), (
        case("target-house", "household", VALUE, owner="other-worker"),
        case("other-house", "household", "North"),
        case("middle-house", "household", "South", "target-house"),
        case("middle-other", "household", "South", "other-house"),
        case("middle-dangling", "household", "South", "unrestored-house"),
        case("linked", "client", "South", "middle-house"),
        case("direct", "client", "South", "target-house"),
        case("wrong-ancestor", "client", VALUE, "middle-other"),
        case("unresolved-second-hop", "client", VALUE, "middle-dangling"),
        case("unlinked", "client", VALUE),
    ))
    configuration = Configuration(
        flags={"CASE_SEARCH_ADVANCED", "CASE_SEARCH_RELATED_LOOKUPS", "FOLLOWUP_FORMS_AS_CASE_LIST_FORM",
               "SYNC_SEARCH_CASE_CLAIM"},
        privileges={"CLOUDCARE", "LOOKUP_TABLES"},
        case_search_enabled=True,
    )
    with hq_check(configuration) as (unit, _):
        with unit.operation("parent-path:import", row.id.encode()):
            config = CaseSearchConfig.objects.get(domain=unit.domain)
            config.ignore_patterns.add(IgnorePatterns.objects.create(
                domain=unit.domain, case_type="client", case_property=key, regex="!",
            ))
            districts = workbook([
                ("types", ("Delete(Y/N)", "table_id", "is_global?", "field 1", "field 2"),
                 [("N", "districts", "yes", "id", "name")]),
                ("districts", ("UID", "Delete(Y/N)", "field: id", "field: name"),
                 [(None, "N", "d1", "Upper valley"), (None, "N", "d2", "Lower valley")]),
            ])
            assert operations.upload_lookup_workbook(unit, districts, replace=False).errors == []
            app_id, _uploads = operations.publish(unit, [nova_shaped_upload(source, "Parent village Search")])

        before = operations.held_app(unit, app_id).modules[0]
        assert before.search_config.properties[1].name == key
        saved = pages.fresh_section_save(editor_driver, unit, pages.CASE_SEARCH, app_id, before.unique_id)
        assert saved.save and saved.save.status == 200 and not saved.refused, (saved.alerts, saved.unsent)
        after = operations.held_app(unit, app_id).modules[0]
        field = after.search_config.properties[1]
        assert (field.name, field.label["en"], field.exclude) == (key, "Village", False)

        with serve(unit, None, app_id, runner=formplayer_runner, database=database) as served, served.run("parent-path"):
            web = apps.web(formplayer_runner, served)
            menu = web.navigate(["0"])
            assert screen_kind(menu) == "commands" and len(menu["commands"]) == 2, menu
            # Registration opens a form directly. The follow-up is the only
            # command that selects and searches existing clients.
            path = [*menu["selections"], "1"]
            search = web.navigate(path)
            if screen_kind(search) == "entities":
                action, = (index for index, item in enumerate(search["actions"])
                           if item["text"] == "Search All Cases")
                path = [*search["selections"], f"action {action}"]
                search = web.navigate(path)
            assert screen_kind(search) == "query", search
            assert [display["id"] for display in search["displays"]].count(key) == 1, search["displays"]
            assert any(display["id"] == key and display["text"] == "Village" for display in search["displays"]), search
            assert not served.hq.searches
            results = web.navigate(path, query_data={search["queryKey"]: {
                "inputs": {key: ENTERED}, "execute": True,
            }})
            sent = served.hq.searches
            assert len(sent) == 1 and sent[0].values(key) == (ENTERED,), sent
            assert sent[0].values("village") == (), sent
            entities = {item["id"] for item in results.get("entities", [])}
            compiled = operations.compile_case_search(unit, f'{key} = "{VALUE}"', ("client",))
            serialized = json.dumps(compiled)
            assert '"parent"' in serialized and json.dumps(reverse_link_id) in serialized
            assert '"middle-dangling"' not in serialized and '"other-house"' not in serialized
            evidence("parent-path-search", {
                "editorStatus": saved.save.status, "field": field.to_json(),
                "workerPromptIds": [display["id"] for display in search["displays"]],
                "request": sent[0].params, "compiled": compiled, "entities": sorted(entities),
                "responses": [(item.url_name, item.status) for item in served.hq.exchanges],
            })
            assert screen_kind(results) == "entities" and entities == {expected}, results
            assert not served.hq.failures(), served.hq.failures()
