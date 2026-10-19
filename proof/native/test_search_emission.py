"""HQ's entries and remote requests for Nova's search, prompt, CSQL, quote, link and composition corpora equal Nova's.

Contract: for every scenario of the seven corpora, every ``<entry>`` and
``<remote-request>`` HQ's suite contributors build equals Nova's, compared
whole (every attribute, leaf text and child, in order), with known XPath
carriers compared as HQ's parser's complete expression trees. An unprompted,
unfiltered search (``automatic``) sends the same ``match-all()`` ``_xpath_query`` on both
paths, so it is compared whole. The family's Core class then runs both paths
(``SearchRuntimeTest``, ``SearchPromptRuntimeTest``,
``CsqlFunctionRuntimeTest``, ``CsqlQuoteRuntimeTest``,
``StaticQuoteRuntimeTest``, ``FormLinkRuntimeTest``,
``CsqlCompositionRuntimeTest``). The plausible failures:
a query, prompt, claim or stack frame HQ builds differently, and a scenario
missing from a corpus.
"""

import pytest
from lxml import etree

from proof.native.hq_support import hq_commit, parse_xml_xpaths, sha256, shape, write_evidence

FAMILIES = ("search", "prompt", "function", "quote", "static-quote", "form-link", "csql")
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
    "csql": {"datetime-equality"},
}


def compare_entries(local, native, scenario, parsed):
    for tag in ["entry", "remote-request"]:
        assert [shape(e, parsed) for e in local.findall(tag)] == [shape(e, parsed) for e in native.findall(tag)], (
            scenario,
            tag,
        )


@pytest.mark.parametrize("family", sorted(CORPORA))
def test_hq_entries_and_remote_requests_equal_novas(native, family):
    result = native.step(family)
    assert set(result["sources"]) == CORPORA[family]
    suites = [
        (record, etree.fromstring(record["local"]), etree.fromstring(record["native"])) for record in result["records"]
    ]
    parsed = parse_xml_xpaths(
        *(
            element
            for _, local, hq in suites
            for root in (local, hq)
            for tag in ("entry", "remote-request")
            for element in root.findall(tag)
        )
    )
    scenarios = []
    for record, local, hq in suites:
        compare_entries(local, hq, record["scenario"], parsed)
        scenarios.append(
            {
                "scenario": record["scenario"],
                "sourceSha256": record["sourceSha256"],
                "suiteSha256": sha256(record["local"]),
                "nativeSuiteSha256": sha256(record["native"]),
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
            "child order, comparing known XPath carriers through HQ's parser. Build version and URL origin from the "
            "check's configuration; no resource install, full HQ build or network. Advanced Search on; every other "
            "flag off.",
        },
    )
