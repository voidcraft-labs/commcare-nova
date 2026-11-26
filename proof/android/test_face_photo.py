"""An installed face question dispatches its own camera activity and submits the file that activity cropped."""

from io import BytesIO

import pytest
from PIL import Image
from lxml import etree

from proof.android.test_form_reads import _app, _entries, _forms, _served

pytestmark = pytest.mark.reader("android")


def test_installed_face_question_returns_the_cropped_picture(android_documents, hq):
    submissions = []
    with _served(android_documents["targeted-face-photo"]) as (served, archive):
        reported, sent = _app(served, archive, "face-photo", commands=["m0-f0"], views=True, controls=True,
                              questions={"/data/portrait": ["camera"]}, submissions=submissions)
    form, = _forms(reported["walks"]["m0-f0"])
    question, = [q for screen in form["screens"] for q in screen.get("questions", [])
                 if q["reference"] == "/data/portrait[1]"]
    assert question["widget"] == "FaceCaptureWidget", question
    captured, = _entries(form, "/data/portrait[1]")
    assert captured["camera"] == "org.commcare.activities.camera.MicroImageActivity", captured
    assert captured["faceLens"] == 1 and captured["switchLens"] is True, captured
    assert (captured["croppedWidth"], captured["croppedHeight"]) == (660, 580), captured
    assert captured["taken"] and form["saved"]["finishing"], form
    instance, = sent
    posted, = submissions
    name = etree.fromstring(instance).findtext("{*}portrait")
    assert name and posted.instance == instance, (name, posted.instance, instance)
    with Image.open(BytesIO(dict(posted.files)[name])) as photo:
        assert photo.format == "JPEG" and photo.size == (660, 580), (photo.format, photo.size)
        pixel = photo.convert("RGB").getpixel((330, 290))
        assert max(pixel[:2]) < 20 and pixel[2] > 230, pixel
