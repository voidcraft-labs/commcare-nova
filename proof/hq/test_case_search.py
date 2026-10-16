"""HQ's case search compiler, in the context HQ's search builds.

Contract: ``operations.compile_case_search`` compiles CSQL the way HQ's case
search does, so HQ's own refusals apply: related-case lookups need
``CASE_SEARCH_RELATED_LOOKUPS`` there (``filter_dsl.py::_require_related_lookups_flag``,
which checks only when the context's helper is a case search helper), and a
blank or numeric value compared with a date property is refused (defect 6).
The plausible failure: compiling with only a domain (``build_filter_from_xpath(domain=...)``),
whose helper is not a case search helper, so the flag refusal never happens.

Past the flag's gate a related lookup queries HQ's case search index while
it compiles (``xpath_functions/ancestor_functions.py::_get_case_ids_from_ast_filter``),
over the unit's own Elasticsearch (``proof.hq.elasticsearch``): that query
is the observation that the gate let the filter through.

HQ's query builder (``case_search/utils.py::CaseSearchQueryBuilder``) is
also what decides two things Nova writes for it: the zero-input
``_xpath_query`` of ``'match-all()'``, which both export paths send because
HQ builds no search for a menu with neither a property nor a default
property, adds one ``match_all`` filter and nothing else (finding 53); and a
request key HQ reads as part of the request never queries a case property
of its name, so Nova refuses a Search question that would send one
(``CASE_LIST_SEARCH_INPUT_NAME_RESERVED``, read from the generated
surface's ``csql-key`` family as Nova's set is).
"""

from __future__ import annotations

import pytest

from proof.checks.manifest_usage import load_manifest
from proof.hq import operations
from proof.hq.check import hq_check
from proof.hq.configuration import Configuration

RELATED = [
    "ancestor-exists(parent, name = 'x')",
    "parent/name = 'x'",
    "subcase-exists('parent', name = 'x')",
    "subcase-count('parent', name = 'x') > 1",
]


@pytest.mark.parametrize("xpath", RELATED)
def test_a_related_case_filter_needs_the_flag_in_a_case_search_context(hq, core_runner, xpath):
    from corehq.apps.case_search.exceptions import XPathFunctionException

    def lookups(record):
        return [read for read in record.elasticsearch_reads if read[1] == "_search"]

    configuration = Configuration()
    with hq_check(configuration) as (state, record):
        with pytest.raises(XPathFunctionException, match="You cannot query related cases here"):
            operations.compile_case_search(state, xpath, ["person"])
        assert not lookups(record)

        # The same filter with only a domain passes the gate and runs its lookup in HQ's case search index.
        operations.compile_domain_filter(state, xpath)
        assert lookups(record) and not record.elasticsearch_refusals

        # A related filter on the parent's id needs no lookup, and compiles.
        operations.compile_case_search(state, "parent/@case_id = 'abc'", ["person"])

    gate_reads = [r.verdict for r in record.flags if r.symbol == "CASE_SEARCH_RELATED_LOOKUPS"]
    assert gate_reads and not any(gate_reads)


@pytest.mark.parametrize("prop", ["date_opened", "closed_on", "last_modified"])
def test_a_blank_or_numeric_date_comparison_is_refused(hq, core_runner, prop):
    from corehq.apps.case_search.exceptions import CaseFilterError

    configuration = Configuration()
    with hq_check(configuration) as (state, _):
        operations.compile_case_search(state, f"{prop} = '2026-01-01'", ["person"])
        with pytest.raises(CaseFilterError, match="is not a correctly formatted date or datetime"):
            operations.compile_case_search(state, f"{prop} = ''", ["person"])
        with pytest.raises(CaseFilterError, match="Malformed search query"):
            operations.compile_case_search(state, f"{prop} < 5", ["person"])


def test_an_ordering_on_a_time_is_refused(hq, core_runner):
    from corehq.apps.case_search.exceptions import CaseFilterError

    configuration = Configuration()
    with hq_check(configuration) as (state, _):
        operations.compile_case_search(state, "visit_date < '2026-01-01'", ["person"])
        with pytest.raises(CaseFilterError, match="15:00 is not a correctly formatted date or datetime"):
            operations.compile_case_search(state, "visit_time < '15:00'", ["person"])


def test_each_string_a_sessions_search_sends_is_compiled_as_hq_compiles_a_search(hq, core_runner):
    """The intent check holds every CSQL string proof 3's sessions send to HQ's compiler
    (``sessions.search_compiles``): each search step's ``_xpath_query`` and each request's, once, with the case
    types the request names, a refusal named by its class and where HQ raised it, and a related lookup past its
    gate compiled, its own lookup run in the unit's index. The plausible failures: a string a request sent left
    out, the case types lost (a related lookup compiles against no type), or a harness failure recorded as HQ's
    refusal."""
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
    for flags, gate in ((frozenset(), "raised"), (frozenset({"CASE_SEARCH_RELATED_LOOKUPS"}), "compiled")):
        with hq_check(Configuration(flags=flags)) as (state, _):
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

    with hq_check(Configuration()) as (state, _):
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


def _built_queries(domain, default_properties):
    """The ``<query>`` elements of HQ's suite for one list-first case menu whose search holds no property."""
    from corehq.apps.app_manager.models import CaseSearch
    from corehq.apps.app_manager.tests.app_factory import AppFactory
    from corehq.apps.app_manager.tests.util import patch_get_xform_resource_overrides
    from corehq.apps.app_manager.util import module_offers_search
    from lxml import etree

    factory = AppFactory(domain=domain, build_version="2.54.0")
    module, form = factory.new_basic_module("patients", "patient")
    factory.form_requires_case(form, "patient")
    module.search_config = CaseSearch(default_properties=default_properties)
    with patch_get_xform_resource_overrides():
        suite = etree.fromstring(factory.app.create_suite())
    return bool(module_offers_search(module)), list(suite.iter("query"))


def _built_search(state, pairs):
    """HQ's case search for a request of ``pairs``, read as HQ's view reads Formplayer's post."""
    from corehq.apps.case_search.utils import CaseSearchQueryBuilder, _get_helper

    config = operations.search_request_config(state, "search-app", [("case_type", "patient"), *pairs])
    helper = _get_helper(None, state.domain, config.case_types, None)
    return CaseSearchQueryBuilder(helper, config.case_types).build_query(config.criteria)


def test_the_zero_input_filter_makes_hq_build_a_search_that_matches_every_case(hq, core_runner):
    """A search with no input and no filter sends ``_xpath_query`` ``'match-all()'`` on both export paths
    (``lib/commcare/suite/case-search/xpathQuery.ts::ZERO_INPUT_SEARCH_SENTINEL``). HQ builds no search for a
    menu with neither a search property nor a default property (``util.py::module_offers_search``), so the
    sentinel is what makes HQ's build hold the query; and HQ's query builder turns the request that carries it
    into the request without it plus one ``match_all`` filter, so a worker finds the same cases. The plausible
    failures: HQ building a search with no default property, so the sentinel would be needless, and the
    sentinel narrowing or widening what the search finds."""
    from corehq.apps.app_manager.models import DefaultCaseSearchProperty

    with hq_check(Configuration()) as (state, _):
        offered, queries = _built_queries(state.domain, [])
        assert not offered and queries == []
        sentinel = DefaultCaseSearchProperty(property="_xpath_query", defaultValue="'match-all()'")
        offered, queries = _built_queries(state.domain, [sentinel])
        assert offered and len(queries) == 1
        data = {element.get("key"): element.get("ref") for element in queries[0].iter("data")}
        assert data["_xpath_query"] == "'match-all()'"

        without = _built_search(state, []).filters
        matching_all = _built_search(state, [("_xpath_query", "match-all()")]).filters
    assert matching_all == [*without, {"match_all": {}}]


def _request_keys():
    """Every request key HQ reads as part of a search request, from the generated surface's ``csql-key``
    family: the exact keys but ``case_id`` and ``owner_id``, which HQ searches as the case's id and its owner,
    and one name under each prefix."""
    names = []
    for key in load_manifest().family("csql-key"):
        if key in ("case_id", "owner_id"):
            continue
        names.append(f"{key[:-1]}parent" if key.endswith(".*") else key)
    return names


def _queries_property(query, name):
    """Whether an Elasticsearch query names the case property ``name`` in a term on the property's key. HQ's
    query builders hold a clause's parts in a list or, from ``filters.AND`` and its kind, a tuple."""
    from corehq.apps.es.case_search import PROPERTY_KEY

    if isinstance(query, dict):
        term = query.get("term")
        if isinstance(term, dict) and term.get(PROPERTY_KEY) == name:
            return True
        return any(_queries_property(value, name) for value in query.values())
    if isinstance(query, (list, tuple)):
        return any(_queries_property(value, name) for value in query)
    return False


@pytest.mark.parametrize("name", _request_keys())
def test_a_request_key_hq_reads_never_searches_the_case_property_it_names(hq, core_runner, name):
    """Nova refuses a Search question that reaches HQ as its own request key under a name HQ reads as part of
    the request (``CASE_LIST_SEARCH_INPUT_NAME_RESERVED``), and refuses one named ``_xpath_query`` on every
    route (``CASE_LIST_SEARCH_INPUT_NAME_IS_DEFAULT_FILTER``). HQ takes such a key out of the request as a
    setting, ignores it, filters by owner or project space with it, compiles it as a query, or searches a
    case index with it (``case_search/models.py::extract_search_request_config``,
    ``case_search/utils.py::CaseSearchQueryBuilder._apply_filter``); in no case does it query a case property
    of that name, where ``first_name`` does. The names come from the surface's ``csql-key`` family, so a key
    HQ adds is run the week it appears. The plausible failure: a key HQ reads as a case property after all,
    which Nova would refuse for nothing."""
    from corehq.apps.case_search.exceptions import CaseFilterError

    def queried(state, key):
        return _queries_property(_built_search(state, [(key, "x")]).raw_query, key)

    with hq_check(Configuration()) as (state, _):
        assert queried(state, "first_name")
        if name == "_xpath_query":
            # Compiled as a query, and a plain value is no query.
            with pytest.raises(CaseFilterError, match="at least one boolean operator"):
                queried(state, name)
        else:
            assert not queried(state, name)
