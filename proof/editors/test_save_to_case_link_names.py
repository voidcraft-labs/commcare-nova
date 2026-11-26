"""The pinned Form Designer preserves a hyphen in an index calculation's path."""

from lxml import etree

from proof.editors import vellum
from proof.editors.conftest import corpus_document
from proof.editors.test_plan_features import XFORMS, _form, _published
from proof.observe.hqside import _patched

CASE = "http://commcarehq.org/case/transaction/v2"
VELLUM = "http://commcarehq.org/xforms/vellum"


def _save_with_link(editor_driver, name):
    document = corpus_document("case-operation-query")
    with _published(document, "VELLUM_SAVE_TO_CASE", True) as opened:
        form = _form(opened.state, opened.app_id, lambda f: 'vellum:role="SaveToCase"' in (f.source or ""))
        root = etree.fromstring(form.source.encode())
        transaction = next(
            node
            for node in root.iter(f"{{{CASE}}}case")
            if node.getparent().get(f"{{{VELLUM}}}role") == "SaveToCase"
            and node.find(f"{{{CASE}}}index") is None
        )
        index = etree.SubElement(transaction, f"{{{CASE}}}index")
        link = etree.SubElement(index, f"{{{CASE}}}{name}", case_type="household", relationship="child")
        model = root.find(f".//{{{XFORMS}}}model")
        path = "/" + "/".join(etree.QName(node).localname for node in (*reversed(list(link.iterancestors())), link)[
            4:
        ])
        assert path.endswith(f"/case/index/{name}") and path.startswith("/data/"), path
        etree.SubElement(model, f"{{{XFORMS}}}bind", nodeset=path, calculate="'household-123'")
        _patched(
            opened.state, opened.app_id, form.unique_id, etree.tostring(root, encoding="unicode"), "index name control"
        )
        run = vellum.fresh_open_and_save(editor_driver, opened.state, opened.app_id, form.unique_id)
        assert run.loaded, run.load_error
        return run, path


def test_hyphenated_save_to_case_link_calculation_survives_native_save(hq, core_runner, editor_driver):
    run, path = _save_with_link(editor_driver, "par-ent")
    assert run.saved, run.save_refusal
    root = etree.fromstring(run.stored_source.encode())
    matching = [bind for bind in root.iter(f"{{{XFORMS}}}bind") if bind.get("nodeset") == path]
    assert [bind.get("calculate") for bind in matching] == ["'household-123'"]
    assert len(list(root.iter(f"{{{CASE}}}par-ent"))) == 1


def test_period_in_save_to_case_link_cannot_keep_its_calculation(hq, core_runner, editor_driver):
    run, path = _save_with_link(editor_driver, "par.ent")
    if run.saved:
        root = etree.fromstring(run.stored_source.encode())
        assert all(
            bind.get("calculate") != "'household-123'"
            for bind in root.iter(f"{{{XFORMS}}}bind")
            if bind.get("nodeset") == path
        )
    else:
        assert run.save_refusal, run
