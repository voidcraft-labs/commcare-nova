"""Evaluate reports what Core computes for a form or a case list, with given session and case data.

An intent check asks Core a question whose answer is fixed by hand from what
a document authors (a constraint's verdict for an answer, a list's order), so
evaluate must report Core's own answer: constraint verdicts from
FormEntryController, expression values from Core's XPath engine over the
runtime's instances, and rows in the order Core's case list gives them.

An expression Core cannot evaluate is reported as the exception it raised,
with where Core constructed it (``FormRun.java::site``), which the trace
comparison names a failure by (``proof.checks.compare.trace.exception_cause``).

The plausible failures: verdicts that do not follow the form's constraint,
instances that are not the session's and the restore's, a clock the request
did not set (in a form or in a case list's text), a row order that does not
follow the case list's sort, and a site that merges two of Core's templates
or splits one. Where a test needs a known constraint or sort, it authors that
itself, so the expected answer follows from the test's own input rather than
from reading XPath out of a fixture.
"""

from __future__ import annotations

import base64
from collections.abc import Callable
from pathlib import Path

from lxml import etree

from proof.core.artifacts import (
    BASIC_APP,
    BASIC_RESTORE,
    archive_variant,
    core_site,
    form_xmlns,
    read_archive_entry,
)

CASE_XMLNS = "http://commcarehq.org/case/transaction/v2"
CONSTRAINTS_FORM = "modules-1/forms-0.xml"
# Core's Calendar.DAY_OF_WEEK (Sunday 1) for the two clocks the time tests set.
CLOCKS = {"2026-01-15T10:30:00.000Z": "5", "2030-06-01T08:05:00.000Z": "7"}


def restore64(restore: bytes = BASIC_RESTORE.read_bytes()) -> str:
    return base64.b64encode(restore).decode("ascii")


def number_form(constraint: str) -> bytes:
    """A form with one required integer question under the given constraint."""
    return (
        '<h:html xmlns="http://www.w3.org/2002/xforms" xmlns:h="http://www.w3.org/1999/xhtml"'
        ' xmlns:xsd="http://www.w3.org/2001/XMLSchema">'
        "<h:head><h:title>Numbers</h:title><model>"
        '<instance><data xmlns="http://example.org/numbers"><n/></data></instance>'
        f'<bind nodeset="/data/n" type="xsd:int" required="true()" constraint="{constraint}"/>'
        '</model></h:head><h:body><input ref="/data/n"><label>A number</label></input></h:body></h:html>'
    ).encode()


def test_constraint_verdicts_follow_the_forms_constraint(core_runner):
    """The same values under two constraints: each verdict follows the constraint the form holds."""
    values = ("25", "7", "9000", "")
    verdicts = {}
    for constraint in (". &gt; 20 and . &lt; 8000", ". &lt; 20"):
        result = core_runner.evaluate(
            restoreBase64=restore64(),
            formBase64=base64.b64encode(number_form(constraint)).decode(),
            constraintChecks=[{"path": "/data/n", "value": value} for value in values],
        )
        verdicts[constraint] = [check["result"] for check in result["constraints"]]
    assert verdicts == {
        ". &gt; 20 and . &lt; 8000": ["ok", "constraint", "constraint", "required"],
        ". &lt; 20": ["constraint", "ok", "constraint", "required"],
    }


# Expressions Core raises for, each with where Core's source constructs the exception: the file under its
# src/main/java, the method, and the text on that line alone. One template with two sets of values
# (XPathSelectedAtFunc.selectedAt), two templates of one exception class in one method (two of FunctionUtils.toDate's
# three), and two NumberFormatExceptions the Java platform constructs (Integer.parseInt), one for each line of Core's
# DateUtils.parseTimeAndStore that calls it on a time zone it cannot read.
FAILING = {
    "selected-at('a b', 5)": ("org/javarosa/xpath/expr/XPathSelectedAtFunc.java", "selectedAt", "select element"),
    "selected-at('a b c d', 9)": ("org/javarosa/xpath/expr/XPathSelectedAtFunc.java", "selectedAt", "select element"),
    "date('abc')": ("org/javarosa/xpath/expr/FunctionUtils.java", "toDate", '"converting string "'),
    "date(100000000000000000000)": ("org/javarosa/xpath/expr/FunctionUtils.java", "toDate", "out-of-range value"),
    "date('2020-01-01T10:00+ab')": (
        "org/javarosa/core/model/utils/DateUtils.java",
        "parseTimeAndStore",
        "Integer.parseInt(hours)",
    ),
    "date('2020-01-01T10:00+01:xy')": (
        "org/javarosa/core/model/utils/DateUtils.java",
        "parseTimeAndStore",
        "Integer.parseInt(tzPieces[1])",
    ),
}


def test_a_failure_is_recorded_where_core_constructed_it(core_runner):
    """Each failure names the line of Core's that constructed it, whatever values its message carries: one template
    is one site, two templates in one method are two, and an exception the Java platform constructs is named by the
    line of Core's that called the platform, so two such lines are two sites. The same request twice records the
    same."""
    request = {
        "restoreBase64": restore64(),
        "formBase64": base64.b64encode(number_form("true()")).decode(),
        "expressions": list(FAILING),
    }
    first, second = (core_runner.evaluate(**request)["values"] for _ in range(2))
    assert first == second
    sites = {value["expression"]: value["error"]["site"] for value in first}
    assert sites == {expression: core_site(*where) for expression, where in FAILING.items()}
    assert len(set(sites.values())) == 5


def test_expressions_read_the_sessions_and_the_restores_data(core_runner, basic_app):
    restore = etree.fromstring(BASIC_RESTORE.read_bytes())
    case = next(
        block
        for block in restore.iter(f"{{{CASE_XMLNS}}}case")
        if block.find(f"{{{CASE_XMLNS}}}create/{{{CASE_XMLNS}}}case_type").text == "coverage_basic"
    )
    name = case.find(f"{{{CASE_XMLNS}}}create/{{{CASE_XMLNS}}}case_name").text
    form = read_archive_entry(BASIC_APP, "modules-2/forms-1.xml")
    result = core_runner.evaluate(
        app=basic_app,
        xmlns=form_xmlns(form),
        restoreBase64=restore64(),
        session={"command": "m2-f1", "data": {"case_id": case.get("case_id")}},
        expressions=[
            "instance('commcaresession')/session/data/case_id",
            "instance('casedb')/casedb/case[@case_id = instance('commcaresession')/session/data/case_id]/case_name",
            "count(instance('casedb')/casedb/case)",
        ],
        instances=["commcaresession"],
    )
    values = [value["value"] for value in result["values"]]
    assert values == [case.get("case_id"), name, str(len(list(restore.iter(f"{{{CASE_XMLNS}}}case"))))]
    session = etree.fromstring(result["instance"]["commcaresession"].encode())
    assert session.findtext("data/case_id") == case.get("case_id")


def test_values_are_cores_comparisons(core_runner, basic_app):
    """Core compares by number, so two times as text are not ordered (defect 6's Core symptom), while 2 < 10."""
    form = read_archive_entry(BASIC_APP, CONSTRAINTS_FORM)
    result = core_runner.evaluate(
        app=basic_app,
        xmlns=form_xmlns(form),
        restoreBase64=restore64(),
        expressions=["'14:30' < '15:00'", "'2' < '10'", "2 < 10"],
    )
    assert [(value["type"], value["value"]) for value in result["values"]] == [
        ("boolean", "false"),
        ("boolean", "true"),
        ("boolean", "true"),
    ]


def test_now_and_today_read_the_requests_clock(core_runner, basic_app):
    """The clock's own spellings are marked, and the marks name the clock each request set."""
    form = read_archive_entry(BASIC_APP, CONSTRAINTS_FORM)
    readings = []
    for clock in CLOCKS:
        result = core_runner.evaluate(
            app=basic_app,
            xmlns=form_xmlns(form),
            restoreBase64=restore64(),
            clock=clock,
            expressions=["format-date(now(), '%H:%M')", "format-date(today(), '%d/%m/%Y')", "today()"],
        )
        readings.append(([value["value"] for value in result["values"]], result["generated"]["clock"]))
    assert readings == [
        (
            ["10:30", "15/01/2026", "@clock:today"],
            {"@clock:now": "2026-01-15T10:30:00.000Z", "@clock:today": "2026-01-15"},
        ),
        (
            ["08:05", "01/06/2030", "@clock:today"],
            {"@clock:now": "2030-06-01T08:05:00.000Z", "@clock:today": "2030-06-01"},
        ),
    ]


def with_cases_named(names: list[str]) -> bytes:
    restore = etree.fromstring(BASIC_RESTORE.read_bytes())
    for index, name in enumerate(names):
        block = etree.SubElement(
            restore,
            f"{{{CASE_XMLNS}}}case",
            case_id=f"ordered-{index}",
            date_modified="2017-07-14T14:26:20.559000Z",
            user_id="7afceb0259b2866be17b3632392f8a4b",
        )
        create = etree.SubElement(block, f"{{{CASE_XMLNS}}}create")
        etree.SubElement(create, f"{{{CASE_XMLNS}}}case_type").text = "coverage_basic"
        etree.SubElement(create, f"{{{CASE_XMLNS}}}case_name").text = name
        etree.SubElement(create, f"{{{CASE_XMLNS}}}owner_id").text = "7afceb0259b2866be17b3632392f8a4b"
    return etree.tostring(restore)


def m2_list_variant(target: Path, edit: Callable[[list[etree._Element]], None]) -> Path:
    """basic.ccz with the fields of module m2's case list (its short detail) edited."""
    suite = etree.fromstring(read_archive_entry(BASIC_APP, "suite.xml"))
    detail = next(d for d in suite.iter("detail") if d.get("id") == "m2_case_short")
    edit(detail.findall("field"))
    return archive_variant(BASIC_APP, target, {"suite.xml": etree.tostring(suite)})


def m2_list(core_runner, archive: Path, restore: str, **request) -> dict:
    report = core_runner.admit(archive)
    assert report["admitted"], report["problems"]
    try:
        return core_runner.evaluate(
            app=report["app"], restoreBase64=restore, session={"command": "m2-f1"}, caseList={}, **request
        )["caseList"]
    finally:
        core_runner.release(report["app"])


def test_case_list_rows_come_in_the_order_the_lists_sort_gives(core_runner, tmp_path):
    """Case names sorted as strings put "10" before "2"; sorted as integers, "2" comes first."""

    def sorted_by_name(kind: str) -> Callable[[list[etree._Element]], None]:
        def edit(fields: list[etree._Element]) -> None:
            fields[0].find("template/text/xpath").set("function", "case_name")
            sort = fields[0].find("sort")
            sort.attrib.update({"type": kind, "order": "1", "direction": "ascending"})
            sort.find("text/xpath").set("function", "case_name")

        return edit

    restore = restore64(with_cases_named(["2", "10"]))
    orders = {}
    for kind in ("string", "int"):
        rows = m2_list(core_runner, m2_list_variant(tmp_path / f"{kind}-sort.ccz", sorted_by_name(kind)), restore)
        orders[kind] = [row["fields"][0] for row in rows["rows"] if row["fields"][0] in {"2", "10"}]
    assert orders == {"string": ["10", "2"], "int": ["2", "10"]}


def test_a_case_lists_text_reads_the_requests_clock(core_runner, tmp_path):
    """dow() in a case list's XPath text (Core's Text) reads the request's clock, not the wall clock."""

    def day_of_week(fields: list[etree._Element]) -> None:
        fields[-1].find("template/text/xpath").set("function", "dow()")

    variant = m2_list_variant(tmp_path / "dow.ccz", day_of_week)
    days = {}
    for clock in CLOCKS:
        rows = m2_list(core_runner, variant, restore64(), clock=clock)["rows"]
        assert rows
        days[clock] = {row["fields"][-1] for row in rows}
    assert days == {clock: {day} for clock, day in CLOCKS.items()}


def test_a_case_list_search_matches_as_cores_list_does(core_runner, basic_app):
    restore = restore64(with_cases_named(["zebra crossing", "alpha"]))
    everything = core_runner.evaluate(app=basic_app, restoreBase64=restore, session={"command": "m2-f1"}, caseList={})[
        "caseList"
    ]
    searched = core_runner.evaluate(
        app=basic_app, restoreBase64=restore, session={"command": "m2-f1"}, caseList={"searchText": "zebra"}
    )["caseList"]
    assert len(everything["rows"]) > 1
    assert [row["fields"][0] for row in searched["rows"]] == ["zebra crossing"]
