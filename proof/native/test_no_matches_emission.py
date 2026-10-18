"""HQ's no-match registration action, its stack and the menus equal Nova's.

Contract: for each of the six no-matches scenarios, the case list's
``<detail>/<action>``, every ``<entry>/<stack>`` and every ``<menu>`` HQ's
suite contributors build equal Nova's, compared whole (every attribute, leaf
text and child, in order), with known XPath carriers compared as HQ's parser's
complete expression trees. ``NoMatchesRuntimeTest`` then runs the action and
stack on both paths in Core. The plausible failures: a registration action,
frame or menu HQ builds differently, and a scenario missing from the corpus.
"""

from lxml import etree

from proof.native.hq_support import hq_commit, parse_xml_xpaths, sha256, shape, write_evidence

FAMILIES = ("no-matches",)


def test_hq_registration_action_stack_and_menus_equal_novas(native):
    records = native.step("no-matches")
    suites = [(record, etree.fromstring(record["local"]), etree.fromstring(record["native"])) for record in records]
    selectors = ["detail/action", "entry/stack", "menu"]
    parsed = parse_xml_xpaths(
        *(
            element
            for _, local, hq in suites
            for root in (local, hq)
            for selector in selectors
            for element in root.findall(selector)
        )
    )
    for record, local, native_suite in suites:
        for selector in selectors:
            assert [shape(e, parsed) for e in local.findall(selector)] == [
                shape(e, parsed) for e in native_suite.findall(selector)
            ], (
                record["scenario"],
                selector,
            )
    assert len(records) == 6, len(records)
    write_evidence(
        native.family("no-matches"),
        "no-matches-emission",
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
            "limits": "Actual imported HQ model, native case/meta/Vellum XForm processing and suite contributors. "
            "Complete action, post-entry stack and menu trees retain all text/attributes/children, comparing known "
            "XPath carriers through HQ's parser. Default build "
            "2.53 and origin from the check's configuration; advanced search and follow-up case list forms on. No "
            "real search/claim HTTP, whole HQ build or resource installation.",
        },
    )
