"""Formplayer and the media slots Nova offers that no runtime reads (defect 16).

A field of ``media-rich`` names an image, a sound and a video on its label, an
image on its hint and an image on its validation message (the field's
constraint is ``. = 'ok'``). On HQ's release of that export served to
Formplayer by HQ's own views (``proof.formplayer.hq``), Formplayer's form
answers hand the Web Apps client the label's media and the hint's text, and
no field of the question names the hint's image
(``api/json/PromptToJson.java``); an answer that breaks the constraint is
answered with the message's text and nothing naming its image. Contract:
the hint's and the validation message's media reach no worker through
Formplayer. Plausible failures: either image handed to the client (so a
worker in Web Apps would see it, and removing the slot loses something), or
a harness that never reads the question at all, which the label's media and
the message's text being handed rule out.
"""

from __future__ import annotations

import json

from proof.formplayer import apps

DOCUMENT = "media-rich"
QUESTION = "/data/answer"
# The digests the export names its media files by (``jr://file/commcare/<sha256>.<ext>``).
LABEL_IMAGE = "50a8af47cc2e68f022bfb93e26be925081df6d21b3d4c276cdabdbd8d31de83d"
HINT_IMAGE = "c5f74c6dda51d3941b4d17d05991f900debbf387ff748eda65d2f03dda227b2e"
MESSAGE_IMAGE = "30ab512e6539a83342a9415c6e7ddc7358a0ffd2aefe5369c86b9efb591e3984"


def _questions(tree):
    for node in tree or ():
        if isinstance(node, dict):
            yield node
            yield from _questions(node.get("children"))


def test_formplayer_hands_no_hint_or_validation_message_media(
    hq, core_runner, formplayer_runner, formplayer_documents, evidence
):
    with apps.published(formplayer_documents[DOCUMENT], core_runner) as published:
        with apps.served(published, formplayer_runner) as served:
            walked = apps.walked(formplayer_runner, served)
    forms = [
        step
        for run in walked["runs"]
        for step in run["steps"]
        if isinstance(step.get("response"), dict) and isinstance(step["response"].get("tree"), list)
    ]
    opened = [
        node for step in forms for node in _questions(step["response"]["tree"]) if node.get("binding") == QUESTION
    ]
    indices = {node.get("ix") for node in opened}
    attempts = [
        attempt
        for run in walked["runs"]
        for step in run["steps"]
        for attempt in step.get("answers") or ()
        if attempt.get("ix") in indices
    ]
    evidence("media-slots", {"question": opened[:1], "attempts": attempts})
    assert opened, f"Formplayer's walk of {DOCUMENT} never opened the form holding {QUESTION}"
    question = json.dumps(opened[0])
    # The control: the label's image and the hint's text are handed to the client.
    assert LABEL_IMAGE in str(opened[0].get("caption_image")), opened[0]
    assert opened[0].get("hint") == "A hint", opened[0]
    # The slot: nothing of the question names the hint's image.
    assert HINT_IMAGE not in question, opened[0]
    # Every value the answer table gives breaks the constraint, so each answer is refused with the message.
    refused = [attempt["response"] for attempt in attempts if attempt["response"].get("status") != "accepted"]
    assert refused, attempts
    for response in refused:
        assert "Use ok" in json.dumps(response), response
        assert MESSAGE_IMAGE not in json.dumps(response), response
