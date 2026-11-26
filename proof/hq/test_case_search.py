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
    return CaseSearchQueryBuilder(helper, config.case_types).build_query(config.criteria, commcare_sort=config.commcare_sort)


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


@pytest.mark.parametrize("increased,limit", [(False, 500), (True, 1500)])
def test_project_space_search_limit_and_literal_matchers(hq, increased, limit):
    """The cap and optional native matching come from the selected project space,
    with overrides scoped to the requested types and property. A literal period
    is removed as text; a rule on another type does not remove the letter B."""
    from corehq.apps.case_search.models import CaseSearchConfig
    from corehq.apps.es.case_search import case_property_query

    def includes(node, expected):
        if node == expected:
            return True
        children = node.values() if isinstance(node, dict) else node if isinstance(node, list) else []
        return any(includes(child, expected) for child in children)

    flags = frozenset(["INCREASED_MAX_SEARCH_RESULTS"]) if increased else frozenset()
    with hq_check(Configuration(case_search_enabled=True, flags=flags)) as (state, _):
        config = CaseSearchConfig.objects.get(domain=state.domain)
        config.fuzzy_properties.create(domain=state.domain, case_type="patient", properties=["badge_code"])
        config.ignore_patterns.create(domain=state.domain, case_type="patient", case_property="badge_code", regex=".")
        config.ignore_patterns.create(domain=state.domain, case_type="doctor", case_property="badge_code", regex="B")
        config.ignore_patterns.create(domain=state.domain, case_type="patient", case_property="other", regex="A")
        query = _built_search(state, [("badge_code", "A.B")]).raw_query
        assert query["size"] == limit
        assert includes(query["query"], case_property_query("badge_code", "AB", fuzzy=True))
        exact = _built_search(state, [("patient_number", "A.B")]).raw_query
        assert includes(exact["query"], case_property_query("patient_number", "A.B", fuzzy=False))


def test_literal_removal_preserves_all_requested_types_in_configuration_order(hq):
    from corehq.apps.case_search.models import CaseSearchConfig
    from corehq.apps.case_search.utils import CaseSearchQueryBuilder, _get_helper
    from corehq.apps.es.case_search import case_property_query

    with hq_check(Configuration(case_search_enabled=True)) as (state, _):
        config = CaseSearchConfig.objects.get(domain=state.domain)
        config.fuzzy_properties.create(domain=state.domain, case_type="doctor", properties=["badge"])
        for kind, text in [("patient", "ab"), ("doctor", "bc"), ("patient", "c")]:
            config.ignore_patterns.create(domain=state.domain, case_type=kind, case_property="badge", regex=text)

        def query(types, value):
            post = [*(("case_type", name) for name in types), ("badge", value)]
            request = operations.search_request_config(state, "search-app", post)
            helper = _get_helper(None, state.domain, request.case_types, None)
            builder = CaseSearchQueryBuilder(helper, request.case_types)
            assert request.case_types == types
            criterion, = request.criteria
            assert criterion.key == "badge"
            return builder._get_query(criterion)

        # These two results together distinguish A/B/A from both possible
        # per-type bucket orders. In the single-type control B is untouched.
        for value in ("abc", "bc"):
            assert query(["patient", "doctor"], value) == case_property_query("badge", "", fuzzy=True)
        assert query(["patient"], "bc") == case_property_query("badge", "b", fuzzy=False)


def test_search_expansion_below_the_result_cap_depends_on_hqs_index(hq):
    """All 150 near terms meet the edit distance. The native index admits only a
    subset, while its separate exact-token branch returns the exact record."""
    import hashlib
    import string

    from casexml.apps.case.mock import CaseBlock
    from corehq.apps.case_search.exceptions import CaseFilterError
    from corehq.apps.case_search.models import CaseSearchConfig, FuzzyProperties, IgnorePatterns
    from corehq.apps.es.case_search import RELEVANCE_SCORE, wrap_case_search_hit
    from corehq.apps.hqcase.utils import submit_case_blocks

    from proof.hq import redis as hq_redis

    needle = "xxaaaaaa"
    near_terms = sorted({
        needle[:position] + letter + needle[position + 1:]
        for position in range(2, len(needle))
        for letter in string.ascii_lowercase[1:]
    })
    assert len(near_terms) == 150
    near = {f"near-{index}": term for index, term in enumerate(near_terms)}
    # The terms on the field are shared by every key in nested case_properties.
    # Put the vocabulary on each shard, independently of the routing of case ids.
    vocabulary = " ".join([needle, *near_terms])
    values = {**near, "exact": "XXAAAAAA", "different-prefix": "zyaaaaaa"}

    with hq_check(Configuration(case_search_enabled=True)) as (state, _):
        with hq_redis.shared(None), state.committing():
            with state.operation("indexed near terms", hashlib.sha256(b"indexed near terms").digest()):
                blocks = [
                    CaseBlock(case_id=key, create=True, case_name=key, case_type="patient",
                              owner_id="worker", update={"alias": value, "lexicon": vocabulary,
                                                         RELEVANCE_SCORE: "stored"}).as_text()
                    for key, value in values.items()
                ]
                submit_case_blocks(blocks, state.domain, user_id="worker", device_id="proof")

        # The baseline matches the precise stored property including case.
        assert [hit["_id"] for hit in _built_search(state, [("alias", "XXAAAAAA")]).run().raw_hits] == ["exact"]
        assert not _built_search(state, [("alias", needle)]).run().raw_hits
        config = CaseSearchConfig.objects.get(domain=state.domain)
        config.fuzzy_properties.add(FuzzyProperties.objects.create(
            domain=state.domain, case_type="patient", properties=["alias"],
        ))
        config.ignore_patterns.add(IgnorePatterns.objects.create(
            domain=state.domain, case_type="patient", case_property="alias", regex=".*",
        ))
        # A literal is removed on the incoming query, not from each stored term.
        hits = _built_search(state, [("alias", "xx.*aaaaaa")]).run().raw_hits
        by_id = {hit["_id"]: hit for hit in hits}
        assert "exact" in by_id
        assert "different-prefix" not in by_id
        assert set() < near.keys() & by_id.keys() < near.keys()
        exact = by_id["exact"]
        assert wrap_case_search_hit(exact).case_json[RELEVANCE_SCORE] == "stored"
        assert wrap_case_search_hit(exact, include_score=True).case_json[RELEVANCE_SCORE] == exact["_score"]
        assert exact["_score"] > 0
        assert any(hit["_score"] != exact["_score"] for key, hit in by_id.items() if key in near)
        with pytest.raises(CaseFilterError, match="Fuzzy search is not supported with multiple values"):
            _built_search(state, [("alias", needle), ("alias", "another")])


def test_native_filters_distinguish_missing_cleared_and_current_values(hq):
    """An update clears a previously indexed parent on the real case receiver.
    The blank reverse-index criterion and the blank ordinary property in a
    multivalue request read different facts about exactly the same cases."""
    import hashlib

    from casexml.apps.case.mock import CaseBlock
    from corehq.apps.hqcase.utils import submit_case_blocks

    from proof.hq import redis as hq_redis

    configuration = Configuration(case_search_enabled=True, flags=frozenset({"CASE_SEARCH_RELATED_LOOKUPS"}))
    with hq_check(configuration) as (state, _):
        def write(operation, blocks):
            with hq_redis.shared(None), state.committing():
                with state.operation(operation, hashlib.sha256(operation.encode()).digest()):
                    submit_case_blocks([block.as_text() for block in blocks], state.domain,
                                       user_id="worker", device_id="proof")

        write("create parent and three children", [
            CaseBlock(case_id="house", create=True, case_type="household", case_name="Upper", owner_id="worker",
                      update={"district": "Upper"}),
            CaseBlock(case_id="linked", create=True, case_type="patient", case_name="Linked", owner_id="worker",
                      index={"parent": ("household", "house")}, update={"status": "waiting"}),
            CaseBlock(case_id="cleared", create=True, case_type="patient", case_name="Cleared", owner_id="worker",
                      index={"parent": ("household", "house")}, update={"status": "booked"}),
            CaseBlock(case_id="never", create=True, case_type="patient", case_name="Never", owner_id="other"),
        ])
        write("clear one real index", [CaseBlock(case_id="cleared", index={"parent": ("household", "")})])

        def matches(*pairs):
            return {hit["_id"] for hit in _built_search(state, pairs).run().raw_hits}

        everyone = {"linked", "cleared", "never"}
        assert matches(("indices.parent", "house")) == {"linked"}
        assert matches(("indices.parent", "")) == {"cleared"}
        assert matches(("indices.parent", "house"), ("indices.parent", "")) == everyone
        assert matches(("parent/district", "Upper")) == {"linked"}
        assert matches(("owner_id", "")) == everyone
        assert matches(("owner_id", "other")) == {"never"}
        assert matches(("commcare_project", state.domain)) == everyone
        assert not matches(("commcare_project", "another-space"))
        assert matches(("case_id", "never"), ("case_id", "linked")) == {"never", "linked"}
        assert matches(("status", "")) == {"never"}
        assert matches(("status", "booked"), ("status", "")) == {"cleared", "never"}
        assert matches(("name", "Linked")) == {"linked"}


def test_destination_day_and_native_range_read_the_index_at_a_dst_boundary(hq):
    """On the short New York day, HQ's equality includes a piece of the
    following local day. Strict greater-than starts after the following
    midnight. The raw date range reads the indexed property's UTC calendar."""
    import hashlib
    from datetime import datetime

    from casexml.apps.case.mock import CaseBlock
    from corehq.apps.hqcase.utils import submit_case_blocks
    from time_machine import travel

    from proof.hq import redis as hq_redis
    from proof.hq.state import domain_document

    configuration = Configuration(case_search_enabled=True)
    with hq_check(configuration) as (state, _):
        bounds = {
            "before": "2024-03-10T04:59:59",
            "start": "2024-03-10T05:00:00",
            "next-midnight": "2024-03-11T04:00:00",
            "overlap": "2024-03-11T04:30:00",
            "end": "2024-03-11T05:00:00",
        }
        with hq_redis.shared(None), state.committing():
            with state.operation("New York date searches", hashlib.sha256(b"New York date searches").digest()):
                state.couch.seed({**domain_document(configuration), "default_timezone": "America/New_York"})
                blocks = [
                    CaseBlock(case_id=key, create=True, case_type="patient", case_name=key, owner_id="worker",
                              date_opened=datetime.fromisoformat(value), update={"visit": value + "Z"}).as_text()
                    for key, value in bounds.items()
                ]
                submit_case_blocks(blocks, state.domain, user_id="worker", device_id="proof")

        def matches(key, value):
            return {hit["_id"] for hit in _built_search(state, [(key, value)]).run().raw_hits}

        equal = {"start", "next-midnight", "overlap"}
        assert matches("_xpath_query", "date_opened = '2024-03-10'") == equal
        assert matches("_xpath_query", "date_opened > '2024-03-10'") == {"overlap", "end"}
        assert matches("_xpath_query", "date_opened <= '2024-03-10'") == {"before", "start", "next-midnight"}
        with travel("2024-03-11T03:30:00Z", tick=False):
            assert matches("_xpath_query", "date_opened = today()") == equal
        assert matches("visit", "__range__2024-03-10__2024-03-10") == {"before", "start"}


def test_ordered_server_keys_choose_matches_after_excluding_named_owners(hq):
    """Run HQ's actual index and request parser. A string property can be
    sorted as text, a number or a date. The second datum breaks ties left by
    the first, and a single exclusion value can name two owners."""
    import hashlib

    from casexml.apps.case.mock import CaseBlock
    from corehq.apps.hqcase.utils import submit_case_blocks

    from proof.hq import redis as hq_redis

    cases = [
        ("none", "blue", "absent", "2024-06-12"),
        ("two-early", "blue", "2", "2024-01-03"),
        ("two-late", "blue", "2", "2024-09-03"),
        ("ten", "blue", "10", "2023-01-03"),
        ("excluded-a", "red", "1", "2024-01-01"),
        ("excluded-b", "gold", "3", "2024-01-02"),
    ]
    with hq_check(Configuration(case_search_enabled=True)) as (state, _):
        with hq_redis.shared(None), state.committing():
            with state.operation("sort and exclusion", hashlib.sha256(b"sort and exclusion").digest()):
                blocks = [CaseBlock(case_id=key, create=True, case_name=key, case_type="patient",
                                    owner_id=owner, update={"priority": value, "visit": date}).as_text()
                          for key, owner, value, date in cases]
                submit_case_blocks(blocks, state.domain, user_id="worker", device_id="proof")

        def ordered(*controls):
            query = _built_search(state, controls)
            return [hit["_id"] for hit in query.run().raw_hits]

        exclude = ("commcare_blacklisted_owner_ids", "red gold")
        first = ("commcare_sort", "+priority:numeric")
        second = ("commcare_sort", "-visit:date")
        assert ordered(first, second, exclude) == ["none", "two-late", "two-early", "ten"]
        assert ordered(second, first, exclude) == ["two-late", "none", "two-early", "ten"]
        assert ordered(("commcare_sort", "+priority:exact,-visit:date"), exclude) == [
            "ten", "two-late", "two-early", "none",
        ]
        assert set(ordered(first, second)) == {case[0] for case in cases}


def test_mixed_search_keeps_only_its_requested_paths_and_searchable_child_types(hq):
    """Run HQ's form-encoded request, search index and related-case reader against
    real submissions. A closed supporting parent supplies the sibling detail's
    terminal. A child can join the fixture independently of the tab's visibility."""
    import hashlib

    from casexml.apps.case.mock import CaseBlock
    from corehq.apps.app_manager.models import Application, CaseSearchProperty, DetailColumn, DetailTab, Module
    from corehq.apps.case_search.const import IS_RELATED_CASE
    from corehq.apps.case_search.utils import _get_helper, get_unconfigured_endpoint_results
    from corehq.apps.hqcase.utils import submit_case_blocks

    from proof.hq import redis as hq_redis

    with hq_check(Configuration(case_search_enabled=True)) as (state, _):
        with hq_redis.shared(None), state.committing(), state.operation("mixed search", hashlib.sha256(b"mixed search").digest()):
            app = Application.new_app(state.domain, "Outreach")
            for record_type, tab_type in [("household", "visit"), ("referral", "task"), ("patient", "ignored")]:
                menu = app.add_module(Module.new_module(record_type, "en"))
                menu.case_type = record_type
                if tab_type != "ignored":
                    menu.search_config.properties = [CaseSearchProperty(name="note", label={"en": "Note"})]
                menu.case_details.short.columns = [DetailColumn(header={"en": "Name"}, model="case", field="name", format="plain")]
                if record_type == "household":
                    menu.case_details.short.columns[0].field = "parent/parent/name"
                menu.case_details.long.columns = [DetailColumn(header={"en": "Name"}, model="case", field="name", format="plain")]
                menu.case_details.long.tabs = [DetailTab(starting_index=0, has_nodeset=True, nodeset_case_type=tab_type,
                                                        nodeset="instance('casedb')/casedb/case", relevant="false()")]
            app.save()
            blocks = []
            for case_id, kind, parent, target_type in [
                ("terminal", "region", None, None), ("middle", "group", "terminal", "region"),
                ("dynamic", "care", "middle", "group"), ("patient", "patient", None, None),
                ("home", "household", None, None), ("referral", "referral", None, None),
                ("visit", "visit", "dynamic", "care"), ("task", "task", "home", "household"),
                ("ignored", "ignored", "patient", "patient"),
            ]:
                blocks.append(CaseBlock(case_id=case_id, create=True, case_type=kind, case_name=case_id, owner_id="another-worker",
                                        index={"parent": (target_type, parent)} if parent else {},
                                        update={"care_record": "dynamic"} if case_id == "patient" else {}))
            blocks.extend([
                CaseBlock(case_id="extension-host", create=True, case_type="care", case_name="Extension host", owner_id="another-worker"),
                CaseBlock(case_id="extension-seed", create=True, case_type="care", case_name="Explicit extension", owner_id="another-worker",
                          index={"host": ("care", "extension-host", "extension")}),
                CaseBlock(case_id="extension-leaf", create=True, case_type="care", case_name="Nested extension", owner_id="another-worker",
                          index={"host": ("care", "extension-seed", "extension")}),
                CaseBlock(case_id="referral", update={"care_record": "extension-seed"}),
            ])
            blocks.extend(CaseBlock(case_id=case_id, close=True) for case_id in [
                "dynamic", "middle", "terminal", "visit", "task", "extension-seed",
            ])
            submit_case_blocks([block.as_text() for block in blocks], state.domain, user_id="worker", device_id="proof")

        def returned(*include):
            pairs = [("case_type", kind) for kind in ["patient", "household", "referral"]]
            pairs.append(("x_commcare_custom_related_case_property", "care_record"))
            pairs.extend(("x_commcare_include_all_related_cases", value) for value in include)
            request = operations.search_request_config(state, app._id, pairs)
            results = get_unconfigured_endpoint_results(_get_helper(None, state.domain, request.case_types, None), request, app._id)
            return {case.case_id: (case.case_json.get(IS_RELATED_CASE), case.closed) for case in results}

        details = returned()
        assert {case_id for case_id, (tag, _) in details.items() if not tag} == {"patient", "home", "referral"}
        assert {case_id for case_id, value in details.items() if value == ("true", True)} == {
            "dynamic", "extension-seed", "terminal", "task", "visit"
        }
        assert {"middle", "ignored", "extension-host", "extension-leaf"}.isdisjoint(details)
        assert returned("") == details
        # HQ tests truthiness after unwrapping only a singleton. It preserves
        # the separate choices of a dedicated setting and ordered defaults.
        for values in [("false",), ("", ""), ("true", "")]:
            hierarchy = returned(*values)
            assert hierarchy["ignored"][0] == "true"
            # The explicitly fetched record is a hierarchy root even though
            # it is closed. Its closed parent and grandparent are still tagged.
            assert hierarchy["dynamic"] == ("true", True)
            assert hierarchy["middle"] == ("true", True)
            assert hierarchy["terminal"] == ("true", True)
            assert hierarchy["extension-host"] == ("true", False)
            assert hierarchy["extension-seed"] == ("true", True)
            assert hierarchy["extension-leaf"] == ("true", False)
