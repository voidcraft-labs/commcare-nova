"""The Web Apps query screen broadcasts a selected address to its configured fields."""

from dataclasses import replace

import pytest

from proof.observe import casedata
from proof.webapps import hq as webapps_hq
from proof.webapps import steps
from proof.webapps.session import SMALL_SCREEN, Session
from proof.webapps.test_question_display import ADDRESS
from proof.webapps.test_search import _menu_requests

PLACE = {
    **ADDRESS,
    "place_name": "18 Visit Road, Example Town, Upper valley",
    "context": [*ADDRESS["context"], {"id": "region.proof-valley", "text": "Upper valley"}],
}


def _geocoder_fields(app, mode):
    app["cloudcare_enabled"] = True
    fields = app["modules"][0]["search_config"]["properties"]
    village = next(field for field in fields if field["name"] == "village")
    district = next(field for field in fields if field["name"] == "district")
    if mode in ("text", "combined"):
        village["receiver_expression"] = "home-us_state||city"
    if mode in ("lookup", "combined"):
        district["receiver_expression"] = "home-region"
    fields.insert(0, {
        "doc_type": "CaseSearchProperty", "name": "home",
        "label": {"en": "Find an address"}, "appearance": "address",
        "exclude": True,
    })


RECEIVERS = {
    "eval": """() => {
        const city = document.querySelector('#row-village input.query-field');
        const district = document.querySelector('#row-district select.query-field');
        if (!city || !district) throw Error("The address receivers are missing");
        return {
            city: city.value,
            district: district.selectedOptions[0]?.textContent.trim() || "",
            districtValue: district.value,
            districtChoices: [...district.options].map(option => [option.value, option.text.trim()]),
            address: JSON.parse(sessionStorage.geocoderValues || "{}").home || null,
            addressDisplayed: document.querySelector('#home_mapbox input')?.value || "",
            suggestions: [...document.querySelectorAll('#home_mapbox ul.suggestions li')].map(li => li.textContent.trim()),
            lookups: performance.getEntriesByType('resource')
                .filter(entry => entry.name.includes('/geocoding/'))
                .map(entry => new URL(entry.name).pathname),
            fields: [...document.querySelectorAll('.query-field')].map(field => ({
                tag: field.tagName, id: field.id, receiver: field.dataset.receive || null,
            })),
        };
    }"""
}
TYPE_ADDRESS = {
    "eval": """() => {
        const input = document.querySelector('[id$=_mapbox] input.mapboxgl-ctrl-geocoder--input');
        if (!input) throw Error("Search does not offer an address input");
        input.focus();
        input.value = "Visit Road";
        input.dispatchEvent(new KeyboardEvent("keydown", {key:"d", bubbles:true}));
    }"""
}
CLEAR_ADDRESS = {
    "eval": """() => {
        const geocoder = document.querySelector('[id$=_mapbox] .mapboxgl-ctrl-geocoder');
        geocoder.dispatchEvent(new MouseEvent("mouseenter"));
        const clear = geocoder.querySelector(".mapboxgl-ctrl-geocoder--button");
        if (!clear.getClientRects().length) throw Error("The selected address has no visible clear control");
        clear.click();
    }"""
}


@pytest.mark.parametrize(
    ("viewport", "mode"),
    [(None, "text"), (SMALL_SCREEN, "text"), (None, "lookup"), (None, "combined")],
    ids=["desktop-text", "phone-text", "lookup", "combined"],
)
def test_address_query_sends_ordered_fallback_and_lookup_value_without_the_address(
    hq, core_runner, formplayer_runner, editor_driver, webapps_documents, evidence, viewport, mode
):
    document = webapps_documents["hq-search"]
    opening = [*steps.open_app("Client search"), *steps.choose("Clients"), *steps.choose("Followup Form"), steps.SCREEN]
    select = [
        TYPE_ADDRESS,
        {"until": "webapps/choose_address",
         "arg": {"name": PLACE["place_name"], "scope": "#home_mapbox"}, "within": 8000},
        RECEIVERS,
        steps.SETTLE,
        RECEIVERS,
    ]

    def enable(config):
        return replace(
            config, privileges=config.privileges | {"CLOUDCARE", "GEOCODER"},
            flags=config.flags | {"CASE_SEARCH_ADVANCED"},
        )

    database = casedata.document_case_database(document)
    clear_and_choose = [CLEAR_ADDRESS, steps.SETTLE, RECEIVERS, *select] if viewport is None else []
    with webapps_hq.authored_project(document, "A", configure=enable) as project:
        with project.released(
            formplayer_runner, change=lambda app: _geocoder_fields(app, mode), database=database
        ) as release:
            run = Session(release, editor_driver).run([
                {"geocoderFixture": {"query": "Visit Road", "feature": PLACE}},
                *opening, RECEIVERS, *select, *clear_and_choose, *steps.run_search(), steps.SCREEN,
            ], viewport=viewport)
    before = 1 + len(opening)
    initial, picked, filled = run.value(before), run.value(before + 3), run.value(before + 5)
    cleared = run.value(before + 8) if viewport is None else None
    actual = [
        entry["inputs"] for request in _menu_requests(run) if request["searched"]
        for entry in request["queryData"].values() if isinstance(entry, dict) and entry.get("execute")
    ]
    evidence("search-address-broadcast", {
        "initial": initial, "picked": picked, "filled": filled, "cleared": cleared, "submitted": actual,
    })
    assert run.page_errors == []
    assert filled["address"] == PLACE["place_name"], filled
    expected = {}
    if mode in ("text", "combined"):
        assert filled["city"] == "Example Town", filled
        expected["village"] = "Example Town"
    if mode in ("lookup", "combined"):
        assert any(label == "Upper valley" for _, label in initial["districtChoices"]), initial
        assert filled["district"] == "Upper valley", filled
        expected["district"] = "d1"
    if cleared:
        assert cleared["city"] == "" and cleared["district"] != "Upper valley"
    assert actual == [expected], actual
