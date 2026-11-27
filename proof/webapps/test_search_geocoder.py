"""The Web Apps query screen broadcasts a selected address to its configured fields."""

from dataclasses import replace

import pytest

from proof.editors import pages
from proof.hq import operations
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
    if mode in ("lookup", "combined", "single"):
        district["receiver_expression"] = "home-region"
        district["input_"] = "select1" if mode == "single" else "select"
    fields.insert(0, {
        "doc_type": "CaseSearchProperty", "name": "home",
        "label": {"en": "Find an address"}, "appearance": "address",
        "exclude": True,
    })


def _enable_address_search(config):
    return replace(
        config, privileges=config.privileges | {"CLOUDCARE", "GEOCODER"},
        flags=config.flags | {"CASE_SEARCH_ADVANCED"},
    )


def _stored_address_default(project):
    """Use the matrix's exact non-excluded prompt, with no attached receiver."""
    from corehq.apps.app_manager.models.case_search import CaseSearchProperty

    from proof.matrix.registry import load_variants

    variant = next(row for row in load_variants() if row.id == "hq-search/address-picker-with-stored-default")
    app = operations.held_app(project.unit, project.app_id)
    menu = app.modules[0]
    assert variant.change["pointer"] == "/modules/0/search_config/properties/1"
    assert menu.search_config.properties[1].name == "village"
    menu.search_config.properties[1] = CaseSearchProperty.wrap(dict(variant.change["value"]))
    app.cloudcare_enabled = True
    app.save()
    return menu.unique_id


def _address_default_database(document):
    database = casedata.document_case_database(document)
    original = next(case for case in database.cases if case.case_type == "client")
    properties = dict(original.properties)
    properties.update(client_name="Amina", last_visit="2025-12-01")
    return replace(database, cases=(replace(original, name="Amina", properties=tuple(properties.items())),))


def _built_address_default(archive):
    from io import BytesIO
    from zipfile import ZipFile

    from lxml import etree

    with ZipFile(BytesIO(archive)) as zipped:
        suite = etree.fromstring(zipped.read("suite.xml"))
    prompts = suite.xpath(".//query/prompt[@key='village'][@input='address']")
    assert prompts, "HQ emitted no address picker for the saved Village field"
    held = {(prompt.getparent().get("storage-instance"), prompt.get("default"), prompt.get("exclude")) for prompt in prompts}
    (storage, default, exclude), = held
    assert default == "'Old address'" and exclude is None, held
    assert storage
    return {"storage": storage, "default": default, "exclude": exclude}


def test_saved_address_default_stays_out_of_signed_web_search(
    hq, formplayer_runner, editor_driver, webapps_documents, evidence
):
    document = webapps_documents["hq-search"]
    address = {
        "eval": """() => document.querySelector('#village_mapbox input.mapboxgl-ctrl-geocoder--input')?.value"""
    }
    opening = [
        {"geocoderFixture": {"query": "Visit Road", "feature": PLACE}},
        *steps.open_app("Client search"),
        *steps.choose("Clients"),
        *steps.choose("Followup Form"),
        steps.SCREEN,
    ]
    with webapps_hq.authored_project(document, "A", configure=_enable_address_search) as project:
        menu_id = _stored_address_default(project)
        saved = pages.fresh_section_save(editor_driver, project.unit, pages.CASE_LIST, project.app_id, menu_id)
        menu = operations.held_app(project.unit, project.app_id).get_module_by_unique_id(menu_id)
        field = next(field for field in menu.search_config.properties if field.name == "village")
        assert saved.save and saved.save.status == 200 and not saved.refused, saved.alerts
        assert (field.appearance, field.exclude, field.default_value) == ("address", False, "'Old address'")
        assert field.receiver_expression in (None, "")

        with project.released(formplayer_runner, database=_address_default_database(document)) as release:
            built = _built_address_default(release.archive())
            run = Session(release, editor_driver).run([
                *opening, address, TYPE_ADDRESS,
                {"until": "webapps/choose_address",
                 "arg": {"name": PLACE["place_name"], "scope": "#village_mapbox"}, "within": 8000},
                steps.SETTLE, address, *steps.type_prompt(0, "Amina"), *steps.run_search(), steps.SCREEN,
            ])
            requests = [
                entry["inputs"] for request in _menu_requests(run) if request["searched"]
                for entry in request["queryData"].values() if isinstance(entry, dict) and entry.get("execute")
            ]
            hq_searches = [dict(search.params) for search in release.hq.searches]
    initial, selected = run.value(len(opening)), run.value(len(opening) + 4)
    evidence("search-address-stored-default", {
        "hqSave": saved.save.status, "built": built, "initial": initial,
        "selected": selected, "workerSubmitted": requests, "hqSearch": hq_searches,
        "pageErrors": run.page_errors,
    })
    assert run.page_errors == []
    assert initial == "" and selected == PLACE["place_name"]
    assert requests == [{"client_name": "Amina"}], requests
    assert hq_searches and all("village" not in search for search in hq_searches), hq_searches


def test_case_list_editor_keeps_search_address_receivers_after_reopening(
    hq, core_runner, editor_driver, webapps_documents, evidence
):
    from corehq.apps.app_manager.models.case_search import CaseSearchProperty

    document = webapps_documents["hq-search"]

    def fields_in(module):
        return [
            (field.name, field.appearance, field.input_, field.receiver_expression)
            for field in module.search_config.properties
            if field.name in {"home", "district", "village"}
        ]

    with webapps_hq.authored_project(document, "A", configure=_enable_address_search) as project:
        app = operations.held_app(project.unit, project.app_id)
        source = app.to_json()
        _geocoder_fields(source, "combined")
        menu = app.modules[0]
        menu_id = menu.unique_id
        menu.search_config.properties = [
            CaseSearchProperty.wrap(field) for field in source["modules"][0]["search_config"]["properties"]
        ]
        app.save()
        before = fields_in(menu)
        assert before[0][:2] == ("home", "address")
        assert ("village", None, None, "home-us_state||city") in before
        assert ("district", None, "select", "home-region") in before
        saves = []
        for _ in range(2):
            saved = pages.fresh_section_save(editor_driver, project.unit, pages.CASE_LIST, project.app_id, menu_id)
            assert saved.save and saved.save.status == 200 and not saved.refused, saved.alerts
            current = operations.held_app(project.unit, project.app_id).get_module_by_unique_id(menu_id)
            saves.append(fields_in(current))
    evidence("search-address-case-list-resave", {"before": before, "saves": saves})
    assert saves == [before, before]


RECEIVERS = {
    "eval": """() => {
        const city = document.querySelector('input.query-field[id="Village"]');
        const choices = [...document.querySelectorAll('select.query-field')];
        if (!city || choices.length !== 1) throw Error("The expected Village and District controls are missing");
        const [district] = choices;
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
    [(None, "text"), (SMALL_SCREEN, "text"), (None, "lookup"), (None, "combined"), (None, "single")],
    ids=["desktop-text", "phone-text", "lookup", "combined", "single"],
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

    database = casedata.document_case_database(document)
    clear_and_choose = [CLEAR_ADDRESS, steps.SETTLE, RECEIVERS, *select] if viewport is None else []
    with webapps_hq.authored_project(document, "A", configure=_enable_address_search) as project:
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
    if mode in ("lookup", "combined", "single"):
        assert any(label == "Upper valley" for _, label in initial["districtChoices"]), initial
        if mode == "single":
            assert filled["district"] == "", filled
        else:
            assert filled["district"] == "Upper valley", filled
            expected["district"] = "d1"
    if cleared:
        assert cleared["city"] == ""
        assert cleared["district"] == filled["district"]
    assert actual == [expected], actual
