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
# The menu over the app's screens (``partials/menu/dropdown.html``, ``menu-dropdown-template``): its toggle, and
# each language it offers, by the language's code (``language-option-template``).
MENU_DROPDOWN = "#menu-dropdown > .dropdown-toggle"
LANGUAGE_OPTION = "#menu-dropdown a.lang[id='{}']"
NAVIGATE = "/formplayer/navigate_menu"


# A case list's page button (``partials/pagination.html``: each page's item, by its index from 0), and how many
# cases a page holds on a small screen (``menus/api.js``: five at or under ``SMALL_SCREEN_WIDTH_PX``).
PAGE = "#menu-region li.page-item.js-page[data-id='{}']"
SMALL_SCREEN_PAGE = 5


def turn_to(page: int, *, within=None, or_skip_to=None) -> list[dict]:
    """A case list turned to ``page`` as a worker turns it, by its page button, then Formplayer's answer to the
    request the client sends for that page and the client's arrival."""
    [step, _settle] = click(PAGE.format(page), visible=True, within=within, or_skip_to=or_skip_to)
    return [
        {"mark": True},
        step,
        {"awaitRequest": {"method": "POST", "pathname": NAVIGATE}, "sinceMark": True, "unlessMissed": True},
        *arrive(any_screen=True),
    ]


def choose_language(code: str, arrival: list[dict], *, within=None, or_skip_to=None) -> list[dict]:
    """A language chosen as a worker chooses it: the menu over the app's screens opened, the language clicked
    (``menus/views.js::LanguageOptionView``), then Formplayer's answer to the request the client sends for the
    same screen in that language (``web_form_session.js::changeLang`` asks it after loading the menus'
    controller, so the route is already where it leads before anything is sent), then the client's arrival."""
    [opened, _settle] = click(MENU_DROPDOWN, within=within, or_skip_to=or_skip_to)
    [chosen, _settle] = click(LANGUAGE_OPTION.format(code), visible=True, within=within, or_skip_to=or_skip_to)
    return [
        opened,
        SETTLE,
        {"mark": True},
        chosen,
        {"awaitRequest": {"method": "POST", "pathname": NAVIGATE}, "sinceMark": True, "unlessMissed": True},
        *arrival,
    ]


# The home of the client's breadcrumb, which in App Preview is the app's own first screen; that screen's Settings
# (``partials/grid_view/single_app.html``); and in Settings, the language the app is shown in and Done
# (``partials/settings_view.html``, ``layout/views/settings.js::LangSettingView``, which HQ's client offers in App
# Preview alone).
HOME = "#breadcrumb-region .js-home a"
SETTINGS = "#menu-region .js-settings"
LANGUAGE_SETTING = "select.js-lang"
SETTINGS_DONE = ".js-done"


def set_preview_language(code: str, *, within=None, or_skip_to=None) -> list[dict]:
    """From App Preview's first screen, the language the app is shown in set as a person there sets it: its
    Settings, the language chosen in "Set the application language" (the client keeps it among its display options
    and sends it with every later request), then Done, and the client's arrival back at the app's first screen."""
    [settings, _settle] = click(SETTINGS, visible=True, within=within, or_skip_to=or_skip_to)
    chosen = {"until": "pages/choose", "arg": {"selector": LANGUAGE_SETTING, "value": code}}
    if within is not None:
        chosen = {**chosen, "within": within, **({"orSkipTo": or_skip_to} if or_skip_to is not None else {})}
    [done, _settle] = click(SETTINGS_DONE, visible=True, within=within, or_skip_to=or_skip_to)
    return [settings, *arrive(any_screen=True), chosen, SETTLE, done, *arrive(any_screen=True)]


def choose_preview_language(code: str, arrival: list[dict], *, within=None, or_skip_to=None) -> list[dict]:
    """A language chosen in App Preview as a person there chooses it: the breadcrumb's home to the app's first
    screen, the language set in its Settings (``set_preview_language``), then the app entered again by its Start
    and the client's arrival where that leads, in the language chosen."""
    [home, _settle] = click(HOME, within=within, or_skip_to=or_skip_to)
    [start, _settle] = click(START_APP, within=within, or_skip_to=or_skip_to)
    return [
        home,
        *arrive(any_screen=True),
        *set_preview_language(code, within=within, or_skip_to=or_skip_to),
        start,
        *arrival,
    ]


# A search's Search button (``query/list.html``), and on a small screen the list's Refine search, which unfolds
# the search a list shows beside it (``case_list/menu_header.html``: the sidebar, folded under the large width).
SEARCH_BUTTON = "#query-submit-button"
REFINE_SEARCH = "#search-more[aria-expanded='false']"


def open_sidebar() -> list[dict]:
    """The search beside a case list unfolded on a small screen by the list's Refine search, where the client shows
    it folded; nothing where it shows none (a search on a screen of its own), after the client has had
    ``WITHIN_MS`` to draw one. The page is then quiet (the fold's own transition run)."""
    return click(REFINE_SEARCH, visible=True, within=WITHIN_MS)


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
    answer is the map's centre whenever the map moves): the map dragged by ``offset`` pixels from its middle, in as
    few strokes as stay inside the map and the window, each pressed, moved once and released (Leaflet moves the
    map on each move of a drag, and a drag of one move ends with no glide), each followed by Formplayer's answer
    to the answer the client sent and the page quiet (the driver's ``drag``), then the page quiet."""
    give = {"draw": "webapps/widget", "drag": list(offset), "answeredBy": {"method": "POST", "pathname": ANSWER}}
    return _gesture(ix, "map", give, ANSWER)


def submit_and_land(*, one_question_per_screen: bool = False) -> list[dict]:
    """The open form's Submit (``steps/webapps/submit.js``), Formplayer's answer to the submission, then the
    client's arrival wherever it then goes (the screen Formplayer's end of form navigation names, the app's first
    screen, or the form again with its errors). Where the client keeps Submit disabled, nothing is sent. A form
    shown one question a screen is submitted by its Complete button, which the client shows at its last screen."""
    return [
        {"mark": True},
        {
            "until": "webapps/submit",
            "arg": {"complete": one_question_per_screen},
            "within": ANSWERED_WITHIN_MS,
        },
        {"awaitRequest": {"method": "POST", "pathname": SUBMIT}, "sinceMark": True, "unlessMissed": True},
        *arrive(any_screen=True),
    ]


# Where the client sends a form's step to its next screen when it shows one question a screen
# (``web_form_session.js::nextQuestion``, ``constants.NEXT_QUESTION``).
NEXT_INDEX = "/formplayer/next_index"


def advance(ix: str | None, *, or_skip_to: str | None = None) -> list[dict]:
    """A form the client shows one question a screen stepped forward by its own Next button until the question at
    ``ix`` is on the screen (with no ``ix``, until the form's last screen), each press followed by Formplayer's
    answer to the request the client sends for it and the page quiet (``steps/webapps/advance.js``, the driver's
    ``advance``). Where the client keeps Next from being pressed the outcome says so and the run ends there (at
    ``or_skip_to``), as a worker's form that cannot go on; where the screen went past ``ix`` (a question the form
    holds irrelevant there) the answer's own step records it absent and the run goes on."""
    step = {
        "advance": "webapps/advance",
        "arg": {"ix": ix},
        "answeredBy": {"method": "POST", "pathname": NEXT_INDEX},
        "timers": True,
        # A question the screen went past is the answer step's to record ("absent"), and the walk goes on.
        "passes": [True, "absent"],
    }
    if or_skip_to is not None:
        step["orSkipTo"] = or_skip_to
    return [step, SETTLE]


# App Preview's first screen (``partials/grid_view/single_app.html``): its Start, and its Log in as, which HQ
# draws only for a person who may log in as a worker in a project space whose plan has it
# (``hq_shared_tags.py::can_use_restore_as``).
START_APP = "#menu-region .js-start-app"
LOG_IN_AS = "#menu-region .js-restore-as-item"
# A worker's row in the list of those the person may log in as (``users/views.js::UserRowView``, named by the
# worker's username), and the confirmation the client asks before logging in as them
# (``partials/confirmation_modal.html``).
USER_ROW = "tr.js-user[aria-label='{}']"
CONFIRM = "#js-confirmation-confirm"


def log_in_as(username: str) -> list[dict]:
    """The worker logged in as from App Preview's first screen, as a person in HQ's builder does it: its Log in as,
    then the worker's row of the list HQ's own view answers (``cloudcare/views.py::LoginAsUsers``, over HQ's
    Elasticsearch), then the confirmation's Log in once the dialog is done opening, then the client's arrival back
    at the app's first screen (``users/views.js::onClickUser``: the worker kept in the client's cookie, every
    later request to Formplayer naming them)."""
    return [
        *click(LOG_IN_AS, visible=True),
        *click(USER_ROW.format(username), visible=True),
        *click(CONFIRM, visible=True),
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
    return click(SEARCH_BUTTON)


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
