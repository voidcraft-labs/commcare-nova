"""The pinned Form Designer keeps or changes deployed index identifiers."""

import pytest
from lxml import etree

from proof.editors import vellum
from proof.editors.conftest import corpus_document
from proof.editors.test_plan_features import XFORMS, _form, _published
from proof.observe.hqside import _patched

CASE = "http://commcarehq.org/case/transaction/v2"
VELLUM = "http://commcarehq.org/xforms/vellum"


def _save_with_link(editor_driver, name, *, action_present=None, expect_load=True):
    document = corpus_document("case-operation-query")
    with _published(document, "VELLUM_SAVE_TO_CASE", True) as opened:
        form = _form(
            opened.state,
            opened.app_id,
            lambda f: 'vellum:role="SaveToCase"' in (f.source or ""),
        )
        root = etree.fromstring(form.source.encode())
        transaction = next(
            node
            for node in root.iter(f"{{{CASE}}}case")
            if node.getparent().get(f"{{{VELLUM}}}role") == "SaveToCase"
            and node.find(f"{{{CASE}}}index") is None
            and (
                action_present is None
                or node.find(f"{{{CASE}}}{name}") is None
            )
        )
        index = etree.SubElement(transaction, f"{{{CASE}}}index")
        link = etree.SubElement(
            index, f"{{{CASE}}}{name}", case_type="household", relationship="child"
        )
        model = root.find(f".//{{{XFORMS}}}model")
        path = "/" + "/".join(
            etree.QName(node).localname
            for node in (*reversed(list(link.iterancestors())), link)[4:]
        )
        assert path.endswith(f"/case/index/{name}") and path.startswith("/data/"), path
        if action_present and name == "close":
            transaction.insert(0, etree.Element(f"{{{CASE}}}close"))
        if action_present and name == "create":
            case_path = path.removesuffix(f"/index/{name}")
            create = etree.Element(f"{{{CASE}}}create")
            transaction.insert(0, create)
            case_type = transaction.getparent().get(f"{{{VELLUM}}}case_type")
            assert case_type
            for field, expression in (
                ("case_type", repr(case_type)),
                ("case_name", "'Witness case'"),
                ("owner_id", "/data/meta/userID"),
            ):
                etree.SubElement(create, f"{{{CASE}}}{field}")
                etree.SubElement(
                    model, f"{{{XFORMS}}}bind", nodeset=f"{case_path}/create/{field}", calculate=expression
                )
            for bind in model.findall(f"{{{XFORMS}}}bind"):
                if bind.get("nodeset") == f"{case_path}/@case_id":
                    model.remove(bind)
            etree.SubElement(
                model, f"{{{XFORMS}}}setvalue", event="xforms-ready", ref=f"{case_path}/@case_id", value="uuid()"
            )
        etree.SubElement(
            model, f"{{{XFORMS}}}bind", nodeset=path, calculate="'household-123'"
        )
        _patched(
            opened.state,
            opened.app_id,
            form.unique_id,
            etree.tostring(root, encoding="unicode"),
            "index name control",
        )
        run = vellum.fresh_open_and_save(
            editor_driver, opened.state, opened.app_id, form.unique_id
        )
        if expect_load:
            assert run.loaded, run.load_error
        return run, path


def test_hyphenated_save_to_case_link_calculation_survives_native_save(
    hq, core_runner, editor_driver
):
    run, path = _save_with_link(editor_driver, "par-ent")
    assert run.saved, run.save_refusal
    root = etree.fromstring(run.stored_source.encode())
    matching = [
        bind for bind in root.iter(f"{{{XFORMS}}}bind") if bind.get("nodeset") == path
    ]
    assert [bind.get("calculate") for bind in matching] == ["'household-123'"]
    assert len(list(root.iter(f"{{{CASE}}}par-ent"))) == 1


def test_period_in_save_to_case_link_cannot_keep_its_calculation(
    hq, core_runner, editor_driver
):
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


@pytest.mark.parametrize("name", ["parént", "亲属"])
def test_unicode_save_to_case_link_cannot_keep_its_calculation(
    hq, core_runner, editor_driver, name, evidence,
):
    run, path = _save_with_link(editor_driver, name)
    if not run.saved:
        assert run.save_refusal, run
        evidence("unicode-index", {"name": name, "saved": False, "refusal": str(run.save_refusal)})
        return
    root = etree.fromstring(run.stored_source.encode())
    bindings = [
        bind.get("calculate")
        for bind in root.iter(f"{{{XFORMS}}}bind")
        if bind.get("nodeset") == path
    ]
    assert "'household-123'" not in bindings
    evidence("unicode-index", {"name": name, "saved": True, "exactLinks": len(list(root.iter(f"{{{CASE}}}{name}"))), "bindings": bindings})


@pytest.mark.parametrize("name", ["instance", "parsererror"])
def test_form_designer_cannot_open_a_link_named_as_a_source_element(hq, core_runner, editor_driver, name):
    run, _ = _save_with_link(editor_driver, name, expect_load=False)
    assert not run.loaded
    assert run.load_error


@pytest.mark.parametrize("name", ["create", "close"])
def test_an_index_named_for_an_absent_action_cannot_keep_the_action_set(
    hq, core_runner, editor_driver, name
):
    run, path = _save_with_link(editor_driver, name, action_present=False)
    if not run.saved:
        assert run.save_refusal, run
        return
    root = etree.fromstring(run.stored_source.encode())
    case_path = path.removesuffix(f"/index/{name}")
    transaction = next(
        node
        for node in root.iter(f"{{{CASE}}}case")
        if "/" + "/".join(
            etree.QName(part).localname
            for part in (*reversed(list(node.iterancestors())), node)[4:]
        ) == case_path
    )
    assert transaction.find(f"{{{CASE}}}{name}") is not None


@pytest.mark.parametrize("name", ["create", "close"])
def test_an_index_named_for_an_existing_action_keeps_its_bind(
    hq, core_runner, editor_driver, name
):
    run, path = _save_with_link(editor_driver, name, action_present=True)
    assert run.saved, run.save_refusal
    root = etree.fromstring(run.stored_source.encode())
    assert any(
        bind.get("nodeset") == path and bind.get("calculate") == "'household-123'"
        for bind in root.iter(f"{{{XFORMS}}}bind")
    )
    blocks = [
        node
        for node in root.iter(f"{{{CASE}}}case")
        if node.find(f"{{{CASE}}}index/{{{CASE}}}{name}") is not None
    ]
    assert len(blocks) == 1
    assert [etree.QName(node).localname for node in blocks[0]].count(name) == 1
