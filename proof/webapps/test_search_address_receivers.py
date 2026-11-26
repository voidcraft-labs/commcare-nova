"""Web Apps can broadcast the same address part to several text fields."""

from dataclasses import replace

from proof.observe import casedata
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
