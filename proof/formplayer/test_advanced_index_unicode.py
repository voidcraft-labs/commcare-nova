"""Formplayer follows a Georgian index that the older Android lexer cannot name."""

from proof.editors.conftest import ADVANCED_APP, publish_hq_app
from proof.editors.test_advanced_index_identifier import PARENT, _worker_case, _worker_database
from proof.editors.test_advanced_unicode_transport import _profiles
from proof.formplayer import apps
from proof.formplayer.hq import serve
from proof.formplayer.walk import screen_kind
from proof.hq import operations
from proof.hq.check import hq_check
from proof.hq.configuration import Configuration


def _open_command(web, screen, label):
    assert screen_kind(screen) == "commands", screen
    selected, = [
        str(index) for index, item in enumerate(screen["commands"])
        if item["displayText"] == label
    ]
    return web.navigate([*map(str, screen.get("selections", ())), selected])


def test_web_only_georgian_advanced_connection_resolves_the_signed_worker_route(hq, formplayer_runner, evidence):
    from corehq.apps.app_manager.models import AutoSelectCase, LoadUpdateAction

    name = "აprobe"
    web_names, android_names = _profiles()
    assert ord(name[0]) in web_names["initial"]
    assert ord(name[0]) not in android_names["initial"]
    witness = "georgian-requisition"
    database = _worker_database(
        _worker_case(PARENT, "clinic", "Selected clinic"),
        _worker_case(witness, "requisition", "Georgian connection", indices=((name, "clinic", PARENT, "child"),)),
        _worker_case("ascii-requisition", "requisition", "Unaccented neighbor", indices=(("aprobe", "clinic", PARENT, "child"),)),
        _worker_case(
            "unshared-requisition", "requisition", "Other worker",
            owner="another-worker", indices=((name, "clinic", PARENT, "child"),),
        ),
    )
    with hq_check(Configuration(privileges={"CHILD_CASES", "CLOUDCARE"})) as (state, _):
        app_id = publish_hq_app(state, ADVANCED_APP)
        app = operations.held_app(state, app_id)
        app.cloudcare_enabled = True
        forms = app.modules[1].forms
        forms[1].actions.open_cases[0].case_indices[0].reference_id = name
        receive = forms[2]
        receive.actions.load_update_cases[-1].case_index.reference_id = name
        receive.actions.load_update_cases.append(LoadUpdateAction(
            case_type="clinic",
            case_tag="return_clinic",
            auto_select=AutoSelectCase(mode="case", value_source="case_requisition", value_key=name),
        ))
        app.save()
        with serve(
            state, None, app_id, runner=formplayer_runner, database=database, platforms={"web-apps"},
        ) as served, served.run("web-only-georgian"):
            web = apps.web(formplayer_runner, served)
            menu = _open_command(web, web.navigate(), "Manage Supply Points")
            clinic = _open_command(web, menu, "Receive Requisition")
            assert screen_kind(clinic) == "entities", clinic
            assert [row["id"] for row in clinic["entities"]] == [PARENT], clinic
            requisition = web.navigate([*map(str, clinic["selections"]), PARENT])
            assert screen_kind(requisition) == "entities", requisition
            assert [row["id"] for row in requisition["entities"]] == [witness], requisition
            form = web.navigate([*map(str, requisition["selections"]), witness])
            assert screen_kind(form) == "form", form
            assert not served.hq.failures(), served.hq.failures()
            evidence("web-only-georgian-index", {"selected": witness, "form": form["title"]})
