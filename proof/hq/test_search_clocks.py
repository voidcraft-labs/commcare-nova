"""The guard on the lane's two clocks where HQ's case search reads its own (``proof/observe/sessions.py``).

The runtimes read one fixed instant (``proof.core.client.DEFAULT_CLOCK``) and
HQ the commit instant of its pin (``proof.hq.determinism.EPOCH``), so a case
date between the two days compares with ``today()`` one way on a device and the
other in HQ's search. Proofs 3 and 4 answer each search their Core sessions
send with HQ's own search view (``HqSearches``), and the first answered query
that has HQ read its clock refuses a case database holding such a date
(``ClocksApart``). The plausible failures: a clock call HQ's parser finds that
the guard misses (inside a query function, or under ``date-add``), a quoted
``today()`` read as a call, a date the guard reads past (a date and time, a
case's own stamp), and a guard that refuses a search reading no clock or one HQ
refused, where no case was compared with HQ's day.
"""

from __future__ import annotations

import datetime as dt

import pytest

from proof.observe.casedata import CaseDatabase, CaseRecord
from proof.observe.sessions import (
    ClocksApart,
    HqSearches,
    clock_days,
    dates_between,
    reads_hq_clock,
)


@pytest.mark.parametrize(
    "query",
    [
        "last_visit <= today()",
        "date-add(today(), 'days', -3) > dob",
        "seen < now()",
        "subcase-exists('parent', @status = 'open' and dob < today())",
    ],
)
def test_a_query_that_calls_hqs_clock_reads_it(query):
    assert reads_hq_clock(query)


@pytest.mark.parametrize("query", ["last_visit = '2026-07-17'", "name = 'today()'", "match-all()"])
def test_a_query_that_calls_no_clock_reads_none(query):
    assert not reads_hq_clock(query)


def _case(case_id, *, stamp="2025-12-01T08:00:00.000000Z", **properties):
    return CaseRecord(
        case_id=case_id,
        case_type="patient",
        name=case_id,
        owner_id="proof-worker-id",
        opened_on=stamp,
        modified_on=stamp,
        external_id=None,
        properties=tuple(properties.items()),
        indices=(),
    )


def _database(*cases):
    return CaseDatabase("proof-worker-id", "proof-worker", (), tuple(cases), None)


def _between():
    first, last = clock_days()
    return first + (last - first) // 2


def test_the_guarded_span_holds_both_clocks_days_and_a_day_beyond_each():
    from proof.core.client import DEFAULT_CLOCK
    from proof.hq.determinism import EPOCH

    days = sorted((dt.date.fromisoformat(DEFAULT_CLOCK[:10]), EPOCH.astimezone(dt.UTC).date()))
    assert clock_days() == (days[0] - dt.timedelta(days=1), days[1] + dt.timedelta(days=1))


def test_a_date_or_a_date_and_time_between_the_clocks_is_found_and_one_outside_is_not():
    inside = _between()
    database = _database(
        _case("patient-1", last_visit=inside.isoformat()),
        _case("patient-2", seen=f"{inside.isoformat()}T11:00:00.000Z"),
        _case("patient-3", last_visit="2001-02-03", note="proof text"),
        _case("patient-4", stamp=f"{inside.isoformat()}T08:00:00.000000Z"),
    )
    first, last = clock_days()
    found = dates_between(database, first, last)
    assert [(case_id, name) for case_id, name, _ in found] == [
        ("patient-1", "last_visit"),
        ("patient-2", "seen"),
        ("patient-4", "date_opened"),
        ("patient-4", "last_modified"),
    ]


class _Answered:
    def __init__(self, status):
        self.status, self.body = status, b"<results/>"


def _searches(database, status=200):
    searches = HqSearches(unit=None, database=database, label="A", operation=None, app_id="app")
    searches._views = lambda request: _Answered(status)
    return searches


def test_a_search_that_has_hq_read_its_clock_refuses_cases_dated_between_the_clocks():
    database = _database(_case("patient-1", last_visit=_between().isoformat()))
    with pytest.raises(ClocksApart, match="patient-1 last_visit"):
        _searches(database)("https://hq/a/proof/phone/search/app/", {"_xpath_query": ["last_visit <= today()"]})


def test_a_search_that_reads_no_clock_or_that_hq_refused_answers_whatever_the_cases_hold():
    database = _database(_case("patient-1", last_visit=_between().isoformat()))
    url = "https://hq/a/proof/phone/search/app/"
    assert _searches(database)(url, {"_xpath_query": ["last_visit = '2026-07-17'"]})[0] == 200
    assert _searches(database, status=400)(url, {"_xpath_query": ["last_visit <= today()"]})[0] == 400


def test_a_search_that_has_hq_read_its_clock_over_cases_dated_outside_answers():
    database = _database(_case("patient-1", last_visit="2001-02-03"), _case("patient-2", last_visit="2099-06-15"))
    answered = _searches(database)("https://hq/a/proof/phone/search/app/", {"_xpath_query": ["last_visit <= today()"]})
    assert answered == (200, b"<results/>")
