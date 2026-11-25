"""The web client supplies OK for messages when the worker submits, including a message with a starting value."""

from lxml import etree

from proof.webapps import hq as webapps_hq
from proof.webapps import steps
from proof.webapps.session import Session


def test_web_client_confirms_messages_in_the_received_submission(
    hq, core_runner, formplayer_runner, editor_driver, webapps_documents, evidence
):
    with webapps_hq.project(webapps_documents["targeted-worker-messages"]) as project:
        with project.released(formplayer_runner) as release:
            session = Session(release, editor_driver)
            run = session.run([
                *steps.open_app(release.doc["name"]), *steps.choose("Visits"), *steps.choose("Review the visit"),
                steps.SCREEN, *steps.submit_and_land(),
            ])
            submission, = session.hq.submissions
    assert not run.page_errors, run.page_errors
    questions = run.screens[0]["form"]["questions"]
    # A question's captured text holds its label with its hint, help and media's fallback text around it, as the
    # client draws them, so each label is read as a part of its question's text.
    shown = [question["label"] for question in questions]
    expected = ["Read the visit notes", "I reviewed the notes", "Optional follow-up"]
    assert len(shown) >= 3 and all(label in text for label, text in zip(expected, shown)), questions
    assert not any("Follow up after confirmation" in text for text in shown), questions
    root = etree.fromstring(submission.instance)
    assert [root.findtext("{*}" + name) for name in ("notice", "confirmed", "optional")] == ["OK", "OK", "OK"]
    evidence("web-worker-confirmation", {"questions": questions, "submission": submission.instance.decode()})


def test_web_worker_replaces_a_refused_default_and_sends_only_that_file(hq, core_runner, formplayer_runner, editor_driver,
                                                                     webapps_documents, evidence):
    from proof.formplayer.walk import CAPTURES_DIR

    file = "proof-file.pdf"
    content = (CAPTURES_DIR / file).read_bytes()
    with webapps_hq.project(webapps_documents["targeted-worker-messages"]) as project:
        with project.released(formplayer_runner) as release:
            session = Session(release, editor_driver)
            run = session.run([
                *steps.open_app("Visit instructions"), *steps.choose("Visits"), *steps.choose("Visit documents"),
                *steps.submit_and_land(), steps.SCREEN,
                *steps.answer_media("2", "file", file, content, "application/pdf"),
                *steps.submit_and_land(),
            ])
            submission, = session.hq.submissions
    assert not run.page_errors, run.page_errors
    errors = [question["errors"] for question in run.screens[0]["form"]["questions"]]
    assert errors == [[], [], ["Choose the current report"]], errors
    root = etree.fromstring(submission.instance)
    assert root.findtext("{*}report") == "carry-forward.pdf" and not root.findtext("{*}photo"), submission.instance
    part, = submission.files
    assert part == (root.findtext("{*}replacement"), content), part[0]
    evidence("chosen-capture", {"errors": errors, "instance": submission.instance.decode(), "file": part[0]})
