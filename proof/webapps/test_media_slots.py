"""What a worker sees in Web Apps of the media slots Nova offers (defect 16).

``targeted-media-slots``: a survey whose group's label names an image, and
whose one question inside it names an image, a sound and a video on its
label, an image on its hint and the same image on its validation message.
Formplayer hands the client the group's label image and the question's label
media, and neither the hint's image nor the message's
(``proof/formplayer/test_media_slots.py``). This is what the client does with
what it is handed, on HQ's release of Nova's export: Formplayer's own walk of
the build replayed in the browser (``proof.webapps.observe.replay``), the
question answered through its text box with the walk's answers, the page
read once more after the first, which the constraint refuses, so the client
shows its message.

Contract: the browser lays out the question's label image, sound and video
(``form_entry/multimedia.html``), and nothing in the group's header
(``form_entry/sub_group.html`` draws its caption's text alone), and no
screen names the hint's or the message's image, while the hint's text and
the message's text are shown. Plausible failures: a group label's image a
worker sees, which would make the slot one a removal loses; and a page read
that sees no media at all, which the question's own label media rule out.
"""

from __future__ import annotations

import json

from proof.webapps import hq as webapps_hq
from proof.webapps import observe, steps
from proof.webapps.session import Session

DOCUMENT = "targeted-media-slots"
# The files the document names: the question's label image, sound and video, the group's label image, and the one
# image its hint and its validation message both name.
LABEL_IMAGE = "50a8af47cc2e68f022bfb93e26be925081df6d21b3d4c276cdabdbd8d31de83d.png"
LABEL_AUDIO = "4aebda3a657a0d8f532d11ceacb1679081d7bdf7d7d301a53f1096af3580be91.wav"
LABEL_VIDEO = "e9cefb19834b705b60adbb1f14ae4cce5313616c0390e9b9601a50b3ca9bab38.mp4"
GROUP_IMAGE = "c5f74c6dda51d3941b4d17d05991f900debbf387ff748eda65d2f03dda227b2e"
UNSHOWN_IMAGE = "30ab512e6539a83342a9415c6e7ddc7358a0ffd2aefe5369c86b9efb591e3984"


def test_web_apps_shows_a_questions_label_media_and_no_group_hint_or_message_media(
    hq, core_runner, formplayer_runner, editor_driver, webapps_documents, evidence
):
    from proof.formplayer.walk import Walk

    with webapps_hq.project(webapps_documents[DOCUMENT]) as project:
        with project.released(formplayer_runner) as release:
            walk = Walk.of(release)
            (run,) = [each for each in walk.run()["runs"] if any("answers" in step for step in each["steps"])]
            session = Session(release, editor_driver)
            made, kinds = observe.replay(release.doc["name"], [run], session.home)
            # The page read again once the client has answered the first attempt (``steps.answer``: the request
            # mark, the answer, Formplayer's reply, the page quiet).
            after_first = kinds.index(("answer", 0, 0)) + 3
            made = [*made[:after_first], steps.SCREEN, *made[after_first:]]
            replayed = session.run(made, deadline=180.0 + 2.0 * len(made))
    screens = replayed.screens
    evidence("screens", screens)
    assert replayed.page_errors == []
    forms = [screen["form"] for screen in screens if screen.get("form")]
    assert forms, f"The client never showed the form of {DOCUMENT}: {screens}"
    for form in forms:
        (group,) = form["groups"]
        (question,) = form["questions"]
        assert group["label"] == "Household", group
        # The group's header holds its text alone.
        assert group["media"] == [], group
        # The question's label image, sound and video, each laid out by the browser, and its hint's text.
        assert [(item["kind"], item["src"].rsplit("/", 1)[-1]) for item in question["media"]] == [
            ("img", LABEL_IMAGE),
            ("audio", LABEL_AUDIO),
            ("video", LABEL_VIDEO),
        ], question
        assert "Write the street" in question["label"], question
    # The answer table's first text is refused: the client shows the message's text, and no screen names its image.
    (refused,) = [form for form in forms if form["questions"][0]["errors"]]
    assert refused["questions"][0]["errors"] == ["Write proof"], refused
    whole = json.dumps(screens)
    assert UNSHOWN_IMAGE not in whole and GROUP_IMAGE not in whole
    # The worker went on with the answer the constraint takes, and the form was submitted.
    submitted = replayed.answered("submit-all")
    assert len(submitted) == 1 and submitted[0].json()["status"] == "success", submitted
