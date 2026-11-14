"""HQ's menus, frames and endpoints for menus that show their forms above equal Nova's.

Contract: for each document of the ``menu-screens`` family but its two controls, every ``<menu>``, every
``<entry>/<stack>`` and every ``<endpoint>`` HQ's suite contributors build from Nova's HQ import body equal the
ones Nova's local suite writes, compared whole (every attribute, leaf text and child, in order), with known
XPath carriers compared as HQ's parser's complete expression trees. ``MenuScreensRuntimeTest`` then runs the
menus and frames on both suites in Core. The plausible failures: a menu id, a ``root`` attribute, a locale id,
a conjoined condition or a frame child Nova writes differently from HQ's build (``id_strings.py::menu_id``,
``menus.py::_generate_menu``, ``workflow.py::WorkflowHelper.get_frame_children``), and a document missing from
the corpus.
"""

from lxml import etree

from proof.native.hq_support import hq_commit, parse_xml_xpaths, sha256, shape, write_evidence

FAMILIES = ("menu-screens",)

DOCUMENTS = (
    "forms-in-menu-above",
    "forms-in-menu-above-nested",
    "forms-in-menu-above-one-case",
    "forms-in-menu-above-registration-only",
    "register-from-case-list",
    "register-from-case-list-web-apps",
)
CONTROLS = ("step-back-control", "two-registrations-control")
SELECTORS = ("menu", "entry/stack", "endpoint")


def test_hq_menus_frames_and_endpoints_equal_novas(native):
    records = native.step("menu-screens")
    assert sorted(record["scenario"] for record in records) == sorted(DOCUMENTS + CONTROLS)
    compared = [record for record in records if record["scenario"] in DOCUMENTS]
    suites = [(record, etree.fromstring(record["local"]), etree.fromstring(record["native"])) for record in compared]
    parsed = parse_xml_xpaths(
        *(
            element
            for _, local, hq in suites
            for root in (local, hq)
            for selector in SELECTORS
            for element in root.findall(selector)
        )
    )
    for record, local, native_suite in suites:
        for selector in SELECTORS:
            assert [shape(e, parsed) for e in local.findall(selector)] == [
                shape(e, parsed) for e in native_suite.findall(selector)
            ], (record["scenario"], selector)
        # Every document of the family is one HQ's build admits: no case list offers a form HQ refuses.
        assert record["caseListFormErrors"] == [], record["scenario"]
    write_evidence(
        native.family("menu-screens"),
        "menu-above-emission",
        {
            "results": [
                {"scenario": r["scenario"], "sourceSha256": r["sourceSha256"], "nativeSha256": sha256(r["native"])}
                for r in compared
            ],
            "hqCommit": hq_commit(),
            "limits": "Actual imported HQ model and suite contributors (details, entries, menus, endpoints and the "
            "workflow post-processor). Complete menu, post-entry stack and endpoint trees retain all "
            "text/attributes/children, comparing known XPath carriers through HQ's parser. Advanced search and "
            "session endpoints on. No whole HQ build or resource installation.",
        },
    )
