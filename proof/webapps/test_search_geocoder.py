"""The Web Apps query screen broadcasts a selected address to its configured fields."""

from dataclasses import replace

from proof.observe import casedata
from proof.webapps import hq as webapps_hq
from proof.webapps import steps
from proof.webapps.session import Session
from proof.webapps.test_question_display import ADDRESS
from proof.webapps.test_search import _menu_requests

PLACE = {
    **ADDRESS,
    "place_name": "18 Visit Road, Example Town, Upper valley",
    "context": [*ADDRESS["context"], {"id": "region.proof-valley", "text": "Upper valley"}],
}


def _geocoder_fields(app):
    app["cloudcare_enabled"] = True
    fields = app["modules"][0]["search_config"]["properties"]
    village = next(field for field in fields if field["name"] == "village")
    district = next(field for field in fields if field["name"] == "district")
    village["receiver_expression"] = "home-us_state||city"
    district["receiver_expression"] = "home-region"
    fields.insert(0, {
        "doc_type": "CaseSearchProperty", "name": "home",
        "label": {"en": "Find an address"}, "appearance": "address",
        "exclude": True,
    })


RECEIVERS = {
    "eval": """() => {
        const city = document.querySelector('input[data-receive="home-us_state||city"]');
        const district = document.querySelector('select[data-receive="home-region"]');
        if (!city || !district) throw Error("The address receivers are missing");
        return {city: city.value, district: district.selectedOptions[0]?.textContent.trim() || ""};
    }"""
}
TYPE_ADDRESS = {
    "eval": """() => {
        const input = document.querySelector('.query-field input.mapboxgl-ctrl-geocoder--input');
        if (!input) throw Error("Search does not offer an address input");
        input.focus();
        input.value = "Visit Road";
        input.dispatchEvent(new KeyboardEvent("keydown", {key:"d", bubbles:true}));
    }"""
}
CLEAR_ADDRESS = {
    "eval": """() => {
        const geocoder = document.querySelector('.query-field .mapboxgl-ctrl-geocoder');
        geocoder.dispatchEvent(new MouseEvent("mouseenter"));
        const clear = geocoder.querySelector(".mapboxgl-ctrl-geocoder--button");
        if (!clear.getClientRects().length) throw Error("The selected address has no visible clear control");
        clear.click();
    }"""
}


def test_address_query_sends_ordered_fallback_and_lookup_value_without_the_address(
    hq, core_runner, formplayer_runner, editor_driver, webapps_documents, evidence
):
    document = webapps_documents["hq-search"]
    opening = [*steps.open_app("Client search"), *steps.choose("Clients"), steps.SCREEN]
    select = [TYPE_ADDRESS, {"until": "webapps/choose_address", "arg": PLACE["place_name"]}, steps.SETTLE]

    def enable(config):
        return replace(
            config, privileges=config.privileges | {"CLOUDCARE", "GEOCODER"},
            flags=config.flags | {"CASE_SEARCH_ADVANCED"},
        )

    database = casedata.document_case_database(document)
    with webapps_hq.authored_project(document, "A", configure=enable) as project:
        with project.released(formplayer_runner, change=_geocoder_fields, database=database) as release:
            run = Session(release, editor_driver).run([
                {"geocoderFixture": {"query": "Visit Road", "feature": PLACE}},
                *opening, *select, RECEIVERS, CLEAR_ADDRESS, steps.SETTLE, RECEIVERS,
                *select, *steps.run_search(), steps.SCREEN,
            ])
    first = 1 + len(opening) + len(select)
    filled = run.value(first)
    cleared = run.value(first + 3)
    actual = [
        entry["inputs"] for request in _menu_requests(run) if request["searched"]
        for entry in request["queryData"].values() if isinstance(entry, dict) and entry.get("execute")
    ]
    evidence("search-address-broadcast", {"filled": filled, "cleared": cleared, "submitted": actual})
    assert run.page_errors == []
    assert filled == {"city": "Example Town", "district": "Upper valley"}
    assert cleared["city"] == "" and cleared["district"] != "Upper valley"
    assert len(actual) == 1
    assert actual[0]["village"] == "Example Town" and actual[0]["district"] == "d1"
    assert "home" not in actual[0]
