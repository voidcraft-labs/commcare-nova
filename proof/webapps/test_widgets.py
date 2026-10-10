"""Every question a worker answers with a gesture is answered, by Formplayer's walk and by the Web Apps client.

``targeted-capture-widgets``: a survey holding an image, a sound, a video, a
document and a signature question, two location questions (the second holding
a place already), then a text, on HQ's release
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
question, and each location's last answer is a latitude and longitude within
a pixel of the walk's place at its map's opening zoom (the second's map,
opening zoomed in far from it, is dragged there in several strokes, each
answered); and HQ's receiver was
handed each file both times, the walk's submission and the client's.
A second walk replays the first, its uploads at the same places of their
runs, and Formplayer takes each again. Plausible failures: a widget the
replay calls unanswerable while a worker can answer it (what this test
replaced: every file, signature and location question was left unanswered),
a file the client never uploads (a change event its knockout binding does not
hear), a map drag the client reads as a click, which moves no centre, and a
later run's upload refused for the row an earlier run's left (Formplayer's
file ids come from Core's random source, which the lane seeds by a request's
place in its run: ``FormplayerRunner.forget_media``).
"""

from __future__ import annotations

import json

from proof.webapps import hq as webapps_hq
from proof.webapps import observe
from proof.webapps.session import Session

DOCUMENT = "targeted-capture-widgets"
FILE_QUESTIONS = 5
# A pixel of each location's map at the zoom it opens at (``observe.MAP_OPENS``, ``observe.MAP_ANSWER_ZOOM``): a
# world 512 pixels wide with no place held, 16384 with one.
PIXEL_DEGREES = {"Place": 360 / 512, "Where you stand": 360 / 16384}


def test_every_question_a_worker_answers_with_a_gesture_is_answered_in_web_apps_and_on_formplayer(
    hq, core_runner, formplayer_runner, editor_driver, webapps_documents, evidence
):
    from proof.formplayer.walk import Walk, load_answer_table, script_of

    with webapps_hq.project(webapps_documents[DOCUMENT]) as project:
        with project.released(formplayer_runner) as release:
            walk = Walk.of(release)
            derived = walk.run()
            (run,) = [each for each in derived["runs"] if any("answers" in step for step in each["steps"])]
            # The walk again, its uploads at the same places of their runs, so each draws the id the first drew.
            again = walk.run(script_of(derived))
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
    # A later run's uploads, drawing the ids the first run's drew, are taken as the first run's were.
    (replayed_form,) = [step for each in again["runs"] for step in each["steps"] if "answers" in step]
    assert [attempt["response"].get("status") for attempt in replayed_form["answers"]] == ["accepted"] * len(
        form["answers"]
    ), replayed_form["answers"]

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
    assert all(coordinate.strip("?.") for label in PIXEL_DEGREES for coordinate in left[label]), left

    # Each location's answer is its map's centre, the walk's place to within a pixel: the second's map opens on
    # the place it holds, zoomed in and far from the walk's, so it is dragged there in several strokes, each
    # answered, the last the place.
    places = load_answer_table()["dataTypes"]["geopoint"]
    located = [attempt for attempt in form["answers"] if attempt["value"] in places]
    assert len(located) == len(PIXEL_DEGREES), located
    answered = [json.loads(exchange.body) for exchange in replayed.answered("answer")]
    for place, (label, pixel) in zip(located, PIXEL_DEGREES.items(), strict=True):
        latitude, longitude = (float(part) for part in place["value"].split()[:2])
        moves = [sent["answer"] for sent in answered if sent.get("ix") == place["ix"]]
        assert abs(moves[-1][0] - latitude) < pixel and abs(moves[-1][1] - longitude) < pixel, (label, moves)
        if label == "Where you stand":
            assert len(moves) > 1, moves

    # HQ's receiver was handed the files with the walk's submission and with the client's.
    assert len(submissions) == walked + 1
    assert len(submissions[walked].files) == FILE_QUESTIONS
