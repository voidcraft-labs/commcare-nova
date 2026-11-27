"""Formplayer reads existing Advanced links and submits links from HQ-built open actions."""

import pytest

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


def _advanced_index_producer(state, name, *, web_apps):
    app_id = publish_hq_app(state, ADVANCED_APP)
    app = operations.held_app(state, app_id)
    app.cloudcare_enabled = web_apps
    app.modules[1].forms[1].actions.open_cases[0].case_indices[0].reference_id = name
    app.save()
    return app_id


def _assert_produced_index(raw, name):
    from lxml import etree
    from proof.editors.test_advanced_index_identifier import CASE

    form = etree.fromstring(raw)
    link, = form.xpath("//*[local-name()='index']/*[local-name()=$name]", name=name)
    assert link.tag == f"{{{CASE}}}{name}", raw
    assert (link.text, link.get("case_type")) == (PARENT, "clinic"), raw
    return link.getparent().getparent().get("case_id")


@pytest.mark.reader("formplayer")
@pytest.mark.parametrize("name", ["probe", "probeé", "Ωprobe"], ids=["ascii", "accented", "greek"])
def test_formplayer_opens_and_submits_advanced_index_producer(hq, formplayer_runner, evidence, name):
    from corehq.form_processor.models import CommCareCase
    from proof.formplayer.test_receiving_answers import _questions
    from proof.formplayer.webapps import FormplayerRefused

    database = _worker_database(_worker_case(PARENT, "clinic", "Selected clinic"))
    with hq_check(Configuration(privileges={"CHILD_CASES", "CLOUDCARE"})) as (state, _):
        app_id = _advanced_index_producer(state, name, web_apps=True)
        with serve(state, None, app_id, runner=formplayer_runner, database=database, platforms={"web-apps"}) as served:
            with served.run("advanced-index-producer"):
                web = apps.web(formplayer_runner, served)
                menu = _open_command(web, web.navigate(), "Manage Supply Points")
                clinic = _open_command(web, menu, "Create Requisition")
                assert screen_kind(clinic) == "entities", clinic
                assert [row["id"] for row in clinic["entities"]] == [PARENT], clinic
                args = [*map(str, clinic["selections"]), PARENT]
                if not name.isascii():
                    with pytest.raises(FormplayerRefused, match="SAXParseException") as failed:
                        web.navigate(args)
                    assert not served.hq.submissions
                    evidence("advanced-index-cannot-open", {
                        "name": name, "status": failed.value.exchange.response.status,
                        "exception": str(failed.value),
                    })
                    return
                form = web.navigate(args)
                assert screen_kind(form) == "form", form
                question, = _questions(form["tree"])
                reply = web.submit(form["session_id"], {question["ix"]: "One requisition"})
                assert reply["status"] == "success", reply
                submission, = served.hq.submissions
                case_id = _assert_produced_index(submission.instance, name)
                created = CommCareCase.objects.get_case(case_id, state.domain)
                index, = created.indices
                assert (index.identifier, index.referenced_id) == (name, PARENT)
                evidence("advanced-index-submitted", {"name": name, "caseType": created.type})


@pytest.mark.reader("android")
def test_installed_android_submits_advanced_unicode_index(hq, evidence):
    from corehq.form_processor.models import CommCareCase
    from proof.android import observe
    from proof.observe.record import Blobs

    name = "Ωprobe"
    database = _worker_database(_worker_case(PARENT, "clinic", "Selected clinic"))
    with hq_check(Configuration(privileges={"CHILD_CASES"})) as (state, _):
        app_id = _advanced_index_producer(state, name, web_apps=False)
        with serve(state, None, app_id, database=database, platforms={"android"}) as served:
            archive = observe.release_archive(served)
            blobs, sent = Blobs(), []
            result = observe.app(
                served, blobs, label="advanced-unicode-index", archive=archive, delivered=True,
                commands=["m1-f1"], questions={"/data/req_name": ["One requisition"]}, sent=sent,
            )
            assert len(sent) == 1, blobs.get_json(result["answer"])
            case_id = _assert_produced_index(sent[0], name)
            created = CommCareCase.objects.get_case(case_id, state.domain)
            index, = created.indices
            assert (index.identifier, index.referenced_id) == (name, PARENT)
            evidence("advanced-unicode-android-submitted", {"name": name, "caseType": created.type})
