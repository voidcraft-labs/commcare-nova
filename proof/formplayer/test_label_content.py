"""Formplayer and a label's other contents (``targeted-label-content``).

The document's first question's label shows as typed and holds an extended text (``long``), a QR code
(``qrcode``), a spoken text (``tts``) and an inline video (``video-inline``) beside its image; its second
question's label is formatted and holds an extended text too. On HQ's release of that app served to Formplayer
by HQ's own views (``proof.formplayer.hq``), Formplayer hands the Web Apps client each question's caption as
Core's ``FormEntryCaption.getLongText`` reads it and its markdown caption as ``getMarkdownText`` reads it
(``api/json/PromptToJson.java``), its label image, and no field naming a ``qrcode``, ``tts`` or
``video-inline`` form, which ``PromptToJson`` never asks for.

Contract: the first question's caption is its extended text, with no markdown caption, so the client shows the
extended text; the second's markdown caption is its formatted label, which the client shows over the caption;
the first question's label image is handed, and nothing of the question names its QR code's text, its spoken
text or its inline video's file. Plausible failures: the extended text left out of the caption (an export that
dropped the form, or a markdown form written beside it, which the client would show instead), the formatted
label lost to its extended text, and a QR code, spoken text or inline video handed to a client that has no
reader of it, so Web Apps would show something Nova's platform table says it ignores.
"""

from __future__ import annotations

import json

from proof.formplayer import apps

DOCUMENT = "targeted-label-content"
NAME = "/data/family_name"
NOTE = "/data/note"
# The digests the export names its media files by (``jr://file/commcare/<sha256>.<ext>``): the label image and
# the video the inline video names.
LABEL_IMAGE = "50a8af47cc2e68f022bfb93e26be925081df6d21b3d4c276cdabdbd8d31de83d"
INLINE_VIDEO = "e9cefb19834b705b60adbb1f14ae4cce5313616c0390e9b9601a50b3ca9bab38"


def _questions(tree):
    for node in tree or ():
        if isinstance(node, dict):
            yield node
            yield from _questions(node.get("children"))


def test_formplayer_hands_the_extended_text_and_no_qr_code_speech_or_inline_video(
    hq, core_runner, formplayer_runner, formplayer_documents, evidence
):
    with apps.published(formplayer_documents[DOCUMENT], core_runner) as published:
        with apps.served(published, formplayer_runner) as served:
            walked = apps.walked(formplayer_runner, served)
    trees = [
        step["response"]["tree"]
        for run in walked["runs"]
        for step in run["steps"]
        if isinstance(step.get("response"), dict) and isinstance(step["response"].get("tree"), list)
    ]
    nodes = [node for tree in trees for node in _questions(tree)]
    name = [node for node in nodes if node.get("binding") == NAME]
    note = [node for node in nodes if node.get("binding") == NOTE]
    evidence("label-content", {"name": name[:1], "note": note[:1]})
    assert name and note, f"Formplayer's walk of {DOCUMENT} never showed {NAME} and {NOTE}: {nodes}"
    question = name[0]
    # The label shows as typed: its caption is the extended text, and no markdown caption stands over it.
    assert question.get("caption") == "Write the name the family uses", question
    assert not question.get("caption_markdown"), question
    # The control: the label's image is handed.
    assert LABEL_IMAGE in str(question.get("caption_image")), question
    # Nothing of the question names its QR code's text, its spoken text or its inline video's file.
    whole = json.dumps(question)
    for unshown in ("FAMILY-17", "Say the family name", INLINE_VIDEO):
        assert unshown not in whole, (unshown, question)
    # The formatted label: its markdown caption is the label, which the client shows over the extended text.
    assert note[0].get("caption_markdown") == "**Thank** the family", note[0]
    assert note[0].get("caption") == "Extended thanks", note[0]
