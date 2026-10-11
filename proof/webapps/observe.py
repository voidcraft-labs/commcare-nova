"""A document's Web Apps observation: every screen a worker reaches, as the client shows it, as a record.

Where ``proof.formplayer.observe`` keeps what Formplayer answers on a walk
of a build, this keeps what the Web Apps client then shows a worker on the
same walk. The walk is Formplayer's own, derived on the released build
(``proof.formplayer.walk``: every menu command, every case of each list,
each list action once, each search, each form answered and submitted, in
every language the app holds); each of its runs is then replayed whole in the browser by what a
worker does (``plan``), and the page is read after every step that leads
somewhere (``steps.SCREEN``):

- a language is chosen from the menu over the app's screens, as a worker
  chooses one (``steps.choose_language``);
- a menu choice is a click on that row of the menu;
- a case is a click on its row, then, where the client opens the case's
  detail, a read of the detail and its Continue once the dialog is done
  opening; a multi-select list's case is its row's checkbox and the list's
  Continue;
- a list action is a click on its button, and a search a click on Search
  with the prompts as the client shows them;
- a form the run reaches is answered question by question through the
  widgets the client draws, with each answer the walk gave, in its order
  (``steps.answer``; a file question with the file the walk uploaded, chosen
  through the widget's own file input, and a signature with a stroke drawn
  on its pad, ``steps.answer_media``), read as the worker leaves it,
  submitted, and the screen the client lands on read.

Every step waits for the client's own arrival where it leads
(``steps.arrive``, ``driver/steps/webapps/arrived.js``), never a time. Each
run of a walk is replayed on a fresh page of its own, from the home screen,
in a fork of the served state of its own (``shown``).

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

import math
from collections.abc import Mapping, Sequence
from typing import Any

from proof.formplayer.walk import CAPTURES_DIR, CONTENT_TYPES, Walk
from proof.observe import walks
from proof.webapps import steps
from proof.webapps.session import Session

HOME = steps.HOME


class Unreplayable(AssertionError):
    """A run of Formplayer's walk holds a choice the browser replay has no click for."""


class SubmittedOtherwise(AssertionError):
    """The client submitted a run's form otherwise than Formplayer's walk of the same run: the walk is to submit
    exactly what the client submits (``proof.formplayer.walk.submission``), so a difference is the harness's."""


def _same_sent(walked, sent) -> bool:
    """Whether the walk's value is the client's: equal, or a mark of an id Formplayer drew where the client holds
    the id itself (``proof.formplayer.canonical``)."""
    from proof.formplayer.canonical import TOKEN

    if isinstance(walked, str) and walked.startswith(TOKEN):
        return isinstance(sent, str)
    if isinstance(walked, dict) and isinstance(sent, dict):
        return walked.keys() == sent.keys() and all(_same_sent(walked[key], sent[key]) for key in walked)
    if isinstance(walked, list) and isinstance(sent, list):
        return len(walked) == len(sent) and all(_same_sent(a, b) for a, b in zip(walked, sent, strict=True))
    return walked == sent


def submitted_alike(served, walk_run: Mapping[str, Any], run) -> None:
    """Holds the client's submission of a run's form (its ``submit-all`` request, the answers and
    ``prevalidated`` it wrote) to Formplayer's walk of the same run; ``SubmittedOtherwise`` where they differ.
    Nothing is held where either did not submit: where the client stopped or kept Submit disabled, its record
    says so."""
    from proof.formplayer import canonical
    from proof.formplayer.observe import BUILD, USERCASE

    form = _form_step(walk_run)
    sent = [exchange.request_json() for exchange in run.answered("submit-all")]
    if form is None or "submitted" not in form or not sent:
        return
    drawn = {served.build_id: BUILD}
    if served.usercase_id:
        drawn[served.usercase_id] = USERCASE
    client = canonical.replace_text(
        {"answers": sent[0].get("answers"), "prevalidated": sent[0].get("prevalidated")}, drawn
    )
    # The walk's trace as a record keeps it names these ids by their marks, and the walk as made names them as is.
    if len(sent) != 1 or not _same_sent(canonical.replace_text(form["submitted"], drawn), client):
        raise SubmittedOtherwise(
            f"The Web Apps client submitted the run {list(walk_run['script'])!r} as {sent!r}, where Formplayer's walk"
            f" of it submitted {form['submitted']!r}. The walk submits what the client submits"
            " (proof/formplayer/walk.py::submission): find what the client holds otherwise."
        )


# A multi-select list's Continue below its cases (``partials/case_list/list.html``); the list's header holds a
# second one that does the same (``menu_header.html``).
MULTI_SELECT_CONTINUE = "#menu-region .case-list-actions.d-md-block > .multi-select-continue-btn"
# Formplayer's name for a question's style that asks for a twelve-hour clock (``form_entry/const.js``,
# ``TIME_12_HOUR``, which ``entries.js::TimeEntry`` reads).
TWELVE_HOUR = "12-hour"


def _navigations(run: Mapping[str, Any]) -> list[Mapping[str, Any]]:
    """Each navigation of a run as Formplayer's walk made it, in order: what it sent (its ``request``) and, where
    Formplayer answered, its ``response``; a case's detail, asked beside one, and the search the walk sends with
    its prompts typed into, beside the one it goes on with, left out."""
    return [
        step
        for step in run["steps"]
        if "request" in step
        and step.get("request", {}).get("route") != "get_details"
        and not step.get("request", {}).get("typed")
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


def _question(opened: Any, attempts: Sequence[Mapping[str, Any]], position: int) -> Mapping[str, Any]:
    """The question an attempt answers, as Formplayer last showed it before the attempt: in the tree of the
    latest answer before it that holds the question, else in the form as it opened."""
    from proof.formplayer.walk import questions

    ix = str(attempts[position]["ix"])
    shown = [attempt.get("response") for attempt in reversed(attempts[:position])]
    for response in [*shown, opened]:
        tree = response.get("tree") if isinstance(response, dict) else None
        node = next((node for node in questions(tree or ()) if str(node.get("ix")) == ix), None)
        if node is not None:
            return node
    return {}


def _twelve_hour(question: Mapping[str, Any]) -> bool:
    style = question.get("style") or {}
    raw = style.get("raw") if isinstance(style, dict) else style
    return TWELVE_HOUR in str(raw or "").split()


# Where the Web Apps client's map opens for a location question (``entries.js::GeoPointEntry.DEFAULT``): the
# centre and zoom with no answer, and the zoom it opens at on an answer the question already holds.
MAP_OPENS = (30.0, 0.0, 1)
MAP_ANSWER_ZOOM = 6


def _map_pixel(lat: float, lon: float, zoom: int) -> tuple[float, float]:
    """Where a place is on the client's map at a zoom, in pixels of the whole world's picture: Leaflet's own
    projection (``CRS.EPSG3857``, spherical Mercator, a world 256 pixels wide at zoom 0, twice as wide at each
    zoom after)."""
    size = 256 * 2**zoom
    latitude = max(-85.0511287798, min(85.0511287798, lat))
    sine = math.sin(math.radians(latitude))
    return (lon + 180.0) / 360.0 * size, (0.5 - math.log((1 + sine) / (1 - sine)) / (4 * math.pi)) * size


def _place(value: str) -> tuple[float, float]:
    latitude, longitude, *_ = str(value).split()
    return float(latitude), float(longitude)


def _page_of(screen: Any, case: str, small: bool) -> int:
    """The page of a case list a case is on, as the client pages the list (0 where it pages nothing): Formplayer's
    walk asks for a desktop's ten cases a page, which shows every case the lane's lists hold, and a small screen
    is handed five a page (``steps.SMALL_SCREEN_PAGE``)."""
    if not small or not isinstance(screen, dict):
        return 0
    ids = [str(entity.get("id")) for entity in screen.get("entities") or [] if isinstance(entity, dict)]
    return ids.index(case) // steps.SMALL_SCREEN_PAGE if case in ids else 0


def plan(
    run: Mapping[str, Any], *, end: str | None = None, small: bool = False, preview: bool = False
) -> tuple[list[dict], list[tuple | None]]:
    """The steps that replay one run of Formplayer's walk in the browser, whole, and beside each what it reads:
    ``("screen",)`` for each screen read, ``("answer", position)`` for each answer's outcome, ``("submit",)``
    for the submission's, ``("held", position)`` (``position`` None for the submission) for a form shown one
    question a screen whose Next the client kept from being pressed before it, or None.

    The run is replayed from the app's first screen: each choice is clicked as a worker clicks it and the step
    waits for the client's arrival where it leads (``_arrival``), never a time; a case is taken by its row and,
    where the client opens its detail, by the detail's Continue once the detail is done opening; a form the run
    reaches is answered question by question through its widgets with the answers the walk gave, each attempt
    in order, then submitted, and the screen the client lands on is read.

    With ``end`` (a label the caller places after the run), a choice the client shows nothing to click for is
    recorded as missed and the rest of the run skipped, in place of failing the whole replay. With ``small`` the
    replay is on a small screen, where a case on a later page of its list is reached by that page's button. With
    ``preview`` the replay is in App Preview: a language is chosen in its Settings (``steps.choose_preview_language``),
    and a form shows one question a screen, each question brought onto the screen by the form's own Next before it
    is answered, and the form to its last screen before its Complete (``steps.advance``).
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
        page = _page_of(screen, str(choice["entity"]), small) if "entity" in choice else 0
        if page:
            add(steps.turn_to(page, within=within, or_skip_to=end))
        if walks.LANGUAGE in choice and preview:
            add(steps.choose_preview_language(choice[walks.LANGUAGE], arrival, within=within, or_skip_to=end))
        elif walks.LANGUAGE in choice:
            add(steps.choose_language(choice[walks.LANGUAGE], arrival, within=within, or_skip_to=end))
        elif "menu" in choice:
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
            if small:
                # On a small screen a search beside its list is folded away, and a worker opens it by the list's
                # Refine search before its Search is there to press (``case_list/menu_header.html``).
                add(steps.open_sidebar())
            add(steps.navigate(steps.SEARCH_BUTTON, searching, visible=True, within=within, or_skip_to=end))
        else:
            raise Unreplayable(
                f"Formplayer's walk made the choice {choice!r}, which the Web Apps replay has no click for"
                " (proof/webapps/observe.py::plan knows a language, a menu row, a case, a list action and a"
                " search)."
            )
        add([steps.SCREEN], ("screen",))
    form = _form_step(run)
    if form is not None:
        opened = navigations[-1].get("response") if navigations else None
        # Where each location question's map stands, as the client's drags leave it: (x, y, zoom).
        maps: dict[str, tuple[float, float, int]] = {}
        for position, attempt in enumerate(form["answers"]):
            ix = str(attempt["ix"])
            question = _question(opened, form["answers"], position)
            if attempt.get("media"):
                name = str(attempt["value"])
                answering = steps.answer_media(
                    ix, attempt["media"], name, (CAPTURES_DIR / name).read_bytes(), CONTENT_TYPES[name]
                )
            elif question.get("datatype") == "geo":
                # The map is dragged from where it stands so that its centre comes to the walk's place, to the
                # nearest pixel: the client's answer is the map's centre, so it is the place as near as a drag
                # can bring it.
                if ix not in maps:
                    held = question.get("answer")
                    if isinstance(held, str):
                        held = held.split()
                    if isinstance(held, list) and len(held) >= 2:
                        maps[ix] = (*_map_pixel(float(held[0]), float(held[1]), MAP_ANSWER_ZOOM), MAP_ANSWER_ZOOM)
                    else:
                        maps[ix] = (*_map_pixel(MAP_OPENS[0], MAP_OPENS[1], MAP_OPENS[2]), MAP_OPENS[2])
                x, y, zoom = maps[ix]
                target = _map_pixel(*_place(attempt["value"]), zoom)
                offset = (round(x - target[0]), round(y - target[1]))
                maps[ix] = (x - offset[0], y - offset[1], zoom)
                answering = steps.answer_place(ix, offset)
            else:
                answering = steps.answer(ix, str(attempt["value"]), twelve_hour=_twelve_hour(question))
            if preview:
                bringing = steps.advance(ix, or_skip_to=end)
                add(bringing)
                what[len(what) - len(bringing)] = ("held", position)
            add(answering)
            what[len(what) - len(answering) + 1] = ("answer", position)
        if preview:
            bringing = steps.advance(None, or_skip_to=end)
            add(bringing)
            what[len(what) - len(bringing)] = ("held", None)
        # The form as the worker leaves it, then where Submit takes them.
        add([steps.SCREEN], ("screen",))
        submitting = steps.submit_and_land(one_question_per_screen=preview)
        add(submitting)
        what[len(what) - len(submitting) + 1] = ("submit",)
        add([steps.SCREEN], ("screen",))
    return made, what


def clicks(run: Mapping[str, Any], end: str | None = None) -> list[dict]:
    """The steps that replay one run of Formplayer's walk in the browser (``plan``)."""
    return plan(run, end=end)[0]


def replay(
    app_name: str,
    runs: Sequence[Mapping[str, Any]],
    home: str,
    *,
    small: bool = False,
    preview_as: str | None = None,
    preview_language: str | None = None,
) -> tuple[list[dict], list[tuple | None]]:
    """Every run of a walk as one list of steps (``plan``, on a small screen with ``small``), each from the home
    screen into the app, and beside
    each step what it reads: ``("home",)``, ``("screen", run)``, ``("answer", run, position)``,
    ``("submit", run)``, ``("held", run, position)``, ``("end", run)`` (the screen a run ended on) or None. A run
    the client cannot follow ends where it stops, and the next starts from the home screen all the same.

    With ``preview_as`` (a worker's username) the page is App Preview: its first screen is the app's own, where
    the person logs in as that worker (``steps.log_in_as``), sets the app's default language
    (``preview_language``) in its Settings and enters the app by its Start, and its window is a phone's (a small
    screen) in which a form shows one question a screen. App Preview opens an app in the person's own language,
    or English where they have none (``cloudcare/preview_app.html``, ``request.user.language|default:'en'``),
    where Web Apps opens it in the worker's or the app's first, so the language is set to the app's first, from
    which a run's own choice of another then moves it as in Web Apps."""
    made: list[dict] = [steps.SCREEN]
    kinds: list[tuple | None] = [("home",)]

    def add(more, kind=None):
        made.extend(more)
        kinds.extend([kind] * len(more))

    for index, run in enumerate(runs):
        end = f"run-{index}"
        navigations = _navigations(run)
        first = _arrival(navigations[0] if navigations else None)
        if preview_as is not None:
            add(steps.log_in_as(preview_as))
            if preview_language is not None:
                add(steps.set_preview_language(preview_language, within=steps.WITHIN_MS, or_skip_to=end))
            add(steps.navigate(steps.START_APP, first, within=steps.WITHIN_MS, or_skip_to=end))
        else:
            add(steps.navigate(steps.APP_TILE, first, app_name, within=steps.WITHIN_MS, or_skip_to=end))
        add([steps.SCREEN], ("screen", index))
        run_steps, run_kinds = plan(run, end=end, small=small or preview_as is not None, preview=preview_as is not None)
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
    """Each id Formplayer drew in ``run`` that the client then names in its route, by the mark a record writes
    for it: a selection that first appears in one of Formplayer's answers, before the client ever sent it (the
    id ``MultiSelectEntityScreen`` stores a multi-select list's chosen cases under, where the client sent
    ``use_selected_values``)."""
    drawn: dict[str, str] = {}
    sent_so_far: set[str] = set()
    for exchange in run.formplayer:
        try:
            sent, answered = exchange.request_json(), exchange.json()
        except ValueError:
            continue
        if not isinstance(sent, dict):
            continue
        sent_so_far.update(str(value) for value in sent.get("selections") or [])
        if not isinstance(answered, dict):
            continue
        for value in answered.get("selections") or []:
            if str(value) not in sent_so_far:
                drawn.setdefault(str(value), SELECTION.format(len(drawn) + 1))
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
        if what[0] == "held":
            # A form shown one question a screen whose Next the client kept from being pressed: the answer, or the
            # submission, the worker could not reach.
            if outcome.get("value") == "held":
                held = found["runs"][what[1]]
                if what[2] is None:
                    held["submit"] = "held"
                else:
                    held.setdefault("answers", []).append("held")
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
    walk = Walk.of(served).run()
    return shown(served, driver, walk)


# The windows each run is replayed in: a desktop's, then a phone's (``proof.webapps.session.SMALL_SCREEN``), where
# the client lays its screens out for a small screen and pages a list five cases at a time, then App Preview's,
# the phone-sized frame HQ's app builder shows the app in (``proof.webapps.session.PREVIEW_FRAME``). A run replayed
# on the phone is recorded after every desktop run, marked ``"viewport": "small"``, and one in App Preview after
# those, marked ``"viewport": "preview"``.
SMALL = "small"
PREVIEW = "preview"


def shown(served, driver, walk: Mapping[str, Any]) -> dict[str, Any]:
    """The client's screens on a walk Formplayer already made of a state HQ serves with its own views
    (``proof.formplayer.hq.Served``): each run of the walk replayed whole in the browser (``replay``), each in a
    run of the served state of its own (a fork of HQ's state, the worker signed in afresh and starting over in
    Formplayer, a fresh page), as Formplayer's own walk runs each: a case one run's submission made is not in the
    next run's list. Every run is replayed in a desktop's window and again in a phone's (``SMALL``), then in App
    Preview (``PREVIEW``): the same client under the page HQ's app builder shows the app in, for the project
    space's admin, who logs in as the worker there, over the app as it stands (HQ's download makes its archive from
    the stored app, where Web Apps runs the release), in the builder's phone-sized frame, where the client shows a
    form one question a screen to a person who is not Dimagi's (``preview_app/main.js``). App Preview's submission
    holds only the last screen's answers (the client accumulates what its form shows), so it is not held to the
    walk's; HQ's receiver processes it all the same, and the record keeps where the client landed.

    A run the client shows nothing to click for at some choice (once it has arrived, within ``steps.WITHIN_MS``)
    is recorded as far as it went, with ``stopped`` and the screen it ended on; each answer the client could not
    give is named (``unanswerable``, ``absent``, ``unchanged``, ``refused``), and so is a Submit it kept disabled;
    an error the client's own script raised is recorded by its message (``pageErrors``).
    """
    from corehq.apps.users.util import raw_username

    from proof.webapps.session import PREVIEW_FRAME, SMALL_SCREEN

    windows = ((None, Session(served, driver), None), (SMALL, Session(served, driver), SMALL_SCREEN))
    windows += ((PREVIEW, Session(served, driver, preview=True), PREVIEW_FRAME),)
    found = None
    for window, session, viewport in windows:
        for index, each in enumerate(walk["runs"]):
            made, kinds = replay(
                served.doc["name"],
                [each],
                session.home,
                small=window == SMALL,
                preview_as=raw_username(served.username) if window == PREVIEW else None,
                preview_language=walks.default_language(served.languages) if window == PREVIEW else None,
            )
            # The run's deadline grows with its steps: a whole walk of a large form is many screens and answers.
            run = session.run(
                made,
                name=f"webapps-{window or 'desktop'}-{index}",
                deadline=180.0 + 2.0 * len(made),
                viewport=viewport,
            )
            if window != PREVIEW:
                submitted_alike(served, each, run)
            one = _record(served.runner, driver, served.version, {"runs": [each]}, run, kinds)
            if window is not None:
                one["runs"] = [{**held, "viewport": window} for held in one["runs"]]
            if found is None:
                found = {**one, "runs": [], "pageErrors": []}
            found["runs"].extend(one["runs"])
            found["pageErrors"] = sorted({*found["pageErrors"], *one["pageErrors"]})
    if found is None:
        made, kinds = replay(served.doc["name"], [], session.home)
        found = _record(served.runner, driver, served.version, {"runs": []}, session.run(made), kinds)
    return found
