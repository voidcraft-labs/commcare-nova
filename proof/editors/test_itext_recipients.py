"""A real Form Designer save preserves each referenced alternative text."""

from lxml import etree

from proof.editors import vellum
from proof.editors.conftest import corpus_document, write_evidence
from proof.editors.test_plan_features import _form, _published
from proof.formplayer.test_itext_recipients import LONG_TEXT, VIDEO, XF, with_isolated_help, with_recipient_forms
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


def test_form_designer_saves_video_only_help_and_observes_its_empty_neighbor(hq, core_runner, editor_driver):
    evidence = {}
    with _published(corpus_document(GROUPED), "CLOUDCARE", True) as opened:
        form = _form(opened.state, opened.app_id, lambda f: "/data/household/address" in f.source)
        source = form.source
        for mode, values in {
            "video-only": [(None, None), ("video-inline", VIDEO)],
            "blank": [(None, None)],
            "regular": [(None, "Ordinary question help")],
            "regular-video": [(None, None), ("video", VIDEO)],
        }.items():
            _patched(opened.state, opened.app_id, form.unique_id, with_isolated_help(source, values), mode)
            result = vellum.fresh_open_and_save(editor_driver, opened.state, opened.app_id, form.unique_id)
            row = {"loaded": result.loaded, "saved": result.saved}
            if result.saved:
                root = etree.fromstring(result.stored_source.encode())
                question = root.find(f".//{XF}input[@ref='/data/isolated_help']")
                help_element = question.find(f"{XF}help")
                row["helpRef"] = help_element.get("ref") if help_element is not None else None
                row["values"] = [
                    [value.get("form"), value.text]
                    for entry in root.iter(f"{XF}text")
                    if entry.get("id") == "isolated-help-control"
                    for value in entry.findall(f"{XF}value")
                ]
            else:
                row["error"] = result.load_error or result.save_refusal
            evidence[mode] = row
    write_evidence("editor-help-affordance-controls", evidence)
    assert evidence["video-only"]["saved"], evidence
    assert ["video-inline", VIDEO] in evidence["video-only"]["values"], evidence
    assert evidence["blank"]["saved"] and evidence["blank"]["helpRef"] is None, evidence
    assert evidence["regular"]["saved"] and evidence["regular"]["helpRef"], evidence
    assert evidence["regular-video"]["saved"] and ["video", VIDEO] in evidence["regular-video"]["values"], evidence
