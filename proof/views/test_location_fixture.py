"""Defect 14, ``both_fixtures``: what HQ's restore hands a worker of an app that names that location fixture choice,
on a device and in Web Apps.

Contract: Nova writes ``location_fixture_restore: both_fixtures`` into an app
that reads the locations fixture (``lib/commcare/expander.ts``), a value
HQ's settings page does not offer. HQ's restore gives such an app's worker
the flat location fixture whatever the project space's own setting says
(``locations/fixtures.py::should_sync_flat_fixture``), where
``project_default``, the value HQ's page writes, asks the project space. The
plausible failures: a restore that asks the project space either way (then
the value is inert), and one that syncs no fixture at all here, which would
say nothing.

One location app is published as Nova publishes it, its project space
given a district and a clinic under it and its worker assigned to the
district, each through HQ's own models. The app is then released under each
choice, with the project space's flat fixture setting on and off, and its
worker restores two ways, each answered by HQ's own restore view
(``ota/views.py::restore``):

- **as a device does**, at the address the released build's profile names
  (``ota-restore-url``, which names the app), with the worker's own
  credentials. The restore holds the flat fixture, with both places, under
  ``both_fixtures`` whatever the project space says, and under
  ``project_default`` only where the project space syncs it;
- **as Web Apps does**: Formplayer installs the release and asks HQ for the
  worker's restore at the address that names no app
  (``RestoreFactory.getUserRestoreUrl``), so HQ's restore reads no app's
  choice and asks the project space under both. Where the fixture is not
  there, the form that reads it, walked by Formplayer, moves no case.

So ``both_fixtures`` is what a device restores by and nothing Web Apps
reads: with the project space's flat fixture off, the same app has its
places on Android and none in Web Apps.
"""

from __future__ import annotations

import base64
import io
import zipfile
from urllib.parse import urlsplit

from lxml import etree

from proof.observe import casedata
from proof.views.conftest import ask

DOCUMENT = "location-direct"
CHOICES = ("both_fixtures", "project_default")


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


def test_a_device_restores_the_flat_fixture_by_the_apps_choice_and_web_apps_by_the_project_spaces(
    hq, core_runner, lane_services, view_documents, published
):
    from corehq.apps.locations.models import LocationFixtureConfiguration

    from proof.formplayer import hq as formplayer_hq
    from proof.formplayer import observe as formplayer_observe
    from proof.hq import operations
    from proof.observe import services
    from proof.observe.record import Blobs

    document = view_documents[DOCUMENT]
    owner_id = casedata.document_case_database(document).user_id
    runner, blobs, found, walk = services.formplayer(), Blobs(), {}, None
    with published(document, "minimum", core_runner) as (unit, app_id, _):
        assert operations.held_app(unit, app_id).location_fixture_restore == "both_fixtures"
        for choice in CHOICES:
            for syncs in (True, False):

                def change(stored, choice=choice):
                    stored["location_fixture_restore"] = choice

                label = f"{choice}-{'on' if syncs else 'off'}"
                with formplayer_hq.serve(unit, document, app_id, runner=runner, label=label, change=change) as served:
                    with unit.committing(), formplayer_hq.index(unit):
                        LocationFixtureConfiguration.objects.update_or_create(
                            domain=unit.domain,
                            defaults={"sync_flat_fixture": syncs, "sync_hierarchical_fixture": False},
                        )
                        _, clinic = _places(unit, served.worker, owner_id)
                    with served.run(f"device-{label}"):
                        device = _flat_fixture(_device_restore(unit, served, label))
                    _, trace = formplayer_observe.walked(served, runner, blobs, script=walk)
                    walk = walk or formplayer_observe.script_of(trace)
                    assert served.hq.restores, "Formplayer asked HQ for no restore"
                    web_apps = _flat_fixture(served.hq.restores[-1])
                    moved = [owner == clinic.location_id for owner in _owners_written(trace)]
                    found[choice, syncs] = {"device": device, "webApps": web_apps, "moved": moved}
    places = ["north", "north_clinic"]
    there = {"device": places, "webApps": places, "moved": [True]}
    assert found == {
        ("both_fixtures", True): there,
        # The app's own choice is a device's alone: Web Apps asks the project space.
        ("both_fixtures", False): {"device": places, "webApps": None, "moved": []},
        ("project_default", True): there,
        ("project_default", False): {"device": None, "webApps": None, "moved": []},
    }, found
