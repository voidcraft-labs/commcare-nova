"""Formplayer selects a visit from an active HQ endpoint, claims it and submits its update."""
from contextlib import nullcontext

import pytest
from lxml import etree

from proof.hq.configuration import Configuration
from proof.hq.state import open_unit


def _worker_search_app(endpoint_id):
    """HQ's working case-update form, reachable through either route to the directory."""
    from copy import deepcopy

    from proof.hq.conftest import hq_test_app

    app = hq_test_app()
    app["build_spec"]["version"] = "2.57.0"
    app["cloudcare_enabled"] = True
    original = app["modules"][0]
    source = original["forms"][1]
    form_xml = app["_attachments"][source["unique_id"] + ".xml"]
    app["modules"] = []
    app["_attachments"] = {}
    for index, (label, case_type) in enumerate([("Clinics", "clinic"), ("Directory", "visit"), ("Follow up", "visit")]):
        module = deepcopy(original)
        module.update(name={"en": label}, unique_id=f"{index + 1:032x}", case_type=case_type)
        for size in ("short", "long"):
            detail = module["case_details"][size]
            # The suite fixture filters its local list to a demonstration value.
            # The visit directory displays every locally available visit.
            detail.pop("filter", None)
            column = detail["columns"][0]
            column.update(field="case_name", header={"en": "Name"})
            detail["columns"] = [column]
        form = deepcopy(source)
        form.update(unique_id=f"{index + 4:032x}", xmlns=f"urn:nova:proof:worker-search:{index}")
        module["forms"] = [form]
        app["_attachments"][form["unique_id"] + ".xml"] = form_xml.replace(source["xmlns"], form["xmlns"])
        if index:
            module["search_config"] = {
                "case_search_endpoint_id": endpoint_id,
                "default_properties": [{"property": "region", "defaultValue": "'north'"}],
                "inline_search": index == 2,
                "auto_launch": True,
                "default_search": True,
            }
        if index == 2:
            module["parent_select"] = {"active": True, "module_id": app["modules"][0]["unique_id"], "relationship": "parent"}
        app["modules"].append(module)
    return app


@pytest.mark.parametrize(("provider", "route", "menu", "expected"), [
    ("elasticsearch", "ordinary", "1", {"linked", "other"}),
    ("projectdb", "ordinary", "1", {"linked", "other"}),
    ("elasticsearch", "inline", "2", {"linked"}),
    ("projectdb", "inline", "2", set()),
], ids=["es-ordinary", "sql-ordinary", "es-inline", "sql-inline"])
def test_worker_chooses_and_claims_a_directory_visit_through_both_entries(
    provider, route, menu, expected, hq, formplayer_runner, evidence,
):
    from hashlib import sha256

    from corehq.apps.case_search.models import CaseSearchEndpoint, CaseSearchEndpointVersion
    from corehq.apps.data_dictionary.models import CaseProperty, CaseType
    from proof.formplayer import apps
    from proof.formplayer.hq import serve
    from proof.formplayer.walk import questions, screen_kind
    from proof.hq.conftest import nova_shaped_upload
    from proof.hq.operations import publish
    from proof.observe import casedata

    from proof.hq.database import fresh_database
    from proof.hq.project_search_database import visit_database

    stamp = "2025-12-01T08:00:00.000Z"

    def case(key, kind, owner, parent=None):
        return casedata.CaseRecord(key, kind, key, owner, stamp, stamp, None,
                                  (("district", "north"),) if kind == "visit" else (),
                                  (("parent", "clinic", parent, "child"),) if parent else ())

    rows = casedata.CaseDatabase(casedata.USER_ID, casedata.USERNAME, (), (
        case("clinic-a", "clinic", casedata.USER_ID), case("clinic-b", "clinic", casedata.USER_ID),
        case("linked", "visit", "other-worker", "clinic-a"), case("other", "visit", "other-worker", "clinic-b"),
    ))
    sql_rows = [("linked", "other-worker", "north", "clinic-a"), ("other", "other-worker", "north", "clinic-b")]
    domain = visit_database(sql_rows) if provider == "projectdb" else nullcontext("visit-directory")
    with domain as space, (fresh_database() if provider == "projectdb" else nullcontext()):
        settings = Configuration(
            domain=space, flags={"CASE_SEARCH_ENDPOINTS", "SYNC_SEARCH_CASE_CLAIM"}, privileges={"CLOUDCARE"},
            case_search_enabled=True, sync_cases_on_form_entry=True,
        )
        with open_unit(settings, root_key=settings.digest(), strict=False) as unit:
            with unit.operation("build visit directory", sha256(b"visit directory").digest()):
                if provider == "projectdb":
                    endpoint = CaseSearchEndpoint.objects.create(domain=unit.domain, name="Visits",
                                                                target_type=CaseSearchEndpoint.TargetType.PROJECT_DB)
                    endpoint.current_version = CaseSearchEndpointVersion.objects.create(
                        endpoint=endpoint, version_number=1, case_type="visit", action=CaseSearchEndpointVersion.Action.CREATE,
                        dangerous_sql=(
                            "SELECT case_id, case_id AS case_name, parent_id AS index "
                            "FROM visit WHERE case_name = :region "
                            "AND (:_xpath_query IS NULL OR parent_id IS NOT NULL) "
                            "AND (:commcare_blacklisted_owner_ids IS NULL OR owner_id <> :commcare_blacklisted_owner_ids) "
                            "ORDER BY case_id"
                        ),
                    )
                else:
                    visit = CaseType.objects.create(domain=unit.domain, name="visit")
                    CaseProperty.objects.create(case_type=visit, name="district", data_type=CaseProperty.DataType.PLAIN)
                    endpoint = CaseSearchEndpoint.objects.create(domain=unit.domain, name="Visits",
                                                                 target_type=CaseSearchEndpoint.TargetType.ELASTICSEARCH)
                    endpoint.current_version = CaseSearchEndpointVersion.objects.create(
                        endpoint=endpoint, version_number=1, case_type="visit", action=CaseSearchEndpointVersion.Action.CREATE,
                        parameters=[{"name": "region", "type": "text"}],
                        query={"type": "all", "children": [{"type": "component", "field": "district", "operator": "equals",
                                                            "inputs": {"value": {"type": "parameter", "value": "region"}}}]},
                    )
                endpoint.save(update_fields=["current_version"])
                app_id, _ = publish(unit, [nova_shaped_upload(_worker_search_app(endpoint.pk), "Worker visits")])
            with serve(unit, None, app_id, runner=formplayer_runner, database=rows) as served:
                with served.run(route):
                    start = len(served.hq.claims)
                    sent = len(served.hq.submissions)
                    search = len(served.hq.searches)
                    web = apps.web(formplayer_runner, served)
                    response = web.navigate([menu])
                    if route == "inline":
                        assert {item["id"] for item in response.get("entities", [])} == {"clinic-a", "clinic-b"}, response
                        response = web.navigate([*response["selections"], "clinic-a"])
                    assert screen_kind(response) == "entities", response
                    assert {item["id"] for item in response["entities"]} == expected, response
                    assert any(req.values("region") == ("north",) and req.values("x_commcare_endpoint_id") == (str(endpoint.pk),)
                               for req in served.hq.searches[search:]), served.hq.searches[search:]
                    if not expected:
                        # ProjectDB emits index as a flat text child. The parent
                        # datum requires a nested relationship in the returned fixture.
                        assert not served.hq.failures(), served.hq.failures()
                        assert not served.hq.claims[start:] and not served.hq.submissions[sent:]
                        evidence("parent-excludes-flat-index", {"requests": [r.params for r in served.hq.searches[search:]],
                                                                "visible": [], "claims": []})
                        return
                    selections = [*response["selections"], "linked"]
                    form = web.navigate(selections)
                    def observation(screen):
                        return {
                            "kind": screen_kind(screen), "selections": screen.get("selections"),
                            "entities": [item["id"] for item in screen.get("entities", [])],
                            "commands": screen.get("commands"), "notifications": screen.get("notifications"),
                            "searches": [s.params for s in served.hq.searches[search:]],
                            "claims": [s.params for s in served.hq.claims[start:]],
                            "answers": [(r.url_name, r.status) for r in served.hq.exchanges],
                        }

                    after_choice = observation(form)
                    evidence("after-choice", after_choice)
                    # The ordinary remote request rewinds to the form's case
                    # selection after the worker claims the case.
                    if route == "ordinary" and screen_kind(form) == "entities":
                        assert "linked" in after_choice["entities"], after_choice
                        form = web.navigate([*form["selections"], "linked"])
                    # A menu with one available form may still ask which form to open.
                    if screen_kind(form) == "commands":
                        assert len(form["commands"]) == 1, form
                        form = web.navigate([*form["selections"], "0"])
                    assert screen_kind(form) == "form", (after_choice, observation(form))
                    assert [claim.values("case_id") for claim in served.hq.claims[start:] if "linked" in claim.values("case_id")]
                    assert not served.hq.failures(), served.hq.failures()
                    [rename] = [node for node in questions(form["tree"]) if node.get("datatype") == "str"]
                    submitted = web.submit(form["session_id"], {rename["ix"]: "Visited"})
                    instances = [etree.fromstring(sub.instance) for sub in served.hq.submissions[sent:] if sub.instance]
                    updates = [(block.get("case_id"), block.xpath("string(./*[local-name()='update']/*[local-name()='case_name'])"))
                               for instance in instances for block in instance.xpath("//*[local-name()='case'][@case_id]")]
                    assert ("linked", "Visited") in updates, (submitted, updates)
                    evidence(route, {"selected": sorted(expected), "claim": [claim.params for claim in served.hq.claims[start:]],
                                     "updates": updates})
