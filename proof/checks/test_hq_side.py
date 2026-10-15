"""What a person saves in HQ over A reaches HQ through HQ's own views, and Nova's next publish over it loses it.

Contract (``proof.observe.hqside``): each save a document's ``hq-side.json``
names is made as HQ's page or upload makes it and lands in what HQ holds,
and the identity record proof 1 compares (``proof.observe.identity``) shows
what Nova's next push of its lookup workbook does to the table a person
keeps. The plausible failures: a save the harness makes that HQ's view
refuses or reads otherwise (so A would not hold what a person leaves there,
and every symptom observed over it would be the harness's), a refusal the
harness swallows, and an identity record that misses the table HQ makes
again (so proof 1 could not see defect 5).

``targeted-hq-side-state`` and ``targeted-hq-side-lookup`` are each published as Nova's first publish leaves
them (a workbook where the document has lookup tables, then the create), their saves made over it, and their next
publish applied over that: the first holds the UI translation, location capture and build profile saves, the second
the lookup table a person keeps. A project space without ``BUILD_PROFILES`` is the refusal: HQ's language profiles
page refuses the save, and the harness says so rather than going on.
"""

from __future__ import annotations

from dataclasses import replace

import pytest

from proof.checks import cases
from proof.checks.identity import compare_identities
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


def test_a_persons_saves_land_in_hq_and_novas_next_publish_loses_them(hq, core_runner):
    from proof.hq import operations
    from proof.observe import hqside, publish

    document = _document(STATE)
    export = document.exports["minimum"]
    saves = document.hq_side
    with hq_check(export.configuration.hq()) as (unit, _):
        app_id = _created(unit, export)
        held = hqside.save(unit, _ops(unit), app_id, saves)
        assert sorted(held) == sorted(saves)

        app = operations.held_app(unit, app_id)
        assert app.translations["en"]["home.start"] == saves["uiTranslations"]["en"]["home.start"]
        assert app.auto_gps_capture is True
        assert {key: list(profile.langs) for key, profile in app.build_profiles.items()} == {"mandarin-only": ["zho"]}

        refusal, lookups = publish.update(unit, app_id, export.republish, "B")
        assert _landed(refusal, lookups), (refusal, lookups)
        app = operations.held_app(unit, app_id)
        assert "home.start" not in app.translations["en"]
        assert app.auto_gps_capture is False
        assert list(app.build_profiles) == ["mandarin-only"]


def test_a_table_a_person_keeps_is_made_again_by_novas_next_push(hq, core_runner):
    from proof.observe import hqside, publish
    from proof.observe.identity import project_identity

    document = _document(LOOKUP)
    export = document.exports["minimum"]
    saves = document.hq_side
    with hq_check(export.configuration.hq()) as (unit, _):
        app_id = _created(unit, export)
        held = hqside.save(unit, _ops(unit), app_id, saves)
        assert sorted(held) == sorted(saves)

        kept = saves["lookupTable"]
        a = {"project": project_identity(unit.domain)}
        table = a["project"]["lookup_tables"][kept["tag"]]
        assert table["description"] == kept["description"]
        assert table["fields"]["name"]["properties"] == [kept["fieldProperty"]["property"]]
        assert table["item_attributes"] == [kept["rowAttribute"]["name"]]
        assert [row["item_attributes"] for row in table["rows"]] == [
            {kept["rowAttribute"]["name"]: value} for value in kept["rowAttribute"]["values"]
        ]
        assert all(len(row["owners"]) == 3 for row in table["rows"]), table["rows"]

        refusal, lookups = publish.update(unit, app_id, export.republish, "B")
        assert refusal is None and lookups is not None and lookups["errors"] == [], (refusal, lookups)
        found = {
            (difference.path, difference.kind)
            for difference in compare_identities(a, {"project": project_identity(unit.domain)}, document=LOOKUP)
        }
    for path in (
        "/lookup_tables/*/id",
        "/lookup_tables/*/description",
        "/lookup_tables/*/rows/*/id",
        "/lookup_tables/*/rows/*/owners/*",
        "/lookup_tables/*/rows/*/item_attributes/*",
        "/lookup_tables/*/item_attributes/*",
        "/lookup_tables/*/fields/*/properties/*",
    ):
        assert any(shown == path for shown, _ in found), (path, sorted(found))


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
