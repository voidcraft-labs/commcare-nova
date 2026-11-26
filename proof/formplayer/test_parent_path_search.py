"""The retained HQ ancestor Search field survives its editor and request unchanged."""

import json

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

VARIANT = "hq-search/field-named-by-a-parent-path"
KEY = "parent/village"
VALUE = "Dyer's crossing"


def test_hq_editor_and_worker_keep_the_parent_path_search_key(
    hq, core_runner, editor_driver, formplayer_runner, evidence,
):
    row = next(variant for variant in load_variants() if variant.id == VARIANT)
    source = json.loads((HQ_APPS / row.base / "app.json").read_bytes())
    assert row.change["pointer"] == "/modules/0/search_config/properties/1"
    assert source["modules"][0]["search_config"]["properties"][1]["name"] == "village"
    source["modules"][0]["search_config"]["properties"][1] = dict(row.change["value"])
    source["cloudcare_enabled"] = True
    stamp = "2025-12-01T08:00:00.000Z"

    def case(case_id, kind, village, parent=None):
        return casedata.CaseRecord(
            case_id, kind, case_id, casedata.USER_ID, stamp, stamp, None,
            (("village", village), ("last_visit", "2024-01-01")),
            (("parent", "household", parent, "child"),) if parent else (),
        )

    database = casedata.CaseDatabase(casedata.USER_ID, casedata.USERNAME, (), (
        case("target-house", "household", VALUE),
        case("other-house", "household", "North"),
        case("linked", "client", "South", "target-house"),
        case("own-value", "client", VALUE, "other-house"),
        case("unlinked", "client", VALUE),
    ))
    configuration = Configuration(
        flags={"CASE_SEARCH_ADVANCED", "CASE_SEARCH_RELATED_LOOKUPS", "FOLLOWUP_FORMS_AS_CASE_LIST_FORM",
               "SYNC_SEARCH_CASE_CLAIM"},
        privileges={"CLOUDCARE", "LOOKUP_TABLES"},
        case_search_enabled=True,
    )
    with hq_check(configuration) as (unit, _):
        with unit.operation("parent-path:import", VARIANT.encode()):
            districts = workbook([
                ("types", ("Delete(Y/N)", "table_id", "is_global?", "field 1", "field 2"),
                 [("N", "districts", "yes", "id", "name")]),
                ("districts", ("UID", "Delete(Y/N)", "field: id", "field: name"),
                 [(None, "N", "d1", "Upper valley"), (None, "N", "d2", "Lower valley")]),
            ])
            assert operations.upload_lookup_workbook(unit, districts, replace=False).errors == []
            app_id, _uploads = operations.publish(unit, [nova_shaped_upload(source, "Parent village Search")])

        before = operations.held_app(unit, app_id).modules[0]
        assert before.search_config.properties[1].name == KEY
        saved = pages.fresh_section_save(editor_driver, unit, pages.CASE_SEARCH, app_id, before.unique_id)
        assert saved.save and saved.save.status == 200 and not saved.refused, (saved.alerts, saved.unsent)
        after = operations.held_app(unit, app_id).modules[0]
        field = after.search_config.properties[1]
        assert (field.name, field.label["en"], field.exclude) == (KEY, "Village", False)

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
            assert [display["id"] for display in search["displays"]].count(KEY) == 1, search["displays"]
            assert any(display["id"] == KEY and display["text"] == "Village" for display in search["displays"]), search
            assert not served.hq.searches
            results = web.navigate(path, query_data={search["queryKey"]: {
                "inputs": {KEY: VALUE}, "execute": True,
            }})
            sent = served.hq.searches
            assert len(sent) == 1 and sent[0].values(KEY) == (VALUE,), sent
            assert sent[0].values("village") == (), sent
            entities = {item["id"] for item in results.get("entities", [])}
            compiled = operations.compile_case_search(unit, f'{KEY} = "{VALUE}"', ("client",))
            serialized = json.dumps(compiled)
            assert '"parent"' in serialized and '"target-house"' in serialized and '"other-house"' not in serialized
            evidence("parent-path-search", {
                "editorStatus": saved.save.status, "field": field.to_json(),
                "workerPromptIds": [display["id"] for display in search["displays"]],
                "request": sent[0].params, "compiled": compiled, "entities": sorted(entities),
                "responses": [(item.url_name, item.status) for item in served.hq.exchanges],
            })
            assert screen_kind(results) == "entities" and entities == {"linked"}, results
            assert not served.hq.failures(), served.hq.failures()
