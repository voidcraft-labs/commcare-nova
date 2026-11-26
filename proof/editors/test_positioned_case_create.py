"""HQ's actual form editor must preserve a positioned create and its adjacent guard."""

from lxml import etree

from proof.editors import vellum
from proof.editors.conftest import corpus_document
from proof.editors.test_plan_features import XFORMS, _form, _published

CASE = "http://commcarehq.org/case/transaction/v2"


def _position(source):
    root = etree.fromstring(source.encode("utf-8"))
    model = root.find(f".//{{{XFORMS}}}model")
    data = model.find(f"{{{XFORMS}}}instance")[0]
    assert [etree.QName(child).localname for child in data][:4] == [
        "visit_name", "save_visit", "nova_guard_save_visit_text", "notes",
    ]
    create = data[1].find(f"{{{CASE}}}case")
    guard = data[2].find(f"{{{CASE}}}case")
    assert create.find(f"{{{CASE}}}create") is not None
    assert guard.find(f"{{{CASE}}}update/{{{CASE}}}case_type") is not None
    (ready,) = [setvalue.get("value") for setvalue in model.iter(f"{{{XFORMS}}}setvalue")
                if setvalue.get("ref") == "/data/save_visit/case/@case_id"]
    (guard_id,) = [bind.get("calculate") for bind in model.iter(f"{{{XFORMS}}}bind")
                   if bind.get("nodeset") == "/data/nova_guard_save_visit_text/case/@case_id"]
    assert ready == "uuid()" and "save_visit/case/@case_id" in guard_id
    return guard_id


def test_hq_keeps_a_positioned_case_create_and_its_adjacent_guard(hq, core_runner, editor_driver):
    document = corpus_document("targeted-positioned-case-create")
    with _published(document, "VELLUM_SAVE_TO_CASE", True) as opened:
        form = _form(opened.state, opened.app_id, lambda candidate: candidate.default_name() == "Record a visit")
        before = _position(form.source)
        run = vellum.fresh_open_and_save(editor_driver, opened.state, opened.app_id, form.unique_id)
        assert run.loaded and run.saved, (run.load_error, run.save_refusal)
        assert _position(run.stored_source) == before
