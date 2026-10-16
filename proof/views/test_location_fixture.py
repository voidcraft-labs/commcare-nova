"""Defect 14 and finding 69: what HQ's restore hands a worker of an app that reads places, on a device and in Web
Apps, by the app's location fixture choice and the project space's own setting.

Contract: every app Nova writes carries ``location_fixture_restore:
project_default`` (``lib/commcare/hqShells.ts``), so HQ's restore asks the
project space whether to sync the flat location fixture
(``locations/fixtures.py::should_sync_flat_fixture``,
``LocationFixtureConfiguration.sync_flat_fixture``, on unless someone
turned it off), and a device and Web Apps agree: both hold the places where
the project space syncs them, and neither does where it does not. Nova's
publish asks the person to confirm that setting, since no API reads it. The
plausible failures: a restore that reads the app's choice for one reader and
the project space's for the other (then a device and Web Apps disagree), and
one that syncs no fixture at all here, which would say nothing.

One location app is published as Nova publishes it, its project space
given a district and a clinic under it and its worker assigned to the
district, each through HQ's own models. The app is then released with the
project space's flat fixture setting on and off, and its worker restores two
ways, each answered by HQ's own restore view (``ota/views.py::restore``):

- **as a device does**, at the address the released build's profile names
  (``ota-restore-url``, which names the app), with the worker's own
  credentials;
- **as Web Apps does**: Formplayer installs the release and asks HQ for the
  worker's restore at the address that names no app
  (``RestoreFactory.getUserRestoreUrl``), so HQ's restore reads no app's
  choice. Where the fixture is not there, the form that reads it, walked by
  Formplayer, moves no case.

The same release with ``both_fixtures`` written into the stored app, a value
HQ's settings page does not offer, is the standing proof of what HQ does
with that choice: a device restores the fixture whatever the project space
says, and Web Apps still asks the project space. On a plan without
``LOCATIONS`` neither restore holds the fixture under either setting
(``Domain.uses_locations``). The project space's setting is HQ's own Location
Fixture page (``domain/views/fixtures.py::LocationFixtureConfigView``),
answered 404 without ``HIERARCHICAL_LOCATION_FIXTURE``, whose form, with
it, turns the flat list off and on again.
"""

from __future__ import annotations

import base64
import dataclasses
import io
import zipfile
from urllib.parse import urlsplit

import pytest
from lxml import etree

from proof.observe import casedata
from proof.views.conftest import ask

DOCUMENT = "location-direct"
CHOICES = ("both_fixtures", "project_default")
SETTINGS_FLAG = "HIERARCHICAL_LOCATION_FIXTURE"
# Where a person's browser has HQ's page open: HQ's own origin, as the requests here reach it (Django's request
# factory names the host ``testserver``), which HQ's CSRF check holds a form's Referer to.
ORIGIN = "https://testserver/"


def _places(unit, worker, owner_id):
    """A district and a clinic under it, as a person makes them, the district under the id the document's cases
    are owned by (the form reads the clinic of the case's owner), and the worker assigned to the district."""
    from corehq.apps.locations.models import LocationType, SQLLocation

    district_type = LocationType.objects.create(domain=unit.domain, name="District", code="district")
    clinic_type = LocationType.objects.create(
        domain=unit.domain, name="Clinic", code="clinic", parent_type=district_type
    )
    district = SQLLocation.objects.create(
        domain=unit.domain, name="North", site_code="north", location_type=district_type, location_id=owner_id
    )
    clinic = SQLLocation.objects.create(
        domain=unit.domain, name="North clinic", site_code="north_clinic", location_type=clinic_type, parent=district
    )
    worker.set_location(district)
    return district, clinic


def _flat_fixture(restore: bytes):
    """The site codes of the flat location fixture a restore holds, or None where it holds none."""
    root = etree.fromstring(restore)
    fixtures = [
        element for element in root.iter() if element.tag.endswith("fixture") and element.get("id") == "locations"
    ]
    if not fixtures:
        return None
    return sorted(
        child.text
        for fixture in fixtures
        for location in fixture.iter()
        if isinstance(location.tag, str) and location.tag.endswith("location")
        for child in location
        if isinstance(child.tag, str) and child.tag.endswith("site_code")
    )


def _owners_written(trace) -> list[str]:
    """The owner each submission of a walk writes into its case, as Formplayer sent it to HQ."""
    found = []
    for run in trace["runs"]:
        for step in run["steps"]:
            for submission in step.get("submissions") or []:
                root = etree.fromstring(submission["instance"].encode("utf-8"))
                found += [element.text or "" for element in root.iter() if element.tag.endswith("}owner_id")]
    return found


def _device_restore(unit, served, label) -> bytes:
    """The worker's restore as a device asks for it: at the address the released build's profile names, with the
    worker's own credentials (HTTP basic, as CommCare sends them)."""
    from proof.formplayer import hq as formplayer_hq

    with zipfile.ZipFile(io.BytesIO(served.archive())) as archive:
        profile = etree.fromstring(archive.read("profile.ccpr"))
    (address,) = [prop.get("value") for prop in profile.iter("property") if prop.get("key") == "ota-restore-url"]
    path = urlsplit(address).path
    assert served.app_id in path or served.build_id in path, f"the profile's restore address names no app: {address}"
    credentials = base64.b64encode(f"{served.worker.username}:{formplayer_hq.PASSWORD}".encode()).decode()
    answer = ask(
        unit,
        "GET",
        path,
        query="version=2.0&device_id=proof-device",
        headers=(("Authorization", f"Basic {credentials}"),),
        label=f"device-restore-{label}",
    )
    assert answer.status == 200, (answer.status, answer.body[:300])
    return answer.body


def _observed(unit, document, app_id, runner, blobs, walk, owner_id, choice, syncs, label):
    """What a device and Web Apps each restore of the app released under ``choice`` with the project space's flat
    fixture setting ``syncs``, and whether Formplayer's walk moved each case to the clinic. Returns that and the
    walk's script."""
    from corehq.apps.locations.models import LocationFixtureConfiguration

    from proof.formplayer import hq as formplayer_hq
    from proof.formplayer import observe as formplayer_observe

    def change(stored):
        stored["location_fixture_restore"] = choice

    with formplayer_hq.serve(unit, document, app_id, runner=runner, label=label, change=change) as served:
        with unit.committing():
            LocationFixtureConfiguration.objects.update_or_create(
                domain=unit.domain,
                defaults={"sync_flat_fixture": syncs, "sync_hierarchical_fixture": False},
            )
            _, clinic = _places(unit, served.worker, owner_id)
        with served.run(f"device-{label}"):
            device = _flat_fixture(_device_restore(unit, served, label))
        _, trace = formplayer_observe.walked(served, runner, blobs, script=walk)
        assert served.hq.restores, "Formplayer asked HQ for no restore"
        web_apps = _flat_fixture(served.hq.restores[-1])
        # Whether each submission of the walk moved its case to the clinic: the walk opens the form for every case
        # its list offers, and each answers the same.
        moved = sorted({owner == clinic.location_id for owner in _owners_written(trace)})
    return {"device": device, "webApps": web_apps, "moved": moved}, walk or formplayer_observe.script_of(trace)


@pytest.mark.reader("formplayer")  # walks a release in the session's Formplayer
def test_a_device_restores_the_flat_fixture_by_the_apps_choice_and_web_apps_by_the_project_spaces(
    hq, core_runner, lane_services, view_documents, published
):
    from proof.hq import operations
    from proof.observe import services
    from proof.observe.record import Blobs

    document = view_documents[DOCUMENT]
    owner_id = casedata.document_case_database(document).user_id
    runner, blobs, found, walk = services.formplayer(), Blobs(), {}, None
    configuration = document.exports["minimum"].configuration.hq()
    assert "LOCATIONS" in configuration.privileges
    with published(document, "minimum", core_runner) as (unit, app_id, _):
        assert operations.held_app(unit, app_id).location_fixture_restore == "project_default"
        for choice in CHOICES:
            for syncs in (True, False):
                label = f"{choice}-{'on' if syncs else 'off'}"
                found[choice, syncs], walk = _observed(
                    unit, document, app_id, runner, blobs, walk, owner_id, choice, syncs, label
                )
    without_locations = dataclasses.replace(
        configuration, privileges=frozenset(configuration.privileges - {"LOCATIONS"})
    )
    with published(document, "minimum", core_runner, configuration=without_locations) as (unit, app_id, _):
        for syncs in (True, False):
            label = f"no-locations-{'on' if syncs else 'off'}"
            found["no-locations", syncs], walk = _observed(
                unit, document, app_id, runner, blobs, walk, owner_id, "project_default", syncs, label
            )
    places = ["north", "north_clinic"]
    there = {"device": places, "webApps": places, "moved": [True]}
    none = {"device": None, "webApps": None, "moved": []}
    assert found == {
        # The choice Nova writes: a device and Web Apps both ask the project space.
        ("project_default", True): there,
        ("project_default", False): none,
        # HQ's own reading of ``both_fixtures``: the app's choice is a device's alone, and Web Apps asks the
        # project space.
        ("both_fixtures", True): there,
        ("both_fixtures", False): {"device": places, "webApps": None, "moved": []},
        # A plan without Locations syncs no places to either, whatever the project space's setting says.
        ("no-locations", True): none,
        ("no-locations", False): none,
    }, found


def _settings_answer(unit, signed_in, method, label, syncs=None):
    from urllib.parse import urlencode

    from django.urls import reverse

    path = reverse("location_fixture_config", args=[unit.domain])
    if method == "GET":
        return ask(unit, "GET", path, headers=(("Cookie", signed_in.cookie),), label=label)
    fields = [("csrfmiddlewaretoken", signed_in.csrf)] + ([("sync_flat_fixture", "on")] if syncs else [])
    return ask(
        unit,
        "POST",
        path,
        body=urlencode(fields).encode(),
        headers=(
            ("Content-Type", "application/x-www-form-urlencoded"),
            ("Cookie", signed_in.cookie),
            ("Referer", ORIGIN),
        ),
        label=label,
    )


def test_the_project_spaces_location_fixture_page_turns_the_flat_list_off_and_on_only_under_its_flag(
    hq, core_runner, view_documents, published
):
    """HQ's Location Fixture page, where a person turns the project space's flat list off, answers 404 without
    ``HIERARCHICAL_LOCATION_FIXTURE``; with it, its form turns the flat list off and on again. Nova's publish
    asks the person about the setting rather than reading the flag, since a space can have had the flag, turned
    the list off and lost the flag since."""
    from corehq.apps.locations.models import LocationFixtureConfiguration

    from proof.formplayer import hq as formplayer_hq
    from proof.hq import redis as hq_redis

    document = view_documents[DOCUMENT]
    minimum = document.exports["minimum"].configuration.hq()
    stored = {}
    for flagged in (False, True):
        flags = minimum.flags | {SETTINGS_FLAG} if flagged else minimum.flags - {SETTINGS_FLAG}
        configuration = dataclasses.replace(minimum, flags=frozenset(flags))
        published_space = published(document, "minimum", core_runner, configuration=configuration, create=False)
        with published_space as (unit, _, _), hq_redis.shared(None):
            label = "flagged" if flagged else "unflagged"
            signed_in = formplayer_hq.admin_signed_in(unit, unit.operation, "location-fixture", label)
            page = _settings_answer(unit, signed_in, "GET", f"location-fixture-page-{label}")
            if not flagged:
                stored[flagged] = page.status
                continue
            assert page.status == 200, (page.status, page.body[:300])
            steps = []
            for syncs in (False, True):
                answer = _settings_answer(
                    unit, signed_in, "POST", f"location-fixture-{'on' if syncs else 'off'}", syncs=syncs
                )
                assert answer.status == 200, (answer.status, answer.body[:300])
                steps.append(LocationFixtureConfiguration.for_domain(unit.domain).sync_flat_fixture)
            stored[flagged] = steps
    assert stored == {False: 404, True: [False, True]}, stored
