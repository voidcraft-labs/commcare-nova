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
applied over them; the second holds the lookup table a person keeps, over which Nova's next publish stops.
``targeted-kept-values`` holds every value a ``.ccz`` made for the project space mirrors, secure submissions among
them, which HQ takes only through the app settings page's one save (``views/settings.py::edit_commcare_settings``)
and answers with 400 at the attribute's own URL (``views/apps.py::edit_app_attr``). A project space without
``BUILD_PROFILES`` is the refusal: HQ's language profiles page refuses the save, and the harness says so rather
than going on.

``targeted-hq-changes-forms`` has a form deleted and a survey added in HQ, which Nova's republish brings in: that
republish names the added form by the id HQ minted, which the HQ side writes in place of the one the capture's peer
drew (``proof.observe.publish.held_ids``).
"""

from __future__ import annotations

from dataclasses import replace

import pytest

from proof.checks import cases
from proof.hq.check import hq_check

STATE = "targeted-hq-side-state"
LOOKUP = "targeted-hq-side-lookup"
KEPT = "targeted-kept-values"
RESAVE = "targeted-hq-changes-resave"
FORMS = "targeted-hq-changes-forms"


def _document(name):
    documents = {document.id: document for document in cases.load_corpus().emitted}
    # A targeted document every emission writes, a sampled run's among those it leaves out (``emitted``): a corpus
    # without it is a broken emission, which fails here by name where a skip would pass for saves nothing made.
    assert name in documents, (
        f"The corpus this run reads holds no {name}, a targeted document every emission writes"
        " (proof/targeted/documents/hqSideState.ts, hqSideLookup.ts, keptValues.ts), so HQ-side saves were held on"
        " nothing. Emit the corpus again (proof/corpus/emit.ts) and read its log for why the document was left out."
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
                "add_ons": {slug: app.add_ons.get(slug) for slug in saves["addOns"]},
                "properties": {key: app.profile["properties"].get(key) for key in saves["profileProperties"]},
                "build_profiles": {key: list(profile.langs) for key, profile in app.build_profiles.items()},
            }

        saved = {
            "home.start": saves["uiTranslations"]["en"]["home.start"],
            "add_ons": saves["addOns"],
            "properties": saves["profileProperties"],
            "build_profiles": {"mandarin-only": ["zho"]},
        }
        assert kept(operations.held_app(unit, app_id)) == saved

        refusal, lookups = publish.update(unit, app_id, export.republish, "B")
        assert _landed(refusal, lookups), (refusal, lookups)
        assert kept(operations.held_app(unit, app_id)) == saved


def test_a_form_keeps_its_independent_location_choice_after_the_app_switch_is_cleared(hq, core_runner):
    """HQ's two authentic settings saves and its build distinguish both choices from a geopoint answer."""
    from lxml import etree
    from proof.hq import operations
    from proof.observe import hqside

    document = _document("targeted-gps-question")
    export = document.exports["minimum"]
    with hq_check(export.configuration.hq()) as (unit, _):
        app_id = _created(unit, export)

        def held():
            app = operations.held_app(unit, app_id)
            form = app.get_module(0).get_form(0)
            xml = etree.fromstring(form.render_xform())
            model = xml.xpath("//*[local-name()='model']")[0]
            sensors = model.xpath("./*[local-name()='pollsensor']")
            meta = model.xpath("./*[local-name()='instance'][1]/*/*[local-name()='meta']/*[local-name()='location']")
            binds = model.xpath("./*[local-name()='bind' and @nodeset='/data/meta/location' and @type='geopoint']")
            return (app.auto_gps_capture, form.auto_gps_capture, bool(meta), bool(binds),
                    [sensor.get("ref") for sensor in sensors])

        target = {"module": 0, "form": 0}
        assert held() == (False, False, False, False, [None])
        hqside.form_attribute(unit, app_id, {**target, "attributes": {"auto_gps_capture": "true"}})
        hqside.app_attributes(unit, app_id, {"auto_gps_capture": True})
        assert held() == (True, True, True, True, ["/data/meta/location"])
        hqside.app_attributes(unit, app_id, {"auto_gps_capture": False})
        assert held() == (False, True, True, True, ["/data/meta/location"])
        hqside.form_attribute(unit, app_id, {**target, "attributes": {"auto_gps_capture": "false"}})
        assert held() == (False, False, False, False, [None])


def test_every_value_a_local_archive_mirrors_lands_in_hq_and_novas_next_publish_keeps_it(hq, core_runner):
    from proof.hq import operations
    from proof.observe import hqside, publish

    document = _document(KEPT)
    export = document.exports["minimum"]
    saves = document.hq_side
    assert saves["appAttributes"]["secure_submissions"] is True, saves["appAttributes"]
    with hq_check(export.configuration.hq()) as (unit, _):
        app_id = _created(unit, export)
        held = hqside.save(unit, _ops(unit), app_id, saves)
        assert sorted(held) == sorted(set(saves) - set(hqside.STATEMENTS))
        assert saves["republish"] == "proceeds"

        def kept(app):
            return {
                "translations": {
                    lang: {key: app.translations.get(lang, {}).get(key) for key in texts}
                    for lang, texts in saves["uiTranslations"].items()
                },
                "attributes": {key: getattr(app, key) for key in saves["appAttributes"]},
                "properties": {key: app.profile["properties"].get(key) for key in saves["profileProperties"]},
                "features": {key: app.profile["features"].get(key) for key in saves["profileFeatures"]},
            }

        saved = {
            "translations": saves["uiTranslations"],
            "attributes": saves["appAttributes"],
            "properties": saves["profileProperties"],
            "features": saves["profileFeatures"],
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


def test_a_form_builder_save_runs_where_the_in_band_audit_can_rerun_it_in_a_fork(
    hq, core_runner, editor_driver, monkeypatch
):
    """Contract: a save made in HQ's form builder (``hqside.FORM_BUILDER_SAVES``) is made between the unit's scopes,
    as proof 4 makes one, so the in-band audit (``PROOF_EDITOR_AUDIT``, which the weekly verified lane sets to 1)
    can rerun it on a fresh page in a fork of the unit first. Catches a save opened inside its own operation: the
    unit takes a mark only between scopes (``proof/hq/branch.py::Unit._require_branchable``), so every audited run
    of the document would fail before A existed. The save still lands as the form builder's own save."""
    from proof.editors.pages import AUDIT_ENVIRONMENT
    from proof.observe import hqside

    document = _document(RESAVE)
    export = document.exports["minimum"]
    saves = document.hq_side
    monkeypatch.setenv(AUDIT_ENVIRONMENT, "1")
    with hq_check(export.configuration.hq()) as (unit, _):
        app_id = _created(unit, export)
        held = hqside.save(unit, _ops(unit), app_id, saves, driver=editor_driver)
        assert sorted(held) == ["formResave"], held
        assert held["formResave"][0]["view"] == "patch_xform", held


def test_novas_publish_after_a_bring_in_names_a_form_hq_added_by_the_id_hq_minted(hq, core_runner):
    """Contract (``proof.observe.publish.held_ids``, ``proof.hq.operations.with_held_ids``): the republish after a
    bring-in of a form a person added in HQ names that form by the id HQ's ``new_form`` minted, which is the id Nova's
    bring-in reads of HQ's app, and not the one the capture's peer drew; a record naming a form HQ holds under no
    ``xmlns`` refuses by name. Catches a republish that lands the peer's id over HQ's, which proof 1 reads as Nova
    minting a form's id anew."""
    from proof.hq import operations
    from proof.observe import hqside, publish

    document = _document(FORMS)
    export = document.exports["minimum"]
    record = export.brought_in
    assert record is not None and record.taken == "brought-in", record
    with hq_check(export.configuration.hq()) as (unit, _):
        app_id = _created(unit, export)
        hqside.save(unit, _ops(unit), app_id, document.hq_side)
        added = operations.held_app(unit, app_id).get_module(0).get_form(-1)
        ids = publish.held_ids(unit, app_id, record)
        assert list(ids.values()) == [added.unique_id], ids
        [peer] = ids
        sent = operations.upload_field(operations.with_held_ids(export.republish.upload(), ids), "app_file").decode()
        assert peer not in sent and added.unique_id in sent
        refusal, lookups = publish.update(unit, app_id, export.republish, "B")
        assert _landed(refusal, lookups), (refusal, lookups)
        held = {form.xmlns: form.unique_id for form in operations.held_app(unit, app_id).get_forms()}
        assert held[added.xmlns] == added.unique_id, held
        stray = replace(
            record,
            identities=[
                {
                    "entityKind": "form",
                    "novaEntityUuid": "stray",
                    "uniqueId": peer,
                    "xmlns": "http://openrosa.org/formdesigner/held-nowhere",
                }
            ],
        )
        with pytest.raises(operations.CapturedIdsNotHeld, match="no form under that xmlns"):
            publish.held_ids(unit, app_id, stray)
