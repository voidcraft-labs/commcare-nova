"""The Android predicates the known-defect register names, each run over both spellings of its difference.

    python3 -m unittest proof.android.predicates -v

A register entry whose harm is on Android names the Android predicate in its ``android`` field, and its
difference is two spellings of one artifact (a profile property present or absent, a tile cell's style, a
form's ``xmlns``). Each test here installs both spellings on Android and holds what Android's own code reads of
each: the spelling Nova exports is a retained control's archive (``proof/controls``), and the other is that
archive with exactly the entry's difference written into it. So each test says, by a run of Android's own
classes, whether the two spellings differ for a worker and how.

Every predicate is held here by one archive edit: the element HQ's build spells one way and Nova's local
archive another (a hidden sort column's header, an image column's width, the claim a sync-on-form-entry build
posts before a form, a list's sort keys) is written into the control's archive exactly as HQ's build of that
control spells it, so the two archives differ in that element alone. The lane's Android stage
(``proof.android.stage``) holds the same predicates on HQ's own builds of every document, as register entries
(``android@...``); these say, wherever the reader runs, which element each rests on.

It needs a reader runtime (``PROOF_ANDROID_RUNTIME``) and ``java``, and the standard library alone. Like
``selfcheck.py`` it is not a ``test_*.py``: the lane's image holds no reader runtime.
"""

from __future__ import annotations

import json
import tempfile
import unittest
import zipfile
from pathlib import Path

from proof.android.client import AndroidReader, AndroidReaderUnavailable, unavailable
from proof.android.selfcheck import CONTROLS, differing, variant, with_property

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
        self.assertEqual(answers["kept"]["reopened"]["records"][0]["AndroidCommCarePlatform.getFormDefId"], "held")
        self.assertEqual(answers["renamed"]["reopened"]["records"][0]["AndroidCommCarePlatform.getFormDefId"], "none")
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
        self.assertEqual(form["ended"], "end")
        self.assertIs(form["saved"]["finishing"], True)

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
        searched = "m0/@action:0/m0-f0"
        self.assertEqual(self.steps(answers["held"], "PostRequestActivity"), [])
        claims = self.steps(answers["claimed"], "PostRequestActivity")
        self.assertTrue(claims)
        for step in claims:
            self.assertEqual(sorted(step["post"]["params"]), ["case_id"])
            self.assertTrue(step["post"]["url"].endswith("/phone/claim-case/"))
            self.assertIs(step["post"]["finishing"], True)
            self.assertEqual(step["post"]["resultCode"], -1)
        for name, answer in answers.items():
            screens = [step["screen"] for step in answer["walks"][searched]["steps"]]
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


if __name__ == "__main__":
    unittest.main()
