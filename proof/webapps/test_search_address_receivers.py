"""Observe how Web Apps dispatches address answers to Search fields."""

import pytest

from proof.editors import pages
from proof.hq import operations
from proof.observe import casedata
from proof.observe.search_address import enable_address_search
from proof.webapps import hq as webapps_hq
from proof.webapps import steps
from proof.webapps.session import Session
from proof.webapps.test_search import _menu_requests
from proof.webapps.test_search_geocoder import PLACE, TYPE_ADDRESS, _geocoder_fields


def _same_text_receiver_fields(app):
    _geocoder_fields(app, "text")
    fields = app["modules"][0]["search_config"]["properties"]
    for field in fields:
        if field["name"] in ("village", "client_name"):
            field["receiver_expression"] = "home-region"


def test_search_address_fills_two_text_fields_with_the_same_subscription(
    hq, core_runner, formplayer_runner, editor_driver, webapps_documents
):
    document = webapps_documents["hq-search"]
    read = {
        "eval": """() => [...document.querySelectorAll('input[data-receive="home-region"]')]
            .map(input => input.value)"""
    }
    opening = [
        {"geocoderFixture": {"query": "Visit Road", "feature": PLACE}},
        *steps.open_app("Client search"),
        *steps.choose("Clients"),
        *steps.choose("Followup Form"),
        steps.SCREEN,
        TYPE_ADDRESS,
        {"until": "webapps/choose_address", "arg": {"name": PLACE["place_name"], "scope": "#home_mapbox"}, "within": 8000},
        steps.SETTLE,
    ]

    database = casedata.document_case_database(document)
    with webapps_hq.authored_project(document, "A", configure=enable_address_search) as project:
        with project.released(formplayer_runner, change=_same_text_receiver_fields, database=database) as release:
            run = Session(release, editor_driver).run([*opening, read, *steps.run_search(), steps.SCREEN])

    assert run.page_errors == []
    assert run.value(len(opening)) == ["Upper valley", "Upper valley"]
    sent = [
        entry["inputs"] for request in _menu_requests(run) if request["searched"]
        for entry in request["queryData"].values() if isinstance(entry, dict) and entry.get("execute")
    ]
    assert len(sent) == 1
    assert sent[0]["village"] == sent[0]["client_name"] == "Upper valley"


def _rebuild_reviewed_receivers(project):
    """Read the HQ save through Nova's normal review and send the generated app back."""
    from corehq import privileges

    from proof.hq import redis as hq_redis
    from proof.hq.conftest import nova_shaped_upload
    from proof.hq.seams import also_granted, api_rate_limits
    from proof.matrix.author import Authoring, READER
    from proof.matrix.registry import BASES
    from proof.matrix.retain import app_reads, project_data_reads, reading_input, run_bundle

    unit, app_id = project.unit, project.app_id
    document = project.document
    base = next(base for base in BASES if base.id == document.id)
    author = Authoring(unit, {document.id: document}, document.id, operation=unit.operation)
    with hq_redis.shared(None), unit.committing(), also_granted(privileges.API_ACCESS), api_rate_limits(unit):
        with author.step("search-receiver:api-user"):
            credential = operations.seed_api_user(unit, READER)

        original = document.document
        answers = app_reads(author, app_id, credential)
        project_data, media = project_data_reads(author, app_id, credential)
        (incoming,) = run_bundle([{
            "id": "unmatched-search-topic-a",
            "mode": "first-read",
            "input": reading_input(answers, project_data, media, base, claims="full"),
            "expected": original["doc"],
            "reviewChanges": True,
        }])
        assert incoming["kind"] == "read", incoming
        review = incoming["review"]
        assert review["kind"] == "changes", review
        application = review["application"]
        fields = application["modules"][0]["search_config"]["properties"]
        aliases = {field["name"]: field["receiver_expression"] for field in fields if field.get("receiver_expression")}
        assert aliases == {"client_name": "home-region", "village": "home||city"}
        with author.step("search-receiver:publish"):
            result = operations.apply_upload(unit, nova_shaped_upload(application, application["name"], app_id=app_id))
        assert result.status == 200, result.response

        target = {**original, "doc": review["target"]}
        answers = app_reads(author, app_id, credential)
        (reread,) = run_bundle([{
            "id": "unmatched-search-topic-b",
            "mode": "read-back",
            "input": {
                "appId": target["doc"]["appId"], "identity": "match", "claims": "full",
                "document": target, "application": answers["application"].retained(),
                "source": answers["source"].retained(), "currentVersion": answers["currentVersion"].retained(),
            },
            "expected": target["doc"],
        }])
        assert reread["kind"] == "read", reread
        assert reread["differences"] == [], reread["differences"]
        return aliases


@pytest.mark.parametrize("expression", ["home", "home||city"], ids=["matching-topic", "unmatched-topic"])
def test_editor_keeps_malformed_receiver_and_only_the_matching_topic_fails(
    hq, core_runner, formplayer_runner, editor_driver, webapps_documents, evidence, expression
):
    from corehq.apps.app_manager.models.case_search import CaseSearchProperty

    document = webapps_documents["hq-search"]
    database = casedata.document_case_database(document)
    opening = [
        {"geocoderFixture": {"query": "Visit Road", "feature": PLACE}},
        *steps.open_app("Client search"),
        *steps.choose("Clients"),
        *steps.choose("Followup Form"),
        steps.SCREEN,
        TYPE_ADDRESS,
        {"until": "webapps/choose_address", "arg": {"name": PLACE["place_name"], "scope": "#home_mapbox"}, "within": 8000},
        steps.SETTLE,
    ]
    read = {
        "eval": """() => Object.fromEntries([...document.querySelectorAll('input.query-field[data-receive]')]
            .filter(input => input.dataset.receive)
            .map(input => [input.dataset.receive, input.value]))"""
    }

    with webapps_hq.authored_project(document, "A", configure=enable_address_search) as project:
        app = operations.held_app(project.unit, project.app_id)
        source = app.to_json()
        _geocoder_fields(source, "text")
        fields = source["modules"][0]["search_config"]["properties"]
        next(field for field in fields if field["name"] == "client_name")["receiver_expression"] = "home-region"
        next(field for field in fields if field["name"] == "village")["receiver_expression"] = expression
        menu = app.modules[0]
        menu_id = menu.unique_id
        menu.search_config.properties = [CaseSearchProperty.wrap(field) for field in fields]
        app.cloudcare_enabled = source["cloudcare_enabled"]
        app.save()

        saved = pages.fresh_section_save(editor_driver, project.unit, pages.CASE_LIST, project.app_id, menu_id)
        current = operations.held_app(project.unit, project.app_id).get_module_by_unique_id(menu_id)
        retained = {
            field.name: field.receiver_expression for field in current.search_config.properties
            if field.name in {"client_name", "village"}
        }
        evidence("search-address-malformed-editor", {
            "requested": expression, "status": saved.save.status if saved.save else None,
            "alerts": saved.alerts, "retained": retained,
        })
        assert saved.save and saved.save.status == 200 and not saved.refused, saved.alerts
        assert retained == {"client_name": "home-region", "village": expression}

        if expression == "home||city":
            emitted = _rebuild_reviewed_receivers(project)
            evidence("search-address-reviewed-aliases", emitted)
            # The emitted result also has to survive the native editor again.
            resaved = pages.fresh_section_save(editor_driver, project.unit, pages.CASE_LIST, project.app_id, menu_id)
            assert resaved.save and resaved.save.status == 200 and not resaved.refused, resaved.alerts
            current = operations.held_app(project.unit, project.app_id).get_module_by_unique_id(menu_id)
            assert {
                field.name: field.receiver_expression for field in current.search_config.properties
                if field.receiver_expression
            } == emitted

        with project.released(formplayer_runner, database=database) as release:
            run = Session(release, editor_driver).run([*opening, read])

    values = run.value(len(opening))
    evidence("search-address-malformed-topic", {"values": values, "pageErrors": run.page_errors})
    assert values == {"home-region": "Upper valley", expression: ""}
    if expression == "home":
        assert len(run.page_errors) == 1 and "reading 'split'" in str(run.page_errors[0]), run.page_errors
    else:
        assert run.page_errors == []
