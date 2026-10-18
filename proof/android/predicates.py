"""What CommCare Android reads of a difference the register or a spelling rule rests on, each run over both
spellings of it.

    python3 -m unittest proof.android.predicates -v

A register entry whose harm is on a device, and a spelling rule one of whose readers is Android
(``proof.rules.SpellingRule.readers``, which names its test here), each rest on what Android's own code reads of
two spellings of one artifact (a profile property present or absent, a tile cell's style, a
form's ``xmlns``). Each test here installs both spellings on Android and holds what Android's own code reads of
each: the spelling Nova exports is a retained control's archive (``proof/controls``), and the other is that
archive with exactly the entry's difference written into it. So each test says, by a run of Android's own
classes, whether the two spellings differ for a worker and how.

Every predicate is held here by one archive edit: the element HQ's build spells one way and Nova's local
archive another (a hidden sort column's header, an image column's width, the claim a sync-on-form-entry build
posts before a form, a list's sort keys) is written into the control's archive exactly as HQ's build of that
control spells it, so the two archives differ in that element alone. The lane's shards hold the same
predicates on HQ's own releases of every document, read by a device beside HQ's unit, as register entries
(``android@...``); these say, wherever the reader runs, which element each rests on.

It needs a reader runtime (``PROOF_ANDROID_RUNTIME``) and ``java``, and the standard library alone. Like
``selfcheck.py`` it is not a ``test_*.py``: it runs where the runtime is built or restored, before any shard
starts, on the runner's own Python.
"""

from __future__ import annotations

import json
import tempfile
import unittest
import zipfile
from pathlib import Path
from xml.etree import ElementTree

from proof.android.client import AndroidReader, AndroidReaderUnavailable, unavailable
from proof.android.selfcheck import (
    CONTROLS,
    PROFILE_NAMESPACE,
    differing,
    edited,
    leaves,
    variant,
    with_property,
)

FIXTURES = Path(__file__).resolve().parent / "fixtures"
ANSWERS = Path(__file__).resolve().parents[1] / "core" / "answers.json"
SURVEY = CONTROLS / "targeted-survey-menu" / "local.ccz"
SURVEY_AGAIN = CONTROLS / "targeted-survey-menu" / "local-again.ccz"
TILE = CONTROLS / "targeted-custom-tile"
LABELLED_REPEAT = CONTROLS / "targeted-labelled-group-repeat" / "local.ccz"
INLINE_LIST = CONTROLS / "case-list-inline" / "local.ccz"
INLINE_LIST_RESTORE = FIXTURES / "case-list-inline.restore.xml"
OPERATION_QUERY = CONTROLS / "case-operation-query" / "local.ccz"
OPERATION_QUERY_RESTORE = FIXTURES / "case-operation-query.restore.xml"
SYNC_ON_ENTRY = CONTROLS / "targeted-sync-on-form-entry" / "local.ccz"
SYNC_ON_ENTRY_RESTORE = FIXTURES / "targeted-sync-on-form-entry.restore.xml"
SEARCH_COMPILE = CONTROLS / "targeted-search-hq-compile" / "local.ccz"
CONNECT_DELIVER = CONTROLS / "targeted-connect-deliver-rename" / "local.ccz"
VALIDATED = CONTROLS / "targeted-validated-barcode-secret" / "local.ccz"
# Two selects over tables tagged with the words Core reads as its own data, as Nova emitted them before step 2.
RESERVED_TAGS = CONTROLS / "targeted-lookup-reserved-tags" / "local.ccz"
# A follow-up form over a patient holding an image question and a File question; its patients are the operation
# query's restore's.
CAPTURE = CONTROLS / "case-capture-followup" / "local.ccz"
# The control's two uploads share a field list that is relevant only where its first question is answered ``yes``.
CAPTURES_SHOWN = {"/data/show": "yes"}
# Nova's local archive of a form that names media in every slot, its files bundled.
MEDIA_ONLY = CONTROLS / "media-only" / "local.ccz"
# The edit's pre-fix archive of the control, which holds two suffixed language codes (defect 1's).
SUFFIXED_LANGUAGES = CONTROLS / "targeted-hq-side-state" / "edit" / "local.ccz"
# The settings Android's own settings screen lets a worker change, of those the reader records.
WORKER_SETTABLE = {"cc-fuzzy-search-enabled", "cc-enable-tts", "cc-autoup-freq"}

# Each profile setting an entry's difference is, with the value HQ's profile gives it: the readers it moves from
# what Android gives where the setting is absent (Nova's local profile) to what it gives where it is present,
# and the readers that give the same on a device that installs either (forced at an update only, or written at
# the value its reader gives where it is absent).
MOVES = (
    ("cc-show-saved", "no", {"HiddenPreferences.isSavedFormsEnabled": (True, False)}),
    ("cc-show-incomplete", "no", {"HiddenPreferences.isIncompleteFormsEnabled": (True, False)}),
    ("cc-fuzzy-search-enabled", "yes", {"MainConfigurablePreferences.isFuzzySearchEnabled": (False, True)}),
    ("cc-gps-auto-capture-accuracy", "5", {"HiddenPreferences.getGpsAutoCaptureAccuracy": (10, 5)}),
)
SAME = (
    ("cc-enable-tts", "no", {"MainConfigurablePreferences.isTTSEnabled": False}),
    ("cc-autoup-freq", "freq-never", {"UpdateHelper.getAutoUpdateFrequency": "freq-never"}),
    ("cc-autosync-freq", "freq-never", {"PendingCalcs.getPendingSyncStatus": False}),
    ("cc-days-form-retain", "-1", {"PurgeStaleArchivedFormsTask.getArchivedFormsValidityInDays": -1}),
    ("cc-inflation-target-density", "none", {"HiddenPreferences.isSmartInflationEnabled": False}),
    (
        "cc-label-required-questions-with-asterisk",
        "no",
        {"HiddenPreferences.shouldLabelRequiredQuestionsWithAsterisk": False},
    ),
    ("cc-login-duration-seconds", "86400", {"HiddenPreferences.getLoginDuration": 86400}),
    ("cc-maps-default-layer", "normal", {"HiddenPreferences.getMapsDefaultLayer": "NORMAL"}),
    ("cc-resize-images", "none", {"HiddenPreferences.getResizeMethod": "none"}),
    ("logenabled", "Enabled", {"HiddenPreferences.getLogsEnabled": "Enabled"}),
    # The smallest number of unsent forms, and of days since a sync, the reader counts as over the limit.
    ("unsent-number-limit", "5", {"SyncDetailCalculations.unsentFormNumberLimitExceeded": 6}),
    ("unsent-time-limit", "5", {"SyncDetailCalculations.unsentFormTimeLimitExceeded": 5}),
)


PROFILE_VERSION_1 = '<profile xmlns="http://cihi.commcarehq.org/jad" version="1"'
PROFILE_VERSION_2 = '<profile xmlns="http://cihi.commcarehq.org/jad" version="2"'

# The fifteen settings every Nova app states, at the value a device reads where a profile names none, each with the
# force HQ's own settings give it (lib/commcare/appProfileSettings.ts::appProfileProperties; finding 40),
# and the reader that answers from it.
NOVA_SETTINGS = (
    ("cc-fuzzy-search-enabled", "no", True, "MainConfigurablePreferences.isFuzzySearchEnabled"),
    ("cc-gps-auto-capture-accuracy", "10", True, "HiddenPreferences.getGpsAutoCaptureAccuracy"),
    ("cc-content-valid", "no", True, "CommCareApp.areMMResourcesValidated"),
    ("cc-autoup-freq", "freq-never", True, "UpdateHelper.getAutoUpdateFrequency"),
    ("cc-enable-tts", "no", True, "MainConfigurablePreferences.isTTSEnabled"),
    ("cc-autosync-freq", "freq-never", True, "PendingCalcs.getPendingSyncStatus"),
    ("cc-days-form-retain", "-1", True, "PurgeStaleArchivedFormsTask.getArchivedFormsValidityInDays"),
    ("cc-inflation-target-density", "none", True, "HiddenPreferences.isSmartInflationEnabled"),
    (
        "cc-label-required-questions-with-asterisk",
        "no",
        True,
        "HiddenPreferences.shouldLabelRequiredQuestionsWithAsterisk",
    ),
    ("cc-login-duration-seconds", "86400", True, "HiddenPreferences.getLoginDuration"),
    ("cc-maps-default-layer", "normal", False, "HiddenPreferences.getMapsDefaultLayer"),
    ("cc-resize-images", "none", True, "HiddenPreferences.getResizeMethod"),
    ("logenabled", "Enabled", True, "HiddenPreferences.getLogsEnabled"),
    ("unsent-number-limit", "5", True, "SyncDetailCalculations.unsentFormNumberLimitExceeded"),
    ("unsent-time-limit", "5", True, "SyncDetailCalculations.unsentFormTimeLimitExceeded"),
)
# A project space's four server properties as Nova's profile writes them (runtimeTarget.ts::profileServerProperties).
SERVER = "https://www.commcarehq.org"


def server_properties(domain: str, app_id: str) -> tuple:
    return (
        ("ota-restore-url", f"{SERVER}/a/{domain}/phone/restore/{app_id}/"),
        ("PostURL", f"{SERVER}/a/{domain}/receiver/{app_id}/"),
        ("key_server", f"{SERVER}/a/{domain}/phone/keys/"),
        ("cc_user_domain", f"{domain}.commcarehq.org"),
    )


def with_settings(archive: Path, target: Path, settings, *, version: str | None = None) -> Path:
    """The archive with each setting of ``settings`` (``(key, value, force)``) written into its profile, and, with
    ``version``, the profile at that version (its suite resource with it, so the device stages it as the next)."""
    replacements = []
    if version is not None:
        replacements += [
            (PROFILE_VERSION_1, PROFILE_VERSION_1.replace('version="1"', f'version="{version}"')),
            ('<resource id="suite" version="1"', f'<resource id="suite" version="{version}"'),
        ]
    written = "".join(
        f'<property key="{key}" value="{value}"' + (' force="true"' if force else "") + "/>"
        for key, value, force in settings
    )
    replacements.append(("<features>", written + "<features>"))
    return edited(archive, target, "profile.ccpr", replacements)


def planned(
    archive: Path,
    target: Path,
    sequence: int,
    *,
    unique_id: str,
    version: int | None = None,
    server: tuple = (),
    form_text: tuple | None = None,
) -> Path:
    """The pre-fix archive with step 2's profile and versions written in (the local profile from step 2):
    the profile's ``uniqueid``, its ``version`` and both suite resources' at the archive's version (``version``,
    the sequence where none is given), the required version, ``cc-content-version`` and ``cc-app-version`` at the
    sequence, the server properties ``server`` names; ``<suite version>`` at the archive's version and every form
    and locale resource at the sequence; each form's data node at the sequence; and, with ``form_text``, the first
    form's text ``(old, new)`` changed."""
    archive_version = str(version if version is not None else sequence)
    ElementTree.register_namespace("", PROFILE_NAMESPACE)
    with zipfile.ZipFile(archive) as zipped:
        entries = {name: zipped.read(name) for name in zipped.namelist()}
    profile = ElementTree.fromstring(entries["profile.ccpr"])
    profile.attrib.update(
        {
            "version": archive_version,
            "uniqueid": unique_id,
            "requiredMajor": "2",
            "requiredMinor": "57",
            "requiredMinimal": "0",
        }
    )
    for element in profile.iter(f"{{{PROFILE_NAMESPACE}}}property"):
        if element.get("key") in ("cc-content-version", "cc-app-version"):
            element.set("value", str(sequence))
    for position, (key, value) in enumerate(server):
        element = ElementTree.Element(f"{{{PROFILE_NAMESPACE}}}property", {"key": key, "value": value, "force": "true"})
        profile.insert(3 + position, element)
    for resource in profile.iter(f"{{{PROFILE_NAMESPACE}}}resource"):
        resource.set("version", archive_version)
    suite = ElementTree.fromstring(entries["suite.xml"])
    suite.set("version", archive_version)
    for kind in ("xform", "locale"):
        for resource in suite.iterfind(f"{kind}/resource"):
            resource.set("version", str(sequence))
    edits = {
        "profile.ccpr": ElementTree.tostring(profile, encoding="utf-8"),
        "suite.xml": ElementTree.tostring(suite, encoding="utf-8"),
    }
    for name in sorted(entries):
        if name.startswith("modules-") and name.endswith(".xml"):
            text = entries[name].decode("utf-8")
            data = ' uiVersion="1" version="1" '
            assert text.count(data) == 1, f"{archive}'s {name} holds no data node at version 1"
            text = text.replace(data, f' uiVersion="1" version="{sequence}" ')
            if form_text is not None and name == "modules-0/forms-0.xml":
                assert form_text[0] in text, f"{archive}'s {name} does not hold {form_text[0]!r}"
                text = text.replace(form_text[0], form_text[1])
            edits[name] = text.encode("utf-8")
    return variant(archive, target, edits)


def given(answer) -> dict:
    """Each question a walk answered, by its reference: what the form took and what it refused."""
    found = {}

    def visit(value):
        if isinstance(value, dict):
            if "reference" in value and "given" in value:
                found[value["reference"]] = {"given": value["given"], "refused": value.get("refused", [])}
            for inner in value.values():
                visit(inner)
        elif isinstance(value, list):
            for inner in value:
                visit(inner)

    visit(answer)
    return found


def with_entries(archive: Path, target: Path, entries: dict) -> Path:
    """The archive with more entries (each name to its bytes), none of which it holds already."""
    with zipfile.ZipFile(archive) as original, zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as copy:
        held = {info.filename for info in original.infolist()}
        assert not held & set(entries), f"{archive} already holds {sorted(held & set(entries))}"
        for info in original.infolist():
            copy.writestr(info, original.read(info.filename))
        for name, content in sorted(entries.items()):
            copy.writestr(zipfile.ZipInfo(name, (2026, 1, 1, 0, 0, 0)), content)
    return target


def without_entry(archive: Path, target: Path, name: str) -> Path:
    """The archive without the entry ``name``, which it must hold."""
    with zipfile.ZipFile(archive) as original, zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as copy:
        held = [info for info in original.infolist() if info.filename != name]
        assert len(held) == len(original.infolist()) - 1, f"{archive} holds no {name}"
        for info in held:
            copy.writestr(info, original.read(info.filename))
    return target


def view_classes(view) -> set:
    """Every view class a screen's view tree names, the screen's own included."""
    found = set()

    def visit(node):
        if isinstance(node, dict):
            if isinstance(node.get("class"), str):
                found.add(node["class"])
            for child in node.get("children") or ():
                visit(child)

    visit(view)
    return found


def with_language_code(archive: Path, target: Path, old: str, new: str, *, name_key: bool = True) -> Path:
    """The archive with the language ``old`` named ``new`` in every place the archive names a language by its
    code: its own member (``<old>/app_strings.txt``, renamed), the suite's ``<locale language>``, resource id and
    location, each form's ``<translation lang>``, the key of each app strings member that names the language
    (``<old>=<name>``) and its own member's ``lang.current``, both where ``name_key``. No member keeps ``old``
    where ``name_key``."""
    own = f"{old}/app_strings.txt"
    with zipfile.ZipFile(archive) as original, zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as copy:
        names = [info.filename for info in original.infolist()]
        assert own in names, f"{archive} holds no {own}"
        for info in original.infolist():
            data = original.read(info.filename)
            name = info.filename
            if name == "suite.xml":
                text = data.decode("utf-8")
                for before, after in (
                    (f'<locale language="{old}">', f'<locale language="{new}">'),
                    (f'id="app_strings_{old}"', f'id="app_strings_{new}"'),
                    (f"./{old}/app_strings.txt", f"./{new}/app_strings.txt"),
                ):
                    assert before in text, f"{archive}'s suite does not hold {before!r}"
                    text = text.replace(before, after)
                data = text.encode("utf-8")
            elif name.endswith(".xml") and f'lang="{old}"'.encode() in data:
                data = data.replace(f'<translation lang="{old}"'.encode(), f'<translation lang="{new}"'.encode())
            elif name.endswith("/app_strings.txt"):
                lines = data.decode("utf-8").split("\n")
                for index, line in enumerate(lines):
                    if name_key and line.startswith(f"{old}="):
                        lines[index] = f"{new}={line[len(old) + 1 :]}"
                    elif name_key and name == own and line == f"lang.current={old}":
                        lines[index] = f"lang.current={new}"
                data = "\n".join(lines).encode("utf-8")
                if name == own:
                    name = f"{new}/app_strings.txt"
            copy.writestr(zipfile.ZipInfo(name, info.date_time), data)
    if name_key:
        with zipfile.ZipFile(target) as written:
            held = [info.filename for info in written.infolist() if old in info.filename]
            held += [info.filename for info in written.infolist() if old.encode() in written.read(info.filename)]
        assert not held, f"{target} still names {old} in {sorted(set(held))}"
    return target


def with_runtime_urls(archive: Path, target: Path, app_id: str) -> Path:
    """The archive with its search URL naming ``app_id`` in place of the placeholder a pre-fix archive names, and
    the four server properties Nova's profile writes for its project space after ``cc-app-version``, each
    forced (``lib/commcare/runtimeTarget.ts::profileServerProperties``), naming ``app_id`` where they name the
    app."""
    base, domain = "https://www.commcarehq.org", "nova-proof"
    properties = "".join(
        f'<property key="{key}" value="{value}" force="true"/>'
        for key, value in (
            ("ota-restore-url", f"{base}/a/{domain}/phone/restore/{app_id}/"),
            ("PostURL", f"{base}/a/{domain}/receiver/{app_id}/"),
            ("key_server", f"{base}/a/{domain}/phone/keys/"),
            ("cc_user_domain", f"{domain}.commcarehq.org"),
        )
    )
    version = '<property key="cc-app-version" value="1"/>'
    with zipfile.ZipFile(archive) as zipped:
        suite = zipped.read("suite.xml").decode("utf-8")
        profile = zipped.read("profile.ccpr").decode("utf-8")
    search = f"{base}/a/{domain}/phone/search/__APP_ID__/"
    assert search in suite and version in profile, f"{archive} names no placeholder search URL or app version"
    return variant(
        archive,
        target,
        {
            "suite.xml": suite.replace(search, search.replace("__APP_ID__", app_id)).encode("utf-8"),
            "profile.ccpr": profile.replace(version, version + properties).encode("utf-8"),
        },
    )


def cells(view) -> list[dict]:
    """Each text or image view under ``view``, as Android built it."""
    found = []
    if "text" in view or "scaleType" in view:
        found.append({key: view[key] for key in ("class", "gravity", "textSize", "scaleType") if key in view})
    for child in view.get("children", ()):
        found.extend(cells(child))
    return found


class Predicates(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        reason = unavailable()
        if reason is not None:
            raise AndroidReaderUnavailable(reason)
        cls.scratch = tempfile.TemporaryDirectory(prefix="proof-android-predicates-")
        cls.work = Path(cls.scratch.name)
        cls.reader = AndroidReader()
        cls.reader.start()
        cls.plain = cls.reader.request("profile", archive=str(SURVEY))

    @classmethod
    def tearDownClass(cls):
        cls.reader.close()
        cls.scratch.cleanup()

    def profile_with(self, key, value):
        return self.reader.request("profile", archive=str(with_property(SURVEY, self.work / f"{key}.ccz", key, value)))

    def test_a_profile_setting_hq_writes_and_nova_omits_moves_its_reader(self):
        """Defects 7 and 40. Contract: where HQ's profile holds one of these settings and Nova's local profile
        holds none, Android's reader gives a different value on each install. Failure it catches: a register
        entry that claims a harm Android does not show, or a reader that defaults to HQ's value."""
        for key, value, readers in MOVES:
            with self.subTest(key=key):
                present = self.profile_with(key, value)
                for name, (absent_reads, present_reads) in readers.items():
                    self.assertEqual(self.plain["profile"]["readers"][name], absent_reads)
                    self.assertEqual(present["profile"]["readers"][name], present_reads)
                wanted = {f"/profile/stored/{key}"} | {f"/profile/readers/{name}" for name in readers}
                self.assertEqual(differing(self.plain, present), wanted)

    def test_a_profile_setting_written_at_its_readers_default_reads_alike(self):
        """Finding 40. Contract: where HQ's app settings save writes one of these settings at the value its
        reader gives when it is absent, a device that installs either profile reads the two alike: the stored
        value differs and no reader does. Failure it catches: a setting whose default is not the value HQ
        writes."""
        for key, value, readers in SAME:
            with self.subTest(key=key):
                present = self.profile_with(key, value)
                for name, reading in readers.items():
                    self.assertEqual(self.plain["profile"]["readers"][name], reading)
                    self.assertEqual(present["profile"]["readers"][name], reading)
                self.assertEqual(differing(self.plain, present), {f"/profile/stored/{key}"})

    def test_a_default_forced_over_a_value_an_earlier_profile_gave_replaces_it(self):
        """Finding 40, the ten settings HQ's save writes at their readers' defaults. Contract: Android's own
        settings screen lets a worker change none of the ten, so a device holds another value of one only from
        an earlier profile of the app; a device that holds none reads an update that forces the default as it
        reads an update that names none, and a device that holds another keeps it where the update names none
        and loses it where the update forces the default. So the two profiles are one to a device that never
        held another value and two to a device that did. Failure it catches: calling the two spellings
        equivalent on every device, or a worker's own setting being among the ten."""
        ten = [(key, value, readers) for key, value, readers in SAME if key not in WORKER_SETTABLE]
        self.assertEqual(len(ten), 10)
        self.assertEqual(set(self.plain["profile"]["settings"]["MainConfigurablePreferences"]), WORKER_SETTABLE)
        forced = "".join(
            f'<property key="{key}" value="{value}"'
            + ("" if key == "cc-maps-default-layer" else ' force="true"')
            + "/>"
            for key, value, _ in ten
        )
        held = {
            "cc-autosync-freq": "freq-daily",
            "cc-days-form-retain": "7",
            "cc-login-duration-seconds": "100",
            "logenabled": "Disabled",
            "unsent-number-limit": "1",
        }
        after = {}
        for label, settings in (("absent", ""), ("forced", forced)):
            update = edited(
                SURVEY,
                self.work / f"defaults-{label}.ccz",
                "profile.ccpr",
                [(PROFILE_VERSION_1, PROFILE_VERSION_2), ("<features>", settings + "<features>")],
            )
            for device, stored in (("fresh", {}), ("held", held)):
                answer = self.reader.request("update", archive=str(SURVEY), update=str(update), preferences=stored)
                self.assertEqual((answer["staged"], answer["updated"]), ("UpdateStaged", "Installed"))
                after[label, device] = answer["after"]["readers"]
        self.assertEqual(after["absent", "fresh"], after["forced", "fresh"])
        moved = {
            name for name in after["absent", "held"] if after["absent", "held"][name] != after["forced", "held"][name]
        }
        self.assertEqual(
            moved,
            {
                "HiddenPreferences.getLoginDuration",
                "HiddenPreferences.getLogsEnabled",
                "HiddenPreferences.isLoggingEnabled",
                "PendingCalcs.getPendingSyncStatus",
                "PurgeStaleArchivedFormsTask.getArchivedFormsValidityInDays",
                "SyncDetailCalculations.unsentFormNumberLimitExceeded",
            },
        )
        self.assertEqual(after["absent", "held"]["HiddenPreferences.getLoginDuration"], 100)
        self.assertEqual(after["forced", "held"]["HiddenPreferences.getLoginDuration"], 86400)

    def test_the_media_check_is_skipped_where_the_profile_calls_its_content_valid(self):
        """Defect 40, ``cc-content-valid``. Contract: Android counts an app's media validated, from the moment
        it is installed, where the profile says so, and not otherwise. Failure it catches: the reader forced by
        the harness (the project's own test installer marks every app validated)."""
        present = self.profile_with("cc-content-valid", "yes")
        self.assertIs(self.plain["areMMResourcesValidatedAfterInstall"], False)
        self.assertIs(present["areMMResourcesValidatedAfterInstall"], True)
        self.assertIs(self.plain["profile"]["readers"]["CommCareApp.areMMResourcesValidated"], False)
        self.assertIs(present["profile"]["readers"]["CommCareApp.areMMResourcesValidated"], True)

    def test_a_profile_without_a_current_locale_starts_in_the_default_locale(self):
        """Finding 39. Contract: Android starts an app in the locale its profile names, ``default`` where it
        names none, and its language picker offers the same languages either way. Failure it catches: a claim
        that the picker differs."""
        named = self.profile_with("cur_locale", "en")
        self.assertEqual(self.plain["profile"]["locale"]["Localization.getCurrentLocale"], "default")
        self.assertEqual(named["profile"]["locale"]["Localization.getCurrentLocale"], "en")
        for name in ("ChangeLocaleUtil.getLocaleCodes", "ChangeLocaleUtil.getLocaleNames"):
            self.assertEqual(self.plain["profile"]["locale"][name], named["profile"]["locale"][name])

    def test_two_exports_of_one_document_install_as_two_apps(self):
        """Defect 9. Contract: Android knows an app by its profile's ``uniqueid``
        (``ProfileAndroidInstaller.checkDuplicate``, ``AppUtils.getAppById``), so two exports that carry
        different ids install side by side, and one export installed twice is refused as a duplicate. Failure it
        catches: duplicate detection that reads something else of the profile."""
        two = self.reader.request("installs", archives=[str(SURVEY), str(SURVEY_AGAIN)])
        self.assertEqual([step["install"] for step in two["installs"]], ["Installed", "Installed"])
        self.assertEqual(len(set(two["installs"][1]["installedApps"])), 2)
        same = self.reader.request("installs", archives=[str(SURVEY), str(SURVEY)])
        self.assertEqual([step["install"] for step in same["installs"]], ["Installed", "DuplicateApp"])

    def test_an_archive_that_requires_a_newer_commcare_neither_installs_nor_updates(self):
        """The version floor. Contract: a profile's ``requiredMajor`` and ``requiredMinor`` name the oldest CommCare
        that may run the app, so an archive requiring 2.57, the floor Nova's apps are built to
        (``lib/commcare/versionFloor.ts``), installs and updates, and one requiring a CommCare newer than the
        device's neither installs nor stages as an update (``IncompatibleReqs``), the device staying on the version
        it had. Failure it catches: a requirement Android does not read, so a build HQ makes below the floor, or
        one above the device, reaches a worker."""

        def requiring(version, base):
            major, minor = version.split(".")
            return f'{base} requiredMajor="{major}" requiredMinor="{minor}"'

        installs, updates = {}, {}
        for version in ("2.57", "2.99", "3.0"):
            install = edited(
                SURVEY,
                self.work / f"requires-{version}.ccz",
                "profile.ccpr",
                [(PROFILE_VERSION_1, requiring(version, PROFILE_VERSION_1))],
            )
            update = edited(
                SURVEY,
                self.work / f"requires-{version}-update.ccz",
                "profile.ccpr",
                [(PROFILE_VERSION_1, requiring(version, PROFILE_VERSION_2))],
            )
            installed = self.reader.request("installs", archives=[str(install)])
            installs[version] = [step["install"] for step in installed["installs"]]
            answer = self.reader.request("update", archive=str(SURVEY), update=str(update))
            updates[version] = answer
        self.assertEqual(installs, {"2.57": ["Installed"], "2.99": ["IncompatibleReqs"], "3.0": ["IncompatibleReqs"]})
        self.assertEqual((updates["2.57"]["staged"], updates["2.57"]["updated"]), ("UpdateStaged", "Installed"))
        for version in ("2.99", "3.0"):
            self.assertEqual(updates[version]["staged"], "IncompatibleReqs", version)
            self.assertEqual(updates[version]["after"]["readers"], updates[version]["before"]["readers"], version)

    def test_a_forced_setting_overrides_a_workers_own_at_an_update(self):
        """Defect 40, the settings forced at every update. Contract: a setting the next profile forces replaces
        what a worker chose on the device when the device updates, and one it does not force leaves the worker's
        choice. Failure it catches: an update that never rereads the profile's settings, or one that forces
        every setting."""
        chosen = {"cc-enable-tts": "yes"}
        results = {}
        for label, setting in (
            ("forced", '<property key="cc-enable-tts" value="no" force="true"/>'),
            ("offered", '<property key="cc-enable-tts" value="no"/>'),
        ):
            update = edited(
                SURVEY,
                self.work / f"update-{label}.ccz",
                "profile.ccpr",
                [(PROFILE_VERSION_1, PROFILE_VERSION_2), ("<features>", setting + "<features>")],
            )
            results[label] = self.reader.request("update", archive=str(SURVEY), update=str(update), preferences=chosen)
            self.assertEqual((results[label]["staged"], results[label]["updated"]), ("UpdateStaged", "Installed"))
            self.assertIs(results[label]["before"]["readers"]["MainConfigurablePreferences.isTTSEnabled"], True)
        self.assertIs(results["forced"]["after"]["readers"]["MainConfigurablePreferences.isTTSEnabled"], False)
        self.assertIs(results["offered"]["after"]["readers"]["MainConfigurablePreferences.isTTSEnabled"], True)
        # Nova's seventeen at a higher version: the three settings a worker can also set and Nova forces read Nova's
        # values again, and the map layer, which Nova writes without force, keeps the worker's.
        chosen = {
            "cc-fuzzy-search-enabled": "yes",
            "cc-enable-tts": "yes",
            "cc-autoup-freq": "freq-daily",
            "cc-maps-default-layer": "satellite",
        }
        seventeen = [
            *((key, value, force) for key, value, force, _ in NOVA_SETTINGS),
            ("cc-show-saved", "no", True),
            ("cc-show-incomplete", "yes", True),
        ]
        update = with_settings(SURVEY, self.work / "update-seventeen.ccz", seventeen, version="2")
        answer = self.reader.request("update", archive=str(SURVEY), update=str(update), preferences=chosen)
        self.assertEqual((answer["staged"], answer["updated"]), ("UpdateStaged", "Installed"))
        before, after = answer["before"]["readers"], answer["after"]["readers"]
        self.assertEqual(
            {
                name: (before[name], after[name])
                for name in (
                    "MainConfigurablePreferences.isFuzzySearchEnabled",
                    "MainConfigurablePreferences.isTTSEnabled",
                    "UpdateHelper.getAutoUpdateFrequency",
                    "HiddenPreferences.getMapsDefaultLayer",
                )
            },
            {
                "MainConfigurablePreferences.isFuzzySearchEnabled": (True, False),
                "MainConfigurablePreferences.isTTSEnabled": (True, False),
                "UpdateHelper.getAutoUpdateFrequency": ("freq-daily", "freq-never"),
                "HiddenPreferences.getMapsDefaultLayer": ("SATELLITE", "SATELLITE"),
            },
        )

    def test_novas_fifteen_settings_read_as_no_setting_does(self):
        """Finding 40. Contract: every Nova app states fifteen settings at the value a device reads where a profile
        names none, so the archive with them gives the same answer as the archive without them from each of their
        readers; only the stored values differ. Failure it catches: a constant that moves its reader, which would
        change what every device does from install."""
        stated = with_settings(
            SURVEY, self.work / "fifteen.ccz", [(key, value, force) for key, value, force, _ in NOVA_SETTINGS]
        )
        present = self.reader.request("profile", archive=str(stated))
        self.assertEqual(present["install"], "Installed")
        for key, _, _, reader in NOVA_SETTINGS:
            with self.subTest(key=key):
                self.assertEqual(present["profile"]["readers"][reader], self.plain["profile"]["readers"][reader])
        moved = {path for path in differing(self.plain, present) if not path.startswith("/profile/stored/")}
        self.assertEqual(moved, set())

    def test_a_newer_export_updates_the_installed_app_and_an_equal_one_does_not(self):
        """Defect 9. Contract: Android's update from a file compares versions alone, so an export at a higher
        sequence with a form changed stages and installs and the changed form opens, and one at the same sequence
        with the form changed answers ``UpToDate`` and keeps the old form; the profile's version is what makes a
        download newer. The change is the form's title, which the form left incomplete reopens under
        (``FormController.getFormTitle``, the form's ``h:title``) before any question is drawn. Failure it
        catches: an update that reads anything else, so a later download a phone cannot take, or one it takes
        though it is not newer."""
        unique = "58454579-0000-4000-8000-000000000001"
        changed = ("<h:title>Census</h:title>", "<h:title>Census again</h:title>")
        at_7 = planned(SURVEY, self.work / "seq-7.ccz", 7, unique_id=unique)
        at_8 = planned(SURVEY, self.work / "seq-8.ccz", 8, unique_id=unique, form_text=changed)
        again_7 = planned(SURVEY, self.work / "seq-7-changed.ccz", 7, unique_id=unique, form_text=changed)
        newer = self.reader.request("update", archive=str(at_7), update=str(at_8), incomplete="m0-f0")
        self.assertEqual((newer["staged"], newer["updated"]), ("UpdateStaged", "Installed"))
        self.assertEqual(newer["after"]["app"]["versionNumber"], 8)
        self.assertEqual(newer["reopened"]["form"]["formTitle"], "Census again")
        equal = self.reader.request("update", archive=str(at_7), update=str(again_7), incomplete="m0-f0")
        self.assertEqual(equal["staged"], "UpToDate")
        self.assertEqual(equal["after"]["app"]["versionNumber"], 7)
        self.assertEqual(equal["reopened"]["form"]["formTitle"], "Census")

    def test_an_update_from_a_file_takes_a_file_made_for_another_project_space(self):
        """Defect 9, the page's sentence on Offline Update (written from the reading of
        ``AndroidResourceManager.checkAndPrepareUpgradeResources`` and ``ProfileAndroidInstaller.upgrade``, not
        yet run). Contract: Android's update from a file compares versions alone, so the archive made for project
        space A at sequence 7, updated to the one made for project space B at sequence 8, stages and installs, and
        the app then holds B's ``uniqueid`` and B's address for a completed form: the install takes the new
        profile's forced server properties. That is why the files for two project spaces must not be one app to
        the install screen, which would send a worker to an update. Failure it catches: an update that refuses a
        file of another ``uniqueid``, which would make the page's sentence false."""
        space_a = planned(
            SURVEY,
            self.work / "space-a.ccz",
            7,
            unique_id="58454579-0000-4000-8000-00000000000a",
            server=server_properties("space-a", "hq-app-a"),
        )
        space_b = planned(
            SURVEY,
            self.work / "space-b.ccz",
            8,
            unique_id="58454579-0000-4000-8000-00000000000b",
            server=server_properties("space-b", "hq-app-b"),
        )
        answer = self.reader.request("update", archive=str(space_a), update=str(space_b))
        self.assertEqual((answer["staged"], answer["updated"]), ("UpdateStaged", "Installed"))
        self.assertEqual(answer["after"]["app"]["uniqueId"], "58454579-0000-4000-8000-00000000000b")
        self.assertEqual(
            answer["after"]["readers"]["FormSubmissionHelper.getFormPostURL"],
            f"{SERVER}/a/space-b/receiver/hq-app-b/",
        )

    def test_a_file_for_a_remade_hq_app_updates_a_phone_at_an_unchanged_sequence(self):
        """Defect 9, a remade HQ app (written from the reading of ``Resource.isNewer``, not yet run). Contract: the
        archive whose profile and suite resources carry the archive's version, the sequence plus the HQ apps the
        deployment held before, updates a phone on the archive made for the deleted HQ app at the same sequence,
        and the phone then posts to the new HQ app; the same file with its profile at the sequence alone answers
        ``UpToDate`` and keeps the deleted app's address. Failure it catches: a version at the sequence alone,
        which would leave every phone on a deleted app until the document next changes."""
        unique = "58454579-0000-4000-8000-000000000002"
        first = planned(
            SURVEY, self.work / "h1.ccz", 7, unique_id=unique, server=server_properties("space", "hq-app-1")
        )
        remade = planned(
            SURVEY, self.work / "h2.ccz", 7, unique_id=unique, version=8, server=server_properties("space", "hq-app-2")
        )
        unchanged = planned(
            SURVEY, self.work / "h2-at-7.ccz", 7, unique_id=unique, server=server_properties("space", "hq-app-2")
        )
        answer = self.reader.request("update", archive=str(first), update=str(remade))
        self.assertEqual((answer["staged"], answer["updated"]), ("UpdateStaged", "Installed"))
        self.assertEqual(answer["after"]["app"]["versionNumber"], 8)
        self.assertEqual(answer["after"]["app"]["uniqueId"], unique)
        self.assertEqual(
            answer["after"]["readers"]["FormSubmissionHelper.getFormPostURL"], f"{SERVER}/a/space/receiver/hq-app-2/"
        )
        held = self.reader.request("update", archive=str(first), update=str(unchanged))
        self.assertEqual(held["staged"], "UpToDate")
        self.assertEqual(
            held["after"]["readers"]["FormSubmissionHelper.getFormPostURL"], f"{SERVER}/a/space/receiver/hq-app-1/"
        )

    def test_a_barcode_and_a_secret_refuse_an_answer_their_validation_fails(self):
        """Defect 8. Contract: a barcode's and a secret's own widgets take an answer as any question's do, so on the
        control's archive, which drops their validation, each takes ``abc``; with the constraint, its message and
        the alert written into the form as Nova writes them for a text question, each refuses ``abc`` as a
        constraint and takes ``abcdef``. Failure it catches: a widget that checks no constraint, so the
        validation Nova now writes would mean nothing on a device."""
        answers = {"dataTypes": {"barcode": ["abc", "abcdef"]}, "controls": {"secret": ["abc", "abcdef"]}}
        constraint = 'constraint="string-length(.) = 6" jr:constraintMsg="jr:itext(&apos;{0}-constraintMsg&apos;)"'
        replacements = []
        for name, kind, control in (("code", "barcode", "input"), ("pin", "xsd:string", "secret")):
            replacements += [
                (
                    f'<bind nodeset="/data/{name}" type="{kind}"/>',
                    f'<bind nodeset="/data/{name}" type="{kind}" {constraint.format(name)}/>',
                ),
                (
                    f'<{control} ref="/data/{name}"><label ref="jr:itext(&apos;{name}-label&apos;)"/></{control}>',
                    f'<{control} ref="/data/{name}"><label ref="jr:itext(&apos;{name}-label&apos;)"/>'
                    f'<alert ref="jr:itext(&apos;{name}-constraintMsg&apos;)"/></{control}>',
                ),
            ]
        replacements.append(
            (
                "</translation>",
                '<text id="code-constraintMsg"><value>Enter six characters</value></text>'
                '<text id="pin-constraintMsg"><value>Enter six characters</value></text></translation>',
            )
        )
        validated = edited(VALIDATED, self.work / "validated.ccz", "modules-0/forms-0.xml", replacements)
        for label, archive, expected in (
            ("control", VALIDATED, {"given": "abc", "refused": []}),
            ("validated", validated, {"given": "abcdef", "refused": ["abc: constraint"]}),
        ):
            answer = self.reader.request("app", archive=str(archive), commands=["m0-f0"], answers=answers)
            self.assertEqual(answer["install"], "Installed", label)
            held = given(answer)
            # A reference as Core's ``TreeReference`` writes it, each step under the data node with its multiplicity.
            for reference in ("/data/code[1]", "/data/pin[1]"):
                with self.subTest(archive=label, question=reference):
                    self.assertEqual(held[reference], expected)

    def test_automatic_capture_stops_at_the_accuracy_the_profile_names(self):
        """Finding 34 and finding 40's ``cc-gps-auto-capture-accuracy``. Contract: a form whose poll of the location
        sensor writes into its meta block stops polling at the first fix at least as fine as the profile's
        accuracy: at Nova's ``10`` an 8 metre fix ends the poll, and with ``5``, HQ's page's value, written into
        the profile the poll goes on and a later 4 metre fix replaces the first. Failure it catches: an accuracy
        Android does not read, so Nova's constant would change how long a device polls."""
        form = [
            ("<orx:drift/></orx:meta>", "<orx:drift/><cc:location/></orx:meta>"),
            (
                "</itext></model>",
                '</itext><orx:pollsensor event="xforms-ready" ref="/data/meta/location"/>'
                '<bind nodeset="/data/meta/location" type="geopoint"/></model>',
            ),
        ]
        located = edited(CONNECT_DELIVER, self.work / "located.ccz", "modules-0/forms-0.xml", form)
        tightened = with_settings(located, self.work / "located-5.ccz", [("cc-gps-auto-capture-accuracy", "5", True)])
        fixes = [[12.9716, 77.5946, 920.0, 8.0], [12.9716, 77.5946, 920.0, 4.0]]
        found = {}
        for label, archive in (("10", located), ("5", tightened)):
            answer = self.reader.request(
                "location", archive=str(archive), command="m0-f0", node="/data/meta/location", fixes=fixes
            )
            self.assertEqual((answer["install"], answer["loaded"]), ("Installed", True), label)
            found[label] = [(reading["polling"], reading["node"]) for reading in answer["fixes"]]
        eight, four = "12.9716 77.5946 920.0 8.0", "12.9716 77.5946 920.0 4.0"
        self.assertEqual(found["10"], [(False, eight), (False, eight)])
        self.assertEqual(found["5"], [(True, eight), (False, four)])

    def test_an_incomplete_form_reopens_only_while_its_xmlns_is_the_apps(self):
        """Defect 1. Contract: Android finds an incomplete form's definition by the ``xmlns`` its record holds
        (``AndroidCommCarePlatform.getFormDefId``), so after an update that gives the form another ``xmlns`` the
        form cannot be reopened, and after one that keeps it the form opens. Failure it catches: a lookup by
        anything that survives Nova's republish."""
        old, new = "http://openrosa.org/formdesigner/", "http://openrosa.org/formdesigner/renamed-"
        with zipfile.ZipFile(SURVEY) as zipped:
            suite = zipped.read("suite.xml").decode()
            form = zipped.read("modules-0/forms-0.xml").decode()
            profile = zipped.read("profile.ccpr").decode()
        self.assertIn(PROFILE_VERSION_1, profile)
        profile = profile.replace(PROFILE_VERSION_1, PROFILE_VERSION_2).replace(
            '<resource id="suite" version="1"', '<resource id="suite" version="2"'
        )
        suite = suite.replace(
            '<resource id="modules-0/forms-0.xml" version="1">', '<resource id="modules-0/forms-0.xml" version="2">'
        )
        kept = variant(SURVEY, self.work / "kept.ccz", {"profile.ccpr": profile.encode(), "suite.xml": suite.encode()})
        xmlns = suite.split("<form>", 1)[1].split("</form>", 1)[0]
        renamed_to = xmlns.replace(old, new)
        self.assertIn(xmlns, form)
        renamed = variant(
            SURVEY,
            self.work / "renamed.ccz",
            {
                "profile.ccpr": profile.encode(),
                "suite.xml": suite.replace(xmlns, renamed_to).encode(),
                "modules-0/forms-0.xml": form.replace(xmlns, renamed_to).encode(),
            },
        )
        answers = {
            label: self.reader.request("update", archive=str(SURVEY), update=str(path), incomplete="m0-f0")
            for label, path in (("kept", kept), ("renamed", renamed))
        }
        for label, answer in answers.items():
            self.assertEqual((answer["staged"], answer["updated"]), ("UpdateStaged", "Installed"), label)
            self.assertEqual([record["status"] for record in answer["incomplete"]["records"]], ["incomplete"])
        self.assertIs(answers["kept"]["reopened"]["form"]["loaded"], True)
        self.assertIs(answers["renamed"]["reopened"]["form"]["loaded"], False)
        self.assertEqual(answers["kept"]["reopened"]["records"][0]["AndroidCommCarePlatform.getFormDefId"], "held")
        self.assertEqual(answers["renamed"]["reopened"]["records"][0]["AndroidCommCarePlatform.getFormDefId"], "none")
        self.assertIn(
            "No XForm definition defined for this form", answers["renamed"]["reopened"]["form"]["alert"]["msg"]
        )

    def tile(self, label, replacements):
        archive = edited(TILE / "local.ccz", self.work / f"tile-{label}.ccz", "suite.xml", replacements)
        answer = self.reader.request("app", archive=str(archive), restore=str(TILE / "restore.xml"), commands=["m0-f0"])
        walk = answer["walks"]["m0-f0"]
        raised = walk.get("raised") or {}
        self.assertIn("steps", walk, f"the walk raised {raised.get('class')}: {raised.get('stack', '')[:3000]}")
        return cells(walk["steps"][0]["list"]["rows"][0])

    def test_a_tile_cells_style_reaches_androids_tile_view(self):
        """Defect 14's tile font size and finding 42. Contract: on Android's tile (``EntityViewTile``), a
        vertical alignment of ``start`` lays a cell out as no alignment does, for a text cell and for an image
        cell; a horizontal alignment of ``left`` moves a text cell's gravity from the start to the left and an
        image cell's scale type from ``FIT_CENTER`` to ``FIT_START``; and a font size of ``medium`` changes a
        text cell's size. Failure it catches: the vertical ``start`` equivalence being wrong on Android, or the
        two changes being no change."""
        style = "<style><grid"
        image = [("<template>", '<template form="image">')]

        def styled(attribute):
            return [(style, f"<style {attribute}><grid")]

        plain = self.tile("plain", [])
        self.assertEqual({cell["class"] for cell in plain}, {"TextView"})
        self.assertEqual(self.tile("vert", styled('vert-align="start"')), plain)
        left = self.tile("left", styled('horz-align="left"'))
        self.assertEqual({cell["gravity"] for cell in plain}, {"start|top"})
        self.assertEqual({cell["gravity"] for cell in left}, {"left|top"})
        medium = self.tile("medium", styled('font-size="medium"'))
        self.assertNotEqual([cell["textSize"] for cell in medium], [cell["textSize"] for cell in plain])
        self.assertEqual([cell["gravity"] for cell in medium], [cell["gravity"] for cell in plain])

        pictured = self.tile("image", image)
        scale = [cell.get("scaleType") for cell in pictured if cell["class"] == "ImageView"]
        self.assertTrue(scale and set(scale) == {"FIT_CENTER"})
        self.assertEqual(self.tile("image-vert", image + styled('vert-align="start"')), pictured)
        pictured_left = self.tile("image-left", image + styled('horz-align="left"'))
        self.assertEqual({cell["scaleType"] for cell in pictured_left if cell["class"] == "ImageView"}, {"FIT_START"})

    def test_a_repeat_inside_a_field_list_offers_no_row(self):
        """Defect 27. Contract: Android shows a field list as one screen and never reaches the "add another?"
        prompt of a repeat inside it (``FormEntryActivityUIController.showNextView``), so the repeat's question
        is never asked; the same form without the field list reaches the prompt. Failure it catches: the form
        being usable on Android as exported."""
        form = "modules-0/forms-0.xml"
        listed = self.walked(LABELLED_REPEAT, commands=["m0-f0"])
        plain = self.walked(
            edited(LABELLED_REPEAT, self.work / "no-field-list.ccz", form, [(' appearance="field-list"', "")]),
            commands=["m0-f0"],
        )

        def events(answer):
            return [screen["event"] for screen in answer["walks"]["m0-f0"]["steps"][0]["form"]["screens"]]

        self.assertNotIn("PROMPT_NEW_REPEAT", events(listed))
        self.assertIn("PROMPT_NEW_REPEAT", events(plain))
        # The walk past a repeat's prompt: the dialog's own choices add one row, then leave the repeat, and the
        # form goes on to its end and its save.
        form = plain["walks"]["m0-f0"]["steps"][0]["form"]
        prompts = [screen for screen in form["screens"] if screen["event"] == "PROMPT_NEW_REPEAT"]
        self.assertEqual(len(prompts), 2)
        self.assertNotEqual(prompts[0]["chose"], prompts[1]["chose"])
        # Leaving the last repeat ends this form, which the dialog's own choice then saves.
        self.assertEqual(form["ended"], "finished")
        self.assertIs(form["saved"]["finishing"], True)

    def test_hint_and_group_label_media_show_nowhere_a_device_draws(self):
        """Defect 16 (the media slots Nova offers). Contract: Android lays out a question's hint as its text
        alone and a group's label as its text alone (``QuestionWidget``, ``QuestionsView``), so a form whose hint
        and group label also name an image shows the worker exactly the screen the form without them shows,
        while an image named by a question's own label is laid out beside its text. Failure it catches: either
        slot shown on a device, which would make Nova's removal of it a loss a worker sees, or a comparison of
        screens that sees no media at all (the label's image)."""
        form = "modules-0/forms-0.xml"
        image = (Path(__file__).resolve().parents[1] / "core" / "captures" / "proof-image.jpg").read_bytes()
        hint = (
            '<input ref="/data/household/address"><label ref="jr:itext(&apos;household-address-label&apos;)"/>',
            '<input ref="/data/household/address"><label ref="jr:itext(&apos;household-address-label&apos;)"/>'
            '<hint ref="jr:itext(&apos;household-address-hint&apos;)"/>',
        )
        hint_text = (
            '<text id="household-address-label">',
            '<text id="household-address-hint"><value>Write the street</value></text>'
            '<text id="household-address-label">',
        )
        hinted = edited(LABELLED_REPEAT, self.work / "hinted.ccz", form, [hint, hint_text])
        with_media = with_entries(
            edited(
                hinted,
                self.work / "hinted-media.ccz",
                form,
                [
                    (
                        "<value>Write the street</value>",
                        '<value>Write the street</value><value form="image">jr://file/commcare/image/hint.jpg</value>',
                    ),
                    (
                        "<value>Household</value>",
                        '<value>Household</value><value form="image">jr://file/commcare/image/group.jpg</value>',
                    ),
                ],
            ),
            self.work / "hinted-media-files.ccz",
            {"commcare/image/hint.jpg": image, "commcare/image/group.jpg": image},
        )
        labelled = with_entries(
            edited(
                hinted,
                self.work / "labelled-media.ccz",
                form,
                [
                    (
                        "<value>Address</value>",
                        '<value>Address</value><value form="image">jr://file/commcare/image/label.jpg</value>',
                    )
                ],
            ),
            self.work / "labelled-media-files.ccz",
            {"commcare/image/label.jpg": image},
        )

        def screens(archive):
            answer = self.walked(archive, commands=["m0-f0"], views=True)
            return [screen.get("view") for screen in answer["walks"]["m0-f0"]["steps"][0]["form"]["screens"]]

        plain = screens(hinted)
        self.assertTrue(plain and all(view is not None for view in plain))
        self.assertIn("Write the street", json.dumps(plain))
        self.assertEqual(screens(with_media), plain)
        self.assertNotEqual(screens(labelled), plain)

    def test_a_validation_messages_media_shows_nowhere_a_device_draws(self):
        """Defect 16 (validation message media). Contract: where a worker's answer breaks a question's constraint,
        Android shows the form's message for it as its text alone (``FormEntryActivityUIController
        .showConstraintWarning``, ``QuestionWidget.notifyInvalid``), so a message that also names an image shows
        the same screen as one that does not. Failure it catches: the message's image shown on a device, or a walk
        that never shows the message at all (its text is on the screen)."""
        form = "modules-0/forms-0.xml"
        image = (Path(__file__).resolve().parents[1] / "core" / "captures" / "proof-image.jpg").read_bytes()
        constrained = edited(
            LABELLED_REPEAT,
            self.work / "constrained.ccz",
            form,
            [
                (
                    '<bind nodeset="/data/household/address" type="xsd:string"/>',
                    '<bind nodeset="/data/household/address" type="xsd:string" constraint=". = &apos;ok&apos;"'
                    ' jr:constraintMsg="jr:itext(&apos;household-address-constraintMsg&apos;)"/>',
                ),
                (
                    '<text id="household-address-label">',
                    '<text id="household-address-constraintMsg"><value>Use ok</value></text>'
                    '<text id="household-address-label">',
                ),
            ],
        )
        with_media = with_entries(
            edited(
                constrained,
                self.work / "constrained-media.ccz",
                form,
                [
                    (
                        "<value>Use ok</value>",
                        '<value>Use ok</value><value form="image">jr://file/commcare/image/ok.jpg</value>',
                    )
                ],
            ),
            self.work / "constrained-media-files.ccz",
            {"commcare/image/ok.jpg": image},
        )

        def held(archive):
            # The form is one screen (a field list): the worker types the refused answer and presses finish, and
            # Android keeps the form open on that screen with the form's message.
            answer = self.walked(archive, commands=["m0-f0"], views=True, typeRefused=True)
            form_read = answer["walks"]["m0-f0"]["steps"][0]["form"]
            self.assertIs(form_read["saved"]["finishing"], False)
            return form_read["afterFinish"]

        plain = held(constrained)
        self.assertIn("Use ok", json.dumps(plain))
        self.assertEqual(held(with_media), plain)

    def form_views(self, archive, restore=None, questions=None) -> list:
        """The view of every screen of the first form ``m0-f0`` opens, as Android laid it out, its questions given
        the lane's answers and, by reference, ``questions``'s."""
        options = {}
        if questions is not None:
            lane = json.loads(ANSWERS.read_text(encoding="utf-8"))
            options["answers"] = {**lane, "questions": {**lane.get("questions", {}), **questions}}
        answer = self.walked(archive, restore, commands=["m0-f0"], views=True, **options)
        forms = [step["form"] for step in answer["walks"]["m0-f0"]["steps"] if "form" in step]
        self.assertTrue(forms, f"The walk of {archive} opened no form")
        return [screen.get("view") for screen in forms[0]["screens"]]

    def test_a_file_question_is_drawn_by_androids_document_widget(self):
        """Defect 16 (what the File question's documentation says). Contract: Android draws a File question (an
        ``<upload mediatype="application/*,text/*">``) with its own document widget (``WidgetFactory``,
        ``Constants.CONTROL_DOCUMENT_UPLOAD``: ``DocumentWidget``, its button reading "Choose Document"), and an
        image question with ``ImageWidget``. Failure it catches: a File question Android draws as a text box, the
        claim Nova's documentation made before."""
        views = self.form_views(CAPTURE, OPERATION_QUERY_RESTORE, CAPTURES_SHOWN)
        classes = set().union(*(view_classes(view) for view in views))
        self.assertIn("DocumentWidget", classes)
        self.assertIn("ImageWidget", classes)
        self.assertIn("Choose Document", json.dumps(views))

    def test_an_image_question_with_the_face_appearance_is_drawn_by_androids_face_capture_widget(self):
        """Defect 16 (what ``captureUpload.ts`` says of ``face``). Contract: Android draws an image question whose
        appearance is ``face`` with ``FaceCaptureWidget`` and one without it with ``ImageWidget``
        (``WidgetFactory``, ``FACE_CAPTURE_APPEARANCE_ATTR``). Nova writes no ``face``; it is written into the
        control's form here. Failure it catches: a branch Android lacks, so ``face`` reads as a plain image."""
        face = edited(
            CAPTURE,
            self.work / "face.ccz",
            "modules-0/forms-0.xml",
            [
                (
                    '<upload ref="/data/details/thepicture" mediatype="image/*">',
                    '<upload ref="/data/details/thepicture" mediatype="image/*" appearance="face">',
                )
            ],
        )
        plain = set().union(
            *(view_classes(view) for view in self.form_views(CAPTURE, OPERATION_QUERY_RESTORE, CAPTURES_SHOWN))
        )
        faced = set().union(
            *(view_classes(view) for view in self.form_views(face, OPERATION_QUERY_RESTORE, CAPTURES_SHOWN))
        )
        self.assertIn("ImageWidget", plain)
        self.assertNotIn("FaceCaptureWidget", plain)
        self.assertIn("FaceCaptureWidget", faced)
        self.assertNotIn("ImageWidget", faced)

    def test_a_local_archive_missing_a_media_file_is_refused(self):
        """Defect 11 (what an unbundled media file does). Contract: Android unzips an archive and copies each media
        file out of it (``InstallArchiveActivity``, ``FileSystemInstaller.install``), so Nova's local archive
        installs, and the same archive with one media file taken out is refused (``MissingResourcesWithMessage``).
        Core's and Formplayer's archive installs do not notice the missing file, which is why the media-suite
        oracle's own join is Nova's bundling proof. Failure it catches: an install that skips a missing media file,
        so a bundling mistake would reach a phone unnoticed."""
        with zipfile.ZipFile(MEDIA_ONLY) as held:
            media = sorted(name for name in held.namelist() if name.startswith("commcare/"))
        self.assertTrue(media, f"{MEDIA_ONLY} bundles no media file")
        missing = without_entry(MEDIA_ONLY, self.work / "missing-media.ccz", media[0])
        whole = self.reader.request("installs", archives=[str(MEDIA_ONLY)])
        cut = self.reader.request("installs", archives=[str(missing)])
        self.assertEqual([step["install"] for step in whole["installs"]], ["Installed"])
        self.assertEqual([step["install"] for step in cut["installs"]], ["MissingResourcesWithMessage"])

    # The predicates whose other spelling is HQ's build's -------------------------------------------------------

    def walked(self, archive, restore=None, **options):
        arguments = {"archive": str(archive), "answers": json.loads(ANSWERS.read_text(encoding="utf-8")), **options}
        if restore is not None:
            arguments["restore"] = str(restore)
        answer = self.reader.request("app", **arguments)
        self.assertEqual(answer["install"], "Installed")
        return answer

    @staticmethod
    def steps(answer, screen):
        """Each step of every walk that shows ``screen``, the first walk that reaches one first."""
        return [
            step
            for name in sorted(answer["walks"], key=lambda name: (name.count("/"), name))
            for step in answer["walks"][name].get("steps", ())
            if step["screen"] == screen
        ]

    def test_a_lookup_tag_holding_casedb_or_ledgerdb_reads_no_table_and_one_split_or_in_another_case_does(self):
        """Defect 5 (reserved substrings). Contract: Core picks an instance's data by the words its reference
        contains, case-sensitively (``CommCareInstanceInitializer.generateRoot``: ``ledgerdb``, then ``casedb``,
        then ``fixture``), so on the control's archive, whose tags hold ``casedb`` and ``ledgerdb``, the form's
        first question raises "Error Occurred" with the lookup table sentence and no choices; with the tags
        written split as Nova writes them now (one of them 32 characters), or with the words in another case,
        each select lists its table's two rows. Failure it catches: a split tag Android still reads as its own
        data, or a case-insensitive test, so Nova's rule would refuse too little."""
        stored = ("clinic_casedb_codes", "stock_ledgerdb_codes")

        def retagged(name, tags):
            replacements = list(zip(stored, tags, strict=True))
            suite = edited(RESERVED_TAGS, self.work / f"{name}-suite.ccz", "suite.xml", replacements)
            return edited(suite, self.work / f"{name}.ccz", "modules-0/forms-0.xml", replacements)

        for label, archive in (
            ("split", retagged("split", ("clinic_case_db_codes_0123456789a", "stock_ledger_db_codes"))),
            ("other-case", retagged("other-case", ("clinic_CaseDB_codes", "stock_LedgerDB_codes"))),
        ):
            views = json.dumps(self.form_views(archive))
            with self.subTest(archive=label):
                for choice in ("North clinic", "South clinic", "Soap", "Salt"):
                    self.assertIn(choice, views)
                self.assertNotIn("Error Occurred", views)
        refused = json.dumps(self.walked(RESERVED_TAGS, commands=["m0-f0"], views=True)["walks"]["m0-f0"])
        self.assertIn("Error Occurred", refused)
        self.assertIn("lookup table is available", refused)
        for choice in ("North clinic", "Soap"):
            self.assertNotIn(choice, refused)

    def test_a_hidden_sort_columns_header_puts_it_in_the_sort_menu(self):
        """Finding 36. Contract: Android's Sort menu offers every column whose header is not empty
        (``EntitySelectActivity.getSortOptionsList``), so the hidden sort column Nova's local archive gives a
        header is offered to a worker, and the same column with the empty header HQ's build writes is not.
        Failure it catches: a Sort menu that reads a column's width or its sort element instead."""
        local = self.walked(INLINE_LIST, INLINE_LIST_RESTORE)
        as_hq = self.walked(
            edited(
                INLINE_LIST,
                self.work / "hidden-header.ccz",
                "suite.xml",
                [
                    (
                        '<header width="0"><text><locale id="m0.case_short.case_weight_9.header"/></text>',
                        '<header width="0"><text/>',
                    )
                ],
            ),
            INLINE_LIST_RESTORE,
        )

        def offered(answer):
            return self.steps(answer, "EntitySelectActivity")[0]["list"]["EntitySelectActivity.getSortOptionsList"]

        self.assertIn("Hidden order", " ".join(offered(local)))
        self.assertEqual([name for name in offered(local) if "Hidden order" not in name], offered(as_hq))

    def test_an_image_columns_width_is_the_hint_its_header_carries(self):
        """Finding 38. Contract: Android lays a list's columns out from each header's width hint (``EntityView``,
        ``DetailField.getHeaderWidthHint``): with none, every shown column takes an equal share of the row, and
        the 13% HQ's build writes on an image column gives that column 130 of a 1000-pixel row and the others
        the rest. Failure it catches: a layout that ignores the hint."""
        image = '<header><text><locale id="m0.case_short.case_code_6.header"/></text></header><template form="image">'
        hinted = (
            '<header width="13%"><text><locale id="m0.case_short.case_code_6.header"/></text></header>'
            '<template form="image" width="13%">'
        )

        def widths(answer):
            header = self.steps(answer, "EntitySelectActivity")[0]["list"]["header"][0]
            return [child["layoutWidth"] for child in header["children"]]

        local = widths(self.walked(INLINE_LIST, INLINE_LIST_RESTORE))
        as_hq = widths(
            self.walked(
                edited(INLINE_LIST, self.work / "width.ccz", "suite.xml", [(image, hinted)]), INLINE_LIST_RESTORE
            )
        )
        self.assertEqual(len(set(local)), 1)
        self.assertEqual(sum(local), 1000)
        self.assertIn(130, as_hq)
        self.assertEqual(len(set(as_hq) - {130}), 1)
        self.assertLess(next(iter(set(as_hq) - {130})), local[0])

    def test_a_form_whose_entry_posts_a_claim_is_refused_and_the_session_cleared(self):
        """Defect 20. Contract: where an entry carries a ``post`` (HQ's build under sync on form entry), Android's
        home asks for a sync before the form and, the entry being no remote request, clears the session and
        tells the worker so (``HomeScreenBaseActivity.launchRemoteSync``): no form opens. The same entry
        without it, as Nova's local archive writes it, opens its form. Failure it catches: the claim being
        posted, or the form opening after it."""
        post = (
            '<post url="https://www.commcarehq.org/a/nova-proof/phone/claim-case/">'
            '<data key="case_id" ref="instance(\'commcaresession\')/session/data/case_id"/></post>'
        )
        with zipfile.ZipFile(SYNC_ON_ENTRY) as zipped:
            suite = zipped.read("suite.xml").decode()
        form = suite.split("<entry>", 1)[1].split("</form>", 1)[0] + "</form>"
        local = self.walked(SYNC_ON_ENTRY, SYNC_ON_ENTRY_RESTORE)
        as_hq = self.walked(
            edited(SYNC_ON_ENTRY, self.work / "post.ccz", "suite.xml", [(form, form + post)]), SYNC_ON_ENTRY_RESTORE
        )
        self.assertTrue(self.steps(local, "FormEntryActivity"))
        self.assertTrue(all(step["form"]["loaded"] for step in self.steps(local, "FormEntryActivity")))
        self.assertEqual(self.steps(as_hq, "FormEntryActivity"), [])
        self.assertEqual(self.steps(as_hq, "PostRequestActivity"), [])
        ended = [walk["steps"][-1] for name, walk in as_hq["walks"].items() if name.endswith("m0-f0")]
        self.assertTrue(ended)
        for step in ended:
            self.assertEqual(step["screen"], "home")
            self.assertEqual(step["alert"]["title"], "Session Refresh Required")
            self.assertIsNone(step["session"]["command"])

    def test_a_claim_is_posted_its_sync_run_and_the_session_goes_on_to_the_form(self):
        """The walk past a claim. Contract: Android posts a search result's claim only where the claim's own
        condition holds (a case the device does not hold), and then syncs before the session goes on
        (``PostRequestActivity``); the walk answers the post and runs that sync with the app's own data pull,
        so what follows a claim is read. Failure it catches: a walk that ends at the claim, or one that claims
        a case the device holds. With the control's own archive the device holds every case a search finds,
        so no claim is posted; with the same archive's claim made unconditional it is posted for the chosen
        case, the sync runs, and the walk reaches the form either way."""
        with zipfile.ZipFile(SYNC_ON_ENTRY) as zipped:
            suite = zipped.read("suite.xml").decode()
        post = suite[suite.index("<post ") : suite.index(">", suite.index("<post ")) + 1]
        condition = post[post.index(" relevant=") : post.rindex('"') + 1]
        always = edited(SYNC_ON_ENTRY, self.work / "claim.ccz", "suite.xml", [(condition, "")])
        answers = {
            name: self.walked(archive, SYNC_ON_ENTRY_RESTORE)
            for name, archive in (("held", SYNC_ON_ENTRY), ("claimed", always))
        }
        self.assertEqual(self.steps(answers["held"], "PostRequestActivity"), [])
        claims = self.steps(answers["claimed"], "PostRequestActivity")
        self.assertTrue(claims)
        for step in claims:
            self.assertEqual(sorted(step["post"]["params"]), ["case_id"])
            self.assertTrue(step["post"]["url"].endswith("/phone/claim-case/"))
            self.assertIs(step["post"]["finishing"], True)
            self.assertEqual(step["post"]["resultCode"], -1)
        for name, answer in answers.items():
            # Each case the search finds is a walk of its own, on to the form.
            searched = [
                walk
                for walk_name, walk in answer["walks"].items()
                if walk_name.startswith("m0/@action:0/@case:") and walk_name.endswith("/m0-f0")
            ]
            self.assertTrue(searched, sorted(answer["walks"]))
            for walk in searched:
                screens = [step["screen"] for step in walk["steps"]]
                self.assertIn("QueryRequestActivity", screens, name)
                self.assertIn("FormEntryActivity", screens, name)
                self.assertEqual("PostRequestActivity" in screens, name == "claimed")

    def test_a_forms_title_names_its_completed_save_and_not_the_header_a_worker_opens_it_under(self):
        """Finding 46. Contract: Android names a completed save by the form's own title
        (``FormEntryInstanceState.getDefaultFormTitle``), so a title another save of the form wrote renames
        what a worker finds under Saved Forms, while the header form entry shows from home is the menu's and
        the form's names from the suite (``FormEntryActivity.getHeaderString``) and does not change. Failure it
        catches: the header changing too, or the save's name read from the suite."""
        form = "modules-0/forms-0.xml"
        retitled = edited(
            SURVEY, self.work / "retitled.ccz", form, [("<h:title>Census</h:title>", "<h:title>Recensement</h:title>")]
        )
        answers = {name: self.walked(archive) for name, archive in (("plain", SURVEY), ("retitled", retitled))}
        forms = {
            name: next(
                step["form"]
                for step in self.steps(answer, "FormEntryActivity")
                if step["form"]["formTitle"] in ("Census", "Recensement")
            )
            for name, answer in answers.items()
        }
        self.assertEqual(forms["plain"]["FormEntryInstanceState.getDefaultFormTitle"], "Census")
        self.assertEqual(forms["retitled"]["FormEntryInstanceState.getDefaultFormTitle"], "Recensement")
        self.assertEqual(
            forms["plain"]["FormEntryActivity.getHeaderString"], forms["retitled"]["FormEntryActivity.getHeaderString"]
        )
        for name, title in (("plain", "Census"), ("retitled", "Recensement")):
            saved = forms[name]["saved"]
            self.assertTrue(saved["finishing"], name)
            self.assertIn(title, [record["FormRecord.getDisplayName"] for record in saved["records"]])

    def test_a_search_answer_holding_both_quote_marks_is_sent_and_the_servers_refusal_shown_as_androids_own(self):
        """Finding 48. Contract: Android's search screen sends a search whatever its prompts hold
        (``QueryRequestActivity.makeQueryRequest``): an answer holding both quote marks, which no XPath string
        can hold, leaves Core's prompt errors empty and is sent as the query the suite builds; and when the
        server answers 400, as HQ answers a query it cannot compile, the worker sees Android's own text for a
        client error and the screen stays. Failure it catches: Android stopping the search as Formplayer does,
        or showing the server's message."""
        answer = self.walked(SEARCH_COMPILE, queryAnswer='it\'s "x"')
        probed = [
            step["query"]["withAnswer"]
            for step in self.steps(answer, "QueryRequestActivity")
            if "withAnswer" in step["query"]
        ]
        self.assertTrue(probed)
        sent = [
            value
            for probe in probed
            for values in probe["RemoteQuerySessionManager.getRawQueryParams"].values()
            for value in values
        ]
        self.assertTrue(any("it's" in value or "search-value-mixes-quote-marks" in value for value in sent), sent)
        for probe in probed:
            self.assertEqual(probe["RemoteQuerySessionManager.getErrors"], {})
            refused = probe["afterServerAnswers400"]
            self.assertIs(refused["errorShown"], True)
            self.assertIs(refused["finishing"], False)
            self.assertEqual(refused["errorText"], "Client-side error (code 400) received from network request.")

    def test_a_search_answer_holding_both_quote_marks_sends_match_none_and_finds_nothing(self):
        """Finding 48, the document's side. Contract: where the suite's quote cascade writes ``match-none()`` for
        an answer holding both quote marks, as Nova's emitter writes it now (``csqlEmitter.ts::buildQuoteCascade``),
        Android's search screen sends that query; when the server answers 200 with no case, as HQ answers a search
        that finds nothing (``casexml/apps/case/fixtures.py::CaseDBFixture.fixture``: an empty ``<results
        id="case">``), the screen shows its toast "Query response had no results"
        (``QueryRequestActivity.processSuccess``, ``query.response.empty``), stays, shows no error, and the prompt
        still holds the answer and takes typing. The control's archive is written as the document's here: its one
        cascade's function becomes ``match-none()``, which is the only byte the two suites differ by in that
        expression. Failure it catches: the screen sending the old function, ending the search, or clearing the
        prompt."""
        answered = 'it\'s "x"'
        archive = edited(
            SEARCH_COMPILE,
            self.work / "match-none.ccz",
            "suite.xml",
            [("&apos;search-value-mixes-quote-marks()&apos;", "&apos;match-none()&apos;")],
        )
        answer = self.walked(archive, queryAnswer=answered, queryFindsNothing=True)
        probed = [
            step["query"]["withAnswer"]
            for step in self.steps(answer, "QueryRequestActivity")
            if "withAnswer" in step["query"]
        ]
        self.assertTrue(probed)
        for probe in probed:
            self.assertEqual(probe["RemoteQuerySessionManager.getErrors"], {})
            params = probe["RemoteQuerySessionManager.getRawQueryParams"]
            sent = [value for values in params.values() for value in values]
            self.assertIn("match-none()", sent)
            self.assertFalse(any("search-value-mixes-quote-marks" in value for value in sent), sent)
            found = probe["afterServerFindsNothing"]
            self.assertEqual(found["toast"], "Query response had no results")
            self.assertIs(found["errorShown"], False)
            self.assertIs(found["finishing"], False)
            self.assertTrue(found["prompts"])
            for prompt in found["prompts"].values():
                self.assertEqual(prompt["text"], answered)
                self.assertIs(prompt["enabled"], True)
                self.assertIs(prompt["focusable"], True)

    def test_a_fuzzy_search_matches_a_columns_sort_key_and_only_where_it_has_one(self):
        """Finding 51. Contract: with fuzzy search on, Android matches a misspelled term against each column's
        sort key (``EntityStringFilterer``, ``EntitySortUtil``), so the same list finds a case by a misspelling
        where its column carries the sort element HQ's build writes, and not where the column carries none, as
        Nova's local archive leaves it; with fuzzy search off neither finds it, and the exact word finds it
        either way. Failure it catches: fuzzy search reading the shown text, or the sort element doing nothing."""
        field = '<template><text><xpath function="case_name"/></text></template></field>'
        sort = (
            '<template><text><xpath function="case_name"/></text></template>'
            '<sort type="string" order="1" direction="ascending"><text><xpath function="case_name"/></text></sort>'
            "</field>"
        )
        with zipfile.ZipFile(OPERATION_QUERY) as zipped:
            suite = zipped.read("suite.xml").decode()
        first = suite.index(field)
        keyed = variant(
            OPERATION_QUERY,
            self.work / "sort-key.ccz",
            {"suite.xml": (suite[:first] + sort + suite[first + len(field) :]).encode()},
        )

        def searches(archive):
            listed = self.steps(self.walked(archive, OPERATION_QUERY_RESTORE), "EntitySelectActivity")[0]["list"]
            return listed["searches"]

        local, as_hq = searches(OPERATION_QUERY), searches(keyed)
        for held in (local, as_hq):
            self.assertEqual(held["fuzzyOn"]["proof"], ["proof text"])
            self.assertEqual(held["fuzzyOff"]["proox"], [])
        self.assertEqual(local["fuzzyOn"]["proox"], [])
        self.assertEqual(as_hq["fuzzyOn"]["proox"], ["proof text"])

    def test_every_language_code_an_archive_holds_is_offered(self):
        """Defect 1's language codes. Contract: Android's language picker offers every code an archive's suite
        holds, a preferred spelling (``zho``) beside a suffixed one (``cmn-hant``), each named by the app string
        whose key is the code (``ChangeLocaleUtil.translateLocales``, ``Localization.get``), and the code itself
        where no string has that key. Failure it catches: a code the picker drops or renames, or a name read
        from anything but the app strings."""
        zho = with_language_code(SUFFIXED_LANGUAGES, self.work / "zho.ccz", "cmn-hans", "zho")
        unnamed = with_language_code(
            SUFFIXED_LANGUAGES, self.work / "zho-unnamed.ccz", "cmn-hans", "zho", name_key=False
        )
        offered = {}
        for label, archive in (("suffixed", SUFFIXED_LANGUAGES), ("zho", zho), ("unnamed", unnamed)):
            answer = self.reader.request("profile", archive=str(archive))
            self.assertEqual(answer["install"], "Installed", label)
            locale = answer["profile"]["locale"]
            offered[label] = dict(
                zip(locale["ChangeLocaleUtil.getLocaleCodes"], locale["ChangeLocaleUtil.getLocaleNames"], strict=True)
            )
        self.assertEqual(offered["suffixed"], {"en": "English", "cmn-hans": "简体中文", "cmn-hant": "繁體中文"})
        self.assertEqual(offered["zho"], {"en": "English", "zho": "简体中文", "cmn-hant": "繁體中文"})
        self.assertEqual(offered["unnamed"], {"en": "English", "zho": "zho", "cmn-hant": "繁體中文"})

    # The spelling rules one of whose readers is Android ---------------------------------------------------------

    def test_a_device_reads_an_archive_alike_under_either_app_id(self):
        """The spelling rule ``runtime-url-app-id``. Contract: an archive whose search URL and server
        properties name one app id and the same archive naming another install alike, and every profile
        reader, the home screen and every walk give the same answer but for the id in each address: a device
        reads an app's id as an address and nothing more. Failure it catches: an id read as anything but an
        address (an app's identity, a key of what the device holds), which would make the release's id and
        the working app's two apps to a worker."""
        first, second = "0" * 31 + "1", "0" * 31 + "2"
        answers = {
            app_id: self.walked(
                with_runtime_urls(SYNC_ON_ENTRY, self.work / f"app-{app_id}.ccz", app_id), SYNC_ON_ENTRY_RESTORE
            )
            for app_id in (first, second)
        }
        self.assertTrue(answers[first]["walks"])
        before, after = dict(leaves(answers[first])), dict(leaves(answers[second]))
        changed = differing(answers[first], answers[second])
        self.assertIn("/profile/readers/FormSubmissionHelper.getFormPostURL", changed)
        self.assertTrue([path for path in changed if path.endswith("/query/url")], sorted(changed))
        for path in sorted(changed):
            with self.subTest(path=path):
                self.assertIsInstance(before.get(path), str)
                self.assertIn(first, before[path])
                self.assertEqual(before[path].replace(first, second), after.get(path))

    def test_an_archive_that_needs_a_later_commcare_is_refused(self):
        """The import guide's version sentence. Contract: Android installs an archive whose profile asks for a
        CommCare version it runs (``requiredMajor``, ``requiredMinor`` and ``requiredMinimal``, as HQ's build
        writes them, ``templates/app_manager/profile.xml``), refuses one that asks for a later one
        (``IncompatibleReqs``), and refuses to stage an update to it from an install it runs while it stages
        the update that keeps the version it runs. Failure it catches: a requirement Android does not read, so
        a phone on an older CommCare takes an app it cannot run."""
        root = '<profile xmlns="http://cihi.commcarehq.org/jad" version="{version}"'

        def needing(label, version, major, minor):
            raised = [(root.format(version="1"), root.format(version=version))]
            if version != "1":
                raised.append(('<resource id="suite" version="1"', f'<resource id="suite" version="{version}"'))
            required = f' requiredMajor="{major}" requiredMinor="{minor}" requiredMinimal="0"'
            raised.append((root.format(version=version), root.format(version=version) + required))
            return edited(INLINE_LIST, self.work / f"needs-{label}.ccz", "profile.ccpr", raised)

        runs, later = needing("runs", "1", 2, 57), needing("later", "1", 2, 99)
        installed = self.reader.request("installs", archives=[str(runs)])
        refused = self.reader.request("installs", archives=[str(later)])
        self.assertEqual([step["install"] for step in installed["installs"]], ["Installed"])
        self.assertEqual([step["install"] for step in refused["installs"]], ["IncompatibleReqs"])
        kept = self.reader.request("update", archive=str(runs), update=str(needing("kept", "2", 2, 57)))
        raised = self.reader.request("update", archive=str(runs), update=str(needing("raised", "2", 2, 99)))
        self.assertEqual((kept["staged"], kept["updated"]), ("UpdateStaged", "Installed"))
        self.assertEqual(raised["staged"], "IncompatibleReqs")


if __name__ == "__main__":
    unittest.main()
