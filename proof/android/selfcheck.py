"""The Android reader held to itself, where the reader runs.

    python3 -m unittest proof.android.selfcheck -v

It needs a reader runtime (``PROOF_ANDROID_RUNTIME``, ``proof/android/README.md``) and ``java`` on the path, and
runs on the standard library alone, as everything the harness runs without its image does. It is not a
``test_*.py``: it runs where the runtime is built or restored (the job before the lane's shards, on the runner's
own Python), and holds the reader before any shard hands it a state.

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

from proof.android import observe
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

    def census(self, name, *, data="", binds="", model="", meta="", body=""):
        """The survey control's first form with nodes, binds, model actions, meta nodes and questions added, as
        HQ's build and Nova's export write each."""
        form = "modules-0/forms-0.xml"
        with zipfile.ZipFile(SURVEY / "local.ccz") as zipped:
            text = zipped.read(form).decode("utf-8")
        for old, new in (
            ("<head/>", "<head/>" + data),
            (
                '<bind nodeset="/data/head" type="xsd:string"/>',
                '<bind nodeset="/data/head" type="xsd:string"/>' + binds,
            ),
            ("<orx:drift/></orx:meta>", "<orx:drift/>" + meta + "</orx:meta>"),
            ("<itext>", model + "<itext>"),
            ("</input></h:body>", "</input>" + body + "</h:body>"),
        ):
            self.assertIn(old, text)
            text = text.replace(old, new, 1)
        return variant(SURVEY / "local.ccz", self.work / name, {form: text.encode("utf-8")})

    def test_a_walk_gives_every_capture_question_a_file_through_its_own_screen_and_the_form_saves(self):
        """Contract: an image, video, audio, signature and document question is answered as a worker answers it,
        through the question's own button and the screen Android opens for it (Captures.java), so a form whose
        capture questions are required saves, each answer written as the file given, never the name Android drew
        from its clock. Failure it catches: a capture question left unanswered (the walk then ends at it), given a
        text the form takes as its answer with no file behind it, or recorded under a name no other reading of the
        archive gives."""
        kinds = (
            ("photo", 'mediatype="image/*"', "image"),
            ("clip", 'mediatype="video/*"', "video"),
            ("voice", 'mediatype="audio/*"', "audio"),
            ("signed", 'mediatype="image/*" appearance="signature"', "signature"),
            ("scan", 'mediatype="application/*,text/*"', "file"),
        )
        archive = self.census(
            "captures.ccz",
            data="".join(f"<{node}/>" for node, _, _ in kinds),
            binds="".join(f'<bind nodeset="/data/{node}" type="binary" required="true()"/>' for node, _, _ in kinds),
            body="".join(
                f'<upload ref="/data/{node}" {media}><label>{node}</label></upload>' for node, media, _ in kinds
            ),
        )
        answers = json.loads(observe.ANSWERS.read_text(encoding="utf-8"))
        app = self.reader.request("app", archive=str(archive), commands=["m0-f0"], answers=answers)
        form = app["walks"]["m0-f0"]["steps"][0]["form"]
        given = {
            entry["reference"]: entry
            for screen in form["screens"]
            for entry in screen.get("answered", ())
            if "capture" in entry
        }
        for node, _, kind in kinds:
            entry = given[f"/data/{node}[1]"]
            self.assertEqual((entry["capture"], entry["taken"]), (kind, True), entry)
        self.assertEqual(form["ended"], "end")
        self.assertIs(form["saved"]["finishing"], True)
        shown = [question for screen in form["screens"] for question in screen.get("shown", ())]
        held = {question["reference"]: question["answer"] for question in shown}
        self.assertEqual(held["/data/photo[1]"], "@capture:proof-image.jpg")
        self.assertEqual(held["/data/scan[1]"], "@capture:proof-file.pdf")
        # Two readings of one archive give one record, though Android names each file by the moment it took it.
        again = self.reader.request("app", archive=str(archive), commands=["m0-f0"], answers=answers)
        self.assertEqual(again["walks"], app["walks"])

    def test_a_form_that_polls_the_location_sensor_is_given_the_fix_it_saves(self):
        """Contract: a form that polls the location sensor as it opens (HQ's build of an app with
        auto_gps_capture: ``orx:pollsensor`` on the meta's location) asks the device for the location permission,
        which the walk allows as the worker does, and the device's GPS fix is what Android saves in the form's
        meta (Sensors.java); the same form without the poll asks nothing and saves no location. Failure it
        catches: a fix the form never receives (no permission granted, no provider on, no fix given), or one the
        reader writes into the form itself."""
        polled = self.census(
            "polled.ccz",
            binds='<bind nodeset="/data/meta/location" type="geopoint"/>',
            model='<orx:pollsensor event="xforms-ready" ref="/data/meta/location"/>',
            meta="<cc:location/>",
        )
        plain = self.census("plain.ccz", meta="<cc:location/>")
        answers = json.loads(observe.ANSWERS.read_text(encoding="utf-8"))
        forms = {}
        for name, archive in (("polled", polled), ("plain", plain)):
            app = self.reader.request("app", archive=str(archive), commands=["m0-f0"], answers=answers)
            forms[name] = app["walks"]["m0-f0"]["steps"][0]["form"]
        asked = forms["polled"]["deviceAsked"][0]["permissions"]
        self.assertIn("android.permission.ACCESS_FINE_LOCATION", asked)
        self.assertEqual(forms["polled"]["deviceGave"]["location"], "12.9716 77.5946 920.0 5.0")
        self.assertEqual(
            [record.get("metaLocation") for record in forms["polled"]["saved"]["records"]],
            ["12.9716 77.5946 920.0 5.0"],
        )
        self.assertNotIn("deviceAsked", forms["plain"])
        self.assertEqual([record.get("metaLocation") for record in forms["plain"]["saved"]["records"]], [""])

    def test_a_request_the_reader_cannot_answer_raises(self):
        """Contract: no answer holds a failure of the reader's own. Failure it catches: a missing archive, an
        unknown request or a JVM stopped at its deadline recorded as something Android read. Each raises, and a
        request after them is answered."""
        with self.assertRaises(AndroidReaderError):
            self.reader.request("profile", archive=str(self.work / "no-such.ccz"))
        with self.assertRaises(AndroidReaderError):
            self.reader.request("no-such-request")
        with self.assertRaisesRegex(AndroidReaderError, "did not answer"):
            # No JVM starts and installs an app in a twentieth of a second.
            self.reader.request("profile", archive=str(SURVEY / "local.ccz"), deadline=0.05)
        self.assertEqual(self.reader.request("profile", archive=str(SURVEY / "local.ccz"))["install"], "Installed")


# A restore of one case of basic_tests.ccz's third menu and two cases its detail lists a row each of (a tab whose
# nodeset is the case's open children, and one of them alone): the input the reader is handed, as a device is
# handed a server's answer.
NODE_RESTORE = """<OpenRosaResponse xmlns="http://openrosa.org/http/response" items="4">
<message nature="ota_restore_success">Successfully restored account proof-node!</message>
<Sync xmlns="http://commcarehq.org/sync"><restore_id>proof-node-restore</restore_id></Sync>
<Registration xmlns="http://openrosa.org/user/registration"><username>proof-node</username>
<password>sha1$proof$0000000000000000000000000000000000000000</password><uuid>proof-node-id</uuid>
<date>2026-01-15</date><user_data/></Registration>
<case xmlns="http://commcarehq.org/case/transaction/v2" case_id="parent-1" date_modified="2026-01-15T10:30:00.000Z"
 user_id="proof-node-id"><create><case_type>coverage_basic</case_type><case_name>Ada</case_name>
<owner_id>proof-node-id</owner_id></create></case>
<case xmlns="http://commcarehq.org/case/transaction/v2" case_id="child-1" date_modified="2026-01-15T10:30:00.000Z"
 user_id="proof-node-id"><create><case_type>sub_case_one</case_type><case_name>First</case_name>
<owner_id>proof-node-id</owner_id></create><update><sub_case_number>1</sub_case_number></update>
<index><parent case_type="coverage_basic">parent-1</parent></index></case>
<case xmlns="http://commcarehq.org/case/transaction/v2" case_id="child-2" date_modified="2026-01-15T10:30:00.000Z"
 user_id="proof-node-id"><create><case_type>sub_case_one</case_type><case_name>Second</case_name>
<owner_id>proof-node-id</owner_id></create><update><sub_case_number>2</sub_case_number></update>
<index><parent case_type="coverage_basic">parent-1</parent></index></case>
</OpenRosaResponse>
"""


class DetailSelfCheck(unittest.TestCase):
    """A case detail's tabs, on an archive HQ built (commcare-android's own instrumentation tests install it)."""

    @classmethod
    def setUpClass(cls):
        reason = unavailable()
        if reason is not None:
            raise AndroidReaderUnavailable(reason)

    def test_a_detail_tab_that_lists_a_row_a_node_shows_a_row_for_each_node(self):
        """Contract: a detail tab whose nodeset lists a row a node is read as the app's own fragment shows it,
        a row for each node its nodeset gives in the chosen case's context. Failure it catches: such a tab named
        and its rows left unread, or rows read in the wrong case's context. basic_tests.ccz's third menu shows a
        case's open children on one tab and only the first of them on another; on a device holding one case
        with two children, the first tab shows both and the second one."""
        from proof.android.client import runtime_directory

        runtime = runtime_directory()
        workdir = Path(json.loads((runtime / "runtime.json").read_text(encoding="utf-8"))["workdir"])
        archive = workdir / "instrumentation-tests" / "resources" / "basic_tests.ccz"
        with tempfile.TemporaryDirectory(prefix="proof-android-detail-") as scratch, AndroidReader() as reader:
            restore = Path(scratch) / "restore.xml"
            restore.write_text(NODE_RESTORE, encoding="utf-8")
            app = reader.request("app", archive=str(archive), restore=str(restore), commands=["m3-case-list"])
        steps = app["walks"]["m3-case-list"]["steps"]
        detail = next(step["list"]["detail"] for step in steps if isinstance(step.get("list"), dict))
        node_tabs = [tab for tab in detail["tabs"] if tab.get("nodeset")]
        self.assertEqual(len(node_tabs), 2, detail)
        counts = sorted(len(tab["rows"]["rows"]) for tab in node_tabs)
        self.assertEqual(counts, [1, 2], node_tabs)
        texts = sorted(" ".join(row["texts"]) for tab in node_tabs for row in tab["rows"]["rows"])
        self.assertTrue(any("First" in text for text in texts) and any("Second" in text for text in texts), texts)


class JudgeSelfCheck(unittest.TestCase):
    """The judges, on what commcare-android's own code read: a planted difference Android must show."""

    @classmethod
    def setUpClass(cls):
        reason = unavailable()
        if reason is not None:
            raise AndroidReaderUnavailable(reason)

    def test_proof_3_reports_a_planted_difference_android_shows_and_nothing_where_the_archives_are_one(self):
        """Contract: proof 3's Android judge reports what commcare-android's own code reads differently of two
        archives, and nothing between two readings of one. Failure it catches: answers never compared, or
        compared with themselves, or a reading that differs from itself. With the same archive read twice the
        judge reports nothing; with one setting planted in the profile, it reports that setting's reader and
        the home screen's button, nothing else."""
        from proof.checks import android as judges

        answers = json.loads(observe.ANSWERS.read_text(encoding="utf-8"))
        with tempfile.TemporaryDirectory(prefix="proof-android-judge-") as scratch, AndroidReader() as reader:
            planted = with_property(SURVEY / "local.ccz", Path(scratch) / "planted.ccz", "cc-show-saved", "no")

            def read(archive):
                return reader.request("app", archive=str(archive), answers=answers)

            first, again, other = read(SURVEY / "local.ccz"), read(SURVEY / "local.ccz"), read(planted)

            def found(before, after):
                return [
                    (d.artifact, d.path, d.before, d.after)
                    for d in judges.app_differences(
                        before, after, check="proof3", document="planted", artifact=judges.LOCAL
                    )
                ]

            self.assertEqual(found(first, again), [])
            self.assertEqual(
                found(first, other),
                [
                    (judges.LOCAL, "/home/StandardHomeActivityUIController.getHiddenButtons/saved", None, True),
                    (judges.LOCAL, "/profile/readers/HiddenPreferences.isSavedFormsEnabled", True, False),
                ],
            )


if __name__ == "__main__":
    unittest.main()
