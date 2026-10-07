"""The Android reader held to itself, where the reader runs.

    python3 -m unittest proof.android.selfcheck -v

It needs a reader runtime (``PROOF_ANDROID_RUNTIME``, ``proof/android/README.md``) and ``java`` on the path, and
runs on the standard library alone, as everything the harness runs without its image does. It is not a
``test_*.py``: the lane's pytest collects the whole of ``proof/``, in an image that holds no reader runtime, and
a check that cannot run there must not be collected there. The job that runs the reader runs this first.

Each test names the contract it holds and the failure it would catch. The archives are real: Nova's own exports
kept as controls (``proof/controls``), and the archives HQ built that commcare-android's own instrumentation
tests install (``app/instrumentation-tests/resources``). A variant changes single entries of one.
"""

from __future__ import annotations

import json
import tempfile
import unittest
import zipfile
from pathlib import Path
from xml.etree import ElementTree

from proof.android import archives
from proof.android.client import AndroidReader, AndroidReaderError, AndroidReaderUnavailable, unavailable

CONTROLS = Path(__file__).resolve().parents[1] / "controls"
SURVEY = CONTROLS / "targeted-survey-menu"
PROFILE_NAMESPACE = "http://cihi.commcarehq.org/jad"


def variant(source: Path, target: Path, edits: dict) -> Path:
    """A copy of the archive with the named entries replaced (bytes) or left out (None)."""
    with zipfile.ZipFile(source) as original, zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as copy:
        names = {info.filename for info in original.infolist()}
        missing = set(edits) - names
        assert not missing, f"{source} has no entry {sorted(missing)}"
        for info in original.infolist():
            if info.filename not in edits:
                copy.writestr(info, original.read(info.filename))
            elif edits[info.filename] is not None:
                copy.writestr(info, edits[info.filename])
    return target


def with_property(archive: Path, target: Path, key: str, value: str) -> Path:
    """The archive with one more ``<property>`` in its profile."""
    ElementTree.register_namespace("", PROFILE_NAMESPACE)
    with zipfile.ZipFile(archive) as zipped:
        profile = ElementTree.fromstring(zipped.read("profile.ccpr"))
    setting = ElementTree.Element(f"{{{PROFILE_NAMESPACE}}}property", {"key": key, "value": value})
    profile.insert(0, setting)
    return variant(archive, target, {"profile.ccpr": ElementTree.tostring(profile, encoding="utf-8")})


def leaves(value, path=""):
    """Every leaf of a JSON value by its path."""
    if isinstance(value, dict):
        for key in sorted(value):
            yield from leaves(value[key], f"{path}/{key}")
    elif isinstance(value, list):
        for index, item in enumerate(value):
            yield from leaves(item, f"{path}/{index}")
    else:
        yield path, value


def differing(first, second) -> set[str]:
    a, b = dict(leaves(first)), dict(leaves(second))
    return {path for path in set(a) | set(b) if a.get(path, a) != b.get(path, b)}


class ReaderSelfCheck(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        reason = unavailable()
        if reason is not None:
            raise AndroidReaderUnavailable(reason)
        cls.scratch = tempfile.TemporaryDirectory(prefix="proof-android-selfcheck-")
        cls.work = Path(cls.scratch.name)
        cls.reader = AndroidReader()
        cls.reader.start()

    @classmethod
    def tearDownClass(cls):
        cls.reader.close()
        cls.scratch.cleanup()

    def test_a_profile_setting_changes_exactly_the_reader_that_reads_it(self):
        """Contract: a reader's value is what Android's own method gives for the installed profile. Failure it
        catches: a reader stubbed, defaulted or read from the wrong app, which would give the same value whatever
        the profile holds. One setting added to a profile moves that setting's reader, its stored value and
        nothing else; an archive without it reads Android's own default."""
        plain = self.reader.request("profile", archive=str(SURVEY / "local.ccz"))
        self.assertEqual(plain["install"], "Installed")
        self.assertIs(plain["profile"]["readers"]["HiddenPreferences.isSavedFormsEnabled"], True)
        self.assertIs(plain["profile"]["readers"]["MainConfigurablePreferences.isFuzzySearchEnabled"], False)
        cases = (
            ("cc-show-saved", "no", {"HiddenPreferences.isSavedFormsEnabled": False}),
            ("cc-fuzzy-search-enabled", "yes", {"MainConfigurablePreferences.isFuzzySearchEnabled": True}),
            ("cc-gps-auto-capture-accuracy", "5", {"HiddenPreferences.getGpsAutoCaptureAccuracy": 5}),
        )
        for key, value, expected in cases:
            with self.subTest(key=key):
                changed = self.reader.request(
                    "profile", archive=str(with_property(SURVEY / "local.ccz", self.work / f"{key}.ccz", key, value))
                )
                self.assertEqual(changed["install"], "Installed")
                wanted = {f"/profile/stored/{key}"} | {f"/profile/readers/{name}" for name in expected}
                self.assertEqual(differing(plain, changed), wanted)
                for name, reading in expected.items():
                    self.assertEqual(changed["profile"]["readers"][name], reading)

    def test_android_refuses_an_archive_it_cannot_install_and_installs_one_it_can(self):
        """Contract: the install status is Android's own. Failure it catches: a reader that reports Installed
        without installing. An archive whose suite is missing is refused by Android's resource engine, and the
        archive it was made from installs."""
        broken = variant(SURVEY / "local.ccz", self.work / "no-suite.ccz", {"suite.xml": None})
        refused = self.reader.request("profile", archive=str(broken))
        self.assertNotEqual(refused["install"], "Installed")
        self.assertNotIn("profile", refused)
        self.assertEqual(self.reader.request("profile", archive=str(SURVEY / "local.ccz"))["install"], "Installed")

    def test_one_device_refuses_the_same_app_twice_and_each_request_is_a_device_of_its_own(self):
        """Contract: installs within one request share a device, and no request sees another's. Failure it
        catches: a device reused across requests (the second request's install would be a duplicate), or installs
        in one request on separate devices (a duplicate would install). The same archive twice on one device is
        Android's DuplicateApp (ProfileAndroidInstaller.checkDuplicate), and the same archive in two requests
        installs both times."""
        archive = str(SURVEY / "local.ccz")
        twice = self.reader.request("installs", archives=[archive, archive])
        self.assertEqual([step["install"] for step in twice["installs"]], ["Installed", "DuplicateApp"])
        self.assertEqual(len(twice["installs"][1]["installedApps"]), 1)
        again = self.reader.request("installs", archives=[archive])
        self.assertEqual([step["install"] for step in again["installs"]], ["Installed"])

    def test_the_reader_walks_the_installed_app_through_androids_own_screens(self):
        """Contract: a walk is what Android's home activity and form entry do with the installed suite. Failure
        it catches: a walk that names commands it did not open. Every command of the suite opens Android's form
        entry on the form the suite names for it, with the title the form holds, and for a command the suite does
        not hold Android opens its menu to ask for one, and no form."""
        app = self.reader.request("app", archive=str(SURVEY / "local.ccz"), commands=["m0-f0", "m0-f1", "absent"])
        self.assertEqual(app["install"], "Installed")
        titles = {}
        for command in ("m0-f0", "m0-f1"):
            step = app["walks"][command]["steps"][0]
            self.assertEqual(step["screen"], "FormEntryActivity")
            self.assertIs(step["form"]["loaded"], True)
            titles[command] = step["form"]["formTitle"]
        self.assertEqual(titles, {"m0-f0": "Census", "m0-f1": "Water"})
        self.assertEqual([step["screen"] for step in app["walks"]["absent"]["steps"]], ["MenuActivity"])

    def test_a_request_the_reader_cannot_answer_raises(self):
        """Contract: no answer holds a failure of the reader's own. Failure it catches: a missing archive or an
        unknown request recorded as something Android read. Both raise, and a request after them is answered."""
        with self.assertRaises(AndroidReaderError):
            self.reader.request("profile", archive=str(self.work / "no-such.ccz"))
        with self.assertRaises(AndroidReaderError):
            self.reader.request("no-such-request")
        self.assertEqual(self.reader.request("profile", archive=str(SURVEY / "local.ccz"))["install"], "Installed")


class ArchiveSelfCheck(unittest.TestCase):
    def test_a_materialized_archive_is_the_same_bytes_each_time_and_holds_the_stores_entries(self):
        """Contract: an archive made from a store is a function of its entries. Failure it catches: an entry
        dropped, renamed or reordered, or a timestamp that moves the bytes. Two materializations of one record
        are byte for byte alike and hold each named entry's bytes; a blob the store lacks is refused."""
        from proof.store import disk

        with tempfile.TemporaryDirectory(prefix="proof-android-selfcheck-") as scratch:
            store = Path(scratch) / "store"
            delta = disk.Delta(store)
            entries = {"profile.ccpr": delta.put_blob(b"<profile/>"), "suite.xml": delta.put_blob(b"<suite/>")}
            record = {"kind": "a", "state": {"archive": {"entries": entries}}}
            delta.put(
                "documents",
                "d" * 64,
                {
                    "group": "corpus:example",
                    "parts": {"minimum/a": ["k" * 64, delta.put_blob(json.dumps(record).encode())]},
                },
            )
            listed = archives.document_archives(store, "example")
            self.assertEqual([archive.name for archive in listed], ["minimum/A"])
            first = archives.materialize(store, listed[0], Path(scratch) / "one.ccz").read_bytes()
            second = archives.materialize(store, listed[0], Path(scratch) / "two.ccz").read_bytes()
            self.assertEqual(first, second)
            with zipfile.ZipFile(Path(scratch) / "one.ccz") as zipped:
                self.assertEqual(
                    {name: zipped.read(name) for name in zipped.namelist()},
                    {"profile.ccpr": b"<profile/>", "suite.xml": b"<suite/>"},
                )
            missing = archives.Archive("minimum/A", entries={"suite.xml": "sha256:" + "0" * 64})
            with self.assertRaises(archives.StoreIncomplete):
                archives.materialize(store, missing, Path(scratch) / "three.ccz")


if __name__ == "__main__":
    unittest.main()
