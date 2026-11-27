"""What CommCare Android shows of a media reference with no file, on each slot a worker can meet one on.

Contract (``proof/android/README.md``, "Checks"): the test reads HQ's build of ``targeted-missing-media``, published
as the corpus captured it (``proof.rules.conftest.published``, the ``minimum`` export), with its files taken away
as an app made in CommCare HQ can hold them (``proof.formplayer.apps.with_missing_media``: the question
``remarks``'s image, the one sound, and the picture the menu "Visits", the case list's image column and its Register
action share lose their multimedia map entries), released and served by HQ's own views
(``proof.formplayer.hq.serve``), and installed from HQ's download of the release (``observe.release_archive``). A
reference with no entry has no media resource in the build, so the device installs the app and holds no file for
it. The file of ``photo``'s image keeps its entry and stays: an archive missing a file its build names is one the
device refuses to install (``proof/android/predicates.py``), which would leave nothing of the rest to read, so that
reference is Web Apps' alone (``proof/webapps/test_missing_media.py``), and here it is the counterpart, a question
whose image the device holds.

The device opens the survey "Visit" and the form "Review" from their commands, as the ``app`` request's
``commands`` set them on a session (the case list "Patients" before "Review"), with each screen's views as
Android laid them out; a command's session starts past every menu, so the menus are read apart, by the ``nav``
request's paths (``proof.android.navigation.nav``): the app's first menu as a worker opens it, and the menu
"Visits" chosen from it as a worker taps it. Then:

- the question ``remarks``'s screen shows Android's missing-image prompt (``MediaLayout.setupImage``, which calls
  ``showMissingMediaView`` with ``image_download_prompt``) and an audio button (``MediaLayout.setupStandardAudio``
  shows it for any reference); ``photo``'s screen shows no prompt;
- the select ``answer``'s screen shows one audio button, its first choice's, the second choice naming no sound;
- the case list's image cell draws Android's archive icon for a case whose status maps to the picture
  (``EntityView.setupImageLayout`` draws ``ic_menu_archive`` where no bitmap is found), and the transparent fill
  for a case whose status maps to no picture (its counterpart, the same cell with nothing to draw); the case
  database holds both (``proof/observe/casedata.py`` gives ``care_status`` text values and the two it maps);
- the first menu's item "Visits" names the menu's icon and the menu "Visits"'s item "Visit" the form's sound,
  and the device holds no file for either.

Plausible failures: a missing file Android draws nothing for where Nova refuses the reference (no prompt, no
button, no archive icon, which a cell holding the transparent fill would be), and a prompt shown where the device
holds the file. What the device draws on a menu's tile,
a form's tile and the Register action is not in the walk's record (a menu item is recorded by its texts and the
media it names, and the list's actions by their names), so this test holds that the device names those references
and holds no file for them, and does not hold what it draws there.
"""

from __future__ import annotations

from contextlib import contextmanager

import pytest

from proof.formplayer import apps

pytestmark = pytest.mark.reader("android")

DOCUMENT = "targeted-missing-media"
VISITS = "m0"
VISIT = "m0-f0"
REVIEW = "m2-f0"
# The ``nav`` request's paths: the app's first menu, and the menu "Visits" chosen from it.
FIRST_MENU = "path:"
VISITS_MENU = f"path:{VISITS}"
FORM_ENTRY = "FormEntryActivity"
# ``image_download_prompt`` (commcare-android ``app/res/values/strings.xml``), the text
# ``MediaLayout.showMissingMediaView`` shows for a question's image the device holds no file for.
IMAGE_MISSING = "Image file is missing for this question, Click the download button above to download"
AUDIO_BUTTON = "AudioPlaybackButton"
# What a case list's image cell draws (``proof/android/src/nova/proof/android/Views.java::drawable``): Android's
# archive icon where the device holds no file for the value's picture, and ``R.color.transparent`` where the value
# maps to no picture.
ARCHIVE_ICON = "resource:ic_menu_archive"
NO_PICTURE = "color:#00000000"


@contextmanager
def _served(document):
    """HQ's release of ``document`` with its files taken away, served by HQ's own views, and the archive a
    worker installs of it."""
    from proof.android import observe
    from proof.formplayer import hq as formplayer_hq
    from proof.rules.conftest import published

    with (
        published(document, None) as app,
        formplayer_hq.serve(
            app.unit, document, app.app_id, change=apps.with_missing_media(app, delete_file=False)
        ) as served,
    ):
        yield served, observe.release_archive(served)


def _app(served, archive, label, **steer):
    """The ``app`` request's answer."""
    from proof.android import observe
    from proof.observe.record import Blobs

    blobs = Blobs()
    found = observe.app(served, blobs, label=label, archive=archive, **steer)
    return blobs.get_json(found["answer"])


def _menus(served, archive, label):
    """Each menu the ``nav`` request's paths reach, by path: its step's ``menu``, the items it lists."""
    from proof.android.navigation import nav
    from proof.observe.record import Blobs

    blobs = Blobs()
    found = nav(served, blobs, label=label, archive=archive, paths=[[], [VISITS]])
    answer = blobs.get_json(found["answer"])
    assert answer["install"] == "Installed", answer
    menus = {}
    for name, record in answer["navs"].items():
        assert "raised" not in record, (name, record)
        steps = record["steps"]
        assert steps and steps[-1]["screen"] == "MenuActivity" and steps[-1]["menu"]["items"], (name, steps)
        menus[name] = steps[-1]["menu"]
    return menus


def _shown(view):
    """Every view a laid-out view shows: itself and its children, leaving out any view that is gone or invisible
    and everything under it."""
    if not view or "visibility" in view:
        return []
    found = [view]
    for child in view.get("children", ()):
        found.extend(_shown(child))
    return found


def _screen(walk, reference):
    """The views the one form screen whose question is at ``reference`` shows."""
    screens = [
        screen
        for step in walk.get("steps", [])
        if step.get("screen") == FORM_ENTRY and "form" in step
        for screen in step["form"].get("screens", [])
        if any(question["reference"] == reference for question in screen.get("questions", ()))
    ]
    assert screens, (reference, walk.get("steps"))
    return [_shown(screen.get("view") or {}) for screen in screens]


def _named(media, name):
    """Whether a menu item's media names the file ``name`` and the device holds none for it."""
    return media is not None and media["uri"].endswith(f"/{name}") and media["held"] is False


def test_android_prompts_for_a_questions_missing_image_and_offers_the_missing_sounds(android_documents, hq):
    image, icon, sound = apps.MISSING_MEDIA_UNMAPPED
    with _served(android_documents[DOCUMENT]) as (served, archive):
        answer = _app(
            served,
            archive,
            "missing-media",
            commands=[VISIT, REVIEW],
            questions={"/data/remarks": ["proof"], "/data/answer": ["yes"], "/data/photo": ["proof"]},
            views=True,
        )
        menus = _menus(served, archive, "missing-media-menus")

    visit = answer["walks"][VISIT]
    for shown in _screen(visit, "/data/remarks[1]"):
        texts = [view["text"] for view in shown if view.get("text")]
        assert IMAGE_MISSING in texts, texts
        assert [view["class"] for view in shown].count(AUDIO_BUTTON) == 1, shown
    for shown in _screen(visit, "/data/answer[1]"):
        assert [view["class"] for view in shown].count(AUDIO_BUTTON) == 1, shown
    for shown in _screen(visit, "/data/photo[1]"):
        assert IMAGE_MISSING not in [view.get("text") for view in shown], shown

    lists = [step["list"] for step in answer["walks"][REVIEW].get("steps", []) if step.get("list")]
    assert lists and all(listed["rows"] for listed in lists), lists
    drawn = []
    for listed in lists:
        for row in listed["rows"]:
            cells = [view for view in _shown(row) if "drawable" in view]
            assert len(cells) == 1, row
            drawn.append(cells[0]["drawable"])
        assert "Register" in listed.get("actions", []), listed.get("actions")
    assert ARCHIVE_ICON in drawn and NO_PICTURE in drawn, drawn
    assert set(drawn) == {ARCHIVE_ICON, NO_PICTURE}, drawn

    # The first menu lists "Visits" under its icon, and "Visits" lists "Visit" with its sound; the device holds
    # neither file.
    assert menus[FIRST_MENU]["id"] is None and menus[VISITS_MENU]["id"] == VISITS, menus
    first = {item["id"]: item for item in menus[FIRST_MENU]["items"]}
    assert VISITS in first and _named(first[VISITS]["image"], icon), first
    visits = {item["id"]: item for item in menus[VISITS_MENU]["items"]}
    assert VISIT in visits and _named(visits[VISIT]["audio"], sound), visits
    items = [
        *(item for menu in menus.values() for item in menu["items"]),
        *(
            item
            for walk in answer["walks"].values()
            for step in walk.get("steps", [])
            if step.get("menu") and step["menu"].get("items")
            for item in step["menu"]["items"]
        ),
    ]
    assert image not in str([item for item in items if item["image"] is not None]), items


@pytest.mark.parametrize("scenario", ["ordinary", "orphan", "unmapped", "other-language", "same-language"])
def test_generated_navigation_icon_needs_a_file_in_the_full_release(
    hq, android_documents, android_walk_evidence, scenario
):
    from io import BytesIO
    from zipfile import ZipFile

    from proof.android import observe
    from proof.android.navigation import nav
    from proof.checks.compare.app_strings import parse_app_strings
    from proof.formplayer import hq as formplayer_hq
    from proof.observe.record import Blobs
    from proof.rules.conftest import published

    image, icon, _ = apps.MISSING_MEDIA_UNMAPPED
    expected_name = icon if scenario == "ordinary" else image
    expected_file = scenario not in ("orphan", "unmapped")
    document = android_documents[DOCUMENT]
    with published(document, None) as app:
        with formplayer_hq.serve(
            app.unit, document, app.app_id, change=apps.generated_menu_icon(app, scenario)
        ) as served:
            archive = observe.release_archive(served)
            with ZipFile(BytesIO(archive)) as files:
                locale = parse_app_strings(files.read("en/app_strings.txt").decode())
                assert locale["modules.m0.icon"].endswith("/" + expected_name)
                if scenario == "unmapped":
                    assert locale["modules.m0.icon"] == apps.UNMAPPED_GENERATED_ICON
                assert any(name.endswith("/" + expected_name) for name in files.namelist()) == expected_file
            blobs = Blobs()
            observed = nav(served, blobs, label=f"generated-icon-{scenario}", archive=archive, paths=[[]])
            answer = blobs.get_json(observed["answer"])

    android_walk_evidence(answer)
    assert answer["install"] == "Installed", answer
    assert answer["signIn"].startswith("Success("), answer
    walk = answer["navs"][FIRST_MENU]
    assert "raised" not in walk, walk
    (visit,) = [item for item in walk["steps"][-1]["menu"]["items"] if item["id"] == VISITS]
    assert visit["image"]["uri"].endswith("/" + expected_name), visit
    if scenario == "unmapped":
        assert visit["image"]["uri"] == apps.UNMAPPED_GENERATED_ICON, visit
    assert visit["image"]["held"] == expected_file, visit


def test_other_language_carrier_only_packages_a_generated_icon_when_the_profile_includes_it(
    hq, android_documents, android_walk_evidence
):
    from dataclasses import replace

    from corehq import privileges
    from corehq.apps.accounting import utils as accounting

    from proof.android import observe
    from proof.android.navigation import nav
    from proof.checks.compare.app_strings import parse_app_strings
    from proof.formplayer import hq as formplayer_hq
    from proof.hq import operations
    from proof.hq.check import hq_check
    from proof.hq.seams import build_seams
    from proof.hq.test_installation_profiles import offline_download, profile_payload
    from proof.observe.record import Blobs
    from proof.observe import publish
    from proof.rules.conftest import Published

    image, _, _ = apps.MISSING_MEDIA_UNMAPPED
    document = android_documents[DOCUMENT]
    export = document.exports["maximum"]
    base_configuration = export.configuration.hq()
    configuration = replace(base_configuration, privileges=base_configuration.privileges | {"BUILD_PROFILES"})
    with hq_check(configuration) as (unit, _):
        app_id, refusal, lookups = publish.create(unit, export)
        assert refusal is None, refusal
        assert lookups is None or lookups["errors"] == [], lookups
        for request, _ in export.content.media_uploads():
            media = operations.apply_media_upload(unit, app_id, request.upload())
            assert media.status == 200, media.response
        app = Published(document, export, unit, app_id)
        change = apps.generated_menu_icon(app, "other-language")

        def named_profiles(stored):
            change(stored)
            stored["build_profiles"] = {
                "both": profile_payload("English and French", ["en", "fr"]),
                "english": profile_payload("English", ["en"]),
            }

        with formplayer_hq.serve(
            app.unit, document, app.app_id, change=named_profiles
        ) as served:
            assert accounting.domain_has_privilege(app.unit.domain, privileges.BUILD_PROFILES)
            build = operations.held_app(app.unit, served.build_id)
            for profile, carries_file in (("both", True), ("english", False)):
                with build_seams(), app.unit.committing():
                    files = offline_download(app.unit, build, profile)
                locale = parse_app_strings(files["en/app_strings.txt"].decode())
                icon = locale["modules.m0.icon"]
                assert icon.startswith("jr://file/") and icon.endswith("/" + image)
                file_path = icon.removeprefix("jr://file/")
                assert ("fr/app_strings.txt" in files) == carries_file
                assert (file_path in files) == carries_file
                if carries_file:
                    assert files[file_path]
                archive = observe.archive_bytes(files.items())
                blobs = Blobs()
                found = nav(served, blobs, label=f"generated-icon-profile-{profile}", archive=archive, paths=[[]])
                answer = blobs.get_json(found["answer"])
                android_walk_evidence(answer)
                assert answer["install"] == "Installed", answer
                assert answer["signIn"].startswith("Success("), answer
                walk = answer["navs"][FIRST_MENU]
                assert "raised" not in walk, walk
                (visit,) = [item for item in walk["steps"][-1]["menu"]["items"] if item["id"] == VISITS]
                assert visit["image"]["uri"] == icon, visit
                assert visit["image"]["held"] == carries_file, visit
