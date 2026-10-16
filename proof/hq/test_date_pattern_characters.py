"""A date column's pattern holding a straight apostrophe has no spelling in HQ's build.

HQ's build writes a date column's pattern between straight apostrophes as it
stands, unescaped (``detail_screen.py::Date``: ``format-date(date(<property>),
'<pattern>')``), so a pattern holding ``'`` ends the string literal early and
the template's expression is broken. Nova refuses such a pattern
(``CASE_LIST_DATE_PATTERN_APOSTROPHE``) and its cutover wrote the curved
apostrophe ``’`` in its place.

Contract, on ``case-list-inline`` as Nova's publish leaves it in HQ, with
every date column's stored ``date_format`` rewritten in a fork, as a person's
save would store it:

- with ``%d %b '%y``, HQ builds the app and Core refuses to admit the build,
  so the app does not install from HQ;
- with ``%d %b ’%y``, Core admits the build, and its sessions show each
  case's date in the list as ``<day> <short month> ’<two-digit year>``.

This is where the lane would see HQ start escaping the pattern: the refused
build would then be admitted. Plausible failures: a fork that rewrote no
column (the first build would admit), and a list that never shows the column
(the second would show no formatted date).
"""

from __future__ import annotations

import calendar
from datetime import date

from proof.checks import casedata
from proof.rules.conftest import edited, published, restore, run

DOCUMENT = "case-list-inline"
STRAIGHT = "%d %b '%y"
CURVED = "%d %b ’%y"
HEADER = "Born"
PROPERTY = "birthdate"


def _with_pattern(pattern):
    """The app's JSON with every date column of every detail holding ``pattern``."""

    def change(doc):
        rewritten = 0
        for module in doc["modules"]:
            for detail in (module.get("case_details") or {}).values():
                # A detail pair's values are its details and its own doc_type.
                if not isinstance(detail, dict):
                    continue
                for column in detail.get("columns") or []:
                    if column.get("format") == "date":
                        column["date_format"] = pattern
                        rewritten += 1
        assert rewritten, "the app holds no date column, so the fork rewrites nothing"

    return edited(change)


def _shown_dates(trace):
    """Each list row's date cell, by case id: the field under the date column's header, in every list the sessions
    showed."""
    shown = {}
    for each in trace["runs"]:
        for step in each["trace"]:
            headers = step.get("headers")
            if not headers or HEADER not in headers:
                continue
            at = headers.index(HEADER)
            for row in step.get("rows") or []:
                shown[row["caseId"]] = row["fields"][at]
    return shown


def test_a_straight_apostrophe_in_a_date_pattern_stops_the_build_installing_and_a_curved_one_shows(
    hq, core_runner, documents
):
    document = documents[DOCUMENT]
    database = casedata.case_database(document.document)
    with published(document, core_runner) as app:
        straight = app.spell(doc=_with_pattern(STRAIGHT)).build
        curved = app.spell(doc=_with_pattern(CURVED)).build
        restored = restore(app, database)
        for built in (straight, curved):
            assert built.files is not None and not built.raised, built.raised
        refused = run(app, core_runner, straight, restored, database)
        shown = run(app, core_runner, curved, restored, database)

    assert not refused.admission.get("admitted") and refused.trace is None, refused.admission
    assert shown.admission.get("admitted") and shown.trace is not None, shown.admission

    stored = {case.case_id: dict(case.properties).get(PROPERTY, "") for case in database.cases}
    cells = _shown_dates(shown.trace)
    checked = 0
    for case_id, cell in cells.items():
        value = stored.get(case_id, "")
        try:
            day = date.fromisoformat(value)
        except ValueError:
            continue
        assert cell == f"{day:%d} {calendar.month_abbr[day.month]} ’{day:%y}", (case_id, value, cell)
        checked += 1
    assert checked, f"the sessions showed no list row with a stored date under {HEADER}: {cells}"
