"""HQ's own CSQL parser and filter builder agree with Nova's reading of each search filter text.

Contract: each CSQL text of the search row reader's vectors
(``lib/commcare/reader/expressions/__tests__/csqlVectors.ts``), which the
``csql`` producer writes with the reader's reading of it
(``readSearchFilterRow`` over the text as one ``_xpath_query`` value), is
parsed by HQ's ``eulxml`` parser and built by
``case_search/filter_dsl.py::build_filter_from_xpath`` in a project space
with advanced search and related lookups on. A text HQ builds is one the
reader holds, or claims under a manifest entry: never one it leaves
unrecognized, which would be Nova's own shortfall. A text HQ refuses is one
the reader refuses under a REFUSED entry, whose finding tells a person to
change the app in CommCare HQ. The plausible failures: the reader holding a
text HQ refuses (a function on the left, a property on the right, a value
HQ cannot order by, a function call HQ's lexer reads as a path), and the
reader refusing as broken a text HQ builds.
"""

import json

from proof.native.hq_support import hq_commit, native_check, sha256, write_evidence

FAMILIES = ("csql",)
DOMAIN = "nova-csql-reader-parity"
FLAGS = ("CASE_SEARCH_ADVANCED", "CASE_SEARCH_RELATED_LOOKUPS")


def test_hq_builds_exactly_the_csql_the_reader_does_not_refuse_as_hqs(native):
    exports = native.family("csql")
    source = exports / "csql-reader.jsonl"
    vectors = [json.loads(line) for line in source.read_text().splitlines() if line]
    assert vectors, "the producer wrote no reader vectors"
    results = []
    with native_check(DOMAIN, flags=FLAGS, case_search_enabled=True):
        from corehq.apps.case_search.exceptions import CaseFilterError
        from corehq.apps.case_search.filter_dsl import build_filter_from_xpath

        for vector in vectors:
            try:
                build_filter_from_xpath(vector["csql"], domain=DOMAIN)
                outcome = "built"
            except CaseFilterError as error:
                outcome = type(error).__name__
            verdict = vector["verdict"]
            results.append({"id": vector["id"], "hq": outcome, "reader": verdict})
            if outcome == "built":
                assert "unrecognized" not in verdict, (vector["id"], vector["csql"], verdict)
                assert verdict.get("disposition") != "REFUSED" or "held" in verdict, (
                    vector["id"],
                    vector["csql"],
                    "HQ builds a text the reader refuses as HQ's",
                    verdict,
                )
            else:
                assert verdict.get("disposition") == "REFUSED", (
                    vector["id"],
                    vector["csql"],
                    f"HQ refuses it ({outcome}) and the reader does not refuse it as HQ's",
                    verdict,
                )

    write_evidence(
        exports,
        "csql-reader-parity",
        {
            "hqCommit": hq_commit(),
            "payloadSha256": sha256(source.read_bytes()),
            "vectors": results,
        },
    )
