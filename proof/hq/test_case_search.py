"""HQ's case search compiler, in the context HQ's search builds.

Contract: ``operations.compile_case_search`` compiles CSQL the way HQ's case
search does, so HQ's own refusals apply: related-case lookups need
``CASE_SEARCH_RELATED_LOOKUPS`` there (``filter_dsl.py::_require_related_lookups_flag``,
which checks only when the context's helper is a case search helper), and a
blank or numeric value compared with a date property is refused (defect 6).
The plausible failure: compiling with only a domain (``build_filter_from_xpath(domain=...)``),
whose helper is not a case search helper, so the flag refusal never happens.

Past the flag's gate a related lookup queries Elasticsearch while it
compiles (``xpath_functions/ancestor_functions.py::_get_case_ids_from_ast_filter``),
which the harness refuses: that refusal is the observation that the gate let
the filter through.
"""

from __future__ import annotations

import pytest

from proof.hq import operations
from proof.hq.check import hq_check
from proof.hq.configuration import Configuration
from proof.hq.seams import SeamRefused

RELATED = [
    "ancestor-exists(parent, name = 'x')",
    "parent/name = 'x'",
    "subcase-exists('parent', name = 'x')",
    "subcase-count('parent', name = 'x') > 1",
]


@pytest.mark.parametrize("xpath", RELATED)
def test_a_related_case_filter_needs_the_flag_in_a_case_search_context(hq, core_runner, xpath):
    from corehq.apps.case_search.exceptions import XPathFunctionException

    configuration = Configuration()
    with hq_check(configuration, validate=core_runner.validate_form) as (state, record):
        with pytest.raises(XPathFunctionException, match="You cannot query related cases here"):
            operations.compile_case_search(state, xpath, ["person"])
        assert not record.elasticsearch_refusals

        # The same filter with only a domain passes the gate and reaches its lookup.
        with pytest.raises(SeamRefused, match="Elasticsearch"):
            operations.compile_domain_filter(state, xpath)
        assert record.elasticsearch_refusals

        # A related filter on the parent's id needs no lookup, and compiles.
        operations.compile_case_search(state, "parent/@case_id = 'abc'", ["person"])

    gate_reads = [r.verdict for r in record.flags if r.symbol == "CASE_SEARCH_RELATED_LOOKUPS"]
    assert gate_reads and not any(gate_reads)


@pytest.mark.parametrize("prop", ["date_opened", "closed_on", "last_modified"])
def test_a_blank_or_numeric_date_comparison_is_refused(hq, core_runner, prop):
    from corehq.apps.case_search.exceptions import CaseFilterError

    configuration = Configuration()
    with hq_check(configuration, validate=core_runner.validate_form) as (state, _):
        operations.compile_case_search(state, f"{prop} = '2026-01-01'", ["person"])
        with pytest.raises(CaseFilterError, match="is not a correctly formatted date or datetime"):
            operations.compile_case_search(state, f"{prop} = ''", ["person"])
        with pytest.raises(CaseFilterError, match="Malformed search query"):
            operations.compile_case_search(state, f"{prop} < 5", ["person"])


def test_an_ordering_on_a_time_is_refused(hq, core_runner):
    from corehq.apps.case_search.exceptions import CaseFilterError

    configuration = Configuration()
    with hq_check(configuration, validate=core_runner.validate_form) as (state, _):
        operations.compile_case_search(state, "visit_date < '2026-01-01'", ["person"])
        with pytest.raises(CaseFilterError, match="15:00 is not a correctly formatted date or datetime"):
            operations.compile_case_search(state, "visit_time < '15:00'", ["person"])


def test_each_string_a_sessions_search_sends_is_compiled_as_hq_compiles_a_search(hq, core_runner):
    """The intent check holds every CSQL string proof 3's sessions send to HQ's compiler
    (``sessions.search_compiles``): each search step's ``_xpath_query`` and each request's, once, with the case
    types the request names, a refusal named by its class and where HQ raised it, and a related lookup past its
    gate read as compiled. The plausible failures: a string a request sent left out, the case types lost (a
    related lookup compiles against no type), or a harness failure recorded as HQ's refusal."""
    from proof.observe import sessions

    related = "ancestor-exists(parent, name = 'x')"
    trace = {
        "runs": [
            {
                "trace": [
                    {"screen": "menu"},
                    {
                        "params": {"case_type": ["person"], "_xpath_query": ["visit_time < '15:00'", "name = 'x'"]},
                        "requests": [{"params": {"case_type": ["person"], "_xpath_query": [related, "name = 'x'"]}}],
                    },
                ]
            }
        ]
    }
    for flags, gate in ((frozenset(), "raised"), (frozenset({"CASE_SEARCH_RELATED_LOOKUPS"}), "readsIndex")):
        with hq_check(Configuration(flags=flags), validate=core_runner.validate_form) as (state, _):
            found = sessions.search_compiles(state, trace, state.operation)
        by_query = {compiled["query"]: compiled for compiled in found}
        assert sorted(by_query) == sorted([related, "name = 'x'", "visit_time < '15:00'"])
        assert by_query["name = 'x'"] == {"query": "name = 'x'", "caseTypes": ["person"], "compiled": True}
        assert by_query["visit_time < '15:00'"]["raised"]["class"] == "CaseFilterError"
        assert by_query["visit_time < '15:00'"]["raised"]["site"].startswith("apps/case_search/")
        assert gate in by_query[related]
        if gate == "raised":
            assert by_query[related]["raised"] == {
                "class": "XPathFunctionException",
                "site": "apps/case_search/filter_dsl.py::_require_related_lookups_flag",
                "message": "You cannot query related cases here",
            }
    assert sessions.search_compiles(None, {"runs": [{"trace": [{"screen": "menu"}]}]}, None) == []


def test_a_suites_literal_csql_is_what_its_search_sends_whatever_the_run_gives_it(core_runner):
    """A query's ``_xpath_query`` that Core parses as one string literal is sent as its value on every run, so
    the intent check compiles it even where no session searches; one that reads anything at run time, or chooses
    between strings, is left to what the sessions send. The plausible failure: compiling every string an
    expression could make, including branches no run takes (a quote guard's own refusal)."""
    from proof.observe import sessions

    suite = (
        b"<suite><remote-request><session><query url='https://x' storage-instance='results'>"
        b"<data key='case_type' ref=\"'person'\"/>"
        b"<data key='_xpath_query' ref='\"name = &apos;y&apos;\"'/>"
        b"<data key='_xpath_query' ref=\"if(1 = 1, 'a = 1', 'b = 2')\"/>"
        b"</query></session></remote-request></suite>"
    )
    assert sessions.literal_queries(core_runner, suite) == {("name = 'y'", ("person",))}


def test_a_search_request_is_read_as_hq_reads_formplayers_post(hq, core_runner):
    """Formplayer posts a search's parameters form-encoded, a name repeated
    for each of its values, and HQ's view reads every value as a list. The
    plausible failure: handing HQ's reader a flat dictionary, whose string
    values it keeps as a string (case types) or takes apart character by
    character (a sort)."""
    from corehq.apps.case_search.exceptions import CaseSearchUserError

    with hq_check(Configuration(), validate=core_runner.validate_form) as (state, _):
        config = operations.search_request_config(
            state,
            "search-app",
            [
                ("case_type", "person"),
                ("case_type", "household"),
                ("name", "x"),
                ("commcare_sort", "-name,dob:date"),
                ("x_commcare_tag_module_name", "Menu"),
            ],
        )
        with pytest.raises(CaseSearchUserError, match="Search request must specify case_types"):
            operations.search_request_config(state, "search-app", [("name", "x")])

    assert config.case_types == ["person", "household"]
    assert [(c.key, c.value) for c in config.criteria] == [("name", "x")]
    assert [(s.property_name, s.sort_type, s.is_descending) for s in config.commcare_sort] == [
        ("name", "exact", True),
        ("dob", "date", False),
    ]
