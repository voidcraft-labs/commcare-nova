"""HQ's flat location fixture has the shape Nova's owner forms read, over real places.

Contract: over places saved through HQ's own models, HQ's
``FlatLocationSerializer`` writes the fixture Nova's owner forms read: the
``locations`` fixture for the worker, indexed, one ``location`` per place in
site-code order, each carrying its type, its id and every ancestor's id
under ``<type>_id`` (blank where the chain skips a level), and every location
data field (blank where the place has no value). HQ also keeps the owner
forms' ``both_fixtures`` restore setting and regenerates them;
``LocationOwnerRuntimeTest`` then resolves owners in Core from these exact
restore bytes. The plausible failures: a lineage attribute HQ fills
differently, a data field HQ leaves out, and an owner form HQ cannot
regenerate.
"""

from proof.native.hq_support import hq_commit, hq_source_hashes, write_evidence
from proof.native.steps.location_emission import FIXTURES, place_id, site_code

FAMILIES = ("location",)


def _check_fixture(record):
    scenario = record["fixture"]
    assert record["attrib"] == {"id": "locations", "user_id": "worker", "indexed": "true"}
    in_site_code_order = [place_id(number) for number in sorted(FIXTURES[scenario], key=site_code)]
    assert [location["attrib"]["id"] for location in record["locations"]] == in_site_code_order
    if scenario == "complete":
        clinic = record["locations"][2]
        assert clinic["attrib"] == {
            "type": "clinic",
            "id": "place-3",
            "region_id": "place-1",
            "district_id": "place-2",
            "clinic_id": "place-3",
        }
        assert clinic["data"]["ward"] == "A & B"
        assert clinic["data"]["unset"] == ""
    if scenario == "skipped":
        assert record["locations"][1]["attrib"]["district_id"] == ""
    return {"fixture": scenario, "sha256": record["sha256"]}


def test_hq_serializes_the_flat_fixture_and_regenerates_the_owner_forms(native):
    result = native.step("location")
    records = [_check_fixture(record) for record in result["fixtures"]]
    assert set(result["sources"]) == {"location-direct", "location-multirung", "location-plain"}
    for form in result["forms"]:
        if form["form"] != "plain":
            assert form["locationFixtureRestore"] == "both_fixtures"
        records.append({key: value for key, value in form.items() if key != "locationFixtureRestore"})
    write_evidence(
        native.family("location"),
        "location-emission",
        {
            "hqCommit": hq_commit(),
            "sourceSha256": hq_source_hashes(["corehq/apps/locations/fixtures.py"])[
                "corehq/apps/locations/fixtures.py"
            ],
            "records": records,
            "limits": "HQ's own location types, data fields and places in the check's database; HQ's flat "
            "serializer wrapped in a restore response by hand. No HQ footprint query, network restore or remote "
            "build is claimed. Native Core consumes these exact restore and form artifacts.",
        },
    )
