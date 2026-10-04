"""HQ's no-match registration action, its stack and the menus equal Nova's.

Contract: for each of the six no-matches scenarios, the case list's
``<detail>/<action>``, every ``<entry>/<stack>`` and every ``<menu>`` HQ's
suite contributors build equal Nova's, compared whole (every attribute, leaf
text and child, in order). ``NoMatchesRuntimeTest`` then runs the action and
stack on both paths in Core. The plausible failures: a registration action,
frame or menu HQ builds differently, and a scenario missing from the corpus.
"""

from lxml import etree

from proof.native.hq_support import hq_commit, sha256, shape, write_evidence

FAMILIES = ("no-matches",)


def test_hq_registration_action_stack_and_menus_equal_novas(native):
    records = native.step("no-matches")
    for record in records:
        local = etree.fromstring(record["local"])
        native_suite = etree.fromstring(record["native"])
        for selector in ["detail/action", "entry/stack", "menu"]:
            assert [shape(e) for e in local.findall(selector)] == [shape(e) for e in native_suite.findall(selector)], (
                record["scenario"],
                selector,
            )
    assert len(records) == 6, len(records)
    write_evidence(
        native.family("no-matches"),
        "no-matches-emission",
        {
            "results": [
                {"scenario": r["scenario"], "sourceSha256": r["sourceSha256"], "nativeSha256": sha256(r["native"])}
                for r in records
            ],
            "hqCommit": hq_commit(),
            "limits": "Actual imported HQ model, native case/meta/Vellum XForm processing and suite contributors. "
            "Complete action, post-entry stack and menu trees retain all text/attributes/children. Default build "
            "2.53 and origin from the check's configuration; advanced search and follow-up case list forms on. No "
            "real search/claim HTTP, whole HQ build or resource installation.",
        },
    )
