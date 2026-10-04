"""HQ's case search compiler turns the queries Core evaluates from Nova's searches into exactly the filters meant.

Contract: each search query Core's query manager builds from Nova's
navigation searches (``NavigationRuntimeTest``, both paths) compiles in HQ's
CSQL compiler (``case_search/filter_dsl.py::build_filter_from_xpath``) to the
complete filter the document means: date and datetime arithmetic resolved,
day ranges as UTC half-open bounds on the right property, unsupplied inputs
matching everything. Each query Core builds from Nova's nested CSQL
functions (``CsqlFunctionRuntimeTest``) compiles to its exact property
equality, and each argument tree HQ's parser reads from them has the
relation and case-type structure Nova emits. A property wrapped in a value
function, and a quantity left ungrouped after a comma (the pre-grouping
form), are refused. The plausible failures: a date, bound or relation HQ
compiles differently from what the document means, and a refusal HQ stops
making.
"""

from proof.native.hq_support import hq_commit, native_check, sha256, write_evidence

FAMILIES = ("navigation", "function")
DOMAIN = "nova-navigation-evidence"
FUNCTION_SCENARIOS = ["local-clinician", "local-other", "hq-clinician", "hq-other"]


def property_equality(key, value):
    return {
        "nested": {
            "path": "case_properties",
            "query": {
                "bool": {
                    "filter": [
                        {
                            "bool": {
                                "filter": [
                                    {"term": {"case_properties.key.exact": key}},
                                    {"term": {"case_properties.value.exact": value}},
                                ]
                            }
                        }
                    ],
                    "must": {"match_all": {}},
                }
            },
        }
    }


def property_bound(key, operator, value):
    return {
        "nested": {
            "path": "case_properties",
            "query": {
                "bool": {
                    "filter": [{"term": {"case_properties.key.exact": key}}],
                    "must": {"range": {"case_properties.value.date": {operator: value}}},
                }
            },
        }
    }


def _compile(state, query):
    import json

    from django.core.serializers.json import DjangoJSONEncoder

    from proof.hq.operations import compile_domain_filter

    return json.loads(json.dumps(compile_domain_filter(state, query), cls=DjangoJSONEncoder))


def _refused(state, query):
    from corehq.apps.case_search.exceptions import CaseFilterError

    from proof.hq.operations import compile_domain_filter

    try:
        compile_domain_filter(state, query)
    except CaseFilterError:
        return True
    return False


def _bounded_property(query):
    """The property a day-range query bounds: the left operand of its first comparison, read by HQ's parser."""
    from eulxml.xpath import ast
    from eulxml.xpath import parse as parse_xpath

    node = parse_xpath(query)
    while isinstance(node, ast.BinaryExpression):
        node = node.left
    assert isinstance(node, ast.Step), (query, node)
    return node.node_test.name


def _expected_navigation(scenario, supplied, query):
    if supplied == "false":
        return {"match_all": {}}
    if scenario == "date-add":
        return property_equality("visit_date", "2024-03-07")
    if scenario == "datetime-add":
        return property_equality("last_seen", "2024-02-29T01:00:00+00:00")
    assert scenario == "day-range"
    field = _bounded_property(query)
    start, end = "2024-02-29", "2024-03-01"
    if field != "visit_date":
        assert field in ("last_seen", "date_opened")
        start += "T00:00:00+00:00"
        end += "T00:00:00+00:00"
    bounds = [
        {"range": {"opened_on": {operator: value}}}
        if field == "date_opened"
        else property_bound(field, operator, value)
        for operator, value in [("gte", start), ("lt", end)]
    ]
    return {"bool": {"filter": bounds}}


def _expected_function(scenario, supplied):
    assert scenario in set(FUNCTION_SCENARIOS)
    values = [
        ("visit_date", "2024-02-28"),
        ("last_seen", "2024-02-28T10:30:00+00:00"),
        ("score", 19.5),
        ("visit_date", "2024-03-01"),
        ("score", 0.0 if scenario.endswith("-other") else 19.5),
    ]
    return property_equality(*values[int(supplied)])


def _check_queries(state, payloads, corpus):
    results = []
    for line in payloads.read_text().splitlines():
        scenario, supplied, query = line.split("\t", 2)
        result = _compile(state, query)
        if corpus == "function":
            expected = _expected_function(scenario, supplied)
        else:
            expected = _expected_navigation(scenario, supplied, query)
        # Complete compiled filters: AND composition, property scope, and
        # inclusive and exclusive bounds. No Elasticsearch request is made.
        assert result == expected, (scenario, query, result)
        results.append(
            {
                "scenario": scenario,
                "supplied": supplied if corpus == "function" else supplied == "true",
                "query": query,
                "filter": result,
            }
        )
    return results


def test_hq_compiles_cores_navigation_queries_to_the_meant_filters(native):
    payloads = native.core_artifact("navigation", "nova-search-payloads.tsv", "NavigationRuntimeTest")
    with native_check(DOMAIN, validate=native.validate_form) as (state, _):
        results = _check_queries(state, payloads, "navigation")
        assert len(results) == 10
        assert [row["scenario"] for row in results] == ["date-add"] * 2 + ["datetime-add"] * 2 + ["day-range"] * 6
        assert _refused(state, 'date(visit_date) = date("2024-02-29")'), (
            "Native CSQL accepted a function where a property is required"
        )
    write_evidence(
        native.family("navigation"),
        "search-payload",
        {
            "hqCommit": hq_commit(),
            "payloadsSha256": sha256(payloads.read_bytes()),
            "queries": results,
            "argumentTrees": [],
            "negativeControl": "Property wrapped in a value function is rejected",
            "limits": LIMITS,
        },
    )


def _argument_shape(node):
    from eulxml.xpath import ast

    if isinstance(node, ast.FunctionCall):
        return ["call", node.name, [_argument_shape(argument) for argument in node.args]]
    if isinstance(node, ast.BinaryExpression):
        return [node.op, _argument_shape(node.left), _argument_shape(node.right)]
    if isinstance(node, ast.Step):
        return ["path", ast.serialize(node)]
    assert isinstance(node, str | int | float), type(node)
    return node


def _call(name, *arguments):
    return ["call", name, list(arguments)]


def _typed(kind, inner):
    return ["and", ["=", ["path", "@case_type"], kind], inner]


PARENT = ["path", "parent"]
EXPECTED_ARGUMENTS = [
    _call("ancestor-exists", PARENT, _typed("family", _call("match-all"))),
    _call("not", _call("ancestor-exists", PARENT, _typed("family", _call("match-none")))),
    _call("subcase-exists", "parent", _typed("child", _call("match-all"))),
    [">", _call("subcase-count", "parent", _typed("child", _call("match-all"))), 1],
    _call(
        "ancestor-exists",
        PARENT,
        _typed("family", _call("ancestor-exists", PARENT, _typed("village", _call("match-all")))),
    ),
    _call("fuzzy-date", ["path", "visit_date"], _call("date", "2024-02-28")),
]
LIMITS = (
    "The exact Core-evaluated payloads pass native HQ CSQL compilation with independently specified values and "
    "complete filter shapes. Additional argument trees prove parsing and relation/type structure only, without "
    "running relation queries. This verifies query compilation, not an Elasticsearch result set or a remote request."
)


def test_hq_compiles_cores_function_queries_and_parses_their_arguments(native):
    payloads = native.core_artifact("function", "nova-function-payloads.tsv", "CsqlFunctionRuntimeTest")
    arguments = native.core_artifact("function", "nova-function-arguments.tsv", "CsqlFunctionRuntimeTest")
    with native_check(DOMAIN, validate=native.validate_form) as (state, _):
        from eulxml.xpath import parse as parse_xpath

        results = _check_queries(state, payloads, "function")
        assert [(row["scenario"], row["supplied"]) for row in results] == [
            (scenario, str(i)) for scenario in FUNCTION_SCENARIOS for i in range(5)
        ]
        assert _refused(state, 'date(visit_date) = date("2024-02-29")'), (
            "Native CSQL accepted a function where a property is required"
        )
        argument_results = []
        for line in arguments.read_text().splitlines():
            carrier, index, query = line.split("\t", 2)
            tree = _argument_shape(parse_xpath(query))
            assert tree == EXPECTED_ARGUMENTS[int(index)], (carrier, index, query, tree)
            argument_results.append({"carrier": carrier, "index": int(index), "query": query, "ast": tree})
        assert [(row["carrier"], row["index"]) for row in argument_results] == [
            (carrier, i) for carrier in ["local", "hq"] for i in range(6)
        ]
        old_quantity = 'visit_date = date-add(date("2024-02-28"), \'days\', double("2"))'
        assert _refused(state, old_quantity), "Native parser unexpectedly accepted the ungrouped quantity"
    write_evidence(
        native.family("function"),
        "search-payload",
        {
            "hqCommit": hq_commit(),
            "payloadsSha256": sha256(payloads.read_bytes()),
            "queries": results,
            "argumentTrees": argument_results,
            "negativeControl": "Property wrapped in a value function is rejected; "
            "ungrouped native quantity after a comma is rejected",
            "limits": LIMITS,
        },
    )
