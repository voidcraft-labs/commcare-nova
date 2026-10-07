"""The steps a Web Apps run is made of: what a worker clicks, and what the page then shows.

Each is a step of the editor driver's ``run`` operation
(``proof/editors/driver/driver.mjs``) or one of the Web Apps step files
(``proof/editors/driver/steps/webapps``). A click waits for the element the
client renders, clicks it as a person does, and then waits until the page is
quiet (none of its requests in flight, a frame and a task later still), so
the next step reads what the click led to.
"""

from __future__ import annotations

# What the page shows now (steps/webapps/screen.js).
SCREEN = {"call": "webapps/screen"}
SETTLE = {"settle": True}

APP_TILE = "#menu-region .appicon-default"
MENU_ROW = "#menu-region .menus-container > tr"
LIST_ACTION = "#menu-region .case-list-action-button button"
BREADCRUMB = "#breadcrumb-region .breadcrumb-item a"


def click(selector: str, text: str | None = None) -> list[dict]:
    """A click on the one element ``selector`` finds (with the text ``text``), then the page quiet."""
    return [{"until": "webapps/click", "arg": {"selector": selector, "text": text}}, SETTLE]


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
