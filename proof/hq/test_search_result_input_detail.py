"""HQ build validation of result-prompt expressions shared with a device case list."""

import os
from pathlib import Path

from lxml import etree

from proof.native.hq_support import write_evidence
from proof.rules.conftest import published


def test_native_build_rejects_results_input_in_the_shared_non_inline_detail(hq, documents):
    """A lazy roster guard cannot make a calculated Search column survive HQ validation."""
    input_path = "instance('search-input:results')/input/field[@name = 'patient_name']"
    marker = "case search instance used in casedb case details"
    roster_test = "count(current()/../../results) > 0"
    formulas = {
        "ordinary": f"if({roster_test}, 'search row', 'local row')",
        "unguarded": f"string({input_path})",
        "guarded": f"if({roster_test}, string({input_path}), 'local row')",
    }
    evidence = {}
    with published(documents["targeted-search-workflow"], None, configuration="maximum") as app:
        for name, formula in formulas.items():
            def configure(body):
                menu = body["modules"][0]
                menu["case_list"]["show"] = True
                menu["search_config"].update(auto_launch=False, inline_search=False, default_search=False)
                column = menu["case_details"]["short"]["columns"][0]
                column.update(field=formula, model="case", format="plain", useXpathExpression=True)
                return body

            with app.unit.fork():
                app._write(configure)
                stored = app._app()
                module = stored.get_module(0)
                assert module.search_config.auto_launch is False
                assert module.search_config.inline_search is False
                details = {key: detail for key, detail, enabled in module.get_details() if enabled}
                case = details["case_short"]
                results = details["search_short"]
                assert case.get_instance_name(module) == "casedb"
                assert results.get_instance_name(module) == "results"
                assert case.columns[0].field == results.columns[0].field == formula
                assert case.columns[0].useXpathExpression and results.columns[0].useXpathExpression
                local_errors = [
                    error["details"] for error in module.validator.validate_detail_columns(case)
                    if error["type"] == marker
                ]
                result_errors = [
                    error["details"] for error in module.validator.validate_detail_columns(results)
                    if error["type"] == marker
                ]
                build_errors = [
                    error["details"] for error in module.validate_for_build()
                    if error["type"] == marker
                ]
                expected = set() if name == "ordinary" else {"search-input:results"}
                assert set(local_errors) == set(build_errors) == expected
                assert result_errors == []
                if name == "ordinary":
                    suite = etree.fromstring(stored.create_suite())
                    assert suite.xpath("//detail[@id='m0_case_short']")
                    assert suite.xpath("//detail[@id='m0_search_short']")
                    assert suite.xpath("//datum[@detail-select='m0_case_short']")
                    assert suite.xpath("//query/../datum[@detail-select='m0_search_short']")
                evidence[name] = {
                    "storedFormula": formula, "localRoster": case.get_instance_name(module),
                    "resultsRoster": results.get_instance_name(module),
                    "localErrors": local_errors, "resultsErrors": result_errors, "buildErrors": build_errors,
                }
    if out := os.environ.get("PROOF_OUT"):
        directory = Path(out, "hq")
        directory.mkdir(parents=True, exist_ok=True)
        write_evidence(directory, "search-result-detail-shared-column-build", evidence)
