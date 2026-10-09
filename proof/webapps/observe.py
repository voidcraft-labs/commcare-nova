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

``observe`` makes the record over a release HQ serves with its own views
in a check's own project (``proof.webapps.hq``), for this package's tests:
every run of the walk replayed whole. ``shown`` is what a document's unit
keeps (``proof.observe.served``): the record over a state HQ serves, on the
walk Formplayer already made of it, which proofs 3 and 4 then compare.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

from proof.formplayer.walk import Walk, script_of
from proof.webapps import steps
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


def clicks(run: Mapping[str, Any], end: str | None = None) -> list[dict]:
    """The steps that replay one run of Formplayer's walk in the browser, the screen read after each choice.

    With ``end`` (a label the caller places after the run), a choice the client shows nothing to click for
    within ``steps.WITHIN_MS`` is recorded as missed and the rest of the run is skipped, in place of failing the
    whole replay.
    """
    made: list[dict] = []
    responses = _responses(run)
    within = None if end is None else steps.WITHIN_MS
    for position, choice in enumerate(run["script"]):
        # The screen the choice is made on is Formplayer's answer before it.
        screen = responses[position] if position < len(responses) else None
        if "menu" in choice:
            made += steps.click(f"{steps.MENU_ROW}:nth-child({choice['menu'] + 1})", within=within, or_skip_to=end)
        elif "entity" in choice:
            row = f"#menu-region [id='row-{choice['entity']}']"
            made += steps.click(row, within=within, or_skip_to=end)
            if isinstance(screen, dict) and screen.get("hasDetails"):
                # The client opens a case's detail where it has one to show and takes the case itself where
                # it has none (``menus/controller.js::showDetail``), so Continue is clicked where it is shown.
                made += steps.click("#select-case", visible=True, within=within) if end else steps.click("#select-case")
        elif "action" in choice:
            action = f"{steps.LIST_ACTION}[data-index='{choice['action']}']"
            made += steps.click(action, within=within, or_skip_to=end)
        elif "search" in choice:
            made += steps.click("#query-submit-button", within=within, or_skip_to=end)
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


def tolerant_replay(app_name: str, runs: Sequence[Mapping[str, Any]], home: str) -> tuple[list[dict], list[tuple]]:
    """``replay`` for a document's record: a run the client cannot follow ends where it stops, and the next
    starts from the home screen all the same. Returns the steps and, beside each, what it is: ``("home",)``,
    ``("screen", run)``, ``("end", run)`` (the screen a run ended on) or None."""
    made: list[dict] = [steps.SCREEN]
    plan: list[tuple | None] = [("home",)]

    def add(more, what=None):
        made.extend(more)
        plan.extend([what] * len(more))

    for index, run in enumerate(runs):
        end = f"run-{index}"
        add(steps.click(steps.APP_TILE, app_name, within=steps.WITHIN_MS, or_skip_to=end))
        add([steps.SCREEN], ("screen", index))
        for step in clicks(to_the_first_case(run), end):
            add([step], ("screen", index) if step == steps.SCREEN else None)
        add([{"label": end}])
        add([steps.SCREEN], ("end", index))
        # Home by the client's own breadcrumb, or, where a run stopped or the client shows none, its address.
        add([{"recover": {"click": HOME, "goto": home}}, steps.SETTLE])
    return made, plan


def to_the_first_case(run: Mapping[str, Any]) -> dict:
    """A run of the walk as far as the client is shown it for a document's record: up to the first case a worker
    would choose, that choice left out.

    What only the client decides is on the screens before a case is taken: the home screen's tiles, a menu, a
    list with its cells, its empty text and its actions, a search and its description. What a chosen case leads
    to (its detail, the forms after it, a form's questions) is Formplayer's to answer and is read from its trace;
    and the client's own steps there (a detail it opens or not, a claim's sync) are where its replay stopped
    following the walk one run and followed it the next, which a record cannot hold.
    """
    choices = []
    for choice in run["script"]:
        if "entity" in choice:
            break
        choices.append(choice)
    return {**run, "script": choices}


def _first_line(text) -> str:
    return str(text).strip().splitlines()[0] if str(text).strip() else ""


def _recorded(runner, driver, version, script, run) -> dict[str, Any]:
    if run.page_errors:
        raise AssertionError(f"The Web Apps client raised while it replayed the walk: {run.page_errors}")
    screens = run.screens
    recorded = {
        "runtime": {
            **dict((runner.ready or {}).get("formplayer") or {}),
            "chromium": (driver.ready or {}).get("chromium"),
        },
        "build": {"version": version},
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


def observe(served, driver) -> dict[str, Any]:
    """The Web Apps observation of one state HQ serves (``proof.formplayer.hq.Served``), every run of its walk
    replayed whole."""
    session = Session(served, driver)
    walk = Walk(served.runner, served.hq, domain=served.domain, app_id=served.build_id, scope=served.run).run()
    run = session.run(replay(served.doc["name"], walk["runs"]))
    return _recorded(served.runner, driver, served.version, script_of(walk), run)


def shown(served, driver, walk: Mapping[str, Any]) -> dict[str, Any]:
    """The client's screens on a walk Formplayer already made of a state HQ serves with its own views
    (``proof.formplayer.hq.Served``): the walk's runs replayed in the browser, in one run of the served state
    (the worker signed in, HQ's state put back after it).

    Each run is shown up to the first case a worker would choose (``to_the_first_case``). A run the client
    shows nothing to click for at some choice before that (within ``steps.WITHIN_MS`` of the page being quiet)
    is recorded as far as it went, with ``stopped`` and the screen it ended on, and the next run starts from
    the home screen; an error the client's own script raised is recorded by its message (``pageErrors``).
    """
    from proof.webapps.session import recorded as screen_record

    session = Session(served, driver)
    script = [to_the_first_case(run)["script"] for run in walk["runs"]]
    made, plan = tolerant_replay(served.doc["name"], walk["runs"], session.home)
    run = session.run(made, name="webapps")
    if len(run.outcomes) != len(plan):
        raise AssertionError(
            f"The Web Apps replay ran {len(run.outcomes)} steps where it planned {len(plan)}; a step's outcome is"
            " missing, so no screen can be placed."
        )
    found = {
        "runtime": {
            **dict((served.runner.ready or {}).get("formplayer") or {}),
            "chromium": (driver.ready or {}).get("chromium"),
        },
        "build": {"version": served.version},
        "home": None,
        "runs": [{"script": list(choices), "screens": []} for choices in script],
        "pageErrors": sorted({_first_line(error) for error in run.page_errors}),
    }
    for what, outcome in zip(plan, run.outcomes, strict=True):
        if what is None or outcome.get("skipped") or "value" not in outcome:
            continue
        screen = screen_record(outcome["value"])
        if what[0] == "home":
            found["home"] = screen
        elif what[0] == "screen":
            found["runs"][what[1]]["screens"].append(screen)
        else:
            held = found["runs"][what[1]]
            if len(held["screens"]) != 1 + len(held["script"]):
                # The client did not follow the walk to its end: where it stood when the run ended.
                held["stopped"] = {"after": len(held["screens"]), "screen": screen}
    return found
