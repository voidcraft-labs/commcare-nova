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

The device walks the survey "Visit" from home and the case list "Patients" before its form "Review", with each
screen's views as Android laid them out:

- the question ``remarks``'s screen shows Android's missing-image prompt (``MediaLayout.setupImage``, which calls
  ``showMissingMediaView`` with ``image_download_prompt``) and an audio button (``MediaLayout.setupStandardAudio``
  shows it for any reference); ``photo``'s screen shows no prompt;
- the select ``answer``'s screen shows one audio button, its first choice's, the second choice naming no sound;
- the case list's image cell draws Android's archive icon for a case whose status maps to the picture
  (``EntityView.setupImageLayout`` draws ``ic_menu_archive`` where no bitmap is found), and the transparent fill
  for a case whose status maps to no picture (its counterpart, the same cell with nothing to draw); the case
  database holds both (``proof/observe/casedata.py`` gives ``care_status`` text values and the two it maps);
- the menus name the menu's icon and the form's sound, and the device holds no file for either.

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
VISIT = "m0-f0"
REVIEW = "m2-f0"
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

    items = [
        item
        for walk in answer["walks"].values()
        for step in walk.get("steps", [])
        if step.get("menu") and step["menu"].get("items")
        for item in step["menu"]["items"]
    ]
    assert any(item["id"] == "m0" and _named(item["image"], icon) for item in items), items
    assert any(item["id"] == VISIT and _named(item["audio"], sound) for item in items), items
    assert image not in str([item for item in items if item["image"] is not None]), items
