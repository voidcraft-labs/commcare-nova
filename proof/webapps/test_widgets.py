"""Every question a worker answers with a gesture is answered, by Formplayer's walk and by the Web Apps client.

``targeted-capture-widgets``: a survey holding an image, a sound, a video, a
document, a signature and a location question, then a text, on HQ's release
of Nova's export. Formplayer's own walk uploads the answer table's file for
each file question, signature included, to Formplayer's ``answer_media``
(``proof.formplayer.walk.media_kind``); the client is then given each answer
as a worker gives it (``proof.webapps.observe.plan``): the same file chosen
through the widget's own file input, a stroke drawn on the signature pad, and
the location's map dragged until its centre is the walk's place, to the
nearest pixel.

Contract: every one of the form's answers is ``answered`` in the client, the
form as the worker leaves it shows each (a file's name, the drawn pad, the
map's latitude and longitude), and the form is submitted; the client sent Formplayer one upload per file
question and one answer for the location, a latitude and longitude within a
pixel of the walk's place at the map's opening zoom; and HQ's receiver was
handed each file both times, the walk's submission and the client's.
Plausible failures: a widget the replay calls unanswerable while a worker
can answer it (what this test replaced: every file, signature and location
question was left unanswered), a file the client never uploads (a change
event its knockout binding does not hear), and a map drag the client reads as
a click, which moves no centre.
"""

from __future__ import annotations

import json

from proof.webapps import hq as webapps_hq
from proof.webapps import observe
from proof.webapps.session import Session

DOCUMENT = "targeted-capture-widgets"
FILE_QUESTIONS = 5
# A pixel of the map at the zoom it opens at (``observe.MAP_OPENS``): a world 512 pixels wide.
PIXEL_DEGREES = 360 / 512


def test_every_question_a_worker_answers_with_a_gesture_is_answered_in_web_apps_and_on_formplayer(
    hq, core_runner, formplayer_runner, editor_driver, webapps_documents, evidence
):
    from proof.formplayer.walk import Walk, load_answer_table

    with webapps_hq.project(webapps_documents[DOCUMENT]) as project:
        with project.released(formplayer_runner) as release:
            walk = Walk(release.runner, release.hq, domain=release.domain, app_id=release.build_id, scope=release.run)
            (run,) = [each for each in walk.run()["runs"] if any("answers" in step for step in each["steps"])]
            walked = len(release.hq.submissions)
            session = Session(release, editor_driver)
            made, kinds = observe.replay(release.doc["name"], [run], session.home)
            replayed = session.run(made, deadline=180.0 + 2.0 * len(made))
            submissions = list(release.hq.submissions)
    (form,) = [step for step in run["steps"] if "answers" in step]
    evidence("walk", form)
    uploads = [attempt for attempt in form["answers"] if attempt.get("media")]
    assert sorted(attempt["media"] for attempt in uploads) == ["audio", "file", "image", "signature", "video"]
    assert all(attempt["response"].get("status") == "accepted" for attempt in form["answers"]), form["answers"]
    assert form["submit"].get("status") == "success", form["submit"]
    assert [submission["files"] for submission in form["submissions"]] == [FILE_QUESTIONS]

    record = observe._record(release.runner, editor_driver, release.version, {"runs": [run]}, replayed, kinds)
    evidence("record", record)
    (shown,) = record["runs"]
    assert shown["answers"] == ["answered"] * len(form["answers"]), shown["answers"]
    assert shown["submit"] == "submitted", shown
    assert replayed.page_errors == []
    assert len(replayed.answered("answer_media")) == FILE_QUESTIONS
    assert all(exchange.status == 200 for exchange in replayed.answered("answer_media"))
    # The form as the worker leaves it shows each answer: each file's name, the drawn pad, the map's place.
    left = {question["label"]: question["answer"] for question in shown["screens"][-2]["form"]["questions"]}
    names = {attempt["value"] for attempt in uploads if attempt["media"] != "signature"}
    assert {left[label] for label in ("Photo", "Voice note", "Clip", "Letter")} == names, left
    assert left["Signature"] == "drawn", left
    assert all(coordinate.strip("?.") for coordinate in left["Place"]), left

    # The location's answer is the map's centre, the walk's place to within a pixel.
    places = load_answer_table()["dataTypes"]["geopoint"]
    (place,) = [attempt for attempt in form["answers"] if attempt["value"] in places]
    latitude, longitude = (float(part) for part in place["value"].split()[:2])
    answered = [json.loads(exchange.body) for exchange in replayed.answered("answer")]
    (centre,) = [sent["answer"] for sent in answered if sent.get("ix") == place["ix"]]
    assert abs(centre[0] - latitude) < PIXEL_DEGREES and abs(centre[1] - longitude) < PIXEL_DEGREES, centre

    # HQ's receiver was handed the files with the walk's submission and with the client's.
    assert len(submissions) == walked + 1
    assert len(submissions[walked].files) == FILE_QUESTIONS
