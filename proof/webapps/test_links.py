"""Where a worker lands in Web Apps after a form whose link names a hidden target, end to end.

``targeted-form-link-hidden-target``: three forms of one menu each link,
with no condition, to one target: a form shown in another menu, a form of
that menu the worker's menu does not offer, and a menu the worker is not
offered. Finding 58 observed Formplayer's answer to each submission
(``proof/formplayer/test_end_of_form.py``); this is the whole path a worker
takes: the form opened by clicks in the client, submitted with its own
Submit button, the submission sent to HQ, and the screen the client then
shows.

Contract, on the released build of Nova's export:

- the link to the shown form opens that form;
- the link to the hidden form leaves the worker on the menu that holds it,
  which lists its shown form alone;
- the link to the hidden menu leaves the worker on the app's first screen;
- each time HQ's receiver processes exactly one submission and the client
  shows the message HQ's receiver answered for it (the form's name, saved),
  so no path loses the form.

Plausible failures: a client that shows an error or stays on the submitted
form when Formplayer answers with a screen other than the link's target, a
hidden form opened all the same (what Core's own session does), or a
submission sent twice.

Two more documents hold where a worker lands after a form, on the same path:

- ``targeted-multi-select-destinations``: one follow-up for each destination
  a menu offers, in menus that select several cases and under them, each
  opened as Formplayer's own walk opened it (several cases ticked, then
  Continue, where the list selects several) and submitted with its own
  Submit button. Contract: ``module`` leaves the worker on the menu's case
  list, ``firstMenu`` on the app's first screen, ``parentMenu`` on the parent
  menu with its forms and child menus, and ``previous`` on the screen before
  the form. The plausible failure: a destination the client lands somewhere
  else for, or shows an error for.
- ``targeted-hidden-from-menu``: a menu and forms off the menu. Contract: the
  menus list neither; a link to a hidden form leaves the worker on the menu
  that holds it and a link into the hidden menu on the app's first screen; an
  entry point, opened by the route HQ's own link view sends the browser to
  (``cloudcare/views.py::session_endpoint``), opens its hidden form where it
  ignores display conditions, and otherwise leaves the worker where a link
  would, with no error and no dialog. The plausible failures: a hidden item
  listed, and an entry point the client opens all the same, which would make
  what the builder says of Web Apps untrue.
"""

from __future__ import annotations

import pytest

from proof.webapps import hq as webapps_hq
from proof.webapps import observe, steps
from proof.webapps.session import Session

DOCUMENT = "targeted-form-link-hidden-target"
START = steps.path(steps.open_app("Linked surveys"), steps.choose("Start"))

LINKS = {
    "shown form": ("To shown form", {"form": "Shown"}),
    "hidden form": ("To hidden form", {"title": "Targets", "commands": ["Shown"]}),
    "hidden menu": ("To hidden menu", {"title": "Linked surveys", "commands": ["Start", "Targets"]}),
}


@pytest.mark.parametrize("link", sorted(LINKS))
def test_web_apps_follows_a_link_to_a_shown_form_and_stops_before_a_hidden_target(
    link, hq, core_runner, formplayer_runner, editor_driver, webapps_documents, evidence
):
    source, expected = LINKS[link]
    with webapps_hq.project(webapps_documents[DOCUMENT]) as project:
        with project.released(formplayer_runner) as release:
            session = Session(release, editor_driver)
            run = session.run([*START, *steps.choose(source), steps.SCREEN, *steps.submit_form(), steps.SCREEN])
            received = len(session.hq.submissions)
    opened, landed = run.screens
    submitted = run.answered("submit-all")
    evidence(f"link-{link.replace(' ', '-')}", {"opened": opened, "landed": landed, "submissions": received})
    assert run.page_errors == [] and run.dialogs == []
    # The source form opened, and its one submission reached HQ and was accepted.
    assert opened["form"]["title"] == source
    assert len(submitted) == 1 and submitted[0].json()["status"] == "success"
    assert received == 1
    # HQ's receiver's own message for the form it processed, which the client shows the worker.
    assert landed["alerts"] == [f"'{source}' successfully saved!"]
    if "form" in expected:
        assert landed["form"]["title"] == expected["form"]
        assert landed["breadcrumbs"][-1] == expected["form"]
    else:
        assert "form" not in landed
        assert landed["title"] == expected["title"]
        assert [command["text"] for command in landed["commands"]] == expected["commands"]


DESTINATIONS = "targeted-multi-select-destinations"
SAMPLES = ["Review samples", "Review samples-again", "Several samples", "One more look"]
# Each follow-up of the witness, and where the client leaves the worker after it: a menu's case list (``list``,
# with the title Formplayer gives it), or a menu's screen (``commands``, with what it lists).
LANDINGS = {
    "Review batches": ("list", "Batches"),
    "Review single-under-batches": ("commands", "Batch reviews", ["Batches", "Samples"]),
    "Review samples": ("commands", "Samples", SAMPLES),
    "Review samples-again": ("list", "Samples"),
    "Review batch-under-samples": ("list", "Several samples"),
    "Review single-under-samples": ("commands", "Samples", SAMPLES),
}


def _submitted_runs(walked):
    """One run of Formplayer's walk for each form it submitted, by the form's title."""
    from proof.formplayer.walk import screen_kind

    found = {}
    for run in walked["runs"]:
        forms = [step["response"] for step in run["steps"] if screen_kind(step.get("response")) == "form"]
        submitted = (run["steps"][-1].get("submit") or {}).get("status") == "success"
        if forms and submitted:
            found.setdefault(forms[0]["title"], run)
    return found


def test_web_apps_lands_each_after_submit_destination_where_the_model_says(
    hq, core_runner, formplayer_runner, editor_driver, webapps_documents, evidence
):
    from proof.formplayer.walk import Walk

    with webapps_hq.project(webapps_documents[DESTINATIONS]) as project:
        with project.released(formplayer_runner) as release:
            runs = _submitted_runs(Walk.of(release).run())
            assert sorted(runs) == sorted(LANDINGS), sorted(runs)
            titles = sorted(LANDINGS)
            session = Session(release, editor_driver)
            made, kinds = observe.replay(release.doc["name"], [runs[title] for title in titles], session.home)
            replayed = session.run(made, deadline=180.0 + 2.0 * len(made))
            received = len(session.hq.submissions)
    landed = {title: replayed.value(kinds.index(("end", index))) for index, title in enumerate(titles)}
    answered = [exchange.json() for exchange in replayed.answered("submit-all")]
    evidence("landed", {"client": landed, "formplayer": answered})
    assert replayed.page_errors == [] and replayed.dialogs == []
    # Each form's one submission reached HQ and was accepted.
    assert [answer["status"] for answer in answered] == ["success"] * len(titles)
    assert received == len(titles)
    for title, answer in zip(titles, answered, strict=True):
        kind, menu, *listed = LANDINGS[title]
        screen = landed[title]
        assert screen["alerts"] == [f"'{title}' successfully saved!"], (title, screen["alerts"])
        assert "form" not in screen, title
        if kind == "list":
            assert screen.get("list") is not None, (title, screen)
            assert answer["nextScreen"]["title"] == menu, (title, answer["nextScreen"].get("title"))
        else:
            assert screen["title"] == menu, (title, screen.get("title"))
            assert [command["text"] for command in screen["commands"]] == listed[0], title


HIDDEN = "targeted-hidden-from-menu"
HIDDEN_START = steps.path(steps.open_app("Hidden menus"), steps.choose("Start"))
FIRST_SCREEN = {"title": "Hidden menus", "commands": ["Start", "Targets"]}
TARGETS = {"title": "Targets", "commands": ["Shown"]}
HIDDEN_LINKS = {"hidden form": ("To hidden form", TARGETS), "form inside the hidden menu": ("To inside", FIRST_SCREEN)}
# Each entry point, and what the client shows once it is opened: a form, or a menu's screen.
HIDDEN_ENTRY_POINTS = {
    "shown_form": {"form": "Shown"},
    "hidden_rest": {"form": "Hidden with rest"},
    "hidden_plain": TARGETS,
    "inside": {"form": "Inside"},
    "inside_plain": FIRST_SCREEN,
}


def _shown(screen):
    """A screen as these tests compare it: the form it shows, or a menu's title and what it lists."""
    if "form" in screen:
        return {"form": screen["form"]["title"]}
    return {"title": screen["title"], "commands": [command["text"] for command in screen["commands"]]}


def test_web_apps_lists_no_item_off_the_menu(hq, core_runner, formplayer_runner, editor_driver, webapps_documents):
    with webapps_hq.project(webapps_documents[HIDDEN]) as project:
        with project.released(formplayer_runner) as release:
            run = Session(release, editor_driver).run(
                [*steps.open_app("Hidden menus"), steps.SCREEN, *steps.choose("Targets"), steps.SCREEN]
            )
    assert run.page_errors == []
    assert [_shown(screen) for screen in run.screens] == [FIRST_SCREEN, TARGETS]


@pytest.mark.parametrize("link", sorted(HIDDEN_LINKS))
def test_web_apps_leaves_a_worker_short_of_a_link_target_off_the_menu(
    link, hq, core_runner, formplayer_runner, editor_driver, webapps_documents, evidence
):
    source, expected = HIDDEN_LINKS[link]
    with webapps_hq.project(webapps_documents[HIDDEN]) as project:
        with project.released(formplayer_runner) as release:
            session = Session(release, editor_driver)
            run = session.run([*HIDDEN_START, *steps.choose(source), steps.SCREEN, *steps.submit_form(), steps.SCREEN])
            received = len(session.hq.submissions)
    opened, landed = run.screens
    evidence(f"hidden-{link.replace(' ', '-')}", {"opened": opened, "landed": landed})
    assert run.page_errors == [] and run.dialogs == []
    assert opened["form"]["title"] == source and received == 1
    assert landed["alerts"] == [f"'{source}' successfully saved!"]
    assert _shown(landed) == expected


@pytest.mark.parametrize("entry_point", sorted(HIDDEN_ENTRY_POINTS))
def test_web_apps_opens_a_form_off_the_menu_only_from_an_entry_point_that_ignores_display_conditions(
    entry_point, hq, core_runner, formplayer_runner, editor_driver, webapps_documents, evidence
):
    from django.urls import reverse

    with webapps_hq.project(webapps_documents[HIDDEN]) as project:
        with project.released(formplayer_runner) as release:
            link = reverse("session_endpoint", args=[release.domain, release.app_id, entry_point])
            run = Session(release, editor_driver).run(
                [{"goto": link}, steps.SETTLE, *steps.arrive(any_screen=True), steps.SCREEN]
            )
    [opened] = run.screens
    asked = [exchange.request_json() for exchange in run.answered("get_endpoint")]
    evidence(f"entry-point-{entry_point}", {"opened": opened, "asked": asked})
    assert run.page_errors == [] and run.dialogs == []
    # The client asked Formplayer for the entry point HQ's link view named, once.
    assert [body["endpoint_id"] for body in asked] == [entry_point]
    assert _shown(opened) == HIDDEN_ENTRY_POINTS[entry_point]
    assert opened["alerts"] == []
