"""HQ regenerates every navigation form, allocating the registration datum Nova's suite names, and builds every
after-submit frame's condition byte for byte as Nova's suite writes it.

Contract: HQ imports each navigation scenario and regenerates every form of
its first module with its own case and meta lowering; for the base
scenario's registration form it allocates exactly one new-case datum,
``case_id_new_patient_0``, computed as ``uuid()``, the id Nova's suite
passes. ``NavigationRuntimeTest`` then checks ordinary case writes and
navigation values in Core and writes the search queries HQ's compiler reads
next (``test_search_payload.py``). The plausible failures: a datum HQ names
or computes differently, and a scenario missing from the corpus.

Contract, after submit: for every scenario of the form link corpus
(``lib/commcare/__tests__/formLinkWireFixture.ts``), each ``<create>`` HQ's
workflow builds from the uploaded ``form_links[].xpath`` and
``post_form_workflow_fallback``
(``suite_xml/post_process/workflow.py::EndOfFormNavigationWorkflow``: one frame
per link in link order, then the fallback frame guarded by the negation of
every non-blank ``xpath``) carries the same ``if`` bytes as the ``<create>`` at
the same place in Nova's local suite, and no frame either side lacks. Core
runs both suites over each scenario (``FormLinkRuntimeTest``), so the two
paths run the same destinations only while their conditions are the same
text, which a parse-tree comparison (``test_search_emission.py``) does not
hold: a reversed order or a negation HQ joins with other spacing would pass
there and fail here. The plausible failures: the emission's reversal lost on
one path, a held-case conjunct HQ's frame lacks, and a fallback guard spelled
differently.
"""

from lxml import etree

from proof.native.hq_support import hq_commit, sha256, write_evidence

FAMILIES = ("navigation", "form-link")
FORM_LINK_SCENARIOS = {
    "else",
    "module",
    "home",
    "previous",
    "unconditional",
    "overlap",
    "manual",
    "chain",
    "this-form",
    "carried-held",
}
SCENARIOS = {
    "base",
    "conditions",
    "owner",
    "links",
    "search-legacy",
    "search-date-add",
    "search-datetime-add",
    "search-day-range",
}


def test_hq_regenerates_navigation_forms_with_novas_registration_datum(native):
    result = native.step("navigation")
    assert set(result["sources"]) == SCENARIOS
    forms = []
    for record in result["records"]:
        if record["scenario"] == "base" and record["form"] == 1:
            assert record["newCaseDatums"] == [("case_id_new_patient_0", "uuid()")]
        forms.append({key: value for key, value in record.items() if key != "newCaseDatums"})
    write_evidence(
        native.family("navigation"),
        "navigation-emission",
        {
            "hqCommit": hq_commit(),
            "forms": forms,
            "limits": "Native HQ source import, XForm case/meta regeneration and registration datum allocation. "
            "No full HQ build, database write or remote call; the project space's configuration is the check's.",
        },
    )


def _frame_conditions(suite):
    """Each entry's after-submit frames as the suite writes them: by command, each ``<create>``'s ``if`` in order
    (None where it has none)."""
    root = etree.fromstring(suite)
    return {
        entry.find("command").get("id"): [create.get("if") for create in entry.iterfind("stack/create")]
        for entry in root.iterfind("entry")
    }


def test_hq_builds_every_after_submit_frame_with_novas_condition_bytes(native):
    result = native.step("form-link")
    assert set(result["sources"]) == FORM_LINK_SCENARIOS
    scenarios = []
    for record in result["records"]:
        local = _frame_conditions(record["local"])
        hq = _frame_conditions(record["native"])
        assert local == hq, record["scenario"]
        # The source form's frames are the scenario: each link's, then the fallback where HQ builds one.
        assert local["m0-f0"], record["scenario"]
        scenarios.append(
            {
                "scenario": record["scenario"],
                "sourceSha256": record["sourceSha256"],
                "suiteSha256": sha256(record["local"]),
                "nativeSuiteSha256": sha256(record["native"]),
                "frameConditions": local["m0-f0"],
            }
        )
    write_evidence(
        native.family("form-link"),
        "after-submit-frame-conditions",
        {
            "hqCommit": hq_commit(),
            "scenarios": scenarios,
            "limits": "Native HQ Application import and its workflow post-processing over each uploaded form link "
            "and fallback. Each <create> if attribute compared as text, in order, entry by entry. No resource install, "
            "full HQ build or network.",
        },
    )
