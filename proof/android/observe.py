"""What a worker's device makes of a state the unit serves, as records (``proof/android/README.md``).

Where the unit serves a state to Formplayer and the Web Apps client (``proof.observe.served``), it also hands
it to CommCare Android, read by commcare-android's own code (``proof.android.client``), on a device whose
network HQ's own views answer over that state (``proof.android.hq``). Each request is one device:

- ``app``: the archive a worker installs of the state, the worker HQ made signing in on it (HQ's key record and
  restore views), and every walk down the app's menus with what each screen shows, each form a walk saves sent
  to HQ's receiver, each search sent to HQ's search view and each claim to HQ's claim view;
- ``installs``: two archives installed in turn on one device;
- ``update``: a device on one archive updated to another, with every form left incomplete before it and a
  worker's own settings.

A record keeps the reader's answer and every request the device made of HQ with HQ's answer (``hq``), each a
blob. The archive of a released state is HQ's own download of the released build with the app's multimedia
(``release_archive``: ``hqmedia/views.py::iter_app_files``, what a worker installs from a file with nothing
left to fetch). A request the reader itself could not answer raises, so no record holds it.
"""

from __future__ import annotations

import io
import json
import tempfile
import zipfile
from dataclasses import asdict
from pathlib import Path

# What every search screen's free-text prompts are also answered with, on a screen of its own: an answer that
# holds both quote marks, which no XPath string literal can hold (finding 48).
QUERY_ANSWER = 'it\'s "x"'
ANSWERS = Path(__file__).resolve().parents[1] / "core" / "answers.json"
# A worker's own settings, written before an update: the two a worker sets on Android's settings screen that
# HQ's profile can force (MainConfigurablePreferences, R.xml.main_preferences; ``profile.settings`` in an
# answer names every recorded setting that screen declares).
WORKER_SETTINGS = {"cc-enable-tts": "yes", "cc-autoup-freq": "freq-daily"}
# A zip entry's timestamp: the earliest the format holds.
EPOCH = (1980, 1, 1, 0, 0, 0)


def _zipped(entries) -> bytes:
    """Entries as the ``.ccz`` file a worker installs, in name order with a fixed timestamp."""
    held = io.BytesIO()
    with zipfile.ZipFile(held, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, content in sorted(entries):
            archive.writestr(zipfile.ZipInfo(name, EPOCH), content, zipfile.ZIP_DEFLATED)
    return held.getvalue()


def archive_bytes(entries) -> bytes:
    """A device archive's entries (``proof.observe.build.device_archive``) as the file a worker installs."""
    return _zipped(entries)


def release_archive(served) -> bytes:
    """The released build of a served state as HQ's archive download hands it with the app's multimedia
    (``hqmedia/views.py::iter_app_files``, index files and multimedia both)."""
    from corehq.apps.hqmedia.views import iter_app_files

    from proof.hq import operations
    from proof.observe.build import ArrangementRefused, _bytes

    build = operations.held_app(served.unit, served.build_id)
    entries, errors, _ = iter_app_files(build, True, True, build_profile_id=None)
    # HQ's media errors are complete only once its iterator is exhausted (iter_media_files).
    entries = [(name, _bytes(content)) for name, content in entries]
    if errors:
        raise ArrangementRefused(errors)
    return _zipped(entries)


def stored_archive(archive_record, blobs) -> bytes | None:
    """A state's archive as its record keeps it (``proof.observe.build.archive_record``), zipped; None where it
    keeps none."""
    if not archive_record or not archive_record.get("entries"):
        return None
    return _zipped((name, blobs.get(digest)) for name, digest in archive_record["entries"].items())


def released(build) -> bool:
    """Whether HQ makes a release of a state from its recorded build (``proof.observe.runs.unbuildable``, read
    from the record: HQ's validation listed no error and raised nothing, and HQ wrote the build's files); no
    worker is ever handed an archive of a state HQ does not release."""
    if build is None:
        return False
    return (
        build.get("files") is not None and "validate_app" not in (build.get("raised") or {}) and not build.get("errors")
    )


def worker(served) -> dict:
    """The worker HQ made, as they sign in on Android: the name HQ gave them without the project space's, and
    their password."""
    from corehq.apps.users.util import raw_username

    from proof.formplayer.hq import PASSWORD

    return {"username": raw_username(served.worker.username), "password": PASSWORD}


def _answers() -> dict:
    return json.loads(ANSWERS.read_text(encoding="utf-8"))


def _read(served, blobs, label, op, archives: dict, options: dict, *, delivered: bool = False, sent=None) -> dict:
    from proof.android.hq import DevicePeer
    from proof.observe import services

    reader = services.android()
    peer = DevicePeer(served, label, delivered=delivered)
    with tempfile.TemporaryDirectory(prefix="proof-android-") as directory:
        arguments = dict(options)
        for role, content in archives.items():
            path = Path(directory, f"{role}.ccz")
            path.write_bytes(content)
            arguments[role] = str(path)
        if op == "installs":
            arguments = {"archives": [arguments.pop("first"), arguments.pop("second")], **arguments}
        try:
            answer = reader.request(op, peer=peer, worker=worker(served), **arguments)
        finally:
            peer.close()
    if sent is not None:
        # Each form the device sent HQ's receiver, as it sent it; its log reports are not forms.
        sent.extend(
            submission.instance for submission in peer.views.submissions if DEVICE_REPORT not in submission.instance
        )
    return {"answer": blobs.put_json(answer), "hq": blobs.put_json([asdict(asked) for asked in peer.exchanges])}


# What ``app`` is given for a device whose GPS gives the lane's own fix (``Sensors.java``).
LANE_FIX = "lane"
# The namespace of the log report a device sends its server beside its forms (``DeviceReportRecord``).
DEVICE_REPORT = b"http://code.javarosa.org/devicereport"


def app(
    served, blobs, *, label: str, archive: bytes, delivered: bool = False, fix=LANE_FIX, clock=None, sent=None
) -> dict:
    """The ``app`` request on ``archive`` over the served state; with ``delivered``, the device's restore and forms
    delivered to HQ's own addresses for the worker and the app (``proof.android.hq``); ``fix`` where the device's
    GPS puts it (``[latitude, longitude, altitude, accuracy]``, or None for a GPS that finds no fix); ``clock`` the
    device's instant where it is not the lane's; ``sent``, a list each form the device sent HQ is added to."""
    options = {"answers": _answers(), "queryAnswer": QUERY_ANSWER}
    if fix != LANE_FIX:
        options["position"] = fix
    if clock is not None:
        options["clock"] = clock
    return _read(served, blobs, label, "app", {"archive": archive}, options, delivered=delivered, sent=sent)


def installs(served, blobs, *, label: str, first: bytes, second: bytes) -> dict:
    """``first`` then ``second`` installed on one device."""
    return _read(served, blobs, label, "installs", {"first": first, "second": second}, {})


def update(served, blobs, *, label: str, before: bytes, after: bytes, incomplete: bool) -> dict:
    """A device on ``before`` updated to ``after``, over a worker's own settings, with every form left incomplete
    before it where ``incomplete``."""
    options = {"preferences": dict(WORKER_SETTINGS)}
    if incomplete:
        options["incompleteForms"] = True
    return _read(served, blobs, label, "update", {"archive": before, "update": after}, options)
