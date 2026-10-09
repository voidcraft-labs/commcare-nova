"""A document's Web Apps observation: every screen a worker reaches, as the client shows it, as a record.

Where ``proof.formplayer.observe`` keeps what Formplayer answers on a walk
of a build, this keeps what the Web Apps client then shows a worker on the
same walk. The walk is Formplayer's own, derived on the released build
(``proof.formplayer.walk``: every menu command, the first case of each
list, each list action once, each search, each form answered and
submitted); each of its runs is then replayed whole in the browser by what a
worker does (``plan``), and the page is read after every step that leads
somewhere (``steps.SCREEN``):

- a menu choice is a click on that row of the menu;
- a case is a click on its row, then, where the client opens the case's
  detail, a read of the detail and its Continue once the dialog is done
  opening; a multi-select list's case is its row's checkbox and the list's
  Continue;
- a list action is a click on its button, and a search a click on Search
  with the prompts as the client shows them;
- a form the run reaches is answered question by question through the
  widgets the client draws, with each answer the walk gave, in its order
  (``steps.answer``), read as the worker leaves it, submitted, and the
  screen the client lands on read.

Every step waits for the client's own arrival where it leads
(``steps.arrive``, ``driver/steps/webapps/arrived.js``), never a time. Every
run of one build is replayed in one page, from the home screen (the client's
own Home breadcrumb leads back to it), so a document costs one page load.

What is recorded (``shown``):

- ``runtime``: Formplayer's commit and the Core it vendors, and the
  browser's version, as each announced itself;
- ``build``: the released build's version;
- ``home``: the home screen;
- ``runs``: per run of the walk, its ``script``, the ``screens`` read, what
  became of each answer (``answers``) and of Submit (``submit``), and, where
  the client did not follow the walk to its end, where it ``stopped``, each
  screen as ``proof.webapps.session.recorded`` keeps it;
- ``pageErrors``: what the client's own script raised.

The record holds no id Formplayer drew, no time and no path: HQ's ids in it
(the app's, each media file's) are drawn inside operations keyed by the
document (``proof.webapps.hq``), so the same inputs give the same bytes
(``test_observe.py``).

``observe`` makes the record over a release HQ serves with its own views
in a check's own project (``proof.webapps.hq``), for this package's tests,
on a walk of its own. ``shown`` is what a document's unit keeps
(``proof.observe.served``): the record over a state HQ serves, on the walk
Formplayer already made of it, which proofs 3 and 4 then compare.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

from proof.formplayer.walk import Walk
from proof.webapps import steps
from proof.webapps.session import Session

HOME = "#breadcrumb-region .js-home a"


class Unreplayable(AssertionError):
    """A run of Formplayer's walk holds a choice the browser replay has no click for."""


# A multi-select list's Continue below its cases (``partials/case_list/list.html``); the list's header holds a
# second one that does the same (``menu_header.html``).
MULTI_SELECT_CONTINUE = "#menu-region .case-list-actions.d-md-block > .multi-select-continue-btn"
# Formplayer's name for a question's style that asks for a twelve-hour clock (``form_entry/const.js``,
# ``TIME_12_HOUR``, which ``entries.js::TimeEntry`` reads).
TWELVE_HOUR = "12-hour"


def _navigations(run: Mapping[str, Any]) -> list[Mapping[str, Any]]:
    """Each navigation of a run as Formplayer's walk made it, in order: what it sent (its ``request``) and, where
    Formplayer answered, its ``response``; a case's detail, asked beside one, left out."""
    return [
        step for step in run["steps"] if "request" in step and step.get("request", {}).get("route") != "get_details"
    ]


def _form_step(run: Mapping[str, Any]) -> Mapping[str, Any] | None:
    """The run's form, as the walk answered and submitted it, where the run reached one."""
    return next((step for step in run["steps"] if "answers" in step), None)


def _arrival(navigation: Mapping[str, Any] | None) -> list[dict]:
    """Where the client arrives once a choice is taken (``steps.arrive``), from the walk's request it leads to and
    Formplayer's answer to it: the client keeps a worker's session in its route as it sends it, and then takes
    the selections Formplayer's answer hands back (``menus/collections.js::parse``), as Formplayer's walk does;
    its search's key, run; and a form's session where Formplayer answered with a form. A multi-select list's
    chosen cases are named by an id Formplayer draws, which a trace holds as its mark
    (``proof.formplayer.canonical``): either is any value there. Where Formplayer refused the request or answered
    with no screen, the client stands wherever it then goes."""
    from proof.formplayer.canonical import TOKEN
    from proof.formplayer.walk import USE_SELECTED_VALUES, screen_kind

    response = None if navigation is None else navigation.get("response")
    if navigation is None or screen_kind(response) == "notification":
        return steps.arrive(any_screen=True)
    request = navigation["request"]
    held = response.get("selections") if isinstance(response.get("selections"), list) else request.get("selections")
    selections = [
        None if value == USE_SELECTED_VALUES or str(value).startswith(TOKEN) else str(value) for value in held or []
    ]
    query_data = {
        key: {"execute": bool(value.get("execute"))} for key, value in (request.get("query_data") or {}).items()
    }
    return steps.arrive(selections, query_data=query_data, form=screen_kind(response) == "form")


def _twelve_hour(response: Any, ix: str) -> bool:
    from proof.formplayer.walk import questions

    tree = response.get("tree") if isinstance(response, dict) else None
    node = next((node for node in questions(tree or ()) if node.get("ix") == ix), None)
    style = (node or {}).get("style") or {}
    raw = style.get("raw") if isinstance(style, dict) else style
    return TWELVE_HOUR in str(raw or "").split()


def plan(run: Mapping[str, Any], *, end: str | None = None) -> tuple[list[dict], list[tuple | None]]:
    """The steps that replay one run of Formplayer's walk in the browser, whole, and beside each what it reads:
    ``("screen",)`` for each screen read, ``("answer", position)`` for each answer's outcome, ``("submit",)``
    for the submission's, or None.

    The run is replayed from the app's first screen: each choice is clicked as a worker clicks it and the step
    waits for the client's arrival where it leads (``_arrival``), never a time; a case is taken by its row and,
    where the client opens its detail, by the detail's Continue once the detail is done opening; a form the run
    reaches is answered question by question through its widgets with the answers the walk gave, each attempt
    in order, then submitted, and the screen the client lands on is read.

    With ``end`` (a label the caller places after the run), a choice the client shows nothing to click for is
    recorded as missed and the rest of the run skipped, in place of failing the whole replay.
    """
    made: list[dict] = []
    what: list[tuple | None] = []

    def add(more, kind=None):
        made.extend(more)
        what.extend([kind] * len(more))

    navigations = _navigations(run)
    within = None if end is None else steps.WITHIN_MS
    for position, choice in enumerate(run["script"]):
        # The screen the choice is made on is Formplayer's answer before it; where it leads, the request after it.
        screen = navigations[position].get("response") if position < len(navigations) else None
        arrival = _arrival(navigations[position + 1] if position + 1 < len(navigations) else None)
        if "menu" in choice:
            add(
                steps.navigate(
                    f"{steps.MENU_ROW}:nth-child({choice['menu'] + 1})", arrival, within=within, or_skip_to=end
                )
            )
        elif "entity" in choice and isinstance(screen, dict) and screen.get("multiSelect"):
            # A worker picks a case of a multi-select list by its row's checkbox and goes on with the list's own
            # Continue (``menus/views.js``, ``selectRowAction`` and ``continueAction``), as Formplayer's walk
            # sends the case as the list's selected values.
            row = f"#menu-region [id='row-{choice['entity']}'] .select-row-checkbox"
            add(steps.click(row, within=within, or_skip_to=end))
            add(steps.navigate(MULTI_SELECT_CONTINUE, arrival, visible=True, within=within, or_skip_to=end))
        elif "entity" in choice and isinstance(screen, dict) and screen.get("hasDetails"):
            row = f"#menu-region [id='row-{choice['entity']}']"
            selections = arrival[0]["arg"]["selections"]
            opened = steps.open_case(row, selections, arrival, within=within, or_skip_to=end)
            # The screen read once the client has answered the row's click: its detail, where it opened one.
            add(opened, None)
            what[len(what) - len(opened) + opened.index(steps.SCREEN)] = ("screen",)
        elif "entity" in choice:
            add(steps.navigate(f"#menu-region [id='row-{choice['entity']}']", arrival, within=within, or_skip_to=end))
        elif "action" in choice:
            action = f"{steps.LIST_ACTION}[data-index='{choice['action']}']"
            add(steps.navigate(action, arrival, within=within, or_skip_to=end))
        elif "search" in choice:
            searching = steps.searched(arrival, end)
            add(steps.navigate("#query-submit-button", searching, within=within, or_skip_to=end))
        else:
            raise Unreplayable(
                f"Formplayer's walk made the choice {choice!r}, which the Web Apps replay has no click for"
                " (proof/webapps/observe.py::plan knows a menu row, a case, a list action and a search)."
            )
        add([steps.SCREEN], ("screen",))
    form = _form_step(run)
    if form is not None:
        opened = navigations[-1].get("response") if navigations else None
        for position, attempt in enumerate(form["answers"]):
            answering = steps.answer(
                str(attempt["ix"]), str(attempt["value"]), twelve_hour=_twelve_hour(opened, str(attempt["ix"]))
            )
            add(answering)
            what[len(what) - len(answering) + 1] = ("answer", position)
        # The form as the worker leaves it, then where Submit takes them.
        add([steps.SCREEN], ("screen",))
        submitting = steps.submit_and_land()
        add(submitting)
        what[len(what) - len(submitting) + 1] = ("submit",)
        add([steps.SCREEN], ("screen",))
    return made, what


def clicks(run: Mapping[str, Any], end: str | None = None) -> list[dict]:
    """The steps that replay one run of Formplayer's walk in the browser (``plan``)."""
    return plan(run, end=end)[0]


def replay(app_name: str, runs: Sequence[Mapping[str, Any]], home: str) -> tuple[list[dict], list[tuple | None]]:
    """Every run of a walk as one list of steps (``plan``), each from the home screen into the app, and beside
    each step what it reads: ``("home",)``, ``("screen", run)``, ``("answer", run, position)``,
    ``("submit", run)``, ``("end", run)`` (the screen a run ended on) or None. A run the client cannot follow
    ends where it stops, and the next starts from the home screen all the same."""
    made: list[dict] = [steps.SCREEN]
    kinds: list[tuple | None] = [("home",)]

    def add(more, kind=None):
        made.extend(more)
        kinds.extend([kind] * len(more))

    for index, run in enumerate(runs):
        end = f"run-{index}"
        navigations = _navigations(run)
        first = _arrival(navigations[0] if navigations else None)
        add(steps.navigate(steps.APP_TILE, first, app_name, within=steps.WITHIN_MS, or_skip_to=end))
        add([steps.SCREEN], ("screen", index))
        run_steps, run_kinds = plan(run, end=end)
        made.extend(run_steps)
        kinds.extend(None if kind is None else (kind[0], index, *kind[1:]) for kind in run_kinds)
        add([{"label": end}])
        add([steps.SCREEN], ("end", index))
        # Home by the client's own breadcrumb, or, where a run stopped or the client shows none, its address.
        add([{"recover": {"click": HOME, "goto": home}}, *steps.arrive(any_screen=True)])
    return made, kinds


# What a record writes for the id Formplayer draws for a multi-select list's chosen cases, which the client then
# names in its route in place of the cases (Formplayer keeps the cases under that id).
SELECTION = "<selection {}>"


def _drawn_selections(run) -> dict[str, str]:
    """Each id Formplayer drew for a multi-select list's chosen cases in ``run``, by the mark a record writes for
    it: the selection the client sent as ``use_selected_values``, as Formplayer answered it at the same place
    (``MultiSelectEntityScreen``, which stores the cases and names them by a fresh id)."""
    from proof.formplayer.walk import USE_SELECTED_VALUES

    drawn: dict[str, str] = {}
    for exchange in run.formplayer:
        try:
            sent, answered = exchange.request_json(), exchange.json()
        except ValueError:
            continue
        if not isinstance(sent, dict) or not isinstance(answered, dict):
            continue
        selections, named = sent.get("selections") or [], answered.get("selections") or []
        for index, selection in enumerate(selections):
            if selection == USE_SELECTED_VALUES and index < len(named) and named[index] != USE_SELECTED_VALUES:
                drawn.setdefault(named[index], SELECTION.format(len(drawn) + 1))
    return drawn


def _marked(value, drawn: dict[str, str]):
    """``value`` with each drawn id written as its mark, wherever a string holds it."""
    if isinstance(value, dict):
        return {key: _marked(item, drawn) for key, item in value.items()}
    if isinstance(value, list):
        return [_marked(item, drawn) for item in value]
    if isinstance(value, str):
        for held, mark in drawn.items():
            value = value.replace(held, mark)
    return value


def _first_line(text) -> str:
    return str(text).strip().splitlines()[0] if str(text).strip() else ""


def _record(runner, driver, version, walk, run, kinds) -> dict[str, Any]:
    """The record of a replay (``replay``), each read placed by what its step reads."""
    from proof.webapps.session import recorded as screen_record

    if len(run.outcomes) != len(kinds):
        raise AssertionError(
            f"The Web Apps replay ran {len(run.outcomes)} steps where it planned {len(kinds)}; a step's outcome is"
            " missing, so no screen can be placed."
        )
    found = {
        "runtime": {
            **dict((runner.ready or {}).get("formplayer") or {}),
            "chromium": (driver.ready or {}).get("chromium"),
        },
        "build": {"version": version},
        "home": None,
        "runs": [{"script": list(each["script"]), "screens": []} for each in walk["runs"]],
        "pageErrors": sorted({_first_line(error) for error in run.page_errors}),
    }
    expected = {index: _expected_screens(each) for index, each in enumerate(walk["runs"])}
    for what, outcome in zip(kinds, run.outcomes, strict=True):
        if what is None or outcome.get("skipped"):
            continue
        if what[0] in ("answer", "submit"):
            held = found["runs"][what[1]]
            said = "missed" if outcome.get("missed") else outcome.get("value")
            if what[0] == "answer":
                held.setdefault("answers", []).append("answered" if said is True else said)
            else:
                held["submit"] = "submitted" if said is True else said
            continue
        if "value" not in outcome:
            continue
        screen = screen_record(outcome["value"])
        if what[0] == "home":
            found["home"] = screen
        elif what[0] == "screen":
            found["runs"][what[1]]["screens"].append(screen)
        else:
            held = found["runs"][what[1]]
            if len(held["screens"]) != expected[what[1]]:
                # The client did not follow the walk to its end: where it stood when the run ended.
                held["stopped"] = {"after": len(held["screens"]), "screen": screen}
    return _marked(found, _drawn_selections(run))


def _expected_screens(run: Mapping[str, Any]) -> int:
    """How many screens a whole replay of ``run`` reads (``plan``), the app's first one with them."""
    return 1 + sum(1 for kind in plan(run)[1] if kind == ("screen",))


def observe(served, driver) -> dict[str, Any]:
    """The Web Apps observation of one state HQ serves (``proof.formplayer.hq.Served``), every run of its walk
    replayed whole."""
    walk = Walk(served.runner, served.hq, domain=served.domain, app_id=served.build_id, scope=served.run).run()
    return shown(served, driver, walk)


def shown(served, driver, walk: Mapping[str, Any]) -> dict[str, Any]:
    """The client's screens on a walk Formplayer already made of a state HQ serves with its own views
    (``proof.formplayer.hq.Served``): each run of the walk replayed whole in the browser (``replay``), each in a
    run of the served state of its own (a fork of HQ's state, the worker signed in afresh and starting over in
    Formplayer, a fresh page), as Formplayer's own walk runs each: a case one run's submission made is not in the
    next run's list.

    A run the client shows nothing to click for at some choice (once it has arrived, within ``steps.WITHIN_MS``)
    is recorded as far as it went, with ``stopped`` and the screen it ended on; each answer the client could not
    give is named (``unanswerable``, ``absent``, ``unchanged``, ``refused``), and so is a Submit it kept disabled;
    an error the client's own script raised is recorded by its message (``pageErrors``).
    """
    session = Session(served, driver)
    found = None
    for index, each in enumerate(walk["runs"]):
        made, kinds = replay(served.doc["name"], [each], session.home)
        # The run's deadline grows with its steps: a whole walk of a large form is many screens and answers.
        run = session.run(made, name=f"webapps-{index}", deadline=180.0 + 2.0 * len(made))
        one = _record(served.runner, driver, served.version, {"runs": [each]}, run, kinds)
        if found is None:
            found = {**one, "runs": [], "pageErrors": []}
        found["runs"].extend(one["runs"])
        found["pageErrors"] = sorted({*found["pageErrors"], *one["pageErrors"]})
    if found is None:
        made, kinds = replay(served.doc["name"], [], session.home)
        found = _record(served.runner, driver, served.version, {"runs": []}, session.run(made), kinds)
    return found
