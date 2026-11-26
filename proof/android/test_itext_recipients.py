"""The Android form tree reads extended text and lays out inline video only at its question."""

import copy
import io
import json
import zipfile

from lxml import etree
import pytest

from proof.android.observe import archive_bytes
from proof.android.test_form_reads import FORM, _app, _forms, _served, _texts
from proof.formplayer.test_itext_recipients import VIDEO, XF, with_recipient_forms
from proof.formplayer.test_media_slots import GROUPED


pytestmark = pytest.mark.reader("android")


def _visible_views(view, suffix):
    if view.get("visibility"):
        return
    if view.get("class", "").endswith(suffix):
        yield view
    for child in view.get("children", ()):
        yield from _visible_views(child, suffix)


def _blank_help_and_control(source, inline_video):
    root = etree.fromstring(with_recipient_forms(source, inline_video).encode())
    model, = root.iter(f"{XF}model")
    data, = model.find(f"{XF}instance")
    data_ns = f"{{{etree.QName(data).namespace}}}"
    colour = root.find(f".//{XF}select1[@ref='/data/colour']")
    other = copy.deepcopy(colour)
    other.set("ref", "/data/colour_without_help")
    colour.addnext(other)
    etree.SubElement(data, f"{data_ns}colour_without_help")
    etree.SubElement(model, f"{XF}bind", nodeset="/data/colour_without_help", type="xsd:string")
    help_ref = etree.Element(f"{XF}help", ref="jr:itext('blank-help-control')")
    colour.insert(1, help_ref)
    translation, = model.iter(f"{XF}translation")
    entry = etree.SubElement(translation, f"{XF}text", id="blank-help-control")
    etree.SubElement(entry, f"{XF}value")
    etree.SubElement(entry, f"{XF}value", form="video-inline").text = inline_video
    return etree.tostring(root)


def test_android_uses_long_recipients_and_only_one_inline_video(android_documents, hq, android_walk_evidence):
    with _served(android_documents[GROUPED]) as (served, archive):
        with zipfile.ZipFile(io.BytesIO(archive)) as zip_file:
            entries = {name: zip_file.read(name) for name in zip_file.namelist()}
        path, = (name for name in entries if name.endswith("modules-0/forms-0.xml"))
        entries[path] = _blank_help_and_control(entries[path], VIDEO)
        patched = archive_bytes(entries.items())
        answer, sent = _app(
            served, patched, "itext-recipients", commands=[FORM], views=True,
            questions={"/data/household/address": ["proof"]}, repeat_additions=1,
        )
        refused, refusal_submissions = _app(
            served, patched, "itext-validation-refusal", commands=[FORM], views=True,
            questions={"/data/household/address": ["refused"]}, type_refused=True,
        )
    walk = answer["walks"][FORM]
    refusal_walk = refused["walks"][FORM]
    android_walk_evidence({"accepted": walk, "refused": refusal_walk})
    assert "raised" not in walk and "raised" not in refusal_walk, (walk, refusal_walk)
    form, = _forms(walk)
    screens = form["screens"]
    views = [screen.get("view") or {} for screen in screens]
    text = " ".join(label for view in views for label in _texts(view))
    for expected in ("The address label", "The address hint", "The address help", "The chosen option"):
        assert expected in text, (expected, text)
    headings = [
        heading["text"].strip()
        for screen in screens
        for heading in _visible_views(screen.get("groupHeading") or {}, "TextView")
    ]
    assert "The household title" in headings, headings
    assert "The entries title (1)" in headings, headings
    assert any(screen.get("chose") == "Add a new The entries title?" for screen in screens)
    rejected, = _forms(refusal_walk)
    assert "The address violation" in json.dumps(rejected["screens"]), rejected["screens"]
    assert rejected["saved"]["finishing"] is False and not refusal_submissions
    shown_video_counts = [len(list(_visible_views(view, "VideoView"))) for view in views]
    assert max(shown_video_counts) == 1, shown_video_counts
    for view in views:
        if "The address label" not in " ".join(_texts(view)):
            assert not list(_visible_views(view, "VideoView")), view

    def question_view(path):
        return next(
            screen["view"] for screen in screens
            if any(question["reference"] == path for question in screen.get("questions", ()))
        )

    # The bare help element independently mounts one button, even though the
    # inline asset never mounts a player there. Its identical neighbor has no help.
    blank = question_view("/data/colour[1]")
    absent = question_view("/data/colour_without_help[1]")
    assert len(list(_visible_views(blank, "ImageButton"))) == len(list(_visible_views(absent, "ImageButton"))) + 1
    assert not list(_visible_views(blank, "VideoView"))
    assert form["saved"]["finishing"] and len(sent) == 1, (form.get("saved"), sent)
