"""Retyping the wording preserves Vellum's Face Capture mug and its exact wire behavior."""

from dataclasses import replace
import json

from lxml import etree

from proof.editors import vellum
from proof.editors.conftest import corpus_document, write_evidence
from proof.editors.hq import HQAnswers
from proof.hq.seams import SeamRecord, flags
from proof.rules.conftest import published


def test_vellum_saves_and_reopens_the_face_photo(hq, core_runner, editor_driver):
    with published(corpus_document("targeted-face-photo"), core_runner) as app:
        endpoint = HQAnswers(app.unit, app.unit)
        form = app._app().modules[0].forms[0]
        first = vellum.open_and_save(editor_driver, endpoint, app.app_id, form.unique_id,
                                     edit={"path": "/data/portrait", "label": "Portrait of the visitor", "way": "builder-model"})
        assert first.saved and first.stored_source, (first.load_error, first.save_refusal, first.form_errors)
        fresh = vellum.open_and_save(editor_driver, endpoint, app.app_id, form.unique_id)
        assert fresh.saved and fresh.stored_source, (fresh.load_error, fresh.save_refusal, fresh.form_errors)
    for source in (first.stored_source, fresh.stored_source):
        root = etree.fromstring(source.encode())
        image, = root.xpath("//*[local-name()='upload' and @ref='/data/portrait']")
        assert (image.get("appearance"), image.get("mediatype")) == ("face", "image/*")
        bind, = root.xpath("//*[local-name()='bind' and @nodeset='/data/portrait']")
        assert bind.get("type").split(":")[-1] == "binary"
        assert "Portrait of the visitor" in root.xpath("//*[local-name()='value']/text()")
    write_evidence("face-photo", {"changed": first.stored_source, "reopened": fresh.stored_source})


def test_designer_can_add_a_face_camera_and_a_project_without_the_toggle_can_keep_it(hq, core_runner, editor_driver):
    doc = corpus_document("targeted-face-photo")
    with published(doc, core_runner) as app:
        form = app._app().modules[0].forms[0]
        endpoint = HQAnswers(app.unit, app.unit)
        minimum = doc.exports["minimum"].configuration.hq()
        disabled = replace(minimum, flags=minimum.flags - {"FACE_CAPTURE"})
        enabled = replace(minimum, flags=minimum.flags | {"FACE_CAPTURE"})
        with flags(enabled, SeamRecord()):
            options = vellum.vellum_options(app.unit, app.app_id, form.unique_id)
            assert json.loads(options.json)["features"]["face_capture"] is True
            created = vellum.open_and_save(editor_driver, endpoint, app.app_id, form.unique_id, options=options,
                                           edit={"way": "add-questions", "questions": [
                                               {"type": "FaceCapture", "id": "followup", "label": "Follow-up portrait"}
                                           ]})
            assert created.saved and created.stored_source, (created.load_error, created.save_refusal)
        with flags(disabled, SeamRecord()):
            ordinary = vellum.vellum_options(app.unit, app.app_id, form.unique_id)
            assert not json.loads(ordinary.json)["features"].get("face_capture")
            kept = vellum.open_and_save(editor_driver, endpoint, app.app_id, form.unique_id, options=ordinary)
            assert kept.saved and kept.stored_source, (kept.load_error, kept.save_refusal)
        for source in (created.stored_source, kept.stored_source):
            xml = etree.fromstring(source.encode())
            assert xml.xpath("//*[local-name()='upload' and @appearance='face']/@ref") == ["/data/portrait", "/data/followup"]
            assert "Follow-up portrait" in xml.xpath("//*[local-name()='value']/text()")
        write_evidence("face-created-and-retained", {"created": created.stored_source, "reopened": kept.stored_source})
