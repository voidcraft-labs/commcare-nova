"""Formplayer and the media slots Nova offers that no runtime shows (defect 16).

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

``targeted-media-slots`` adds a group whose label names an image. Formplayer
hands the client a group's label media as it hands a question's
(``PromptToJson.parseQuestionType`` reads a group's caption with
``parseCaption``), so whether a worker sees it is the client's to say:
``proof/webapps/test_media_slots.py`` reads the page. Contract: the group's
image is handed with its label, and the question's hint and validation
message images, one file there, are handed nowhere.
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


GROUPED = "targeted-media-slots"
GROUPED_QUESTION = "/data/household/address"
# The files ``targeted-media-slots`` names: the group's label image, the question's label image, and one image
# both the question's hint and its validation message name.
GROUP_IMAGE = "c5f74c6dda51d3941b4d17d05991f900debbf387ff748eda65d2f03dda227b2e"
GROUPED_LABEL_IMAGE = "50a8af47cc2e68f022bfb93e26be925081df6d21b3d4c276cdabdbd8d31de83d"
UNSHOWN_IMAGE = "30ab512e6539a83342a9415c6e7ddc7358a0ffd2aefe5369c86b9efb591e3984"


def test_formplayer_hands_a_groups_label_media_and_no_hint_or_validation_message_media(
    hq, core_runner, formplayer_runner, formplayer_documents, evidence
):
    with apps.published(formplayer_documents[GROUPED], core_runner) as published:
        with apps.served(published, formplayer_runner) as served:
            walked = apps.walked(formplayer_runner, served)
    trees = [
        step["response"]["tree"]
        for run in walked["runs"]
        for step in run["steps"]
        if isinstance(step.get("response"), dict) and isinstance(step["response"].get("tree"), list)
    ]
    nodes = [node for tree in trees for node in _questions(tree)]
    # A group's node names no binding: it is the sub-group holding the question (``PromptToJson``).
    groups = [
        node
        for node in nodes
        if node.get("type") == "sub-group"
        and any(child.get("binding") == GROUPED_QUESTION for child in node.get("children") or ())
    ]
    questions = [node for node in nodes if node.get("binding") == GROUPED_QUESTION]
    indices = {node.get("ix") for node in questions}
    attempts = [
        attempt
        for run in walked["runs"]
        for step in run["steps"]
        for attempt in step.get("answers") or ()
        if attempt.get("ix") in indices
    ]
    evidence("grouped-media-slots", {"group": groups[:1], "question": questions[:1], "attempts": attempts})
    assert groups and questions, f"Formplayer's walk of {GROUPED} never opened the form holding {GROUPED_QUESTION}"
    # The group's label image is handed to the client with its text, as a question's label image is.
    assert groups[0].get("caption") == "Household", groups[0]
    assert GROUP_IMAGE in str(groups[0].get("caption_image")), groups[0]
    assert GROUPED_LABEL_IMAGE in str(questions[0].get("caption_image")), questions[0]
    assert questions[0].get("hint") == "Write the street", questions[0]
    # Neither the hint's nor the validation message's image is handed, in any form Formplayer answered.
    assert UNSHOWN_IMAGE not in json.dumps(trees), questions[0]
    # The answer table's first text ends in white space and is refused with the message; its second is taken.
    refused = [attempt["response"] for attempt in attempts if attempt["response"].get("status") != "accepted"]
    taken = [attempt for attempt in attempts if attempt["response"].get("status") == "accepted"]
    assert refused and taken, attempts
    for response in refused:
        assert "Write proof" in json.dumps(response), response
        assert UNSHOWN_IMAGE not in json.dumps(response), response
