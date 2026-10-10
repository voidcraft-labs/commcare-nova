"""The steps a Web Apps run is made of: what a worker clicks, and what the page then shows.

Each is a step of the editor driver's ``run`` operation
(``proof/editors/driver/driver.mjs``) or one of the Web Apps step files
(``proof/editors/driver/steps/webapps``). A click waits for the element the
client renders, clicks it as a person does, and then waits until the page is
quiet (none of its requests in flight and none of the client's own short timers
still set, a frame and a task later still), so the next step reads what the
click led to, as a worker acts only once the page has finished reacting.
"""

from __future__ import annotations

import base64

# What the page shows now (steps/webapps/screen.js).
SCREEN = {"call": "webapps/screen"}
# The page quiet: none of its requests in flight, none of the client's own short timers still set (a throttled
# answer, a dialog's transition: driver/steps/page/timers.js), a frame and a task later still.
SETTLE = {"settle": True, "timers": True}

APP_TILE = "#menu-region .appicon-default"
MENU_ROW = "#menu-region .menus-container > tr"
LIST_ACTION = "#menu-region .case-list-action-button button"
BREADCRUMB = "#breadcrumb-region .breadcrumb-item a"


# How long the client is given to show what a replayed choice clicks, once the page is quiet (``within``).
WITHIN_MS = 5000


def click(
    selector: str,
    text: str | None = None,
    *,
    visible: bool = False,
    within: int | None = None,
    or_skip_to: str | None = None,
) -> list[dict]:
    """A click on the one element ``selector`` finds (with the text ``text``; with ``visible``, among those the
    browser lays out), then the page quiet.

    With ``within`` the client is given that many milliseconds to show the element, and a click that misses is
    recorded (``missed``) in place of failing the run: with ``or_skip_to`` the steps up to the one labelled so are
    skipped (the rest of a replayed run), without it the run goes on (an element the client shows only
    sometimes).
    """
    step = {"until": "webapps/click", "arg": {"selector": selector, "text": text, "visible": visible}}
    if within is not None:
        step["within"] = within
        if or_skip_to is not None:
            step["orSkipTo"] = or_skip_to
    return [step, SETTLE]


# How long a step that waits for the client's own answer, and may end the run where the client refuses to go on,
# is given: the run's own deadline bounds it, so it fails only where the client never answered.
ANSWERED_WITHIN_MS = 600_000


def arrive(
    selections: list | None = None, *, query_data: dict | None = None, form: bool | None = None, any_screen=False
) -> list[dict]:
    """Until the client has arrived where a choice leads, by its own account (``steps/webapps/arrived.js``: its
    route holds ``selections``, ``query_data``'s keys and a form's session where ``form`` says one is open, none
    of its requests is in flight, no dialog is open or moving and no notification fading), then the page quiet.
    With ``any_screen`` only the client's own account counts, not its route: where Formplayer refused what was
    asked, the client shows the error and goes back on its own."""
    arg = {"selections": selections, "queryData": query_data or {}, "form": form, "any": any_screen}
    return [{"until": "webapps/arrived", "arg": arg}, SETTLE]


def navigate(
    selector: str,
    arrival: list[dict],
    text: str | None = None,
    *,
    visible: bool = False,
    within: int | None = None,
    or_skip_to: str | None = None,
) -> list[dict]:
    """A click on what takes the worker to another screen, then the client's arrival there (``arrive``), never a
    time: the client asks Formplayer a moment after a click, and draws the answer once it comes."""
    [step, _settle] = click(selector, text, visible=visible, within=within, or_skip_to=or_skip_to)
    return [step, *arrival]


# A case detail's Continue (``partials/case_detail.html``, ``module-case-detail``).
CONTINUE = "#select-case"


def searched(arrival: list[dict], end: str | None) -> list[dict]:
    """``arrival`` for a click on a search's Search button, which the client may refuse to send where a prompt is
    invalid (``arrived.js``, ``search``): that answer ends the run (at ``end``), as a worker's search that cannot go
    on; where no run is replayed tolerantly (no ``end``), the arrival must hold."""
    [wait, settle] = arrival
    if end is None or wait["arg"].get("any"):
        return arrival
    step = {**wait, "arg": {**wait["arg"], "search": True}, "within": ANSWERED_WITHIN_MS, "orSkipTo": end}
    return [step, settle]


def open_case(row: str, selections: list, arrival: list[dict], *, within=None, or_skip_to=None) -> list[dict]:
    """A click on a case's row, until the client has answered it (``steps/webapps/detail.js``: its detail dialog
    done opening, or the case taken without one), the screen read, then the dialog's Continue where it shows,
    then the client's arrival at the screen after the case."""
    [step, _settle] = click(row, within=within, or_skip_to=or_skip_to)
    return [
        step,
        {"until": "webapps/detail", "arg": {"selections": selections}},
        SETTLE,
        SCREEN,
        *click(CONTINUE, visible=True, within=WITHIN_MS),
        *arrival,
    ]


# Where the client sends a form's answers and its submission (``form_entry/web_form_session.js``, under
# ``session.FORMPLAYER_PREFIX``).
ANSWER = "/formplayer/answer"
SUBMIT = "/formplayer/submit-all"


def answer(ix: str, value: str, *, twelve_hour: bool = False) -> list[dict]:
    """One question answered through its widget (``steps/webapps/answer.js``), then Formplayer's answer to the
    request the client sent for it, then the page quiet. The client sends an answer a moment after the widget
    changes (its knockout bindings, then a throttle), so the step waits for that request's answer; where the
    client drew no widget a worker can answer with ``value``, nothing is sent and nothing is waited for."""
    return [
        {"mark": True},
        {
            "until": "webapps/answer",
            "arg": {"ix": ix, "value": value, "twelveHour": twelve_hour},
            "within": ANSWERED_WITHIN_MS,
        },
        {"awaitRequest": {"method": "POST", "pathname": ANSWER}, "sinceMark": True, "unlessMissed": True},
        SETTLE,
    ]


ANSWER_MEDIA = "/formplayer/answer_media"
# Where a worker's pen goes on a signature pad: pressed at one point, moved to another and lifted, as fractions of
# the pad's box. One move, so the pad keeps every point however fast the browser sends them (signature_pad
# throttles its moves by the clock, and keeps a stroke's first move and its end whatever the time between them).
SIGNATURE_STROKE = [[0.2, 0.6], [0.8, 0.4]]


def _gesture(ix: str, widget: str, give: dict, pathname: str) -> list[dict]:
    arg = {"ix": ix, "widget": widget}
    return [
        {"mark": True},
        {"until": "webapps/widget", "arg": arg, "within": ANSWERED_WITHIN_MS},
        {**give, "arg": arg, "unlessMissed": True},
        {"awaitRequest": {"method": "POST", "pathname": pathname}, "sinceMark": True, "unlessMissed": True},
        SETTLE,
    ]


def answer_media(ix: str, kind: str, name: str, content: bytes, content_type: str) -> list[dict]:
    """One file question answered through its widget, as a worker answers it: the file chosen through the
    widget's own file input (an image, audio, video or document question), or, for a signature, a stroke drawn on
    its pad (``steps/webapps/widget.js`` finds either, and the driver's ``files`` and ``draw`` steps give it),
    then Formplayer's answer to the upload the client sent for it (``answer_media``), then the page quiet. The
    file is the one Formplayer's walk uploaded (``kind`` and ``name``, from the answer table); a pad's picture is
    the client's own. Where the client draws no such widget at that question, nothing is given and nothing is
    waited for."""
    if kind == "signature":
        return _gesture(ix, "signature", {"draw": "webapps/widget", "stroke": SIGNATURE_STROKE}, ANSWER_MEDIA)
    given = {"name": name, "mimeType": content_type, "base64": base64.b64encode(content).decode("ascii")}
    return _gesture(ix, "file", {"files": "webapps/widget", "file": given}, ANSWER_MEDIA)


def answer_place(ix: str, offset: tuple[int, int]) -> list[dict]:
    """One location question answered on its map, as a worker answers one (``entries.js::GeoPointEntry``: the
    answer is the map's centre whenever the map moves): the map pressed at its centre, dragged by ``offset``
    pixels and released, in one move (Leaflet moves the map on each move of a drag, and a drag of one move ends
    with no glide), then Formplayer's answer to the answer the client sent, then the page quiet."""
    stroke = [[0.5, 0.5], [0.5, 0.5, offset[0], offset[1]]]
    return _gesture(ix, "map", {"draw": "webapps/widget", "stroke": stroke}, ANSWER)


def submit_and_land() -> list[dict]:
    """The open form's Submit (``steps/webapps/submit.js``), Formplayer's answer to the submission, then the
    client's arrival wherever it then goes (the screen Formplayer's end of form navigation names, the app's first
    screen, or the form again with its errors). Where the client keeps Submit disabled, nothing is sent."""
    return [
        {"mark": True},
        {"until": "webapps/submit", "arg": None, "within": ANSWERED_WITHIN_MS},
        {"awaitRequest": {"method": "POST", "pathname": SUBMIT}, "sinceMark": True, "unlessMissed": True},
        *arrive(any_screen=True),
    ]


def open_app(name: str) -> list[dict]:
    """The app's tile on Web Apps' home screen."""
    return click(APP_TILE, name)


def choose(text: str) -> list[dict]:
    """A menu's row: a menu or a form, by the name the menu shows."""
    return click(MENU_ROW, text)


def select_case(case_id: str) -> list[dict]:
    """A case in a case list, then Continue on the case detail the client opens."""
    return [*click(f"#menu-region [id='row-{case_id}']"), *click("#select-case")]


def list_action(text: str) -> list[dict]:
    """One of a case list's action buttons (a search, a registration form)."""
    return click(LIST_ACTION, text)


def fill(selector: str, value: str) -> list[dict]:
    """Text typed into the one input ``selector`` finds."""
    return [{"until": "webapps/fill", "arg": {"selector": selector, "value": value}}]


def search_list(text: str) -> list[dict]:
    """A case list's own search box: the text typed, then its search button."""
    return [*fill("#searchText", text), *click("#case-list-search-button")]


def run_search() -> list[dict]:
    """A search screen's Search button."""
    return click("#query-submit-button")


def submit_form() -> list[dict]:
    """The open form's Submit button, then Formplayer's answer to the submission and the page quiet again.

    The client sends a submission from a throttled handler a moment after the click, so the page is quiet
    before the request starts: the step waits for the request's answer, and only then for the page.
    """
    return [
        *click("#webforms button.submit"),
        {"awaitRequest": {"method": "POST", "pathname": "/formplayer/submit-all"}},
        SETTLE,
    ]


def path(*steps: list[dict]) -> list[dict]:
    """Several clicks in order, as one list of steps."""
    return [step for group in steps for step in group]
