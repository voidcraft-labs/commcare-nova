"""The guard on the lane's two clocks where HQ's case search reads its own (``proof/observe/sessions.py``).

The runtimes read one fixed instant (``proof.core.client.DEFAULT_CLOCK``) and
HQ the commit instant of its pin (``proof.hq.determinism.EPOCH``), so a query
that has HQ read its clock can find other cases than a device at the same
instant would meet. Proofs 3 and 4 answer each search their Core sessions send
with HQ's own search view (``HqSearches``), and every answered query that has
HQ read its clock is asked again at the runtimes' instant
(``proof.hq.determinism.clock_at``), in a fork, with nothing the views keep of
it kept: the two answers must list the same cases, or the search is refused
(``ClocksApart``). HQ itself evaluates every shift of its clock (``date-add``
of ``today()`` by any quantity, a Search field's among them), so no window of
dates is computed here. The plausible failures: a clock call HQ's parser finds
that the guard misses (inside a query function, or under ``date-add``), a
quoted ``today()`` read as a call, a guard that judges a fixed span of dates
and so misses a shifted window (``due > date-add(today(), 'days', -30)`` over
a case due 2025-12-20, which HQ's two clocks read apart), the second answer
asked at HQ's own clock again so it can never differ, a second answer that
leaves a trace in the record (a request counted, a search kept, the unit not
put back), and a guard that refuses a search reading no clock or one HQ
refused.
"""

from __future__ import annotations

from contextlib import contextmanager

import pytest

from proof.hq import determinism
from proof.observe.sessions import ClocksApart, HqSearches, reads_hq_clock, runtime_instant


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


URL = "https://hq/a/proof/phone/search/app/"


class _Answered:
    def __init__(self, status, body):
        self.status, self.body = status, body


def _results(*case_ids):
    cases = "".join(f'<case case_id="{case_id}" case_type="patient"/>' for case_id in case_ids)
    return f'<results id="case">{cases}</results>'.encode()


class _Views:
    """HQ's views as ``HqSearches`` reaches them: each request counted and kept, and answered by ``answer`` of the
    instant HQ's clock is set to (``determinism._CLOCK_AT``, None for HQ's own)."""

    def __init__(self, answer, status=200):
        self.answer, self.status = answer, status
        self._ordinal = 0
        self.searches = []
        self.clocks = []

    @contextmanager
    def forgetting(self):
        kept = len(self.searches)
        try:
            yield self
        finally:
            del self.searches[kept:]

    def __call__(self, request):
        self._ordinal += 1
        self.searches.append(request)
        self.clocks.append(determinism._CLOCK_AT)
        return _Answered(self.status, self.answer(determinism._CLOCK_AT))


class _Unit:
    def __init__(self):
        self.forks = []

    @contextmanager
    def fork(self):
        self.forks.append("open")
        try:
            yield
        finally:
            self.forks[-1] = "put back"


def _searches(views):
    unit = _Unit()
    searches = HqSearches(unit=unit, database=None, label="A", operation=None, app_id="app")
    searches._views = views
    return searches, unit


def _shifted(clock):
    """HQ's answer to ``due > date-add(today(), 'days', -30)`` over a case due 2025-12-20: kept at the runtimes' day
    (2026-01-15, whose threshold is 2025-12-16), left out at HQ's own (whose threshold is in August 2026)."""
    return _results("patient-1") if clock == runtime_instant() else _results()


def test_a_search_whose_answer_moves_with_hqs_clock_is_refused_even_where_the_clock_is_shifted():
    views = _Views(_shifted)
    searches, unit = _searches(views)
    with pytest.raises(ClocksApart, match="finds patient-1 only at the runtimes'"):
        searches(URL, {"_xpath_query": ["due > date-add(today(), 'days', -30)"]})
    # Asked twice, the second time at the runtimes' instant, in a fork put back, and nothing of it kept.
    assert views.clocks == [None, runtime_instant()]
    assert unit.forks == ["put back"]
    assert len(views.searches) == 1 and views._ordinal == 1
    assert determinism._CLOCK_AT is None


def test_a_search_whose_answer_is_the_same_at_both_clocks_answers_and_leaves_no_trace():
    views = _Views(lambda clock: _results("patient-1", "patient-2"))
    searches, unit = _searches(views)
    answered = searches(URL, {"_xpath_query": ["due > date-add(today(), 'days', -30)"]})
    assert answered == (200, _results("patient-1", "patient-2"))
    assert views.clocks == [None, runtime_instant()] and unit.forks == ["put back"]
    assert len(views.searches) == 1 and views._ordinal == 1


def test_a_search_that_reads_no_clock_or_that_hq_refused_is_asked_once():
    for status, query in ((200, "last_visit = '2026-07-17'"), (400, "last_visit <= today()")):
        views = _Views(_shifted, status=status)
        searches, unit = _searches(views)
        assert searches(URL, {"_xpath_query": [query]})[0] == status
        assert views.clocks == [None] and unit.forks == []


def test_a_second_answer_that_is_no_list_of_cases_is_refused():
    views = _Views(lambda clock: _results("patient-1") if clock is None else b"<html>")
    searches, _ = _searches(views)
    with pytest.raises(ClocksApart, match="answers it otherwise"):
        searches(URL, {"_xpath_query": ["seen < now()"]})


def test_hqs_clock_is_set_for_the_operations_opened_inside_the_block_alone():
    instant = runtime_instant()
    assert determinism._CLOCK_AT is None
    with determinism.clock_at(instant):
        assert determinism._CLOCK_AT == instant
        with pytest.raises(RuntimeError, match="inside a block that set it"), determinism.clock_at(instant):
            pass
    assert determinism._CLOCK_AT is None
