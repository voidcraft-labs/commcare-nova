"""The Android form tree reads extended text and lays out inline video only at its question."""

import io
import json
import zipfile

from proof.android.observe import archive_bytes
from proof.android.test_form_reads import FORM, _app, _forms, _served, _texts
from proof.formplayer.test_itext_recipients import with_recipient_forms
from proof.formplayer.test_media_slots import GROUPED


def _inline_videos(view):
    if view.get("class", "").endswith("VideoView") and not view.get("visibility"):
        yield view
    for child in view.get("children", ()):
        yield from _inline_videos(child)


def test_android_uses_long_recipients_and_only_one_inline_video(android_documents, hq, evidence):
    with _served(android_documents[GROUPED]) as (served, archive):
        with zipfile.ZipFile(io.BytesIO(archive)) as zip_file:
            entries = {name: zip_file.read(name) for name in zip_file.namelist()}
        path, = (name for name in entries if name.endswith("modules-0/forms-0.xml"))
        entries[path] = with_recipient_forms(entries[path]).encode()
        answer, _ = _app(served, archive_bytes(entries), "itext-recipients", commands=[FORM], views=True)
    form, = _forms(answer["walks"][FORM])
    screens = form["screens"]
    views = [screen.get("view") or {} for screen in screens]
    text = " ".join(label for view in views for label in _texts(view))
    evidence("android-itext-recipient-forms", screens)
    for expected in ("The address label", "The address hint", "The household title", "The chosen option", "The entries title"):
        assert expected in text, (expected, text)
    assert "The address violation" in json.dumps(screens), screens
    shown_video_counts = [len(list(_inline_videos(view))) for view in views]
    assert max(shown_video_counts) == 1, shown_video_counts
    for view in views:
        if "The address label" not in " ".join(_texts(view)):
            assert not list(_inline_videos(view)), view
