"""Compile the exact Core-evaluated Search payloads with native HQ CSQL."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
from unittest.mock import patch

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--hq-root", required=True, type=Path)
parser.add_argument("--payloads", required=True, type=Path)
parser.add_argument("--python-path", type=Path, help="Optional dependency overlay for the HQ environment")
parser.add_argument("--arguments", type=Path, help="Core argument payloads, required for functions corpus")
parser.add_argument("--corpus", choices=["navigation", "functions"], default="navigation")
args = parser.parse_args()
hq_root = args.hq_root.resolve()
sys.path.insert(0, str(hq_root))
if args.python_path:
    sys.path.append(str(args.python_path.resolve()))

def deny_network(*_args, **_kwargs):
    raise RuntimeError("Network disabled for native HQ evidence")

socket.socket.connect = deny_network
socket.socket.connect_ex = deny_network
os.environ["CCHQ_TESTING"] = "1"
os.environ["DJANGO_SETTINGS_MODULE"] = "testsettings"
from manage import init_hq_python_path
init_hq_python_path()
import django
django.setup()
from django.conf import settings
from django.test import override_settings
# HQ constructs Redis-backed limiter objects at import without connecting. Swap
# caches only after setup; then Form.source uses in-process storage exclusively.
override_settings(CACHES={name: {
    "BACKEND": "django.core.cache.backends.locmem.LocMemCache",
    "LOCATION": f"nova-case-evidence-{name}",
} for name in settings.CACHES}).enable()
from corehq.apps.case_search.filter_dsl import build_filter_from_xpath
from django.core.serializers.json import DjangoJSONEncoder
from corehq.apps.case_search.exceptions import CaseFilterError


def property_equality(key, value):
    return {"nested": {"path": "case_properties", "query": {"bool": {
        "filter": [{"bool": {"filter": [
            {"term": {"case_properties.key.exact": key}},
            {"term": {"case_properties.value.exact": value}},
        ]}}], "must": {"match_all": {}},
    }}}}


def property_bound(key, operator, value):
    return {"nested": {"path": "case_properties", "query": {"bool": {
        "filter": [{"term": {"case_properties.key.exact": key}}],
        "must": {"range": {"case_properties.value.date": {operator: value}}},
    }}}}


results = []
for line in args.payloads.read_text().splitlines():
    scenario, supplied, query = line.split("\t", 2)
    result = json.loads(json.dumps(build_filter_from_xpath(query, domain="nova-navigation-evidence"), cls=DjangoJSONEncoder))
    if args.corpus == "functions":
        assert scenario in {"local-clinician", "local-other", "hq-clinician", "hq-other"}
        values = [("visit_date", "2024-02-28"), ("last_seen", "2024-02-28T10:30:00+00:00"), ("score", 19.5), ("visit_date", "2024-03-01"), ("score", 0.0 if scenario.endswith("-other") else 19.5)]
        expected = property_equality(*values[int(supplied)])
    elif supplied == "false":
        expected = {"match_all": {}}
    elif scenario == "date-add":
        expected = property_equality("visit_date", "2024-03-07")
    elif scenario == "datetime-add":
        expected = property_equality("last_seen", "2024-02-29T01:00:00+00:00")
    else:
        assert scenario == "day-range"
        field = query.split(" ", 1)[0]
        start, end = "2024-02-29", "2024-03-01"
        if field != "visit_date":
            assert field in ("last_seen", "date_opened")
            start += "T00:00:00+00:00"
            end += "T00:00:00+00:00"
        bounds = [{"range": {"opened_on": {operator: value}}} if field == "date_opened"
                  else property_bound(field, operator, value)
                  for operator, value in [("gte", start), ("lt", end)]]
        expected = {"bool": {"filter": bounds}}
    # Compare complete compiled filters, including AND composition, property
    # scope and inclusive/exclusive bounds. No ES request is made.
    assert result == expected, (scenario, query, result)
    results.append({"scenario": scenario, "supplied": supplied if args.corpus == "functions" else supplied == "true", "query": query, "filter": result})
if args.corpus == "functions":
    assert [(row["scenario"], row["supplied"]) for row in results] == [(scenario, str(i)) for scenario in ["local-clinician", "local-other", "hq-clinician", "hq-other"] for i in range(5)]
else:
    assert len(results) == 10
    assert [row["scenario"] for row in results] == ["date-add"] * 2 + ["datetime-add"] * 2 + ["day-range"] * 6
try:
    build_filter_from_xpath('date(visit_date) = date("2024-02-29")', domain="nova-navigation-evidence")
except CaseFilterError:
    negative_control = "Property wrapped in a value function is rejected"
else:
    raise AssertionError("Native CSQL accepted a function where a property is required")
argument_results = []
if args.corpus == "functions":
    assert args.arguments is not None
    from eulxml.xpath import ast, parse as parse_xpath
    def shape(node):
        if isinstance(node, ast.FunctionCall):
            return ["call", node.name, [shape(arg) for arg in node.args]]
        if isinstance(node, ast.BinaryExpression):
            return [node.op, shape(node.left), shape(node.right)]
        if isinstance(node, ast.Step):
            return ["path", ast.serialize(node)]
        assert isinstance(node, (str, int, float)), type(node)
        return node
    def call(name, *args): return ["call", name, list(args)]
    def typed(kind, inner): return ["and", ["=", ["path", "@case_type"], kind], inner]
    parent = ["path", "parent"]
    expected_arguments = [
        call("ancestor-exists", parent, typed("family", call("match-all"))),
        call("not", call("ancestor-exists", parent, typed("family", call("match-none")))),
        call("subcase-exists", "parent", typed("child", call("match-all"))),
        [">", call("subcase-count", "parent", typed("child", call("match-all"))), 1],
        call("ancestor-exists", parent, typed("family", call("ancestor-exists", parent, typed("village", call("match-all"))))),
        call("fuzzy-date", ["path", "visit_date"], call("date", "2024-02-28")),
    ]
    for line in args.arguments.read_text().splitlines():
        carrier, index, query = line.split("\t", 2)
        tree = shape(parse_xpath(query))
        assert tree == expected_arguments[int(index)], (carrier, index, query, tree)
        argument_results.append({"carrier": carrier, "index": int(index), "query": query, "ast": tree})
    assert [(row["carrier"], row["index"]) for row in argument_results] == [(carrier, i) for carrier in ["local", "hq"] for i in range(6)]
    old_quantity = 'visit_date = date-add(date("2024-02-28"), \'days\', double("2"))'
    try:
        build_filter_from_xpath(old_quantity, domain="nova-navigation-evidence")
    except CaseFilterError:
        negative_control += "; ungrouped native quantity after a comma is rejected"
    else:
        raise AssertionError("Native parser unexpectedly accepted the ungrouped quantity")
print(json.dumps({
    "hqCommit": subprocess.check_output(["git", "-C", str(hq_root), "rev-parse", "HEAD"], text=True).strip(),
    "payloadsSha256": hashlib.sha256(args.payloads.read_bytes()).hexdigest(),
    "queries": results, "argumentTrees": argument_results, "negativeControl": negative_control,
    "limits": "The exact Core-evaluated payloads pass native HQ CSQL compilation with independently specified values and complete filter shapes. Additional argument trees prove parsing and relation/type structure only, without running relation queries. This verifies query compilation, not an Elasticsearch result set or a remote request.",
}, cls=DjangoJSONEncoder, indent=2))
