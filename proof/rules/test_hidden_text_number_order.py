"""Stock form builder and pinned Core agree on explicit numeric text ordering."""

from base64 import b64encode

import pytest
from lxml import etree

from proof.checks import xform_parts
from proof.editors import compare, vellum
from proof.editors.conftest import corpus_document, write_evidence
from proof.editors.hq import HQAnswers
from proof.hq import operations
from proof.observe.build import arrange
from proof.observe.casedata import document_case_database
from proof.observe.sessions import AuthoredTables, admitted, hq_restore
from proof.rules.hidden_text_number_order import RULE
from proof.rules.vellum_attributes import normalize as without_vellum_attributes
from proof.webapps.hq import authored_project


@pytest.mark.parametrize("operand, literal, outcomes", [
    ("/data/code", "m", ["late"] * 7),
    ("/data/code", "20", ["late", "early", "late", "late", "early", "early", "late"]),
    ("/data/code", "1970-01-02", ["late", "late", "late", "late", "early", "late", "late"]),
    ("concat(/data/code, 'x')", "m", ["late"] * 7),
    ("concat(/data/code, '0')", "30", ["early", "late", "late", "late", "early", "early", "late"]),
    ("concat(/data/code, /data/code_again)", "30", ["early", "late", "late", "late", "early", "early", "late"]),
], ids=["lexical-text", "numeric-text", "date-shaped-text", "assembled-nonnumeric", "assembled-numeric", "two-text-answers"])
def test_vellum_and_core_preserve_two_numeric_readings_of_text_order(hq, core_runner, editor_driver, tmp_path, operand, literal, outcomes):
    document = corpus_document("hq-expressions")
    samples = ["", " 2 ", "23", "a", "1970-01-01", "1970-01-03", "2e0"]
    results, stored, built_forms = {}, {}, {}
    with authored_project(document, "A") as project:
        unit, app_id = project.unit, project.app_id
        form = operations.held_app(unit, app_id).get_module(0).get_form(0)
        endpoint = HQAnswers(unit, unit)
        tables = AuthoredTables(document.root / "authored" / "tables.json")
        restore, restored = hq_restore(unit, document_case_database(document), tables, "text-number-order")
        assert restore == {"served": True} and restored
        restored = b64encode(restored).decode()
        for kind, predicate in (
            ("implicit", f"{operand} < '{literal}'"),
            ("explicit", f"number({operand}) < number('{literal}')"),
        ):
            calculate = f"if({predicate}, 'early', 'late')"
            edited = vellum.open_and_save(editor_driver, endpoint, app_id, form.unique_id, edit={
                "path": "/data/language", "property": "calculateAttr", "value": calculate, "way": "builder-model",
            })
            fresh = vellum.open_and_save(editor_driver, endpoint, app_id, form.unique_id)
            for save in (edited, fresh):
                assert save.saved and save.stored_source, (save.load_error, save.save_refusal, save.form_errors)
                tree = etree.fromstring(save.stored_source.encode())
                assert tree.xpath("//*[local-name()='bind' and @nodeset='/data/language']/@calculate") == [calculate]
            stored[kind] = fresh.stored_source
            build = compare.build(unit, app_id, unit.record)
            assert not build.errors, build.errors
            built = etree.fromstring(build.files["modules-0/forms-0.xml"])
            assert built.xpath("//*[local-name()='bind' and @nodeset='/data/language']/@calculate") == [calculate]
            built_forms[kind] = built
            values = []
            with admitted(core_runner, arrange(build.files, tmp_path / kind)) as installation:
                assert installation["admitted"], installation["problems"]
                for index, sample in enumerate(samples):
                    answers = [{"path": "/data/code", "value": sample}]
                    if "/data/code_again" in operand:
                        endings = ["1", "0", "0", "7", "0", "0", "0"]
                        answers.append({"path": "/data/code_again", "value": endings[index]})
                    run = core_runner.evaluate(app=installation["app"], xmlns=form.xmlns, restoreBase64=restored,
                                               session={"command": "m0-f0"}, answers=answers,
                                               expressions=["/data/language"])
                    assert all(answer["result"] == "ok" for answer in run["answers"]), run
                    values.append(run["values"][0]["value"])
            results[kind] = {"calculate": calculate, "answers": values}
    shape = ("two-answers" if "/data/code_again" in operand else
             "assembled" if operand.startswith("concat(") else "direct")
    write_evidence(f"text-number-order-{shape}-{literal}", {"samples": samples, "results": results})
    assert results["implicit"]["answers"] == outcomes
    assert results["explicit"]["answers"] == outcomes
    left, right = (built_forms[kind] for kind in ("implicit", "explicit"))
    for form in (left, right):
        RULE.normalize(form)
        assert form.xpath("//*[local-name()='bind' and @nodeset='/data/language']/@calculate") == [results["explicit"]["calculate"]]
    def locations(before, after):
        return [(kind, at) for kind, at, _, _, _ in xform_parts.compare(before, after)]

    before, after = stored["implicit"], stored["explicit"]
    runtime = ("changed", "/data/language/:bind/@calculate/:respelled")
    assert locations(before, after) == [runtime, ("changed", "/data/language/:bind/@vellum:calculate")]
    # HQ removes this already-known Vellum companion before building the runtime attribute.
    after_vellum_rule = [
        etree.tostring(without_vellum_attributes(etree.fromstring(value.encode())))
        for value in (before, after)
    ]
    assert locations(*after_vellum_rule) == [runtime]


def test_spelling_rule_keeps_other_operands_and_scope_changes_visible():
    implicit = "if(/data/code &lt; '20', 'early', 'late')"
    wrapped = "if(number(/data/code) &lt; number('20'), 'early', 'late')"

    def form(calculation, *, input_type="xsd:string", result_control=""):
        return ('<h:html xmlns:h="http://www.w3.org/1999/xhtml" xmlns="http://www.w3.org/2002/xforms">'
                '<h:head><model><instance><data><code/><other/><result/></data></instance>'
                f'<bind nodeset="/data/code" type="{input_type}"/><bind nodeset="/data/other" type="xsd:string"/>'
                f'<bind nodeset="/data/result" calculate="{calculation}"/></model></h:head>'
                '<h:body><input ref="/data/code"/><input ref="/data/other"/>'
                f'{result_control}</h:body></h:html>')

    def compare(before, after):
        return list(xform_parts.compare(before, after))

    source = form(implicit)
    assert compare(source, form(wrapped))[0][1].endswith("/@calculate/:respelled")
    for different in (wrapped.replace("20", "21"), wrapped.replace("/code", "/other"),
                      wrapped.replace("&lt;", "&gt;"), wrapped.replace("'early'", "'other'"),
                      wrapped.replace("number('20')", "'20'")):
        assert compare(source, form(different))[0][1] == "/data/result/:bind/@calculate"
    for scope in ({"input_type": "xsd:int"}, {"result_control": '<input ref="/data/result"/>'}):
        original, explicit = form(implicit, **scope), form(wrapped, **scope)
        assert compare(original, explicit)[0][1] == "/data/result/:bind/@calculate"
        root = etree.fromstring(original)
        assert etree.tostring(RULE.normalize(root)) == etree.tostring(etree.fromstring(original))
