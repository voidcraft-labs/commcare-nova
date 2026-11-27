"""The Case List editor keeps the optional submitted Search text on Details."""

from __future__ import annotations

from lxml import etree

from proof.editors import compare, pages
from proof.editors.conftest import corpus_document, write_evidence
from proof.hq import operations
from proof.rules.conftest import published


MENU = 2  # Recent patients is the corpus app's standalone auto-launch Search.
PROMPT = "detail_marker"
PROMPT_NODE = f"instance('search-input:results')/input/field[@name = '{PROMPT}']"
FORMULA = (
    "if(count(current()/../../results) > 0, concat('entered=[', "
    f"if(count({PROMPT_NODE}) > 0, string({PROMPT_NODE}), ''), ']'), 'local row')"
)


def _configure(body):
    body["cloudcare_enabled"] = True
    menu = body["modules"][MENU]
    search = menu["search_config"]
    assert search["auto_launch"] and not search["inline_search"]
    search["default_search"] = False
    prompt, = search["properties"]
    prompt.update(name=PROMPT, label={"en": "Detail marker"}, exclude=True)
    menu["case_details"]["long"]["columns"] = [{
        "doc_type": "DetailColumn",
        "model": "case",
        "field": FORMULA,
        "format": "plain",
        "header": {"en": "Entered value"},
        "useXpathExpression": True,
    }]
    return body


def test_current_case_list_editor_keeps_guarded_search_result_detail(hq, core_runner, editor_driver):
    with published(corpus_document("targeted-search-workflow"), core_runner) as app:
        app._write(_configure)
        module = operations.held_app(app.unit, app.app_id).modules[MENU]
        module_id = module.unique_id
        assert module.case_details.long.columns[0].field == FORMULA

        for _ in range(2):
            saved = pages.fresh_section_save(
                editor_driver, app.unit, pages.CASE_LIST, app.app_id, module_id,
            )
            assert saved.save and saved.save.status == 200 and not saved.refused, saved.alerts
            assert not saved.run["pageErrors"], saved.run["pageErrors"]
            module = operations.held_app(app.unit, app.app_id).modules[MENU]
            column, = module.case_details.long.columns
            assert column.useXpathExpression is True and column.field == FORMULA
            assert all(PROMPT_NODE not in short.field for short in module.case_details.short.columns)

        built = compare.build(app.unit, app.app_id, app.unit.record)
        suite = etree.fromstring(built.files["suite.xml"])
        details = {}
        for detail in suite.findall("detail"):
            if detail.get("id") in (f"m{MENU}_case_long", f"m{MENU}_search_long"):
                details[detail.get("id")] = [
                    value for element in detail.iter() for value in element.attrib.values()
                    if "search-input:results" in value
                ]
        write_evidence("standalone-search-result-detail", {
            "stored": column.field,
            "built": details,
        })
        assert details == {f"m{MENU}_{kind}_long": [FORMULA] for kind in ("case", "search")}
