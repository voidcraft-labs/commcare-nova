"""What a worker sees in Web Apps of a label's other contents (``targeted-label-content``).

The document's first question's label shows as typed and holds an extended text, a QR code, a spoken text and
an inline video beside its image; its second question's label is formatted and holds an extended text too.
Formplayer hands the client each caption and markdown caption as Core reads them, the label image, and nothing
of the QR code, the spoken text or the inline video (``proof/formplayer/test_label_content.py``). This is what
the client does with what it is handed, on the form's first screen.

Contract: the first question shows its extended text in its label's place and lays out its label image alone,
no video; the second shows its formatted label, not its extended text; and no screen names the QR code's text,
the spoken text or the inline video's file, which Nova's platform table says Web Apps ignores
(``label-qr-code``, ``label-spoken-text``, ``label-inline-video``). Plausible failures: the short label shown
where the extended text belongs, the formatted label lost to its extended text, and a QR code, speaker or
video the client draws from something it was handed.
"""

from __future__ import annotations

import json

from proof.webapps import hq as webapps_hq
from proof.webapps import steps
from proof.webapps.session import Session

DOCUMENT = "targeted-label-content"
LABEL_IMAGE = "50a8af47cc2e68f022bfb93e26be925081df6d21b3d4c276cdabdbd8d31de83d.png"
INLINE_VIDEO = "e9cefb19834b705b60adbb1f14ae4cce5313616c0390e9b9601a50b3ca9bab38"


def test_web_apps_shows_the_extended_text_and_no_qr_code_speech_or_inline_video(
    hq, core_runner, formplayer_runner, editor_driver, webapps_documents, evidence
):
    with webapps_hq.project(webapps_documents[DOCUMENT]) as project:
        with project.released(formplayer_runner) as release:
            made = [
                *steps.open_app("Label content"),
                *steps.choose("Families"),
                *steps.choose("Visit"),
                steps.SCREEN,
            ]
            run = Session(release, editor_driver).run(made)
    assert run.page_errors == []
    (screen,) = run.screens
    evidence("label-content", screen)
    name, note = screen["form"]["questions"]
    assert "Write the name the family uses" in name["label"], name
    # The short label stands nowhere: the extended text takes its place.
    assert "Name" not in name["label"], name
    # The label image is laid out alone: no inline video.
    assert [(item["kind"], item["src"].rsplit("/", 1)[-1]) for item in name["media"]] == [
        ("img", LABEL_IMAGE)
    ], name
    assert "Thank" in note["label"] and "Extended thanks" not in note["label"], note
    whole = json.dumps(screen)
    for unshown in ("FAMILY-17", "Say the family name", INLINE_VIDEO):
        assert unshown not in whole, (unshown, screen)
