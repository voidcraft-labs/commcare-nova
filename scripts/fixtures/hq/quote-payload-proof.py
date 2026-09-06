"""Consume real Core query values with native HQ CSQL, without a server request."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import socket
import subprocess
import sys

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--hq-root", required=True, type=Path)
parser.add_argument("--payloads", required=True, type=Path)
parser.add_argument("--python-path", type=Path)
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
override_settings(CACHES={name: {
    "BACKEND": "django.core.cache.backends.locmem.LocMemCache",
    "LOCATION": f"nova-quote-evidence-{name}",
} for name in settings.CACHES}).enable()
from corehq.apps.case_search.filter_dsl import build_filter_from_xpath
from corehq.apps.case_search.exceptions import CaseFilterError
from django.core.serializers.json import DjangoJSONEncoder


def equality(key, value):
    exact = {"nested": {"path": "case_properties", "query": {"bool": {
        "filter": [{"bool": {"filter": [
            {"term": {"case_properties.key.exact": key}},
            {"term": {"case_properties.value.exact": value}},
        ]}}], "must": {"match_all": {}},
    }}}}
    if value == "":
        unset = {"bool": {"must_not": {"nested": {"path": "case_properties", "query": {"term": {"case_properties.key.exact": key}}}}}}
        return {"bool": {"should": [unset, exact]}}
    return exact


def negated(value): return {"bool": {"must_not": value}}
def either(left, right): return {"bool": {"should": [left, right]}}

samples = [
    ("absent", None, None), ("empty", "", ""), ("plain", "Ada", "Jr"),
    ("single", "O'Connor", "Jr"), ("double", 'The "Boss"', "Jr"),
    ("injection-single", "x' or match-all() or 'y", "Jr"),
    ("injection-double", 'x" or match-all() or "y', "Jr"),
    ("multiline", "Line\nTwo\t雪", "Jr"), ("both", 'it\'s "quoted"', "Jr"),
    ("computed-both", "Ada'", 'Lovelace"'),
    ("unused-branch", "fallback", 'unused\'"'), ("cleared", None, None),
]
records = [json.loads(line) for line in args.payloads.read_text().splitlines()]
assert [(row["carrier"], row["sample"], row["input"], row["suffix"]) for row in records] == [
    (carrier, *sample) for carrier in ["local", "hq"] for sample in samples
]
results = []
for row in records:
    value, suffix = row["input"], row["suffix"]
    active = {"term": {"name.exact": "active"}}
    # Core represents an explicitly empty answer as a present input node.
    if value is None:
        expected = [{"match_all": {}}] * 4 + [either({"match_all": {}}, active), {"match_all": {}}]
    else:
        equal = equality("first_name", value)
        computed = "fixed" if value == "fallback" else value + " " + suffix
        expected = [equal, negated(equal), negated(equal), either(equal, active), either(negated(equal), active), equality("first_name", computed)]
    assert len(row["queries"]) == 6
    refused = []
    for i, query in enumerate(row["queries"]):
        invalid = row["sample"] == "both" or (row["sample"] == "computed-both" and i == 5)
        if invalid:
            assert query == "search-value-mixes-quote-marks()", (row["sample"], i, query)
            try:
                build_filter_from_xpath(query, domain="nova-quote-evidence")
            except CaseFilterError:
                refused.append(i)
            else:
                raise AssertionError("Unsafe complete query was accepted")
        else:
            actual = json.loads(json.dumps(build_filter_from_xpath(query, domain="nova-quote-evidence"), cls=DjangoJSONEncoder))
            assert actual == expected[i], (row["sample"], i, query, actual, expected[i])
    results.append({"carrier": row["carrier"], "sample": row["sample"], "queries": row["queries"], "rejectedQueryIndexes": refused})
print(json.dumps({
    "hqCommit": subprocess.check_output(["git", "-C", str(hq_root), "rev-parse", "HEAD"], text=True).strip(),
    "payloadsSha256": hashlib.sha256(args.payloads.read_bytes()).hexdigest(),
    "records": results,
    "limits": "All 144 Core-evaluated queries are compiled or refused by native HQ. Complete expected filters preserve supplied literal values and negation/OR structure. No Elasticsearch request or search results are claimed.",
}, indent=2))
