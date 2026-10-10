"""HQ's Web Apps client, run in the lane's Chromium against HQ's own page view and the lane's Formplayer.

A ``Session`` is one worker's browser on one state HQ serves
(``proof.formplayer.hq.Served``). Its page is
HQ's own: ``cloudcare/views.py::FormplayerMain`` answers the navigation
through HQ's URLconf, decorators and templates (``proof.editors.hq``), the
page loads the bundle the image builds from HQ's ``cloudcare/js/formplayer/
main`` entry under HQ's webpack configuration (``proof/image/editors/
build.mjs``), and every request the client then makes goes where the client
sends it:

- **to HQ** (the app list, an error report, a metric): answered by the HQ
  view its URL names, for the worker; and HQ's stylesheets and static
  files, compiled and served by HQ's own code (``proof.webapps.static``),
  so the browser lays the client's markup out as a worker's browser does;
- **to Formplayer**: the page is told Formplayer lives at ``/formplayer`` on
  HQ's own origin (``FORMPLAYER_URL_WEBAPPS``), which is where a deployment's
  proxy serves it (HQ's own firewall rules name ``/formplayer/...`` paths,
  ``cloudcare/urls.py``). Each such request is sent, headers and body as the
  browser wrote them, to Formplayer's own web server
  (``FormplayerRunner.http``), and Formplayer's answer, cookies included,
  goes back to the page. What Formplayer asks HQ meanwhile is answered by
  HQ's own views over the served state (``proof.formplayer.hq.HqViews``):
  the session's user, the released build's archive, the restore, each
  submission, search and claim.

Nothing of the client is copied or called from here: a step clicks what a
worker clicks, or reads what the page shows (``driver/steps/webapps``).

Every run starts as a worker starts after clearing their data in Web Apps
(Formplayer's ``clear_user_data``), since one Formplayer serves every
session of a lane worker and keeps a worker's restore by their name, and
with Formplayer's in-memory caches empty (``FormplayerRunner.forget_caches``).

The browser's randomness is seeded from the run's steps, as an editor
page's is, and its clock starts at the HQ pin's commit time and runs on
from there (``steps/page/seed.js``, ``advancing``): the client's own
animations end and its debounced handlers run, as in a worker's browser,
and nothing it shows reads the clock. ``Run.screens`` is what each ``SCREEN`` step
read, with the one id the client shows that Formplayer draws afresh on
every run (a form session's, in the route) written as a mark.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlsplit

from proof.editors import seeding
from proof.editors.client import EditorDriver, EditorDriverError, PageRequest, PageResponse
from proof.editors.hq import EditorRunFailed, HQAnswers, editor_build
from proof.formplayer.webapps import SESSION_COOKIE, WebApps
from proof.webapps import static

# Where a deployment's proxy serves Formplayer on HQ's own origin.
FORMPLAYER_PREFIX = "/formplayer"
# Request headers that belong to the browser's connection to the origin, not to the request Formplayer is sent.
_TRANSPORT_HEADERS = {"host", "connection", "content-length", "accept-encoding"}
# Response headers that belong to Formplayer's connection with the harness, which the page's own connection replaces.
_HOP_HEADERS = {"content-length", "transfer-encoding", "connection", "keep-alive"}


def _page_headers(headers) -> tuple[tuple[str, str], ...]:
    """Formplayer's response headers as the page is answered with them: without its connection's, and a header
    Formplayer sent several times (``Vary``) as one, its values joined as HTTP joins them. A cookie stays its own
    header: the browser reads each ``Set-Cookie`` apart."""
    cookies, joined = [], {}
    for name, value in headers:
        key = name.lower()
        if key in _HOP_HEADERS:
            continue
        if key == "set-cookie":
            cookies.append((name, value))
        else:
            joined[key] = f"{joined[key]}, {value}" if key in joined else value
    return (*joined.items(), *cookies)


@dataclass
class FormplayerExchange:
    """One request the client made of Formplayer, and Formplayer's answer."""

    method: str
    path: str
    body: bytes | None
    status: int
    response: bytes
    # What Formplayer asked HQ while it answered: (method, path).
    asked: tuple[tuple[str, str], ...]
    log: str = ""
    # The headers the page was answered with.
    headers: tuple[tuple[str, str], ...] = ()

    def request_json(self) -> Any:
        return json.loads(self.body) if self.body else None

    def json(self) -> Any:
        return json.loads(self.response)


@dataclass
class Run:
    """What one run of steps left: each step's outcome, the page's errors, and every exchange."""

    outcomes: list[dict]
    page_errors: list
    console_errors: list
    dialogs: list
    hq: list
    formplayer: list[FormplayerExchange] = field(default_factory=list)
    # Each static file HQ's finders served the page: (path, status).
    statics: list[tuple[str, int]] = field(default_factory=list)

    def value(self, index: int) -> Any:
        """The value step ``index`` evaluated to (negative counts from the end)."""
        return self.outcomes[index].get("value")

    @property
    def screens(self) -> list[dict]:
        """What each ``SCREEN`` step read, in order, as a record keeps it (``recorded``)."""
        return [recorded(outcome["value"]) for outcome in self.outcomes if _is_screen(outcome.get("value"))]

    def answered(self, route: str) -> list[FormplayerExchange]:
        """Formplayer's exchanges for one route (``navigate_menu``, ``submit-all``, ...), in order."""
        return [exchange for exchange in self.formplayer if exchange.path.split("?")[0] == f"/{route}"]


FORM_SESSION = "<form session>"


def _is_screen(value) -> bool:
    return isinstance(value, dict) and "route" in value and "alerts" in value


def recorded(screen: Mapping[str, Any]) -> dict:
    """A screen as a record keeps it: the form session's id in its route, which Formplayer draws afresh on every
    run, written as a mark. Every other value is what the page showed."""
    kept = json.loads(json.dumps(screen))
    route = kept.get("route")
    if isinstance(route, dict) and route.get("sessionId"):
        route["sessionId"] = FORM_SESSION
    return kept


class WebAppsRunFailed(AssertionError):
    """A Web Apps run did not get through; says what the page, HQ and Formplayer saw."""


@dataclass
class Session:
    """One worker's Web Apps on one state HQ serves (``proof.formplayer.hq.Served``)."""

    served: Any
    driver: EditorDriver

    @property
    def hq(self):
        """HQ's own views, which answer every request Formplayer makes of HQ."""
        return self.served.hq

    @property
    def runner(self):
        return self.served.runner

    @property
    def home(self) -> str:
        return f"/a/{self.served.domain}/cloudcare/apps/v2/"

    def _fresh_worker(self) -> None:
        """Formplayer forgets the worker's restore, as after "Clear user data" in Web Apps' settings, and its
        install of the build.

        Formplayer keeps an install by the id it was asked for and never
        downloads that id again (``FormplayerStorageFactory``), so a session
        that kept an earlier install of an id would run that install under
        this build's name.
        """
        web = WebApps(
            self.runner,
            self.hq,
            domain=self.served.domain,
            username=self.served.username,
            app_id=self.served.build_id,
            session_key=self.hq.session_key,
        )
        worker = {"domain": self.served.domain, "username": self.served.username, "restoreAs": None}
        web.post("/clear_user_data", worker)
        web.post("/delete_application_dbs", {"app_id": self.served.build_id, **worker})
        # Nothing an earlier session left in Formplayer's five-minute caches answers this run's requests
        # (FormplayerRunner.forget_caches).
        self.runner.forget_caches()

    def _formplayer_headers(self, headers: Mapping[str, str]) -> list[tuple[str, str]]:
        """The page's request headers as Formplayer is sent them: the browser's own, with HQ named as Formplayer
        knows it.

        A deployment has one name for HQ: the page's origin is the host Formplayer is configured with
        (``commcarehq.host``), and Formplayer's own CORS rule admits a request only from that origin
        (``configuration/CorsConfig.java``). The lane has two, the browser's origin and the address Formplayer
        reaches HQ at (the runner's peer), so the ``Origin`` and ``Referer`` the browser wrote for HQ's origin are
        written with Formplayer's name for the same HQ, and Formplayer's rule then judges the request as it
        judges production's.
        """
        browser = (self.driver.ready or {}).get("origin")
        formplayer = (self.runner.ready or {}).get("hq")
        sent = []
        for name, value in headers.items():
            key = name.lower()
            if key in _TRANSPORT_HEADERS:
                continue
            if browser and formplayer and key in ("origin", "referer") and value.startswith(browser):
                value = formplayer + value[len(browser) :]
            sent.append((name, value))
        return sent

    def run(self, steps: Sequence[Mapping[str, Any]], *, deadline: float = 180.0, name: str = "webapps") -> Run:
        """Opens Web Apps' home page in a fresh browser context and runs ``steps`` after it has loaded, in one run
        of the served state (``Served.run``: a fork of the unit, the worker signed in afresh)."""
        with self.served.run(name):
            return self._run(steps, deadline=deadline)

    def _run(self, steps: Sequence[Mapping[str, Any]], *, deadline: float) -> Run:
        from django.test import override_settings

        editor_build()
        answers = HQAnswers(self.served.acting, self.served.unit)
        exchanges: list[FormplayerExchange] = []
        statics: list[tuple[str, int]] = []

        def answer(asked: PageRequest) -> PageResponse:
            parts = urlsplit(asked.url)
            if not parts.path.startswith(FORMPLAYER_PREFIX + "/"):
                # A static file HQ's own finders hold (a stylesheet HQ compiled, a font) is served as HQ's
                # development server serves it; everything else is HQ's views', from HQ's root.
                served = static.serve(parts.path) if asked.method == "GET" else None
                if served is not None:
                    statics.append((parts.path, served.status))
                    return served
                with static.in_hq_root():
                    return answers(asked)
            target = parts.path[len(FORMPLAYER_PREFIX) :] + (f"?{parts.query}" if parts.query else "")
            headers = self._formplayer_headers(asked.headers)
            exchange = self.runner.http(target, asked.body, method=asked.method, headers=headers, hq=self.hq)
            answered = _page_headers(exchange.response.headers)
            exchanges.append(
                FormplayerExchange(
                    method=asked.method,
                    path=target,
                    body=asked.body,
                    status=exchange.response.status,
                    response=exchange.response.body,
                    asked=tuple((request.method, request.path) for request, _ in exchange.hq),
                    log=exchange.log if exchange.response.status != 200 else "",
                    headers=answered,
                )
            )
            return PageResponse(exchange.response.status, list(answered), exchange.response.body)

        steps = [{"goto": self.home}, {"settle": True, "timers": True}, *steps]
        seed = {
            "seed": hashlib.sha256(json.dumps(steps, sort_keys=True).encode()).hexdigest()[:32],
            "epoch": seeding.epoch_ms(),
            # The client's clock runs on from the epoch, as a worker's browser's does (``steps/page/seed.js``).
            "advancing": True,
        }
        self._fresh_worker()
        try:
            with override_settings(FORMPLAYER_URL_WEBAPPS=FORMPLAYER_PREFIX), static.compiled():
                run = self.driver.run(
                    steps,
                    answer=answer,
                    deadline=deadline,
                    cookies={SESSION_COOKIE: self.hq.session_key},
                    seed=seed,
                    timers=True,
                )
        except EditorDriverError as error:
            refused = "".join(
                f"\n- {e.method} {e.path} answered {e.status}: {e.response[:600]!r}\n{e.log[-2000:]}"
                for e in exchanges
                if e.status != 200
            )
            outcomes = (error.detail.get("run") or {}).get("outcomes")
            raise WebAppsRunFailed(
                f"{EditorRunFailed('The Web Apps run', error, answers)}"
                f"\nFormplayer's failed answers:{refused or ' none'}"
                f"\nFormplayer's exchanges: {[(e.method, e.path, e.status) for e in exchanges]}"
                f"\nHQ's answers: {[(e.method, e.path, e.status) for e in answers.exchanges]}"
                f"\nStatic files: {statics}"
                # Where the run stood is its last steps: the screen it last read, and what it waited for after it.
                f"\nThe run's last steps: {json.dumps(outcomes, ensure_ascii=False)[-6000:]}"
            ) from error
        answers.check()
        return Run(
            outcomes=run["outcomes"][2:],
            page_errors=run["pageErrors"],
            console_errors=run["consoleErrors"],
            dialogs=run["dialogs"],
            hq=answers.exchanges,
            formplayer=exchanges,
            statics=statics,
        )
