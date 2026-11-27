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


def _districts():
    return workbook([
        ("types", ("Delete(Y/N)", "table_id", "is_global?", "field 1", "field 2"),
         [("N", "districts", "yes", "id", "name")]),
        ("districts", ("UID", "Delete(Y/N)", "field: id", "field: name"),
         [(None, "N", "d1", "Upper valley"), (None, "N", "d2", "Lower valley")]),
    ])


@pytest.mark.parametrize(("variant", "key", "reverse_link_id", "expected", "value", "entered"), [
    pytest.param("field-named-by-a-parent-path", "parent/village", "target-house", "direct", VALUE, ENTERED,
                 id="direct-parent"),
    pytest.param("field-named-by-a-nested-parent-path", "parent/parent/village", "middle-house", "linked", VALUE, ENTERED,
                 id="nested-parent"),
    pytest.param("field-named-by-a-nested-parent-path", "parent/parent/village", "middle-house", "linked",
                 "east west", "east we!st", id="nested-parent-multiple-values"),
    pytest.param("field-named-by-three-parent-links", "parent/parent/parent/village", "lower-house",
                 "three-links", VALUE, ENTERED, id="three-parent-links"),
])
def test_hq_editor_and_worker_keep_the_parent_path_search_key(
    hq, core_runner, editor_driver, formplayer_runner, evidence, variant, key, reverse_link_id, expected, value, entered,
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

    # XForm case transactions join multiple choices in their saved order.
    # HQ's case index receives that text, including the space between values.
    database = casedata.CaseDatabase(casedata.USER_ID, casedata.USERNAME, (), (
        case("target-house", "household", value, owner="other-worker"),
        case("other-house", "household", "west east" if value == "east west" else "North"),
        case("middle-house", "household", "South", "target-house"),
        case("middle-other", "household", "South", "other-house"),
        case("middle-dangling", "household", "South", "unrestored-house"),
        case("linked", "client", "South", "middle-house"),
        case("direct", "client", "South", "target-house"),
        case("wrong-ancestor", "client", value, "middle-other"),
        case("unresolved-second-hop", "client", value, "middle-dangling"),
        case("unlinked", "client", value),
        case("lower-house", "household", "South", "middle-house"),
        case("lower-other", "household", "South", "middle-other"),
        case("lower-dangling", "household", "South", "middle-dangling"),
        case("three-links", "client", "South", "lower-house"),
        case("wrong-third-hop", "client", value, "lower-other"),
        case("unresolved-third-hop", "client", value, "lower-dangling"),
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
            assert operations.upload_lookup_workbook(unit, _districts(), replace=False).errors == []
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
                "inputs": {key: entered}, "execute": True,
            }})
            sent = served.hq.searches
            assert len(sent) == 1 and sent[0].values(key) == (entered,), sent
            assert sent[0].values("village") == (), sent
            entities = {item["id"] for item in results.get("entities", [])}
            compiled = operations.compile_case_search(unit, f'{key} = "{value}"', ("client",))
            serialized = json.dumps(compiled)
            assert '"parent"' in serialized and json.dumps(reverse_link_id) in serialized
            assert '"middle-dangling"' not in serialized and '"other-house"' not in serialized
            assert '"lower-other"' not in serialized and '"lower-dangling"' not in serialized
            evidence("parent-path-search", {
                "editorStatus": saved.save.status, "field": field.to_json(),
                "workerPromptIds": [display["id"] for display in search["displays"]],
                "request": sent[0].params, "compiled": compiled, "entities": sorted(entities),
                "responses": [(item.url_name, item.status) for item in served.hq.exchanges],
            })
            assert screen_kind(results) == "entities" and entities == {expected}, results
            assert not served.hq.failures(), served.hq.failures()


@pytest.mark.parametrize("platform_name", [
    pytest.param("web-apps", marks=pytest.mark.reader("webapps")),
    pytest.param("android", marks=pytest.mark.reader("android")),
])
def test_hq_saved_parent_date_matches_the_exact_parent_text_in_web_apps(
    hq, core_runner, editor_driver, formplayer_runner, evidence, platform_name,
):
    """A scalar picker sends a day through HQ's ordinary ancestor matcher. Android omits that widget."""
    from proof.android import observe
    from proof.android.navigation import nav
    from proof.observe.record import Blobs
    from proof.webapps import steps
    from proof.webapps.session import Session

    variant = "hq-search/date-field-named-by-a-parent-path"
    row = next(candidate for candidate in load_variants() if candidate.id == variant)
    source = json.loads((HQ_APPS / row.base / "app.json").read_bytes())
    assert row.change["pointer"] == "/modules/0/search_config/properties/1"
    held_prompt = row.change["value"]
    key = held_prompt["name"]
    assert key == "parent/village" and held_prompt["input_"] == "date"
    source["modules"][0]["search_config"]["properties"][1] = held_prompt
    source["cloudcare_enabled"] = True
    day, earlier, later = "2024-03-10", "2024-03-09", "2024-03-11"
    stamp = "2025-12-01T08:00:00.000Z"

    def record(case_id, kind, village, parent=None):
        return casedata.CaseRecord(
            case_id, kind, case_id, casedata.USER_ID, stamp, stamp, None,
            (("village", village), ("last_visit", "2024-01-01")),
            (("parent", "household", parent, "child"),) if parent else (),
        )

    database = casedata.CaseDatabase(casedata.USER_ID, casedata.USERNAME, (), (
        record("exact-parent", "household", day),
        record("same-era-earlier", "household", earlier),
        record("same-era-later", "household", later),
        record("same-day-timestamp", "household", f"{day}T12:30:00Z"),
        record("exact-parent-result", "client", earlier, "exact-parent"),
        record("earlier-parent-result", "client", day, "same-era-earlier"),
        record("later-parent-result", "client", day, "same-era-later"),
        record("timestamp-parent-result", "client", day, "same-day-timestamp"),
        record("dangling-parent-result", "client", day, "missing-parent"),
        record("unlinked-result", "client", day),
    ))
    configuration = Configuration(
        flags={"CASE_SEARCH_ADVANCED", "CASE_SEARCH_RELATED_LOOKUPS", "FOLLOWUP_FORMS_AS_CASE_LIST_FORM",
               "SYNC_SEARCH_CASE_CLAIM"},
        privileges={"CLOUDCARE", "LOOKUP_TABLES"},
        case_search_enabled=True,
    )
    with hq_check(configuration) as (unit, _):
        with unit.operation("parent-date:import", row.id.encode()):
            assert not operations.upload_lookup_workbook(unit, _districts(), replace=False).errors
            app_id, _ = operations.publish(unit, [nova_shaped_upload(source, "Parent date Search")])
        before = operations.held_app(unit, app_id).modules[0]
        saved = pages.fresh_section_save(editor_driver, unit, pages.CASE_SEARCH, app_id, before.unique_id)
        assert saved.save and saved.save.status == 200 and not saved.refused, (saved.alerts, saved.unsent)
        field = operations.held_app(unit, app_id).modules[0].search_config.properties[1]
        assert (field.name, field.input_, field.exclude) == (key, "date", False)

        with serve(unit, None, app_id, runner=formplayer_runner, database=database) as served:
            if platform_name == "android":
                blobs = Blobs()
                followup = ["m0", "m0-f1"]
                search = [*followup, "@action:0"]
                found = nav(served, blobs, label="parent-date", archive=observe.release_archive(served),
                            paths=[followup, search])
                android = blobs.get_json(found["answer"])
                assert android["install"] == "Installed" and android["signIn"].startswith("Success("), android
                listed = android["navs"]["path:" + "/".join(followup)]
                assert any("Search All Cases" in step.get("list", {}).get("actions", [])
                           for step in listed["steps"] if step.get("list")), listed
                searched = android["navs"]["path:" + "/".join(search)]
                queries = [step["query"] for step in searched["steps"] if "query" in step]
                evidence("parent-date-android", {"saved": field.to_json(), "queries": queries})
                assert len(queries) == 1 and queries[0]["opened"], searched
                assert {"client_name", "client_code"} <= set(queries[0]["prompts"]), queries
                assert key not in queries[0]["prompts"]
                assert key not in queries[0]["RemoteQuerySessionManager.getRawQueryParams"]
                return

            opening = [*steps.open_app("Parent date Search"), *steps.choose("Clients"),
                       *steps.choose("Followup Form"),
                       *steps.click(steps.LIST_ACTION, "Search All Cases", visible=True, within=1500)]
            type_day = {"eval": """() => {
                const date = document.querySelectorAll('#query-list-contents input.date')[0];
                if (!date) throw new Error('The parent scalar date picker is missing');
                date.value = '3/10/2024';
                date.dispatchEvent(new Event('change', {bubbles: true}));
                return date.value;
            }"""}
            run = Session(served, editor_driver).run([
                *opening, steps.SCREEN, type_day, steps.SETTLE, *steps.run_search(), steps.SCREEN,
            ])
            assert run.page_errors == [], run.page_errors
            sent = [search for search in served.hq.searches if search.values(key)]
            evidence("parent-date-web-apps", {
                "saved": field.to_json(), "request": [search.params for search in sent],
                "screens": run.screens,
            })
            assert [search.values(key) for search in sent] == [(day,)], sent
            assert sent[0].values("village") == ()
            assert [result["id"] for result in run.screens[-1]["list"]["rows"]] == ["row-exact-parent-result"]
