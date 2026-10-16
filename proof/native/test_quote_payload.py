"""HQ's case search compiler turns every quoted query Core builds into the exact filter meant, or refuses it.

Contract: Core's query manager evaluates Nova's six guarded queries for
twelve answer samples on both paths (``CsqlQuoteRuntimeTest``, 144 queries),
and HQ's CSQL compiler turns each one into the complete filter the sample
means (the literal value preserved through single quotes, double quotes,
injection attempts, newlines and non-ASCII text, with its negation and OR
structure), except where the value mixes both quote marks: there Core's
query is ``match-none()``, which no runtime byte reaches, and HQ compiles it
to the filter that matches no case. An unanswered or cleared input matches
everything, and an explicitly empty one matches an unset property. The
plausible failures: a quoting HQ reads as a different value or as query
syntax, and an unsafe query that matches more than nothing.
"""

import json

from proof.native.hq_support import hq_commit, native_check, sha256, write_evidence

FAMILIES = ("quote",)
DOMAIN = "nova-quote-evidence"
SAMPLES = [
    ("absent", None, None),
    ("empty", "", ""),
    ("plain", "Ada", "Jr"),
    ("single", "O'Connor", "Jr"),
    ("double", 'The "Boss"', "Jr"),
    ("injection-single", "x' or match-all() or 'y", "Jr"),
    ("injection-double", 'x" or match-all() or "y', "Jr"),
    ("multiline", "Line\nTwo\t雪", "Jr"),
    ("both", 'it\'s "quoted"', "Jr"),
    ("computed-both", "Ada'", 'Lovelace"'),
    ("unused-branch", "fallback", "unused'\""),
    ("cleared", None, None),
]


def equality(key, value):
    exact = {
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
    if value == "":
        unset = {
            "bool": {
                "must_not": {
                    "nested": {"path": "case_properties", "query": {"term": {"case_properties.key.exact": key}}}
                }
            }
        }
        return {"bool": {"should": [unset, exact]}}
    return exact


def negated(value):
    return {"bool": {"must_not": value}}


def either(left, right):
    return {"bool": {"should": [left, right]}}


def _expected(value, suffix):
    active = {"term": {"name.exact": "active"}}
    # Core represents an explicitly empty answer as a present input node.
    if value is None:
        return [{"match_all": {}}] * 4 + [either({"match_all": {}}, active), {"match_all": {}}]
    equal = equality("first_name", value)
    computed = "fixed" if value == "fallback" else value + " " + suffix
    return [
        equal,
        negated(equal),
        negated(equal),
        either(equal, active),
        either(negated(equal), active),
        equality("first_name", computed),
    ]


def test_hq_compiles_every_quoted_query_core_builds(native):
    payloads = native.core_artifact("quote", "nova-quote-payloads.jsonl", "CsqlQuoteRuntimeTest")
    records = [json.loads(line) for line in payloads.read_text().splitlines()]
    assert [(row["carrier"], row["sample"], row["input"], row["suffix"]) for row in records] == [
        (carrier, *sample) for carrier in ["local", "hq"] for sample in SAMPLES
    ]
    results = []
    with native_check(DOMAIN) as (state, _):
        from django.core.serializers.json import DjangoJSONEncoder

        from proof.hq.operations import compile_domain_filter

        for row in records:
            expected = _expected(row["input"], row["suffix"])
            assert len(row["queries"]) == 6
            nothing = []
            for i, query in enumerate(row["queries"]):
                actual = json.loads(json.dumps(compile_domain_filter(state, query), cls=DjangoJSONEncoder))
                unquotable = row["sample"] == "both" or (row["sample"] == "computed-both" and i == 5)
                if unquotable:
                    assert query == "match-none()", (row["sample"], i, query)
                    assert actual == {"match_none": {}}, (row["sample"], i, query, actual)
                    nothing.append(i)
                else:
                    assert actual == expected[i], (row["sample"], i, query, actual, expected[i])
            results.append(
                {
                    "carrier": row["carrier"],
                    "sample": row["sample"],
                    "queries": row["queries"],
                    "matchNoneQueryIndexes": nothing,
                }
            )
    write_evidence(
        native.family("quote"),
        "quote-payload",
        {
            "hqCommit": hq_commit(),
            "payloadsSha256": sha256(payloads.read_bytes()),
            "records": results,
            "limits": "All 144 Core-evaluated queries are compiled by native HQ, those for a value holding both quote "
            "marks to the filter that matches no case. Complete expected filters preserve supplied literal values and "
            "negation/OR structure. No Elasticsearch request or search results are claimed.",
        },
    )
