"""The requests the Web Apps client sends Formplayer for one worker's session, sent as it sends them.

``WebApps`` holds what the browser holds between requests (HQ's session
cookie, Formplayer's CSRF cookie) and writes each request's body with the
fields HQ's client writes, read from HQ's client at the pin:

- menu navigation (``cloudcare/js/formplayer/menus/api.js``, the ``data`` of
  ``queryFormplayer``): the worker, the project space, the app, the
  selections so far, the query data, the page and the display options, to
  ``navigate_menu``;
- form entry (``cloudcare/js/form_entry/web_form_session.js::
  _serverRequest``): the action's own fields with the worker, the project
  space and the form session's id under both of its spellings, to the
  action's route (``answer``, ``submit-all``, ``current``, ...).

The values a browser reads from its window (the zone, the width, the page
size) are fixed here to one browser's: UTC, a desktop width, ten cases a
page. Each request is one HTTP request to Formplayer's own server
(``FormplayerRunner.http``), with Formplayer's requests of HQ answered by
``hq``; every exchange is kept in ``exchanges`` in order.
"""

from __future__ import annotations

import json
from collections.abc import Sequence
from typing import Any

from proof.formplayer.client import Exchange, FormplayerRunner, FormplayerRunnerError, HqHandler

CSRF_COOKIE = "XSRF-TOKEN"
CSRF_HEADER = "X-XSRF-TOKEN"
SESSION_COOKIE = "sessionid"
# One browser's window: a desktop width (cloudcare's utils.js reads window.innerWidth) and ten cases a page
# (menus/api.js: 10 above the small-screen width).
WINDOW_WIDTH = "1280"
CASES_PER_PAGE = 10
TIMEZONE = "UTC"
# The boundary of a multipart request's parts. A browser draws its own for each request; one fixed here keeps a
# request's bytes the same on every run, and Formplayer reads the parts whatever separates them.
MULTIPART_BOUNDARY = "----ProofFormBoundary7MA4YWxkTrZu0gW"


class FormplayerRefused(AssertionError):
    """Formplayer answered a request with an HTTP status other than 200; the Web Apps client shows an error."""

    def __init__(self, path, exchange: Exchange):
        super().__init__(
            f"Formplayer answered {path} with HTTP {exchange.response.status}:"
            f" {exchange.response.body[:2000]!r}\nIts log:\n{exchange.log[-4000:]}"
        )
        self.exchange = exchange


class WebApps:
    """One worker's Web Apps session with one app."""

    def __init__(
        self,
        runner: FormplayerRunner,
        hq: HqHandler,
        *,
        domain: str,
        username: str,
        app_id: str,
        session_key: str,
        locale: str | None = None,
        one_question_per_screen: bool = False,
    ):
        self.runner, self.hq = runner, hq
        self.domain, self.username, self.app_id, self.locale = domain, username, app_id, locale
        self.session_key = session_key
        self.one_question_per_screen = one_question_per_screen
        self.csrf: str | None = None
        self.exchanges: list[tuple[str, Any, Exchange]] = []

    # -- transport ---------------------------------------------------------

    def _headers(self) -> list[tuple[str, str]]:
        cookies = [f"{SESSION_COOKIE}={self.session_key}"]
        headers = []
        if self.csrf is not None:
            cookies.append(f"{CSRF_COOKIE}={self.csrf}")
            headers.append((CSRF_HEADER, self.csrf))
        headers.append(("Cookie", "; ".join(cookies)))
        return headers

    def _keep_csrf(self, exchange: Exchange) -> None:
        for cookie in exchange.response.header_values("Set-Cookie"):
            name, _, rest = cookie.partition("=")
            if name.strip() == CSRF_COOKIE:
                self.csrf = rest.split(";", 1)[0]

    def open(self) -> None:
        """The page's first request of Formplayer, which hands the browser Formplayer's CSRF cookie."""
        exchange = self.runner.http("/serverup", method="GET", headers=self._headers(), hq=self.hq)
        self._keep_csrf(exchange)
        if self.csrf is None:
            raise FormplayerRunnerError(
                "Formplayer's answer to /serverup set no XSRF-TOKEN cookie, which the Web Apps client sends back"
                f" as X-XSRF-TOKEN on every request. Its headers: {exchange.response.headers}",
                kind="request",
            )

    def post(self, path: str, body: dict[str, Any], *, deadline: float = 120.0) -> Any:
        """One request as the client sends it; Formplayer's JSON answer."""
        if self.csrf is None:
            self.open()
        exchange = self.runner.http(path, body, headers=self._headers(), hq=self.hq, deadline=deadline)
        self._keep_csrf(exchange)
        self.exchanges.append((path, body, exchange))
        if exchange.response.status != 200:
            raise FormplayerRefused(path, exchange)
        return exchange.response.json()

    # -- menus -------------------------------------------------------------

    def navigate(
        self,
        selections: Sequence[str] = (),
        *,
        query_data: dict[str, Any] | None = None,
        search_text: str | None = None,
        page: int = 0,
        form_session_id: str | None = None,
        selected_values: Sequence[str] | None = None,
        route: str = "navigate_menu",
        **more: Any,
    ) -> Any:
        """A menu navigation with the selections so far (``menus/api.js``)."""
        body = {
            "username": self.username,
            "restoreAs": None,
            "domain": self.domain,
            "app_id": self.app_id,
            "locale": self.locale,
            "selections": list(selections),
            "offset": page * CASES_PER_PAGE,
            "search_text": search_text,
            "form_session_id": form_session_id,
            "query_data": query_data or {},
            "cases_per_page": CASES_PER_PAGE,
            "oneQuestionPerScreen": self.one_question_per_screen,
            "isPersistent": False,
            "preview": False,
            "tz_offset_millis": 0,
            "tz_from_browser": TIMEZONE,
            "selected_values": list(selected_values) if selected_values is not None else None,
            "isShortDetail": False,
            "isRefreshCaseSearch": False,
            "windowWidth": WINDOW_WIDTH,
            "keepAPMTraces": False,
            **more,
        }
        return self.post(f"/{route}", body)

    # -- form entry --------------------------------------------------------

    def _form_body(self, action: str, session_id: str, **fields: Any) -> dict[str, Any]:
        return {
            **fields,
            "action": action,
            "domain": self.domain,
            "username": self.username,
            "restoreAs": None,
            "session-id": session_id,
            "session_id": session_id,
            "debuggerEnabled": False,
            "tz_offset_millis": 0,
            "tz_from_browser": TIMEZONE,
        }

    def form_request(self, action: str, session_id: str, **fields: Any) -> Any:
        """A form entry request (``web_form_session.js::_serverRequest``)."""
        return self.post(f"/{action}", self._form_body(action, session_id, **fields))

    def answer(self, session_id: str, index: str, answer: Any) -> Any:
        return self.form_request("answer", session_id, ix=index, answer=answer)

    def answer_media(self, session_id: str, index: str, name: str, content: bytes, content_type: str) -> Any:
        """A file question answered with a file, as the client sends it (``web_form_session.js::_serverRequest``
        for ``answer_media``, the action ``entries.js::FileEntry`` sets): a multipart form of the file under
        ``file`` and the request's other fields as a JSON blob under ``answer``, to Formplayer's
        ``FormController.answerMediaQuestion``, which keeps the file and answers the question with the id it gives
        it. The answer names the file as the client's widget does (``FileEntry.onPreProcess``: the file's own
        name)."""
        fields = self._form_body("answer_media", session_id, ix=index, answer=name)
        boundary = MULTIPART_BOUNDARY
        body = b"".join(
            [
                f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{name}"\r\n'.encode(),
                f"Content-Type: {content_type}\r\n\r\n".encode(),
                content,
                f'\r\n--{boundary}\r\nContent-Disposition: form-data; name="answer"; filename="blob"\r\n'.encode(),
                b"Content-Type: application/json\r\n\r\n",
                json.dumps(fields).encode("utf-8"),
                f"\r\n--{boundary}--\r\n".encode(),
            ]
        )
        if self.csrf is None:
            self.open()
        headers = [*self._headers(), ("Content-Type", f"multipart/form-data; boundary={boundary}")]
        exchange = self.runner.http("/answer_media", body, headers=headers, hq=self.hq)
        self._keep_csrf(exchange)
        self.exchanges.append(("/answer_media", fields, exchange))
        if exchange.response.status != 200:
            raise FormplayerRefused("/answer_media", exchange)
        return exchange.response.json()

    def submit(self, session_id: str, answers: dict[str, Any], *, prevalidated: bool = True) -> Any:
        return self.form_request("submit-all", session_id, answers=answers, prevalidated=prevalidated)
