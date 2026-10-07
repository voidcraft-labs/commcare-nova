"""A document's Web Apps observation: every screen a worker reaches, as the client shows it, as a record.

Where ``proof.formplayer.observe`` keeps what Formplayer answers on a walk
of a build, this keeps what the Web Apps client then shows a worker on the
same walk. The walk is Formplayer's own, derived on the released build
(``proof.formplayer.walk``: every menu command, the first case of each
list, each list action once, each search); each of its runs is then
replayed in the browser by what a worker clicks, and the page is read after
every click (``steps.SCREEN``):

- a menu choice is a click on that row of the menu;
- a case is a click on its row, and on Continue where the list opens a
  case's detail first (Formplayer's answer says whether it does);
- a list action is a click on its button, and a search a click on Search
  with the prompts as the client shows them;
- a run ends at the form it reaches, read as the client first shows it. A
  form is not answered here: Formplayer's walk answers and submits it, and
  ``test_links.py`` submits forms in the browser where a finding turns on
  what follows.

Every run of one build is replayed in one page, from the home screen (the
client's own Home breadcrumb leads back to it), so a document costs one
page load.

What is recorded (``observe``):

- ``runtime``: Formplayer's commit and the Core it vendors, and the
  browser's version, as each announced itself;
- ``build``: the released build's version;
- ``home``: the home screen;
- ``runs``: per run of the walk, its ``script`` and the ``screens`` read
  after each click, each as ``proof.webapps.session.recorded`` keeps it.

The record holds no id Formplayer drew, no time and no path: HQ's ids in it
(the app's, each media file's) are drawn inside operations keyed by the
document (``proof.webapps.hq``), so the same inputs give the same bytes
(``test_observe.py``).

This is the observation only. No check judges it yet, so the lane's own
observation of a document does not make it, and nothing stores it; "Web
Apps in the lane" in ``proof/README.md`` says where it joins the unit.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

from proof.formplayer.walk import Walk, script_of
from proof.webapps import steps
from proof.webapps.hq import Project, Release
from proof.webapps.session import Session

HOME = "#breadcrumb-region .js-home a"


class Unreplayable(AssertionError):
    """A run of Formplayer's walk holds a choice the browser replay has no click for."""


def _responses(run: Mapping[str, Any]) -> list[Any]:
    """Formplayer's answer to each navigation of a run, in order (a case's detail, asked beside one, left out)."""
    return [
        step["response"]
        for step in run["steps"]
        if "response" in step and step.get("request", {}).get("route") != "get_details"
    ]


def clicks(run: Mapping[str, Any]) -> list[dict]:
    """The steps that replay one run of Formplayer's walk in the browser, the screen read after each choice."""
    made: list[dict] = []
    responses = _responses(run)
    for position, choice in enumerate(run["script"]):
        # The screen the choice is made on is Formplayer's answer before it.
        screen = responses[position] if position < len(responses) else None
        if "menu" in choice:
            made += steps.click(f"{steps.MENU_ROW}:nth-child({choice['menu'] + 1})")
        elif "entity" in choice:
            row = f"#menu-region [id='row-{choice['entity']}']"
            made += steps.click(row)
            if isinstance(screen, dict) and screen.get("hasDetails"):
                made += steps.click("#select-case")
        elif "action" in choice:
            made += steps.click(f"{steps.LIST_ACTION}[data-index='{choice['action']}']")
        elif "search" in choice:
            made += steps.run_search()
        else:
            raise Unreplayable(
                f"Formplayer's walk made the choice {choice!r}, which the Web Apps replay has no click for"
                " (proof/webapps/observe.py::clicks knows a menu row, a case, a list action and a search)."
            )
        made.append(steps.SCREEN)
    return made


def replay(app_name: str, runs: Sequence[Mapping[str, Any]]) -> list[dict]:
    """Every run of a walk as one list of steps: from the home screen into the app, the run, and home again."""
    made: list[dict] = [steps.SCREEN]
    for run in runs:
        made += steps.open_app(app_name)
        made.append(steps.SCREEN)
        made += clicks(run)
        made += steps.click(HOME)
    return made


def observe(project: Project, release: Release, runner, driver) -> dict[str, Any]:
    """The Web Apps observation of one released build of ``project``'s app."""
    session = Session(project, release, runner, driver)
    walk = Walk(runner, session.hq, domain=project.domain, app_id=release.build_id).run()
    script = script_of(walk)
    run = session.run(replay(release.doc["name"], walk["runs"]))
    if run.page_errors:
        raise AssertionError(f"The Web Apps client raised while it replayed the walk: {run.page_errors}")
    screens = run.screens
    recorded = {
        "runtime": {
            **dict((runner.ready or {}).get("formplayer") or {}),
            "chromium": (driver.ready or {}).get("chromium"),
        },
        "build": {"version": release.version},
        "home": screens[0],
        "runs": [],
    }
    cursor = 1
    for choices in script:
        # The app's first screen, then one screen per choice.
        taken = screens[cursor : cursor + 1 + len(choices)]
        cursor += 1 + len(choices)
        recorded["runs"].append({"script": list(choices), "screens": taken})
    if cursor != len(screens):
        raise AssertionError(
            f"The Web Apps replay read {len(screens)} screens where the walk's {len(script)} runs call for {cursor}."
        )
    return recorded
