"""Observe how Web Apps dispatches address answers to Search fields."""

from dataclasses import replace

import pytest

from proof.editors import pages
from proof.hq import operations
from proof.observe import casedata
from proof.webapps import hq as webapps_hq
from proof.webapps import steps
from proof.webapps.session import Session
from proof.webapps.test_search import _menu_requests
from proof.webapps.test_search_geocoder import PLACE, TYPE_ADDRESS, _enable_address_search, _geocoder_fields


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

    def enable(config):
        return replace(
            config, privileges=config.privileges | {"CLOUDCARE", "GEOCODER"},
            flags=config.flags | {"CASE_SEARCH_ADVANCED"},
        )

    database = casedata.document_case_database(document)
    with webapps_hq.authored_project(document, "A", configure=enable) as project:
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

    with webapps_hq.authored_project(document, "A", configure=_enable_address_search) as project:
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

        with project.released(formplayer_runner, database=database) as release:
            run = Session(release, editor_driver).run([*opening, read])

    values = run.value(len(opening))
    evidence("search-address-malformed-topic", {"values": values, "pageErrors": run.page_errors})
    assert values == {"home-region": "Upper valley", expression: ""}
    if expression == "home":
        assert len(run.page_errors) == 1 and "reading 'split'" in str(run.page_errors[0]), run.page_errors
    else:
        assert run.page_errors == []
