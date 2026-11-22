"""Worker controls in the Vellum-saved app and after Nova republishes over that app."""

import base64
import json
from dataclasses import replace
from contextlib import contextmanager
from xml.etree import ElementTree

import pytest

from proof.webapps import hq as webapps_hq
from proof.webapps import steps
from proof.webapps.session import Session


@contextmanager
def _released(document, publication, runner, *, configure=None):
    # HQ's Web Apps page supplies its Mapbox credential. The pinned SDK
    # instantiates its widget only after parsing the public token payload.
    # This synthetic unsigned configuration is confined to this witness;
    # the browser driver fences all external requests.
    from django.test import override_settings

    payload = base64.urlsafe_b64encode(json.dumps({"u": "proof-worker"}).encode()).decode().rstrip("=")
    with (override_settings(MAPBOX_ACCESS_TOKEN=f"pk.{payload}.synthetic"),
          webapps_hq.authored_project(document, publication, configure=configure) as project,
          project.released(runner) as release):
        yield release


def _ethiopian(ix):
    # The picker accepts its displayed Ethiopian date on blur. The returned
    # ISO date comes from HQ's converter inside the picker, not this driver.
    return [
        {"mark": True},
        {
            "eval": """(ix) => {
            const q = [...document.querySelectorAll("#webforms .q")].find(q =>
                q.querySelector(":scope > .ix")?.textContent.trim().split(" :: ").pop() === ix);
            const input = q?.querySelector(".widget .input-group:not([data-td-target-input]) > input.form-control");
            if (!input) throw Error("No Ethiopian calendar on " + ix);
            input.focus();
            input.value = "01/01/2016";
            input.dispatchEvent(new Event("input",{bubbles:true}));
            input.blur();
            return input.value;
        }""",
            "arg": ix,
        },
        {
            "awaitRequest": {"method": "POST", "pathname": steps.ANSWER},
            "sinceMark": True,
        },
        steps.SETTLE,
    ]


@pytest.mark.parametrize("publication", ["A", "B"])
def test_paired_ethiopian_dates_send_the_same_civil_day(
    hq, core_runner, formplayer_runner, editor_driver, webapps_documents, evidence, publication
):
    # Printed order is stable. Each result also records the independently
    # rendered Bootstrap row width and the native picker element.
    read = {
        "eval": """() => [...document.querySelectorAll("#webforms .q")].slice(1,4).map(q => ({
        label:q.querySelector(".caption,legend,label")?.textContent.trim(),
        calendar:!!q.querySelector(".widget .input-group:not([data-td-target-input]) > input.form-control"),
        half:!!q.closest(".col-md-6"),
    }))"""
    }
    with _released(webapps_documents["hq-question-display"], publication, formplayer_runner) as release:
        run = Session(release, editor_driver).run(
            [
                *steps.open_app("Visit display"),
                *steps.choose("Visits"),
                *steps.choose("Survey"),
                *_ethiopian("1"),
                *_ethiopian("2"),
                read,
                *steps.submit_and_land(),
            ]
        )
        submitted = [
            ElementTree.fromstring(one.instance) for one in release.hq.submissions
        ]
    assert not run.page_errors, run.page_errors
    assert len(submitted) == 1, submitted
    dates = [submitted[0].findtext(f"{{*}}{name}") for name in ("arrival", "follow_up")]
    assert dates == ["2023-09-12", "2023-09-12"], dates
    drawn = run.value(-len(steps.submit_and_land()) - 1)
    answers = [
        (e.request_json()["ix"], e.request_json().get("answer"), e.json().get("status"))
        for e in run.answered("answer")
    ]
    evidence("question-display-calendars", {"drawn": drawn, "answers": answers})
    assert [(item["calendar"], item["half"]) for item in drawn] == [
        (True, False),
        (True, True),
        (False, False),
    ], drawn
    assert answers == [
        ("1", "2023-09-12", "accepted"),
        ("2", "2023-09-12", "accepted"),
    ], answers


@pytest.mark.parametrize("publication", ["A", "B"])
def test_upload_notifies_and_clears_the_filename_in_the_same_form(
    hq, core_runner, formplayer_runner, editor_driver, webapps_documents, evidence, publication
):
    from proof.formplayer.walk import CAPTURES_DIR

    filename = "proof-image.jpg"
    field = """ix => [...document.querySelectorAll('#webforms .q')].find(q =>
        q.querySelector(':scope > .ix')?.textContent.trim().split(' :: ').pop() === ix)"""
    with _released(webapps_documents["hq-question-display"], publication, formplayer_runner) as release:
        run = Session(release, editor_driver).run(
            [
                *steps.open_app("Visit display"),
                *steps.choose("Visits"),
                *steps.choose("Survey"),
                *steps.answer_media(
                    "15",
                    "image",
                    filename,
                    (CAPTURES_DIR / filename).read_bytes(),
                    "image/jpeg",
                ),
                {
                    "until": "webapps/question-value",
                    "arg": {"ix": "16", "value": filename},
                },
                {
                    "eval": f"() => ({{filename: ({field})('16').querySelector('textarea').value, "
                    + f"signatures: ['11','12'].map(ix=>!!({field})(ix).querySelector('canvas'))}})"
                },
                {"mark": True},
                {
                    "eval": f"() => ({field})('15').querySelector('button[data-bind*=onClear]').click()"
                },
                {
                    "until": "webapps/question-value",
                    "arg": {"ix": "16", "value": ""},
                },
                steps.SETTLE,
            ]
        )
    assert not run.page_errors, run.page_errors
    assert run.value(-5) == {"filename": filename, "signatures": [True, True]}, (
        run.outcomes
    )
    uploads = run.answered("answer_media")
    assert [entry.status for entry in uploads] == [200], uploads
    answers = [
        (e.request_json()["ix"], e.request_json().get("answer"), e.json().get("status"))
        for e in run.answered("answer")
    ]
    evidence(
        "question-display-filename", {"uploaded": len(uploads), "answers": answers}
    )
    assert [
        value for ix, value, status in answers if ix == "16" and status == "accepted"
    ] == [filename, None], answers


@pytest.mark.parametrize("publication", ["A", "B"])
def test_row_width_zero_and_rounding_have_separate_browser_outcomes(
    hq, core_runner, formplayer_runner, editor_driver, webapps_documents, evidence, publication
):
    read = {
        "eval": """() => [...document.querySelectorAll('#webforms .q')].flatMap(q => {
        const name=q.querySelector('.caption-text')?.textContent.trim();
        if (!['Zero divisor','Last one-column width','First zero-column width','Large row count'].includes(name))
            return [];
        const tile=q.parentElement, row=tile.closest('.question-tile-row');
        return [{name, css:tile.className, fraction:tile.getBoundingClientRect().width/row.getBoundingClientRect().width}];
    })"""
    }
    with _released(webapps_documents["hq-question-display"], publication, formplayer_runner) as release:
        run = Session(release, editor_driver).run(
            [
                *steps.open_app("Visit display"),
                *steps.choose("Visit options"),
                *steps.choose("Survey"),
                read,
            ]
        )
    assert not run.page_errors, run.page_errors
    tiles = run.value(-1)
    evidence("question-display-grid", tiles)
    assert [tile["css"] for tile in tiles] == [
        "col-md-Infinity",
        "col-md-1",
        "col-md-0",
        "col-md-0",
    ], tiles
    assert 0.07 < tiles[1]["fraction"] < 0.1, tiles
    assert all(0.99 < tiles[index]["fraction"] < 1.01 for index in (0, 2, 3)), tiles


# A fixed response at the external service boundary. HQ and its bundled
# geocoder draw the suggestions, handle selection/clear and send the answers.
ADDRESS = {
    "type": "Feature", "id": "address.proof-office", "place_type": ["address"],
    "relevance": 1, "text": "Visit Road", "place_name": "18 Visit Road, Example Town",
    "address": "18", "center": [35.12, -1.9], "geometry": {"type": "Point", "coordinates": [35.12, -1.9]},
    "properties": {}, "context": [{"id": "place.proof-town", "text": "Example Town"}],
}


@pytest.mark.parametrize("publication", ["A", "B"])
def test_address_search_selects_clears_and_submits_the_returned_city(
    hq, core_runner, formplayer_runner, editor_driver, webapps_documents, evidence, publication
):
    search = [
        {"eval": """() => {
            const input = document.querySelector('#webforms input.mapboxgl-ctrl-geocoder--input');
            if (!input) throw Error("The Meeting point address entry is missing");
            input.focus(); input.value = "Visit Road";
            input.dispatchEvent(new KeyboardEvent("keydown", {key:"d",bubbles:true}));
        }"""},
        {"until": "webapps/choose_address", "arg": ADDRESS["place_name"]},
        {"until": "webapps/question-value", "arg": {"ix": "14", "value": "Example Town"}},
        steps.SETTLE,
    ]
    with _released(webapps_documents["hq-question-display"], publication, formplayer_runner) as release:
        run = Session(release, editor_driver).run([
            {"geocoderFixture": {"query": "Visit Road", "feature": ADDRESS}},
            *steps.open_app("Visit display"), *steps.choose("Visits"), *steps.choose("Survey"),
            *search,
            {"eval": """() => {
                const geocoder = document.querySelector('#webforms .mapboxgl-ctrl-geocoder');
                geocoder.dispatchEvent(new MouseEvent("mouseenter"));
                const clear = geocoder.querySelector(".mapboxgl-ctrl-geocoder--button");
                if (!clear.getClientRects().length) throw Error("The selected address has no visible clear button");
                clear.click();
            }"""},
            {"until": "webapps/question-value", "arg": {"ix": "14", "value": ""}},
            steps.SETTLE, *search, *steps.submit_and_land(),
        ])
        submitted = [ElementTree.fromstring(s.instance) for s in release.hq.submissions]
    assert not run.page_errors, run.page_errors
    assert len(submitted) == 1, submitted
    address = json.loads(submitted[0].findtext("{*}address"))
    assert address["full"] == ADDRESS["place_name"] and address["geopoint"] == "-1.9 35.12", address
    assert address["city"] == submitted[0].findtext("{*}city") == "Example Town"
    received = [
        e.request_json().get("answer") for e in run.answered("answer")
        if e.request_json()["ix"] == "14" and e.json().get("status") == "accepted"
    ]
    evidence("selected-address", {"address": address, "received": received})
    assert received == ["Example Town", None, "Example Town"], received


@pytest.mark.parametrize("missing", ["GEOCODER", "CASE_SEARCH_ADVANCED"])
def test_address_question_is_unavailable_when_one_hq_gate_is_missing(
    hq, core_runner, formplayer_runner, editor_driver, webapps_documents, missing
):
    def without_gate(config):
        if missing == "GEOCODER":
            assert missing in config.privileges
            return replace(config, privileges=config.privileges - {missing})
        assert missing in config.flags
        return replace(config, flags=config.flags - {missing})

    with _released(webapps_documents["hq-question-display"], "A", formplayer_runner, configure=without_gate) as release:
        run = Session(release, editor_driver).run([
            *steps.open_app("Visit display"), *steps.choose("Visits"), *steps.choose("Survey"),
            {"eval": """() => {
                const q = [...document.querySelectorAll("#webforms .q")].find(q=>
                    q.querySelector(":scope > .ix")?.textContent.trim().split(" :: ").pop() === "13");
                return {unsupported:!!q?.querySelector(".unsupported-question-type-trigger"),
                    search:!!q?.querySelector(".mapboxgl-ctrl-geocoder--input")};
            }"""}
        ])
    assert not run.page_errors, run.page_errors
    assert run.value(-1) == {"unsupported": True, "search": False}, run.outcomes



def test_web_calendar_leaves_untouched_days_empty_and_submits_a_cleared_day(
    hq, core_runner, formplayer_runner, editor_driver, webapps_documents, evidence
):
    with webapps_hq.project(webapps_documents["targeted-question-calendar"]) as project:
        with project.released(formplayer_runner) as release:
            run = Session(release, editor_driver).run([
                *steps.open_app("Visit calendar"), *steps.choose("Visits"), *steps.choose("Visit"),
                *steps.answer("1", "2024-02-29"), *steps.answer("1", None),
                *steps.submit_and_land(),
            ])
            submitted = [ElementTree.fromstring(item.instance) for item in release.hq.submissions]
    assert not run.page_errors, run.page_errors
    assert len(submitted) == 1, submitted
    inputs = ("scheduled", "rescheduled", "untouched_ordinary", "untouched_ethiopian", "untouched_nepali",
              "untouched_gregorian", "untouched_gregorian_with_clear")
    fields = {}
    for name in inputs:
        node = submitted[0].find(f"{{*}}{name}")
        assert node is not None, (name, ElementTree.tostring(submitted[0]))
        fields[name] = node.text
    answers = [(e.request_json()["ix"], e.request_json().get("answer"), e.json().get("status"))
               for e in run.answered("answer")]
    evidence("untouched-calendar-days", {"fields": fields, "answers": answers})
    assert fields == {name: "2023-09-12" if name == "scheduled" else None for name in inputs}, fields
    assert answers == [("1", "2024-02-29", "accepted"), ("1", None, "accepted")], answers
