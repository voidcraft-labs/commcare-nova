"""HQ regenerates every navigation form, allocating the registration datum Nova's suite names.

Contract: HQ imports each navigation scenario and regenerates every form of
its first module with its own case and meta lowering; for the base
scenario's registration form it allocates exactly one new-case datum,
``case_id_new_patient_0``, computed as ``uuid()``, the id Nova's suite
passes. ``NavigationRuntimeTest`` then checks ordinary case writes and
navigation values in Core and writes the search queries HQ's compiler reads
next (``test_search_payload.py``). The plausible failures: a datum HQ names
or computes differently, and a scenario missing from the corpus.
"""

from proof.native.hq_support import hq_commit, write_evidence

FAMILIES = ("navigation",)
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
