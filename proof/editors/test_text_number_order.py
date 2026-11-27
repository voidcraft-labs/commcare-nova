"""Stock form builder and pinned Core agree on explicit numeric text ordering."""

from base64 import b64encode

import pytest
from lxml import etree

from proof.editors import compare, vellum
from proof.editors.conftest import corpus_document, write_evidence
from proof.editors.hq import HQAnswers
from proof.observe.build import arrange
from proof.hq import operations
from proof.observe.casedata import document_case_database
from proof.observe.sessions import AuthoredTables, admitted, hq_restore
from proof.webapps.hq import authored_project


@pytest.mark.parametrize("literal, outcomes", [
    ("m", ["late"] * 7),
    ("20", ["late", "early", "late", "late", "early", "early", "late"]),
    ("1970-01-02", ["late", "late", "late", "late", "early", "late", "late"]),
], ids=["lexical-text", "numeric-text", "date-shaped-text"])
def test_vellum_and_core_preserve_two_numeric_readings_of_text_order(hq, core_runner, editor_driver, tmp_path, literal, outcomes):
    document = corpus_document("hq-expressions")
    samples = ["", " 2 ", "23", "a", "1970-01-01", "1970-01-03", "2e0"]
    results = {}
    with authored_project(document, "A") as project:
        unit, app_id = project.unit, project.app_id
        form = operations.held_app(unit, app_id).get_module(0).get_form(0)
        endpoint = HQAnswers(unit, unit)
        tables = AuthoredTables(document.root / "authored" / "tables.json")
        restore, restored = hq_restore(unit, document_case_database(document), tables, "text-number-order")
        assert restore == {"served": True} and restored
        restored = b64encode(restored).decode()
        for kind, predicate in (
            ("implicit", f"/data/code < '{literal}'"),
            ("explicit", f"number(/data/code) < number('{literal}')"),
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
            build = compare.build(unit, app_id, unit.record)
            assert not build.errors, build.errors
            built = etree.fromstring(build.files["modules-0/forms-0.xml"])
            assert built.xpath("//*[local-name()='bind' and @nodeset='/data/language']/@calculate") == [calculate]
            values = []
            with admitted(core_runner, arrange(build.files, tmp_path / kind)) as installation:
                assert installation["admitted"], installation["problems"]
                for sample in samples:
                    run = core_runner.evaluate(app=installation["app"], xmlns=form.xmlns, restoreBase64=restored,
                                               session={"command": "m0-f0"}, answers=[{"path": "/data/code", "value": sample}],
                                               expressions=["/data/language"])
                    assert run["answers"][0]["result"] == "ok", run
                    values.append(run["values"][0]["value"])
            results[kind] = {"calculate": calculate, "answers": values}
    write_evidence(f"text-number-order-{literal}", {"samples": samples, "results": results})
    assert results["implicit"]["answers"] == outcomes
    assert results["explicit"]["answers"] == outcomes
