"""What a person saves in HQ over A reaches HQ through HQ's own views, and what Nova's next publish over it does.

Contract (``proof.observe.hqside``): each save a document's ``hq-side.json``
names is made as HQ's page or upload makes it and lands in what HQ holds,
and the identity record proof 1 compares (``proof.observe.identity``) shows
that Nova's next publish leaves the table a person keeps as it is: Nova's
preflight stops it before anything is sent (defect 5). The plausible
failures: a save the harness makes that HQ's view refuses or reads otherwise
(so A would not hold what a person leaves there, and every symptom observed
over it would be the harness's), a refusal the harness swallows, a stop the
capture does not record, and a publish that writes over a value the target
owns (defect 4): Nova's next publish carries back the UI
translation, keeps Auto Capture Location, which it leaves out of the body of
an app that is not a Connect app, and keeps the add-ons and the setting a
person saved, which Nova's own part of ``add_ons`` and ``profile`` leaves to
the target.

``targeted-hq-side-state`` and ``targeted-hq-side-lookup`` are each published as Nova's first publish leaves
them (a workbook where the document has lookup tables, then the create) and their saves made over it: the first
holds the UI translation, location capture, build profile, add-ons and app settings saves, and its next publish is
applied over them; the second holds the lookup table a person keeps, over which Nova's next publish stops. A
project space without ``BUILD_PROFILES`` is the refusal: HQ's language profiles page refuses the save, and the
harness says so rather than going on.
"""

from __future__ import annotations

from dataclasses import replace

import pytest

from proof.checks import cases
from proof.hq.check import hq_check

STATE = "targeted-hq-side-state"
LOOKUP = "targeted-hq-side-lookup"


def _document(name):
    documents = {document.id: document for document in cases.load_corpus().emitted}
    # A targeted document every emission writes, a sampled run's among those it leaves out (``emitted``): a corpus
    # without it is a broken emission, which fails here by name where a skip would pass for saves nothing made.
    assert name in documents, (
        f"The corpus this run reads holds no {name}, a targeted document every emission writes"
        " (proof/targeted/documents/hqSideState.ts, hqSideLookup.ts), so HQ-side saves were held on nothing. Emit"
        " the corpus again (proof/corpus/emit.ts) and read its log for why the document was left out."
    )
    return documents[name]


def _landed(refusal, lookups):
    """Whether a publish landed: HQ took the app, and the workbook where the export carries one."""
    return refusal is None and (lookups is None or lookups["errors"] == [])


def _created(unit, export):
    from proof.observe import publish

    app_id, refusal, lookups = publish.create(unit, export)
    assert _landed(refusal, lookups), (refusal, lookups)
    return app_id


def _ops(unit):
    return lambda label, digest: unit.operation(label, digest)


def test_a_persons_saves_land_in_hq_and_novas_next_publish_keeps_them(hq, core_runner):
    from proof.hq import operations
    from proof.observe import hqside, publish

    document = _document(STATE)
    export = document.exports["minimum"]
    saves = document.hq_side
    with hq_check(export.configuration.hq()) as (unit, _):
        app_id = _created(unit, export)
        held = hqside.save(unit, _ops(unit), app_id, saves)
        assert sorted(held) == sorted(set(saves) - set(hqside.STATEMENTS))
        assert saves["republish"] == "proceeds"

        def kept(app):
            return {
                "home.start": app.translations["en"].get("home.start"),
                "auto_gps_capture": app.auto_gps_capture,
                "add_ons": {slug: app.add_ons.get(slug) for slug in saves["addOns"]},
                "properties": {key: app.profile["properties"].get(key) for key in saves["profileProperties"]},
                "build_profiles": {key: list(profile.langs) for key, profile in app.build_profiles.items()},
            }

        saved = {
            "home.start": saves["uiTranslations"]["en"]["home.start"],
            "auto_gps_capture": True,
            "add_ons": saves["addOns"],
            "properties": saves["profileProperties"],
            "build_profiles": {"mandarin-only": ["zho"]},
        }
        assert kept(operations.held_app(unit, app_id)) == saved

        refusal, lookups = publish.update(unit, app_id, export.republish, "B")
        assert _landed(refusal, lookups), (refusal, lookups)
        assert kept(operations.held_app(unit, app_id)) == saved


def test_novas_next_publish_stops_over_a_table_a_person_keeps_and_leaves_it_as_it_is(hq, core_runner):
    import json

    from proof.hq import operations
    from proof.hq import redis as hq_redis
    from proof.hq.seams import api_rate_limits
    from proof.observe import hqside
    from proof.observe.identity import project_identity

    document = _document(LOOKUP)
    export = document.exports["minimum"]
    saves = document.hq_side
    # Nova's preflight reads the property and the attribute from HQ's definition list and stops the republish
    # before it sends anything (defect 5), so the capture holds the stop and no republish to send.
    assert saves["republish"] == "stops" and saves["stopCode"] == "hq_table_content_unsupported"
    outcome = json.loads((export.directory / "outcome.json").read_text(encoding="utf-8"))
    assert outcome["republish"] == {"status": "stopped", "code": saves["stopCode"]}, outcome
    assert export.republish is None
    # Nova's preflight reads HQ's API, which a project space reaches under HQ's API access privilege.
    configuration = export.configuration.hq()
    with hq_check(replace(configuration, privileges=configuration.privileges | {"API_ACCESS"})) as (unit, _):
        app_id = _created(unit, export)
        held = hqside.save(unit, _ops(unit), app_id, saves)
        assert sorted(held) == sorted(set(saves) - set(hqside.STATEMENTS))

        kept = saves["lookupTable"]
        before = project_identity(unit.domain)
        table = before["lookup_tables"][kept["tag"]]
        assert table["description"] == kept["description"]
        assert table["fields"]["name"]["properties"] == [kept["fieldProperty"]["property"]]
        assert table["item_attributes"] == [kept["rowAttribute"]["name"]]
        assert [row["item_attributes"] for row in table["rows"]] == [
            {kept["rowAttribute"]["name"]: value} for value in kept["rowAttribute"]["values"]
        ]
        assert all(len(row["owners"]) == 3 for row in table["rows"]), table["rows"]
        # The stopped attempt's one request to HQ is the read its preflight makes, the lookup table list Nova's
        # client reads (``lib/commcare/hq/lookupTables.ts``). HQ answers it, over what the person left, with what
        # the stop rests on (``lib/deployment/lookupResourcePlan.ts::unsupportedLookupContent``): a field property
        # and a row attribute. The table stays global, so its rows' owners take no effect and are not read.
        with hq_redis.shared(None), unit.committing(), api_rate_limits(unit):
            member = operations.seed_api_user(unit, "member-lookup@example.org")
            answer = operations.lookup_tables_read(unit, member)
        assert answer.status == 200, answer.retained()
        [listed] = [entry for entry in json.loads(answer.body)["objects"] if entry["tag"] == kept["tag"]]
        assert listed["id"].replace("-", "") == table["id"], (listed, table["id"])
        assert [field["properties"] for field in listed["fields"] if field["field_name"] == "name"] == [
            [kept["fieldProperty"]["property"]]
        ], listed["fields"]
        assert listed["item_attributes"] == [kept["rowAttribute"]["name"]], listed
        assert listed["is_global"] is True, listed
        # Nothing else was sent, so HQ's table is what the person left: the same table id, description, field
        # properties, row attributes, row ids and owners.
        after = project_identity(unit.domain)
    assert after["lookup_tables"][kept["tag"]] == table


def test_a_save_hq_refuses_stops_the_observation(hq, core_runner):
    from proof.observe import hqside

    document = _document(STATE)
    export = document.exports["minimum"]
    configuration = export.configuration.hq()
    without = replace(configuration, privileges=configuration.privileges - {"BUILD_PROFILES"})
    with hq_check(without) as (unit, _):
        app_id = _created(unit, export)
        with pytest.raises(hqside.HqSideSaveRefused, match="build profiles"):
            hqside.build_profiles(unit, app_id, document.hq_side["buildProfiles"])
