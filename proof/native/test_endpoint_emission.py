"""HQ's session endpoints and the claim requests they reach equal Nova's.

Contract: for each of the seven endpoint scenarios, the ``<endpoint>``
elements HQ's endpoint contributor builds (``SESSION_ENDPOINTS`` on) equal
Nova's, compared whole (every attribute, leaf text and child, in order), with
known XPath carriers compared as HQ's parser's complete expression trees, and
so do the ``<remote-request>`` elements those endpoints' stacks reach. HQ
also builds a claim request for inline search that no endpoint reaches (its
endpoint reads the case fixture), so unreached requests are not compared.
``EndpointRuntimeTest`` then binds both paths' endpoint arguments in Core.
The plausible failures: an argument, stack or claim HQ spells differently,
and a scenario missing from the corpus.
"""

from lxml import etree

from proof.native.hq_support import hq_commit, parse_xml_xpaths, sha256, shape, write_evidence

FAMILIES = ("endpoint",)


def _reachable_requests(root, commands):
    return [e for e in root.findall("remote-request") if e.find("command").get("id") in commands]


def test_hq_endpoints_and_reached_claims_equal_novas(native):
    records = native.step("endpoint")
    for record in records:
        local = etree.fromstring(record["local"])
        native_suite = etree.fromstring(record["native"])
        scenario = record["scenario"]
        commands = {e.get("value")[1:-1] for e in local.findall("endpoint/stack/push/command")}
        local_requests = _reachable_requests(local, commands)
        native_requests = _reachable_requests(native_suite, commands)
        parsed = parse_xml_xpaths(
            *local.findall("endpoint"), *native_suite.findall("endpoint"), *local_requests, *native_requests
        )
        assert [shape(e, parsed) for e in local.findall("endpoint")] == [
            shape(e, parsed) for e in native_suite.findall("endpoint")
        ], (
            scenario,
            "endpoint",
        )
        assert [shape(e, parsed) for e in local_requests] == [shape(e, parsed) for e in native_requests], (
            scenario,
            "reachable remote-request",
        )
    assert len(records) == 7, len(records)
    write_evidence(
        native.family("endpoint"),
        "endpoint-emission",
        {
            "results": [
                {
                    "scenario": r["scenario"],
                    "sourceSha256": r["sourceSha256"],
                    "nativeSha256": sha256(r["native"]),
                }
                for r in records
            ],
            "hqCommit": hq_commit(),
            "limits": "Actual imported HQ model and endpoint/claim contributors; complete endpoint and reachable "
            "remote-request trees compared retaining all text/attributes/children, comparing known XPath carriers "
            "through HQ's parser. Default build 2.53 and origin "
            "from the check's configuration; every flag off but session endpoints and advanced search. No real "
            "claim HTTP request, whole HQ build or resource installation.",
        },
    )
