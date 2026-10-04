"""The runner's form check is the check HQ's build asks Formplayer for.

HQ's build posts each form to Formplayer's validate_form and reads the JSON it
returns (corehq/apps/formplayer_api/form_validation.py::validate_form, then
ValidationAPIResult). Formplayer's UtilController.validateForm parses the form
with Core's XFormParser and a JSONReporter attached, and returns
JSONReporter.generateJSONReport(). So the report's shape is fixed by that
source, not by the runner:

- passed: {"validated": true, "problems": [...]} and nothing else;
- failed: "fatal_error" (the exception's message) and "fatal_error_expected"
  are added. The catch is a multi-catch of XFormParseException and
  XPathException, whose static type is their common supertype
  RuntimeException, so Java binds JSONReporter.setFailed(Exception), which
  sets fatal_error_expected to false for every failure;
- each problem is a JSONReporter.warning: "type", "message", "fatal": false
  and "xml_location" when the parser gave one; warnings never fail a form.

HQ reads Formplayer's answer as JSON (response.json()), so the contract is the
report's content, carried as the text a response body holds. The plausible
failures: a runner that hands back something other than the report's text,
one that loses warnings or changes the report's keys, one that turns a parse
failure into an exception instead of a report, or one that decodes the bytes
as something other than UTF-8.
"""

from __future__ import annotations

import json

from lxml import etree

from proof.core.artifacts import BASIC_APP, XFORMS, XHTML, read_archive_entry

# A form HQ built (basic.ccz, "Constraints"): binds with constraints, relevance,
# selects and a meta block, as HQ's build hands forms to Formplayer.
FORM = "modules-1/forms-0.xml"


def hq_form() -> etree._ElementTree:
    return etree.ElementTree(etree.fromstring(read_archive_entry(BASIC_APP, FORM)))


def serialize(tree: etree._ElementTree) -> bytes:
    return etree.tostring(tree, xml_declaration=True, encoding="utf-8")


def passed_shape(report: dict) -> None:
    assert set(report) == {"validated", "problems"}
    assert report["validated"] is True
    for problem in report["problems"]:
        assert set(problem) - {"xml_location"} == {"type", "message", "fatal"}
        assert problem["fatal"] is False


def failed_shape(report: dict) -> None:
    assert set(report) == {"validated", "fatal_error", "fatal_error_expected", "problems"}
    assert report["validated"] is False
    assert isinstance(report["fatal_error"], str) and report["fatal_error"]
    assert report["fatal_error_expected"] is False


def test_an_hq_built_form_passes_with_formplayers_shape(core_runner):
    text = core_runner.validate_form(serialize(hq_form()))
    assert isinstance(text, str)
    report = json.loads(text)
    passed_shape(report)
    assert not [problem for problem in report["problems"] if problem["type"] == "markup"]


def test_unknown_markup_is_a_warning_not_a_failure(core_runner):
    tree = hq_form()
    body = tree.getroot().find(f"{{{XHTML}}}body")
    etree.SubElement(body, f"{{{XFORMS}}}proof-unknown")
    report = json.loads(core_runner.validate_form(serialize(tree)))
    passed_shape(report)
    assert [problem for problem in report["problems"] if problem["type"] == "markup"]


def test_an_invalid_expression_fails_the_form(core_runner):
    tree = hq_form()
    bind = next(b for b in tree.getroot().iter(f"{{{XFORMS}}}bind") if b.get("constraint"))
    bind.set("constraint", ". +")
    report = json.loads(core_runner.validate_form(serialize(tree)))
    failed_shape(report)


def test_bytes_that_are_not_xml_fail_the_form(core_runner):
    report = json.loads(core_runner.validate_form(serialize(hq_form())[:40]))
    failed_shape(report)
    report = json.loads(core_runner.validate_form(b"not a form"))
    failed_shape(report)


def test_the_body_is_read_as_utf8(core_runner):
    """Formplayer decodes the posted bytes as UTF-8 (Spring's default charset for a String body).

    An instance element named in Devanagari is a valid XML name when the bytes
    are read as UTF-8; read as Latin-1, its bytes become characters such as
    U+00A4 that no XML name may hold. The paired control sends the Latin-1
    reading itself and must fail.
    """
    tree = hq_form()
    data = tree.getroot().find(f"{{{XHTML}}}head/{{{XFORMS}}}model/{{{XFORMS}}}instance")[0]
    etree.SubElement(data, f"{{{data.nsmap[None]}}}जाँच")
    utf8 = serialize(tree)
    passed_shape(json.loads(core_runner.validate_form(utf8)))
    misread = utf8.decode("latin-1").encode("utf-8")
    failed_shape(json.loads(core_runner.validate_form(misread)))
