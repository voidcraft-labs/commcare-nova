"""Worker controls on the question-display base after a Vellum save and Nova's first publish."""

from proof.webapps import hq as webapps_hq
from proof.webapps import steps
from proof.webapps.session import Session


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


def test_paired_ethiopian_dates_send_the_same_civil_day(
    hq, core_runner, formplayer_runner, editor_driver, webapps_documents, evidence
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
    with webapps_hq.project(webapps_documents["hq-question-display"]) as project:
        with project.released(formplayer_runner) as release:
            run = Session(release, editor_driver).run(
                [
                    *steps.open_app("Visit display"),
                    *steps.choose("Visits"),
                    *steps.choose("Survey"),
                    *_ethiopian("1"),
                    *_ethiopian("2"),
                    read,
                ]
            )
    assert not run.page_errors, run.page_errors
    drawn = run.value(-1)
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
