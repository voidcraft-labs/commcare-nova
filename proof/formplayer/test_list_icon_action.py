"""The Web Apps list action submits its chosen form against the clicked case."""
import re

from lxml import etree

from proof.hq.configuration import Configuration
from proof.hq.state import open_unit


def test_icon_submits_the_eligible_form_for_its_row(hq, formplayer_runner, evidence):
    from hashlib import sha256

    from corehq.apps.app_manager.views.modules import _form_endpoint_options
    from proof.formplayer import apps
    from proof.formplayer.hq import serve
    from proof.hq.conftest import hq_test_app_with_menu_ids, nova_shaped_upload
    from proof.hq.operations import held_app, publish
    from proof.observe import casedata

    app = hq_test_app_with_menu_ids()
    app["build_spec"]["version"] = "2.57.0"
    app["cloudcare_enabled"] = True
    [module] = app["modules"]
    form = module["forms"][1]
    module["forms"] = [form]
    form["session_endpoint_id"] = "record-visit"
    # The suite-test form preloads its name over any starting answer. Here the action records a new name.
    form["actions"]["case_preload"]["preload"] = {}
    file = form["unique_id"] + ".xml"
    xml = app["_attachments"][file].replace("rename-label", "Pragma-Submit-Automatically")
    app["_attachments"] = {file: xml.replace("<rename/>", "<rename>Visited</rename>")}
    for size in ("short", "long"):
        detail = module["case_details"][size]
        detail.pop("filter", None)
        column = detail["columns"][0]
        column.update(field="case_name", header={"en": "Name"})
        detail["columns"] = [column]
    module["case_details"]["short"]["columns"].append({
        "doc_type": "DetailColumn", "model": "case", "field": "visit_state",
        "header": {"en": "Record visit"}, "format": "clickable-icon", "endpoint_action_id": "record-visit",
        "enum": [{"key": "ready", "value": {"en": "jr://icons/tick.png"}, "alt_text": {"en": "Record visit"}}],
    })
    stamp = "2026-04-01T00:00:00.000Z"
    cases = casedata.CaseDatabase(casedata.USER_ID, casedata.USERNAME, (), tuple(
        casedata.CaseRecord(key, module["case_type"], key, casedata.USER_ID, stamp, stamp, None, (("visit_state", "ready"),))
        for key in ("first-visit", "second-visit")
    ))
    settings = Configuration(flags={"CASE_LIST_CLICKABLE_ICON", "SESSION_ENDPOINTS"}, privileges={"CLOUDCARE"})
    with open_unit(settings, root_key=settings.digest(), strict=False) as unit:
        with unit.operation("publish a one-click visit", sha256(b"two visits").digest()):
            app_id, _ = publish(unit, [nova_shaped_upload(app, "Mobile visits")])
            held = held_app(unit, app_id)
            offered = _form_endpoint_options(held, held.get_module(0), "en")
            assert [row["id"] for row in offered] == ["record-visit"]
        with serve(unit, None, app_id, runner=formplayer_runner, database=cases) as served:
            with served.run("mark the second visit"):
                web = apps.web(formplayer_runner, served)
                response = web.navigate(["0"])
                assert {row["id"] for row in response["entities"]} == {"first-visit", "second-visit"}, response
                [action] = [row for row in response["endpointActions"] if row]
                route = re.fullmatch(r"/a/\{domain\}/app/v1/\{appid\}/([^/?]+)/\?([^=]+)=\{([^}]+)\}", action["urlTemplate"])
                assert route and route[1] == "record-visit" and route[2] == route[3] and action["background"]
                sent = len(served.hq.submissions)
                outcome = web.navigate([], route="get_endpoint", endpoint_id=route[1], endpoint_args={route[2]: "second-visit"})
                records = [etree.fromstring(sub.instance) for sub in served.hq.submissions[sent:] if sub.instance]
                updates = [(block.get("case_id"), block.xpath("string(./*[local-name()='update']/*[local-name()='case_name'])"))
                           for record in records for block in record.xpath("//*[local-name()='case'][@case_id]")]
                assert updates == [("second-visit", "Visited")], (outcome, updates)
                evidence("click-second-row", {"editor": offered, "action": action, "updates": updates})
