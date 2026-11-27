"""Core opens the retained Survey with its real entry, which supplies no lookup count."""

from lxml import etree

from proof.core.client import load_answer_table
from proof.editors import compare
from proof.editors.conftest import corpus_document, write_evidence
from proof.matrix import ops
from proof.matrix.authoring import Authoring
from proof.observe.build import arrange
from proof.observe.casedata import document_case_database
from proof.observe.sessions import AuthoredTables, admitted, hq_restore
from proof.webapps.hq import authored_project

PATH = "instance('commcaresession')/session/data/fingerprintquery"
FALLBACK = "No lookup result"


def test_retained_survey_bare_lookup_count_without_a_supplier(hq, core_runner, tmp_path):
    document = corpus_document("hq-expressions")
    answer_table = load_answer_table()
    answer_table["dataTypes"]["text"] = ["clinic"]
    observed = {}
    with authored_project(document, "A") as project:
        unit = project.unit
        tables = AuthoredTables(document.root / "authored" / "tables.json")
        restore, restored = hq_restore(unit, document_case_database(document), tables, "fingerprint-query")
        assert restore == {"served": True} and restored
        for label in ("guarded", "bare"):
            with unit.fork():
                authoring = Authoring(unit, {}, label, operation=unit.operation)
                expression = PATH if label == "bare" else f"if(count({PATH}) = 0, '{FALLBACK}', string({PATH}[1]))"

                def edit(root, _form):
                    bind, = root.xpath("//*[local-name()='bind'][@nodeset='/data/language']")
                    bind.set("calculate", expression)

                ops.set_form_source(authoring, project.app_id, 0, 0, edit, what=f"{label}-fingerprint-query")
                built = compare.build(unit, project.app_id, unit.record)
                assert not built.errors, built.errors
                suite = etree.fromstring(built.files["suite.xml"])
                assert not suite.xpath("//lookup | //*[@id='fingerprintquery']"), "The entry must supply no count"
                with admitted(core_runner, arrange(built.files, tmp_path / label)) as installed:
                    assert installed["admitted"], installed["problems"]
                    trace = core_runner.session(installed["app"], restore=restored, answer_table=answer_table)
                xmlns = built.app.modules[0].forms[0].xmlns
                (run, step), = [
                    (run, step) for run in trace["runs"] for step in run["trace"]
                    if step["screen"] == "form" and step["xmlns"] == xmlns
                ]
                observed[label] = {"end": run["end"], "step": step, "script": run["script"]}

    write_evidence("fingerprint-query-no-supplier", observed)
    guarded = observed["guarded"]
    assert guarded["end"] == "submitted", guarded
    submission = etree.fromstring(guarded["step"]["submission"].encode())
    assert submission.findtext("{*}language") == FALLBACK
    bare = observed["bare"]
    assert bare["script"] == guarded["script"], observed
    assert bare["end"] == "form-did-not-open", bare
    assert "fingerprintquery" in str(bare["step"]["error"])
    assert "not a valid question or value" in str(bare["step"]["error"])
    assert "submission" not in bare["step"]


def test_retained_advanced_form_supplies_its_declared_fingerprint_query(hq, core_runner, tmp_path):
    document = corpus_document("hq-advanced")
    declared = "Declared result"
    with authored_project(document, "A") as project:
        unit = project.unit
        restore, restored = hq_restore(unit, document_case_database(document), None, "explicit-fingerprint-query")
        assert restore == {"served": True} and restored
        authoring = Authoring(unit, {}, "explicit-fingerprint-query", operation=unit.operation)

        def edit(root, _form):
            model, = root.xpath("//*[local-name()='model']")
            data, = model.xpath("./*[local-name()='instance'][not(@id)]/*[local-name()='data']")
            etree.SubElement(data, f"{{{etree.QName(data).namespace}}}observed_count")
            etree.SubElement(model, f"{{{etree.QName(model).namespace}}}bind",
                             nodeset="/data/observed_count", calculate=PATH)

        ops.set_form_source(authoring, project.app_id, 1, 0, edit, what="explicit-fingerprint-query")
        ops.set_json(authoring, project.app_id, "/modules/1/forms/0/arbitrary_datums", [
            {"datum_id": "fingerprintquery", "datum_function": f"'{declared}'", "doc_type": "ArbitraryDatum"},
        ])
        built = compare.build(unit, project.app_id, unit.record)
        assert not built.errors, built.errors
        xmlns = built.app.modules[1].forms[0].xmlns
        suite = etree.fromstring(built.files["suite.xml"])
        (datum,) = suite.xpath("//entry[form=$xmlns]/session/datum[@id='fingerprintquery']", xmlns=xmlns)
        assert datum.get("function") == f"'{declared}'"
        assert not suite.xpath("//lookup")
        with admitted(core_runner, arrange(built.files, tmp_path / "declared")) as installed:
            assert installed["admitted"], installed["problems"]
            trace = core_runner.session(installed["app"], restore=restored, answer_table=load_answer_table())
        observed = [
            {"end": run["end"], "step": step, "script": run["script"]}
            for run in trace["runs"] for step in run["trace"]
            if step["screen"] == "form" and step["xmlns"] == xmlns
        ]

    write_evidence("fingerprint-query-explicit-supplier", observed)
    assert observed, trace
    for attempt in observed:
        assert attempt["end"] == "submitted", attempt
        submission = etree.fromstring(attempt["step"]["submission"].encode())
        assert submission.findtext("{*}observed_count") == declared
