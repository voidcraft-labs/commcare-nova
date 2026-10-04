"""HQ's entries and remote requests for Nova's search, prompt, CSQL, quote and link corpora equal Nova's.

Contract: for every scenario of the six corpora, every ``<entry>`` and
``<remote-request>`` HQ's suite contributors build equals Nova's, compared
whole (every attribute, leaf text and child, in order), after exactly two
recorded differences are set aside and asserted present: HQ adds an explicit
``match-all()`` ``_xpath_query`` to an unprompted, unfiltered search
(``automatic``), and Nova declares the selected-cases instance on a
multi-select remote search even when no suite expression reads it
(``remote-multiple``). The family's Core class then runs both paths
(``SearchRuntimeTest``, ``SearchPromptRuntimeTest``,
``CsqlFunctionRuntimeTest``, ``CsqlQuoteRuntimeTest``,
``StaticQuoteRuntimeTest``, ``FormLinkRuntimeTest``). The plausible failures:
a query, prompt, claim or stack frame HQ builds differently, a recorded
difference that no longer appears (so it hides nothing and must go), and a
scenario missing from a corpus.
"""

import pytest
from lxml import etree

from proof.native.hq_support import hq_commit, sha256, shape, write_evidence

FAMILIES = ("search", "prompt", "function", "quote", "static-quote", "form-link")
CORPORA = {
    "search": {
        "inline",
        "browse",
        "multiple",
        "parent",
        "registration-link",
        "hidden-link",
        "automatic",
        "hidden",
        "advanced",
        "remote",
        "remote-multiple",
        "remote-defaults",
    },
    "prompt": {"prompt-widgets", "prompt-guards", "prompt-dataflow"},
    "function": {"nested-lookup", "function-arguments"},
    "quote": {"runtime-quotes"},
    "static-quote": {"static-quotes"},
    "form-link": {"else", "module", "home", "previous", "unconditional", "overlap", "manual"},
}


def compare_entries(local, native, scenario):
    differences = []
    if scenario == "automatic":
        extra = native.findall("entry/session/query/data[@key='_xpath_query']")
        assert len(extra) == 1 and dict(extra[0].attrib) == {"key": "_xpath_query", "ref": "'match-all()'"}
        assert not local.findall("entry/session/query/data[@key='_xpath_query']")
        extra[0].getparent().remove(extra[0])
        differences.append("HQ adds an explicit match-all query to unprompted unfiltered Search")
    if scenario == "remote-multiple":
        extra = local.findall("entry/instance[@id='selected_cases']")
        assert len(extra) == 1 and dict(extra[0].attrib) == {
            "id": "selected_cases",
            "src": "jr://instance/selected-entities/selected_cases",
        }
        assert not native.findall("entry/instance[@id='selected_cases']")
        extra[0].getparent().remove(extra[0])
        differences.append("Nova declares the ordinary collection instance even without a suite expression reading it")
    for tag in ["entry", "remote-request"]:
        assert [shape(e) for e in local.findall(tag)] == [shape(e) for e in native.findall(tag)], (scenario, tag)
    return differences


@pytest.mark.parametrize("family", sorted(CORPORA))
def test_hq_entries_and_remote_requests_equal_novas(native, family):
    result = native.step(family)
    assert set(result["sources"]) == CORPORA[family]
    scenarios = []
    for record in result["records"]:
        differences = compare_entries(
            etree.fromstring(record["local"]), etree.fromstring(record["native"]), record["scenario"]
        )
        scenarios.append(
            {
                "scenario": record["scenario"],
                "sourceSha256": record["sourceSha256"],
                "suiteSha256": sha256(record["local"]),
                "nativeSuiteSha256": sha256(record["native"]),
                "differences": differences,
            }
        )
    write_evidence(
        native.family(family),
        "search-emission",
        {
            "hqCommit": hq_commit(),
            "scenarios": scenarios,
            "limits": "Native HQ Application import and detail/entry/menu contributors, remote request/workflow/"
            "instance post-processing. Complete entry and remote-request trees compared, retaining leaf text and "
            "child order; only explicitly recorded structural differences. Build version and URL origin from the "
            "check's configuration; no resource install, full HQ build or network. Advanced Search on; every other "
            "flag off.",
        },
    )
