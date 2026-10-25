"""Where CommCare Android takes a worker after a form, and from a link or an entry point, on HQ's release of Nova's
export.

Contract (``proof/android/README.md``, "Checks", and the ``nav`` request): each test reads HQ's build of a
corpus document as the pull request's own emitter wrote it, published as the corpus captured it
(``proof.rules.conftest.published``, the ``minimum`` export), released and served by HQ's own views
(``proof.formplayer.hq.serve``), and installed from HQ's download of the release (``observe.release_archive``).
Android's own home activity reads the session each navigation leaves (``proof.android.navigation.nav``).

- ``targeted-multi-select-destinations``: one follow-up for each after-submit destination. Home starts no
  screen where the session needs the cases a menu that selects several holds, so a device opens no form of such
  a menu, nor of one under it but from its command. ``firstMenu`` lands on the list of the app's menus,
  ``module`` on the menu's case list, and ``parentMenu`` and ``previous`` on the parent menu, which lists its
  forms and its child menus (the child menu and its parent hold one case type, so one ``case_id``).
- ``targeted-hidden-from-menu``: a link to a form off the menu, and a link into a menu off the menu, open their
  forms; every entry point opens its form, the two that do not ignore display conditions as the two that do,
  with no alert (Android reads no entry point's ``respect-relevancy``).
- ``targeted-form-link-hidden-target`` (finding 58): links to a shown form, to a form whose display condition
  is false for the worker, and to a menu whose condition is false for them. The two forms open, and the menu
  opens with nothing in it.
- ``targeted-preview-android-renders``: the entry point ``update_visit`` launched on a case id no project space
  holds opens "Update visit" anyway (Core checks only that the session holds the datum's key,
  ``CommCareSession.getFirstMissingDatum``), its status starting blank; completing it, the form updates a case the
  phone lacks, which Core's ``CaseXmlParser.loadCase`` refuses, so the device quarantines the form, sends nothing
  and tells the worker "Problem with your App". Preview running as Android saves nothing for such a form and says
  so (``lib/preview/platform.ts``, ``entryPointUnheldCaseSubmit``).

The plausible failures: a destination HQ builds as another (``root`` as the app's home, ``parent_module`` as
the form's own menu); a device that opens a menu selecting several cases, so a destination there would be one a
worker reaches; a form off the menu a link or an entry point no longer opens, which would make what Nova says
of Android untrue; a hidden menu a link opens as anything but an empty screen; and a form for a case the phone
lacks that reaches HQ, which would make Preview's refusal to save it untrue.
"""

from __future__ import annotations

from contextlib import contextmanager

import pytest

pytestmark = pytest.mark.reader("android")

DESTINATIONS = "targeted-multi-select-destinations"
HIDDEN = "targeted-hidden-from-menu"
HIDDEN_TARGET = "targeted-form-link-hidden-target"
RENDERS = "targeted-preview-android-renders"
# A case id no project space holds, which the entry point names all the same.
UNHELD_CASE = "targeted-unheld-visit"
# Android's notification for a form it could not process (notification.processing.badstructure.title).
PROBLEM_WITH_YOUR_APP = "Problem with your App"
FORM_ENTRY = "FormEntryActivity"
MENU = "MenuActivity"
LIST = "EntitySelectActivity"
# Core's name for what a session needs where a menu selects several cases (SessionFrame.STATE_MULTIPLE_DATUM_VAL).
SELECTED_ENTITIES = "SELECTED_ENTITIES"


@contextmanager
def _served(document):
    """HQ's release of ``document`` as Nova first publishes it, served by HQ's own views, and the archive a
    worker installs of it."""
    from proof.android import observe
    from proof.formplayer import hq as formplayer_hq
    from proof.rules.conftest import published

    with published(document, None) as app, formplayer_hq.serve(app.unit, document, app.app_id) as served:
        yield served, observe.release_archive(served)


def _navs(document, label, **asked):
    """The ``nav`` request's records over HQ's release of ``document``, by navigation; a ``sent`` list among
    ``asked`` gains each form the device sent HQ."""
    from proof.android.navigation import nav
    from proof.observe.record import Blobs

    blobs = Blobs()
    with _served(document) as (served, archive):
        found = nav(served, blobs, label=label, archive=archive, **asked)
    answer = blobs.get_json(found["answer"])
    assert answer["install"] == "Installed", answer
    return answer["navs"]


def _steps(record):
    assert "raised" not in record, record
    return record["steps"]


def _after_form(record):
    """The step home starts after the first form a navigation opened, and that form's step."""
    steps = _steps(record)
    forms = [index for index, step in enumerate(steps) if step["screen"] == FORM_ENTRY]
    assert forms and forms[0] + 1 < len(steps), steps
    return steps[forms[0]], steps[forms[0] + 1]


def _items(step):
    return [item["id"] for item in step["menu"]["items"]]


def test_each_destination_lands_where_the_model_says(android_documents, hq):
    commands = ("m0-f0", "m1-f0", "m2-f0", "m2-f1", "m3-f0", "m4-f0")
    paths = (
        ["m0"],
        ["m0", "m1", "m1-f0"],
        ["m2", "m2-f0"],
        ["m2", "m2-f1"],
        ["m2", "m3", "m3-f0"],
        ["m2", "m4", "m4-f0"],
    )
    navs = _navs(android_documents[DESTINATIONS], "destinations", commands=commands, paths=paths)

    # A menu that selects several cases opens on no device: home starts no screen, its session needing the cases.
    for name in ("command:m0-f0", "command:m3-f0", "path:m0", "path:m0/m1/m1-f0", "path:m2/m3/m3-f0"):
        steps = _steps(navs[name])
        assert steps[-1]["screen"] == "home" and steps[-1]["session"]["needed"] == SELECTED_ENTITIES, (name, steps)
        assert not [step for step in steps if step["screen"] == FORM_ENTRY], (name, steps)

    # firstMenu: the list of the app's menus.
    _, landed = _after_form(navs["command:m1-f0"])
    assert landed["screen"] == MENU and landed["menu"]["id"] is None, landed
    assert _items(landed) == ["m0", "m2"], landed

    # module: the menu's own case list.
    for name in ("command:m2-f1", "path:m2/m2-f1"):
        _, landed = _after_form(navs[name])
        assert landed["screen"] == LIST and landed["session"]["command"] == "m2", (name, landed)

    # parentMenu, and previous from a form of the parent: the parent menu, listing its forms and child menus.
    for name in ("command:m4-f0", "path:m2/m4/m4-f0", "command:m2-f0", "path:m2/m2-f0"):
        _, landed = _after_form(navs[name])
        assert landed["screen"] == MENU and landed["menu"]["id"] == "m2", (name, landed)
        assert _items(landed) == ["m2-f0", "m2-f1", "m3", "m4"], (name, landed)


def test_a_form_off_the_menu_opens_from_a_link_and_from_an_entry_point(android_documents, hq):
    entry_points = {
        "shown_form": "m1-f0",
        "hidden_rest": "m1-f1",
        "hidden_plain": "m1-f2",
        "inside": "m2-f0",
        "inside_plain": "m2-f1",
    }
    navs = _navs(
        android_documents[HIDDEN],
        "hidden-from-menu",
        commands=("m0-f0", "m0-f1"),
        endpoints=[{"id": endpoint} for endpoint in entry_points],
    )

    # Rows 2 and 3: each link opens its target, off the menu or inside a menu off the menu, and home ends there.
    for name, command, header in (
        ("command:m0-f0", "m1-f1", "Hidden menus > Targets > Hidden with rest"),
        ("command:m0-f1", "m2-f0", "Hidden menus > Off the menu > Inside"),
    ):
        _, opened = _after_form(navs[name])
        assert opened["screen"] == FORM_ENTRY and opened["session"]["command"] == command, (name, opened)
        assert opened["form"]["FormEntryActivity.getHeaderString"] == header, (name, opened["form"])
        assert _steps(navs[name])[-1]["screen"] == "home", (name, _steps(navs[name]))

    # Rows 5 and 6, and the shown form: every entry point opens its form, with no alert.
    for endpoint, command in entry_points.items():
        record = navs[f"endpoint:{endpoint}"]
        assert "raised" not in record, record
        assert "handedHome" in record, record
        assert record["handedHome"]["endpoint"] == endpoint, record
        opened = record["landed"]["steps"][0]
        assert opened["screen"] == FORM_ENTRY and opened["session"]["command"] == command, (endpoint, opened)
        assert opened["form"]["loaded"] is True and opened["form"]["alert"] is None, (endpoint, opened["form"])


def test_a_link_to_a_target_its_menu_hides_opens_the_form_and_an_empty_menu(android_documents, hq):
    navs = _navs(android_documents[HIDDEN_TARGET], "hidden-target", commands=("m0-f0", "m0-f1", "m0-f2"))

    for name, command, header in (
        ("command:m0-f0", "m1-f0", "Linked surveys > Targets > Shown"),
        ("command:m0-f1", "m1-f1", "Linked surveys > Targets > Hidden"),
    ):
        _, opened = _after_form(navs[name])
        assert opened["screen"] == FORM_ENTRY and opened["session"]["command"] == command, (name, opened)
        assert opened["form"]["FormEntryActivity.getHeaderString"] == header, (name, opened["form"])

    # The hidden menu opens with nothing in it.
    _, landed = _after_form(navs["command:m0-f2"])
    assert landed["screen"] == MENU and landed["menu"]["id"] == "m2", landed
    assert landed["menu"]["items"] == [], landed


def test_an_entry_point_to_a_case_the_phone_lacks_opens_blank_and_its_completion_is_read(android_documents, hq):
    """``update_visit`` names a case no project space holds and completes the form it opens. The form opens, its
    status question holding no answer; the device sends HQ nothing, and the worker is told "Problem with your
    App": the form is quarantined, never processed, the reading Preview's ``entryPointUnheldCaseSubmit`` holds for
    Android (its outcome A)."""
    sent = []
    navs = _navs(
        android_documents[RENDERS],
        "unheld-case",
        endpoints=[{"id": "update_visit", "arguments": [UNHELD_CASE], "complete": True}],
        sent=sent,
    )

    record = navs["endpoint:update_visit"]
    assert "raised" not in record, record
    opened = record["landed"]["steps"][0]
    assert opened["screen"] == FORM_ENTRY and opened["session"]["command"] == "m1-f0", opened
    (status,) = [
        question
        for screen in opened["form"]["screens"]
        for question in screen["questions"]
        if question["reference"].startswith("/data/status")
    ]
    assert status["answer"] is None, status
    assert sent == [], sent
    assert PROBLEM_WITH_YOUR_APP in record["landed"]["notifications"], record["landed"]
