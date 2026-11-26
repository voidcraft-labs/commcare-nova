"""A real Form Designer save preserves each referenced alternative text."""

from lxml import etree

from proof.editors import vellum
from proof.editors.conftest import corpus_document, write_evidence
from proof.editors.test_plan_features import _form, _published
from proof.formplayer.test_itext_recipients import LONG_TEXT, VIDEO, XF, with_recipient_forms
from proof.formplayer.test_media_slots import GROUPED
from proof.observe.hqside import _patched


def test_the_form_designer_keeps_long_text_and_inline_video_values(hq, core_runner, editor_driver):
    with _published(corpus_document(GROUPED), "CLOUDCARE", True) as opened:
        form = _form(opened.state, opened.app_id, lambda f: "/data/household/address" in f.source)
        _patched(opened.state, opened.app_id, form.unique_id, with_recipient_forms(form.source), "recipient forms")
        result = vellum.fresh_open_and_save(editor_driver, opened.state, opened.app_id, form.unique_id)
    assert result.loaded and result.saved, (result.load_error, result.save_refusal)
    root = etree.fromstring(result.stored_source.encode())
    long = {value.text for value in root.iter(f"{XF}value") if value.get("form") == "long"}
    inline = [value.text for value in root.iter(f"{XF}value") if value.get("form") == "video-inline"]
    write_evidence("editor-itext-recipients", {"long": sorted(long), "inline": inline})
    assert set(LONG_TEXT.values()) <= long, long
    assert inline == [VIDEO] * len(LONG_TEXT), inline
