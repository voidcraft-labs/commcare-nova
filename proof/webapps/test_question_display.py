"""Worker controls in the Vellum-saved app and after Nova republishes over that app."""

import base64
import json
from contextlib import contextmanager
from xml.etree import ElementTree

import pytest

from proof.webapps import hq as webapps_hq
from proof.webapps import steps
from proof.webapps.session import Session


@contextmanager
def _released(document, publication, runner):
    # HQ's Web Apps page supplies its Mapbox credential. The pinned SDK
    # instantiates its widget only after parsing the public token payload.
    # This synthetic unsigned configuration is confined to this witness;
    # the browser driver fences all external requests.
    from django.test import override_settings

    payload = base64.urlsafe_b64encode(json.dumps({"u": "proof-worker"}).encode()).decode().rstrip("=")
    with (override_settings(MAPBOX_ACCESS_TOKEN=f"pk.{payload}.synthetic"),
          webapps_hq.authored_project(document, publication) as project,
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
