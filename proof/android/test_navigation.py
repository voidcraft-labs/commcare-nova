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
  phone lacks, which Core's ``CaseXmlParser.loadCase`` refuses as the form saves, so the device quarantines the
  form, sends nothing and tells the worker "Form Record Quarantined". Preview running as Android saves nothing for
  such a form and says so (``lib/preview/platform.ts``, ``entryPointUnheldCaseSubmit``).
- ``targeted-forms-in-menu-above-one-case``: the entry point ``patient_visit`` (after-submit Previous) completed,
  then opened again and left through Back's quit dialog (Discard). Either way home, launched from outside, resets the session and finishes,
  handing RESULT_CANCELED back to the app that opened the link (``SessionLaunchDelegate.kt::exitFromExternalLaunch``),
  so no after-submit runs and the next visit starts fresh.

The plausible failures: a destination HQ builds as another (``root`` as the app's home, ``parent_module`` as
the form's own menu); a device that opens a menu selecting several cases, so a destination there would be one a
worker reaches; a form off the menu a link or an entry point no longer opens, which would make what Nova says
of Android untrue; a hidden menu a link opens as anything but an empty screen; and a form for a case the phone
lacks that reaches HQ, which would make Preview's refusal to save it untrue; and a deep link's form whose end
keeps the visit going, which would make Preview's return to the phone's home screen untrue.
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
# Android's notification for a form its failed save quarantined (notification.quarantine.local.title).
FORM_RECORD_QUARANTINED = "Form Record Quarantined"
FORM_ENTRY = "FormEntryActivity"
MENU = "MenuActivity"
LIST = "EntitySelectActivity"
# Android's Activity.RESULT_CANCELED, which home hands back to the app that opened a deep link once its form ends.
RESULT_CANCELED = 0
# Core's name for what a session needs where a menu selects several cases (SessionFrame.STATE_MULTIPLE_DATUM_VAL).
SELECTED_ENTITIES = "SELECTED_ENTITIES"


@contextmanager
def _served(document, *, change=None):
    """HQ's release of ``document`` as Nova first publishes it, served by HQ's own views, and the archive a
    worker installs of it."""
    from proof.android import observe
    from proof.formplayer import hq as formplayer_hq
    from proof.rules.conftest import published

    with published(document, None) as app, formplayer_hq.serve(
        app.unit, document, app.app_id, change=change
    ) as served:
        yield served, observe.release_archive(served)


def _navs(document, label, *, change=None, **asked):
    """The ``nav`` request's records over HQ's release of ``document``, by navigation; a ``sent`` list among
    ``asked`` gains each form the device sent HQ."""
    from proof.android.navigation import nav
    from proof.observe.record import Blobs

    blobs = Blobs()
    with _served(document, change=change) as (served, archive):
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
    status question holding no answer; the device sends HQ nothing, and the worker is told "Form Record
    Quarantined": Android processes the form as it saves it, Core refuses the update, and the failed save
    quarantines the form, never processed, the reading Preview's ``entryPointUnheldCaseSubmit`` holds for Android
    (its outcome A)."""
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
    assert FORM_RECORD_QUARANTINED in record["landed"]["notifications"], record["landed"]


def test_reaching_shared_forms_by_android_intent_keeps_each_routes_command_and_breadcrumb(android_documents, hq):
    routes = {
        "visit": ("m0-f1", "Visits", "Visit notes"),
        "clinic_visit": ("m1-f1", "Clinic", "Visit notes"),
        "private_notes": ("m0-f3", "Visits", "Private notes"),
        "clinic_private": ("m1-f3", "Clinic", "Private notes"),
    }
    paths = [["m0", "m0-f1"], ["m1", "m1-f1"]]
    navs = _navs(
        android_documents["targeted-listed-forms"],
        "listed-forms",
        endpoints=[{"id": key} for key in routes],
        paths=paths,
    )
    for endpoint, (command, menu, title) in routes.items():
        record = navs[f"endpoint:{endpoint}"]
        assert record["handedHome"]["endpoint"] == endpoint, record
        opened = record["landed"]["steps"][0]
        assert opened["screen"] == FORM_ENTRY and opened["session"]["command"] == command, (endpoint, opened)
        assert opened["form"]["loaded"] and opened["form"]["alert"] is None, (endpoint, opened)
        assert opened["form"]["FormEntryActivity.getHeaderString"] == f"Field visits > {menu} > {title}", opened

    for path, menu in zip(paths, ("Visits", "Clinic"), strict=True):
        steps = _steps(navs[f"path:{'/'.join(path)}"])
        opened = next(step for step in steps if step["screen"] == FORM_ENTRY)
        assert opened["session"]["command"] == path[-1], opened
        assert opened["form"]["loaded"] and opened["form"].get("alert") is None, opened
        assert opened["form"]["FormEntryActivity.getHeaderString"] == f"Field visits > {menu} > Visit notes", opened


def test_a_form_a_deep_link_opened_ends_the_visit_submitted_or_left(android_documents, hq):
    """Android finishes a visit a deep link opened when its first form ends, submitted or left, before any
    after-submit runs: home resets the session and hands RESULT_CANCELED back to the app that opened the link
    (``SessionLaunchDelegate.kt::exitFromExternalLaunch``, ``ccodk_exit_after_form_submission`` true unless the
    caller says otherwise). ``patient_visit``'s after-submit is Previous, which Web Apps follows to the first
    menu; Preview running as Android shows the phone's home screen on a new session
    (``lib/session/store.ts::previewEntryPointVisit``)."""
    doc = android_documents["targeted-forms-in-menu-above-one-case"]
    navs = _navs(
        doc,
        "first-menu-patient",
        endpoints=[{"id": "patient_visit", "arguments": ["patient-2"], "complete": True}],
        paths=[["m1-f0"]],
    )
    submitted = navs["endpoint:patient_visit"]
    assert "raised" not in submitted, submitted
    opened, returned = _after_form(submitted["landed"])
    assert opened["session"]["command"] == "m0-f0", opened
    assert opened["session"]["selectedCase"] == "patient-2", opened
    assert returned["screen"] == "home" and returned["session"]["command"] is None, returned
    assert "selectedCase" not in returned["session"], returned
    assert submitted["landed"]["finished"] is True, submitted["landed"]
    assert submitted["landed"]["resultCode"] == RESULT_CANCELED, submitted["landed"]
    left = _navs(
        doc,
        "first-menu-patient-left",
        endpoints=[{"id": "patient_visit", "arguments": ["patient-2"], "leave": True}],
    )["endpoint:patient_visit"]
    assert "raised" not in left, left
    assert any(step["screen"] == FORM_ENTRY for step in _steps(left["landed"])), left
    assert left["landed"]["finished"] is True, left["landed"]
    assert left["landed"]["resultCode"] == RESULT_CANCELED, left["landed"]
    fresh = _steps(navs["path:m1-f0"])
    assert any(step["screen"] == LIST for step in fresh), fresh


@pytest.mark.parametrize("layout", ["basic", "advanced"])
def test_list_actions_open_the_parent_form_or_the_form_creating_a_member(android_documents, hq, layout):
    paths = [
        ["m2", "@case:household-2", "@action:0"],
        ["m1", "@case:household-2", "@action:0"],
    ]
    navs = _navs(android_documents[f"case-list-action-{layout}"], "list-action-roles", paths=paths)
    for path, command in zip(paths, ("m3-f0","m3-f1"), strict=True):
        steps = _steps(navs["path:"+"/".join(path)])
        forms = [step for step in steps if step["screen"] == FORM_ENTRY]
        assert forms and forms[0]["session"]["command"] == command, steps
        assert any((step.get("list") or {}).get("took") == 0 for step in steps), steps


def test_menu_badges_are_read_and_shortened_on_the_installed_android_app(android_documents, hq):
    walks = _navs(android_documents["targeted-menu-badges"], "menu-badges", paths=[["m0"]])
    screens = [step["menu"] for step in _steps(walks["path:m0"]) if step.get("menu")]
    menu = next(screen for screen in screens if screen["id"] == "m0")
    assert [(item["id"], item.get("badge")) for item in menu["items"]] == [
        ("m0-f0", None), ("m0-f1", ""), ("m0-f2", "999+"),
        ("m0-f3", "999+"), ("m0-f4", "214.."), ("m0-f5", "Équ.."),
    ]


def test_generated_navigation_badges_are_used_in_the_android_release(android_documents, hq, android_walk_evidence):
    from proof.formplayer.apps import override_navigation_badges

    walks = _navs(
        android_documents["targeted-menu-badges"], "generated-navigation-badges",
        change=override_navigation_badges, paths=[[], ["m0"]],
    )
    android_walk_evidence(walks)
    menu = _steps(walks["path:"])[-1]["menu"]
    assert [(item["id"], item.get("badge")) for item in menu["items"]] == [("m0", "Urg.."), ("m1", None)]
    forms = _steps(walks["path:m0"])[-1]["menu"]
    assert [(item["id"], item.get("badge")) for item in forms["items"]] == [
        ("m0-f0", None), ("m0-f1", ""), ("m0-f2", "999+"),
        ("m0-f3", "999+"), ("m0-f4", "214.."), ("m0-f5", "Rea.."),
    ]


def test_a_worker_can_hold_a_grid_label_to_hear_it_and_choose_that_command(android_documents, hq):
    navs = _navs(
        android_documents["targeted-menu-layouts"],
        "menu-layouts",
        paths=[[], ["m0"], ["m2"], ["m0", "m1-f0"]],
        hold_spoken_label="4aebda3a657a0d8f532d11ceacb1679081d7bdf7d7d301a53f1096af3580be91",
    )
    root = _steps(navs["path:"])[-1]["menu"]
    assert root["view"] == "GridView"
    assert [(item["id"], item["playedOnHold"]) for item in root["items"]] == [("m0", True), ("m2", False)]
    shared = _steps(navs["path:m0"])[-1]["menu"]
    assert shared["view"] == "GridView"
    assert [(item["id"], item["playedOnHold"]) for item in shared["items"]] == [("m0-f0", False), ("m1-f0", True)]
    listed = _steps(navs["path:m2"])[-1]["menu"]
    assert listed["view"] == "ListView"
    assert [item["id"] for item in listed["items"]] == ["m2-f0", "m2-f1"]
    assert listed["items"][0]["audio"]["held"] is True
    assert any(step.get("screen") == FORM_ENTRY for step in _steps(navs["path:m0/m1-f0"]))
