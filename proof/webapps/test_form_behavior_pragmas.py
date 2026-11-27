"""Opening the Nova automatic form submits through Formplayer's navigation."""

from lxml import etree

from proof.webapps import hq as webapps_hq
from proof.webapps import steps
from proof.webapps.session import Session

DOCUMENT = "targeted-form-behavior-pragmas"


def test_opening_the_automatic_visit_posts_without_a_separate_submit_click(
    hq, core_runner, formplayer_runner, editor_driver, webapps_documents, evidence,
):
    with webapps_hq.project(webapps_documents[DOCUMENT]) as project:
        with project.released(formplayer_runner) as release:
            session = Session(release, editor_driver)
            run = session.run([
                *steps.open_app(release.doc["name"]), *steps.choose("Visits"),
                *steps.choose("Automatic visit"), *steps.arrive(any_screen=True), steps.SCREEN,
            ], deadline=45)
            submitted, = (
                exchange for exchange in run.answered("navigate_menu")
                if list(map(str, exchange.request_json()["selections"])) == ["0", "0"]
            )
            received, = session.hq.submissions
            assert submitted.json()["status"] == "success", submitted.json()
            assert etree.fromstring(received.instance).findtext("{*}note") == "Automatic report"
            assert not run.answered("submit-all")
            assert not run.screens[-1].get("form"), run.screens[-1]
            assert not run.page_errors, run.page_errors
            evidence("automatic-visit", {
                "navigation": submitted.json()["status"], "clientSubmitRequests": 0, "answer": "Automatic report",
            })
        with project.released(formplayer_runner) as release:
            session = Session(release, editor_driver)
            run = session.run([
                *steps.open_app(release.doc["name"]), *steps.choose("Visits"),
                *steps.choose("Manual visit"), *steps.arrive(form=True), steps.SCREEN,
            ])
            assert not run.answered("submit-all") and not session.hq.submissions
            assert run.screens[-1]["form"]["title"] == "Manual visit", run.screens[-1]


def test_the_client_submits_previously_accepted_values_only_with_the_changed_answer_pragma(
    hq, core_runner, formplayer_runner, editor_driver, webapps_documents, evidence,
):
    with webapps_hq.project(webapps_documents[DOCUMENT]) as project:
        outcomes = []
        for title, should_post in (("Check changed answers", True), ("Check all answers", False)):
            with project.released(formplayer_runner) as release:
                session = Session(release, editor_driver)
                run = session.run([
                    *steps.open_app(release.doc["name"]), *steps.choose("Visits"),
                    *steps.choose(title), *steps.arrive(form=True),
                    *steps.answer("0", "accepted"), *steps.answer("1", "deny"),
                    *steps.submit_and_land(), steps.SCREEN,
                ])
                replies = run.answered("answer")
                assert [exchange.json()["status"] for exchange in replies] == ["accepted", "accepted"]
                (submit,) = run.answered("submit-all")
                posted = session.hq.submissions
                assert (submit.json()["status"] == "success") is should_post, submit.json()
                assert len(posted) == int(should_post), submit.json()
                if should_post:
                    root = etree.fromstring(posted[0].instance)
                    assert (root.findtext("{*}note"), root.findtext("{*}decision")) == ("accepted", "deny")
                else:
                    assert submit.json()["errors"] == {
                        "0": {"status": "validation-error", "type": "constraint"},
                    }, submit.json()
                    fields = run.screens[-1]["form"]["questions"]
                    first, later = fields
                    assert first["label"] == "First note", fields
                    assert first["errors"] == ["This answer is outside the allowed range."], fields
                    assert later["label"] == "Later decision" and not later["errors"], fields
                assert not run.page_errors, run.page_errors
                outcomes.append({"form": title, "posted": len(posted), "reply": submit.json()["status"]})
        evidence("cross-answer", outcomes)
