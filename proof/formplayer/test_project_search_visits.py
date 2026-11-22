"""Formplayer selects a visit from an active HQ endpoint, claims it and submits its update."""
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


def test_worker_chooses_and_claims_a_directory_visit_through_both_entries(hq, formplayer_runner, evidence):
    from hashlib import sha256

    from corehq.apps.case_search.models import CaseSearchEndpoint, CaseSearchEndpointVersion
    from corehq.apps.data_dictionary.models import CaseProperty, CaseType
    from proof.formplayer import apps
    from proof.formplayer.hq import serve
    from proof.formplayer.walk import questions, screen_kind
    from proof.hq.conftest import nova_shaped_upload
    from proof.hq.operations import publish
    from proof.observe import casedata

    settings = Configuration(
        domain="visit-directory", flags={"CASE_SEARCH_ENDPOINTS", "SYNC_SEARCH_CASE_CLAIM"},
        privileges={"CLOUDCARE"}, case_search_enabled=True, sync_cases_on_form_entry=True,
    )
    stamp = "2025-12-01T08:00:00.000Z"

    def case(key, kind, owner, parent=None):
        return casedata.CaseRecord(key, kind, key, owner, stamp, stamp, None,
                                  (("district", "north"),) if kind == "visit" else (),
                                  (("parent", "clinic", parent, "child"),) if parent else ())

    rows = casedata.CaseDatabase(casedata.USER_ID, casedata.USERNAME, (), (
        case("clinic-a", "clinic", casedata.USER_ID), case("clinic-b", "clinic", casedata.USER_ID),
        case("linked", "visit", "other-worker", "clinic-a"), case("other", "visit", "other-worker", "clinic-b"),
    ))
    with open_unit(settings, root_key=settings.digest(), strict=False) as unit:
        with unit.operation("build visit directory", sha256(b"visit directory").digest()):
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
            for route, menu, expected in [("ordinary", "1", {"linked", "other"}), ("inline", "2", {"linked"})]:
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
                    selections = [*response["selections"], "linked"]
                    form = web.navigate(selections)
                    # A menu with one available form may still ask which form to open.
                    if screen_kind(form) == "commands":
                        assert len(form["commands"]) == 1, form
                        form = web.navigate([*form["selections"], "0"])
                    assert screen_kind(form) == "form", form
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
