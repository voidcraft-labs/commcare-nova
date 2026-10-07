"""The Android predicates the known-defect register names, each run over both spellings of its difference.

    python3 -m unittest proof.android.predicates -v

A register entry whose harm is on Android names the Android predicate in its ``android`` field, and its
difference is two spellings of one artifact (a profile property present or absent, a tile cell's style, a
form's ``xmlns``). Each test here installs both spellings on Android and holds what Android's own code reads of
each: the spelling Nova exports is a retained control's archive (``proof/controls``), and the other is that
archive with exactly the entry's difference written into it. So each test says, by a run of Android's own
classes, whether the two spellings differ for a worker and how.

These hold the predicates whose two spellings one archive edit gives. The predicates whose other side only HQ's
build gives (the Sort menu's hidden column, an image-map column's width, the form entry a sync-on-form-entry
build refuses, the search screen's handling of a refused query, a fuzzy search's matches) are read over the
lane's own archives by ``proof.android.observe``.

It needs a reader runtime (``PROOF_ANDROID_RUNTIME``) and ``java``, and the standard library alone. Like
``selfcheck.py`` it is not a ``test_*.py``: the lane's image holds no reader runtime.
"""

from __future__ import annotations

import tempfile
import unittest
import zipfile
from pathlib import Path

from proof.android.client import AndroidReader, AndroidReaderUnavailable, unavailable
from proof.android.selfcheck import CONTROLS, differing, variant, with_property

SURVEY = CONTROLS / "targeted-survey-menu" / "local.ccz"
SURVEY_AGAIN = CONTROLS / "targeted-survey-menu" / "local-again.ccz"
TILE = CONTROLS / "targeted-custom-tile"
LABELLED_REPEAT = CONTROLS / "targeted-labelled-group-repeat" / "local.ccz"

# Each profile setting an entry's difference is, with the value HQ's profile gives it: the readers it moves from
# what Android gives where the setting is absent (Nova's local profile) to what it gives where it is present,
# and the readers that give the same either way (an entry marked ``equivalence``, or forced at an update only).
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


def edited(archive: Path, target: Path, name: str, replacements) -> Path:
    """The archive with ``name`` rewritten by exact replacements, each of which its text must hold."""
    with zipfile.ZipFile(archive) as zipped:
        text = zipped.read(name).decode("utf-8")
    for old, new in replacements:
        assert old in text, f"{archive}'s {name} does not hold {old!r}"
        text = text.replace(old, new)
    return variant(archive, target, {name: text.encode("utf-8")})


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
        """Defect 40's equivalences. Contract: where HQ's app settings save writes one of these settings at the
        value its reader gives when it is absent, Android reads the two profiles alike: the stored value differs
        and no reader does. Failure it catches: an entry marked ``equivalence`` whose two spellings Android reads
        apart."""
        for key, value, readers in SAME:
            with self.subTest(key=key):
                present = self.profile_with(key, value)
                for name, reading in readers.items():
                    self.assertEqual(self.plain["profile"]["readers"][name], reading)
                    self.assertEqual(present["profile"]["readers"][name], reading)
                self.assertEqual(differing(self.plain, present), {f"/profile/stored/{key}"})

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
        self.assertEqual(answers["renamed"]["reopened"]["records"][0]["AndroidCommCarePlatform.getFormDefId"], -1)
        self.assertIn(
            "No XForm definition defined for this form", answers["renamed"]["reopened"]["form"]["alert"]["msg"]
        )

    def tile(self, label, replacements):
        archive = edited(TILE / "local.ccz", self.work / f"tile-{label}.ccz", "suite.xml", replacements)
        answer = self.reader.request("app", archive=str(archive), restore=str(TILE / "restore.xml"), commands=["m0-f0"])
        return cells(answer["walks"]["m0-f0"]["steps"][0]["list"]["rows"][0])

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
        listed = self.reader.request("app", archive=str(LABELLED_REPEAT), commands=["m0-f0"])
        plain = self.reader.request(
            "app",
            archive=str(
                edited(LABELLED_REPEAT, self.work / "no-field-list.ccz", form, [(' appearance="field-list"', "")])
            ),
            commands=["m0-f0"],
        )

        def events(answer):
            return [screen["event"] for screen in answer["walks"]["m0-f0"]["steps"][0]["form"]["screens"]]

        self.assertNotIn("PROMPT_NEW_REPEAT", events(listed))
        self.assertIn("PROMPT_NEW_REPEAT", events(plain))


if __name__ == "__main__":
    unittest.main()
