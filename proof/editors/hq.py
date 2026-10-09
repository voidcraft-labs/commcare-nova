"""HQ answering the requests an editor page makes, as HQ's own server would.

``HQAnswers`` is the ``answer`` an editor run gives the driver
(``proof.editors.client``). Each request the page makes to HQ's origin is
built the way ``proof.hq.requests`` builds HQ's requests (the check's editor,
its session and message storage, the page's ``lang`` cookie), resolved through
HQ's URLconf, and answered by the view that URL names, decorators and all; a
template response is rendered with HQ's context processors. After each
request the bootstrap version HQ keeps per thread is cleared, as HQ's
``ThreadLocalCleanupMiddleware`` clears it after every request.

Two paths under HQ's static URL are what a deployment's static build serves,
and are answered from it:

- the JavaScript bundles HQ's ``webpack_bundles`` template filter names, which
  the driver serves from the image's editor build (``/opt/editors``). HQ reads
  the bundle names from the manifests its webpack build writes
  (``hqwebapp/utils/webpack.py::get_webpack_manifest``, under
  ``WEBPACK_BUILD_DIR``), and the image's editor build writes its manifests
  there, in HQ's format; ``editor_build`` checks that they are there, since
  under ``UNIT_TESTING`` HQ renders a page with no scripts when they are not
  (``hq_shared_tags.py::webpack_bundles``);
- the JavaScript translation catalog ``{% statici18n %}`` names, which HQ's
  deployment writes with ``manage.py compilejsi18n``
  (``hqscripts/management/commands/compilejsi18n.py``: django-statici18n's
  command, then the chat widget's translations, which no covered page asks
  for); the harness runs django-statici18n's command once per session for the
  locale the pages ask for.

Every exchange is recorded, with the phase of the operation it was asked in,
the headers the page sent, and the digest of HQ's answer (``response_digest``:
its status, headers and body), which is what a transcript keeps
(``proof.editors.transcripts``). A view that reaches something the harness
refuses (a network service, a Couch view the harness does not answer, or an
Elasticsearch index the lane does not keep) is answered with a 500 and recorded as a refusal, so the
run's caller fails the check; the page never decides that.

Given a unit (``unit.request(digest)``, the HQ unit contract of
``proof.hq``), each request HQ answers runs inside it, keyed by the request's
digest (``request_digest``), and the exchange records whether it wrote. A
request answered before the page asks (``preanswer``: a view's navigation,
answered to learn the response a transcript is looked up by) is served from
that answer when the page asks for exactly it.

Under HQ's determinism (``proof.hq.determinism``), the CSRF strings HQ mints
while it answers a request (Django's
``middleware/csrf.py::_get_new_csrf_string``: the secret ``get_token`` keeps
for the request and the mask of each token it hands the page) are drawn from
that request's digest (``csrf_drawn_from``), not from the state's entropy, so
a page HQ renders alike in two states carries the same token in both and
sends it back in the same bodies, and its transcript replays in either. HQ
never reads a token back: a view is called without Django's middleware, so
no CSRF check runs and no cookie is set, and the token's only effect is on
the bytes of the page and of what the page posts. With the determinism off
(``PROOF_HQ_DETERMINISM=0``), Django draws them itself, from the system's
entropy, as it draws every other value then.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import tempfile
import time
import traceback
from contextlib import contextmanager
from dataclasses import dataclass, field
from http.cookies import SimpleCookie
from pathlib import Path
from urllib.parse import urlsplit

from proof.editors.client import PageRequest, PageResponse
from proof.hq import requests as hq_requests
from proof.hq.boot import HarnessRefusal

# The manifests HQ's webpack build writes, one per build (webpack.common.js
# and webpack.b3.common.js's EntryChunksPlugin).
_MANIFESTS = ("manifest.json", "manifest_b3.json")

# Headers that belong to the transport, not to the request: the
# connection's, and the encodings Chromium's network stack offers (it adds
# accept-encoding below the request a Playwright route sees, and the
# driver's origin never encodes an answer).
_TRANSPORT_HEADERS = {"host", "connection", "content-length", "accept-encoding"}
# Request headers the request builder sets itself (the body's type and length,
# the lang cookie) or that belong to the transport; every other header the
# page sent reaches HQ's view as a server passes it on.
_BUILDER_HEADERS = {"cookie", "content-type"} | _TRANSPORT_HEADERS


def _canonical(value) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def request_headers(headers) -> dict[str, str]:
    """A request's headers as the request is identified: lower-cased names, without the transport's."""
    return {name.lower(): value for name, value in headers.items() if name.lower() not in _TRANSPORT_HEADERS}


def request_digest(method: str, url: str, headers, body: bytes | None) -> bytes:
    """What identifies one request to HQ: its method, path and query, headers and body, as a sha256."""
    parts = urlsplit(url)
    return hashlib.sha256(
        _canonical(
            {
                "method": method,
                "target": parts.path + (f"?{parts.query}" if parts.query else ""),
                "headers": request_headers(headers),
                "body": base64.b64encode(body).decode("ascii") if body is not None else None,
            }
        )
    ).digest()


def response_digest(response: PageResponse) -> str:
    """HQ's answer as a transcript keeps it: the sha256 of its status, its headers in order, and its body."""
    head = _canonical({"status": response.status, "headers": [[name, value] for name, value in response.headers]})
    return hashlib.sha256(head + b"\n" + response.body).hexdigest()


@dataclass
class Exchange:
    """One request the page made and how HQ answered it."""

    method: str
    path: str
    query: str
    url_name: str | None
    view: str | None
    status: int
    seconds: float
    messages: list[str] = field(default_factory=list)
    refusal: str | None = None
    error: str | None = None
    # The class of what the view raised (module and name), with ``refusal``
    # or ``error`` holding its message and traceback.
    raised: str | None = None
    body: bytes | None = None
    content_type: str | None = None
    response: bytes | None = None
    # The phase of the operation the request was asked in (PageRequest.phase),
    # the full URL and the headers the page sent.
    phase: str | None = None
    url: str | None = None
    headers: dict = field(default_factory=dict)
    # The driver's number for the request (PageRequest.forwarded).
    forwarded: int | None = None
    # HQ's answer's headers and digest (``response_digest``).
    response_headers: list = field(default_factory=list)
    response_digest: str | None = None
    # Whether answering it wrote HQ's state (None when no unit watched it).
    wrote: bool | None = None


class HQRefusedPageRequest(AssertionError):
    """A page's request reached something the harness refuses, or broke HQ's view.

    ``exchanges`` are the requests that did, so a caller can tell the
    harness's refusals (``Exchange.refusal``) from HQ's own views failing on
    what they were given (``Exchange.error`` alone).
    """

    def __init__(self, message, exchanges=()):
        super().__init__(message)
        self.exchanges = list(exchanges)


def _class_name(error):
    return f"{type(error).__module__}.{type(error).__qualname__}"


# How much of a failed view's traceback a run's failure repeats.
_TRACEBACK_TAIL_LINES = 12


def _failed_answer(exchange):
    text = f"{exchange.method} {exchange.path} ({exchange.url_name}) answered {exchange.status}"
    if exchange.refusal:
        text += f": {exchange.refusal}"
    if exchange.error:
        tail = exchange.error.rstrip().splitlines()[-_TRACEBACK_TAIL_LINES:]
        text += "\n    " + "\n    ".join(tail)
    return text


class EditorRunFailed(AssertionError):
    """An editor run did not get through; says what the page and HQ saw."""

    def __init__(self, what, error, answers):
        run = error.detail.get("run") or {}
        failed = [e for e in answers.exchanges if e.status >= 400 and not e.path.startswith("/static/")]
        super().__init__(
            f"{what} did not complete: {error}\n"
            f"Page errors: {run.get('pageErrors', [])}\n"
            f"Dialogs: {run.get('dialogs', [])}\n"
            "HQ's failed answers:" + ("".join(f"\n- {_failed_answer(e)}" for e in failed) or " none")
        )
        self.error = error
        self.exchanges = answers.exchanges


_CATALOG: dict[str, bytes] = {}


def javascript_catalog(locale):
    """HQ's JavaScript translation catalog for a locale, as ``compilejsi18n`` writes it."""
    if locale not in _CATALOG:
        from django.core.management import call_command
        from statici18n.management.commands.compilejsi18n import Command
        from statici18n.templatetags.statici18n import get_path

        with tempfile.TemporaryDirectory(prefix="proof-jsi18n-") as outputdir:
            call_command(Command(), locale=locale, outputdir=outputdir, verbosity=0)
            relative = os.path.relpath(get_path(locale), _output_dir())
            _CATALOG[locale] = Path(outputdir, relative).read_bytes()
    return _CATALOG[locale]


def _output_dir():
    from statici18n.conf import settings

    return settings.STATICI18N_OUTPUT_DIR


def editor_build():
    """The manifests of the image's editor build, where HQ reads them; fails when they are not there."""
    from corehq.apps.hqwebapp.utils import webpack

    manifests = [Path(webpack.WEBPACK_BUILD_DIR) / name for name in _MANIFESTS]
    missing = [str(path) for path in manifests if not path.is_file()]
    if missing:
        raise HQRefusedPageRequest(
            f"HQ reads its webpack manifests from {webpack.WEBPACK_BUILD_DIR} (hqwebapp/utils/webpack.py), and "
            f"{', '.join(missing)} is not there, so HQ would render its pages with no scripts. The proof image's "
            "editor build writes them there (proof/image/editors/build.mjs); check that the image was built whole."
        )
    return manifests


@contextmanager
def csrf_drawn_from(digest: bytes):
    """Django's CSRF strings minted inside the block, each drawn from ``digest`` and its position in the block.

    The i-th string is the first ``CSRF_SECRET_LENGTH`` characters of
    ``CSRF_ALLOWED_CHARS`` picked by the bytes of sha256(digest | i | n) for
    n = 0, 1, ...; Django's own draw is put back when the block ends. With
    HQ's determinism off (``proof.hq.determinism.ENABLED`` false) the block
    runs with Django's own draw.
    """
    from django.middleware import csrf

    from proof.hq import determinism

    if not determinism.ENABLED:
        yield
        return
    held = csrf._get_new_csrf_string
    drawn = [0]

    def minted():
        drawn[0] += 1
        chars, picked, block = csrf.CSRF_ALLOWED_CHARS, [], 0
        while len(picked) < csrf.CSRF_SECRET_LENGTH:
            seed = digest + b"|csrf|" + drawn[0].to_bytes(4, "big") + block.to_bytes(4, "big")
            picked += [chars[byte % len(chars)] for byte in hashlib.sha256(seed).digest()]
            block += 1
        return "".join(picked[: csrf.CSRF_SECRET_LENGTH])

    csrf._get_new_csrf_string = minted
    try:
        yield
    finally:
        csrf._get_new_csrf_string = held


class PhaseMismatch(AssertionError):
    """The driver asked for a request in a phase other than the one Python is in."""


class PreansweredMismatch(AssertionError):
    """The page asked for its navigation differently from how it was answered ahead of it."""


class HQAnswers:
    """Answers an editor page's requests through HQ's URLconf and views, and records them.

    ``unit``, when given, is the HQ unit every answer runs in
    (``unit.request(digest)``). ``section`` is the section whose phase Python
    is in (``open_section``), or None between sections: a request the driver
    asks in a section's phase is answered only inside it, and a load request
    only outside every section.
    """

    def __init__(self, state, unit=None):
        self.state = state
        self.unit = unit
        self.exchanges: list[Exchange] = []
        self.section: int | None = None
        self._preanswered: tuple[PageRequest, PageResponse, Exchange] | None = None

    # -- phases ------------------------------------------------------------------

    def open_section(self, index: int) -> None:
        self.section = index

    def close_section(self) -> None:
        self.section = None

    def _check_phase(self, asked: PageRequest) -> None:
        phase = asked.phase
        if phase is None or phase in ("run", "vellum"):
            return
        if phase == "load":
            expected = None
        else:
            kind, _, index = phase.partition(":")
            if kind not in ("section", "followup") or not index.isdigit():
                raise PhaseMismatch(
                    f"The driver asked {asked.method} {asked.url} in a phase Python does not know: {phase}."
                )
            expected = int(index)
        if expected != self.section:
            where = "no section" if self.section is None else f"section {self.section}"
            raise PhaseMismatch(
                f"The driver asked {asked.method} {asked.url} in phase {phase} while Python is in {where}'s phase:"
                " a request reached HQ outside the fork it belongs to. A page request that starts between a"
                " section's settling and the end of its phase is the likely cause; see the view's requests."
            )

    # -- answering -----------------------------------------------------------------

    def preanswer(self, asked: PageRequest) -> Exchange:
        """Answers ``asked`` now, before the page asks; the page's identical request is then served from it."""
        response = self(asked)
        exchange = self.exchanges[-1]
        self._preanswered = (asked, response, exchange)
        return exchange

    def consume_preanswer(self) -> Exchange:
        """The request answered ahead (``preanswer``), no longer served to the page: a replay stands for it."""
        if self._preanswered is None:
            raise ValueError("No request was answered ahead of the page, so there is none to consume.")
        exchange = self._preanswered[2]
        self._preanswered = None
        return exchange

    def __call__(self, asked: PageRequest) -> PageResponse:
        self._check_phase(asked)
        if self._preanswered is not None:
            preasked, preresponse, preexchange = self._preanswered
            if asked.method == preasked.method and urlsplit(asked.url)[2:4] == urlsplit(preasked.url)[2:4]:
                self._preanswered = None
                if request_digest(asked.method, asked.url, asked.headers, asked.body) != request_digest(
                    preasked.method, preasked.url, preasked.headers, preasked.body
                ):
                    raise PreansweredMismatch(
                        f"The page asked for {asked.url} with headers {request_headers(asked.headers)}, and it was"
                        f" answered ahead of the page with {request_headers(preasked.headers)}. The driver's"
                        " navigation headers (its probe at start) no longer match what Chromium sends."
                    )
                preexchange.forwarded = asked.forwarded
                return preresponse
        from django.conf import settings
        from statici18n.templatetags.statici18n import statici18n

        started = time.perf_counter()
        parts = urlsplit(asked.url)
        exchange = Exchange(
            method=asked.method,
            path=parts.path,
            query=parts.query,
            url_name=None,
            view=None,
            status=0,
            seconds=0.0,
            body=asked.body,
            content_type=asked.headers.get("content-type"),
            phase=asked.phase,
            url=asked.url,
            headers=request_headers(asked.headers),
            forwarded=asked.forwarded,
        )
        try:
            if parts.path.startswith(settings.STATIC_URL):
                if parts.path == statici18n(settings.LANGUAGE_CODE):
                    response = PageResponse(
                        200,
                        [("Content-Type", "text/javascript; charset=utf-8")],
                        javascript_catalog(settings.LANGUAGE_CODE),
                    )
                else:
                    response = PageResponse(404, [("Content-Type", "text/plain")], b"")
            elif self.unit is not None:
                digest = request_digest(asked.method, asked.url, asked.headers, asked.body)
                with self.unit.request(digest) as scope, csrf_drawn_from(digest):
                    response = self._view(asked, parts, exchange)
                exchange.wrote = bool(scope.wrote)
            else:
                digest = request_digest(asked.method, asked.url, asked.headers, asked.body)
                with csrf_drawn_from(digest):
                    response = self._view(asked, parts, exchange)
        finally:
            exchange.seconds = round(time.perf_counter() - started, 4)
            self.exchanges.append(exchange)
        exchange.status = response.status
        exchange.response = response.body
        exchange.response_headers = [[name, value] for name, value in response.headers]
        exchange.response_digest = response_digest(response)
        return response

    def _view(self, asked, parts, exchange):
        from corehq.apps.hqwebapp.utils.bootstrap import clear_bootstrap_version
        from django.core.exceptions import PermissionDenied, SuspiciousOperation
        from django.http import Http404
        from django.urls import Resolver404, resolve

        try:
            match = resolve(parts.path)
        except Resolver404:
            return PageResponse(404, [("Content-Type", "text/plain")], b"")
        exchange.url_name = match.url_name
        exchange.view = f"{match.func.__module__}.{match.func.__qualname__}"
        request = self._request(asked, parts)
        try:
            response = match.func(request, *match.args, **match.kwargs)
            if hasattr(response, "render") and not getattr(response, "is_rendered", True):
                response.render()
        except Http404:
            return PageResponse(404, [("Content-Type", "text/plain")], b"")
        except PermissionDenied:
            return PageResponse(403, [("Content-Type", "text/plain")], b"")
        except SuspiciousOperation:
            return PageResponse(400, [("Content-Type", "text/plain")], b"")
        except HarnessRefusal as refusal:
            exchange.refusal = f"{type(refusal).__name__}: {refusal}"
            exchange.error = traceback.format_exc()
            exchange.raised = _class_name(refusal)
            return PageResponse(500, [("Content-Type", "text/plain")], b"")
        except Exception as error:
            exchange.error = traceback.format_exc()
            exchange.raised = _class_name(error)
            return PageResponse(500, [("Content-Type", "text/plain")], b"")
        finally:
            exchange.messages = hq_requests.messages(request)
            clear_bootstrap_version()
        body = b"".join(response.streaming_content) if response.streaming else response.content
        headers = [(name, value) for name, value in response.items()]
        headers += [("Set-Cookie", morsel.OutputString()) for morsel in response.cookies.values()]
        return PageResponse(response.status_code, headers, body)

    def _request(self, asked, parts):
        cookie = SimpleCookie()
        cookie.load(asked.headers.get("cookie", ""))
        lang = cookie["lang"].value if "lang" in cookie else None
        target = parts.path + (f"?{parts.query}" if parts.query else "")
        if asked.method == "GET":
            request = hq_requests.get(self.state, target, lang=lang)
        elif asked.method == "POST":
            request = hq_requests.raw_post(
                self.state,
                target,
                asked.body or b"",
                asked.headers.get("content-type", "application/octet-stream"),
                lang=lang,
            )
        else:
            raise HQRefusedPageRequest(f"The page sent HQ a {asked.method} request, which the harness does not build.")
        for name, value in asked.headers.items():
            if name.lower() not in _BUILDER_HEADERS:
                request.META["HTTP_" + name.upper().replace("-", "_")] = value
        return request

    # -- what a run left -------------------------------------------------------

    def refusals(self):
        return [exchange for exchange in self.exchanges if exchange.refusal or exchange.error]

    def check(self, *, harness_only=False):
        """Fails when a request reached something the harness refuses or broke HQ's view.

        With ``harness_only``, only the harness's refusals fail it; an HQ view
        that raised on what the page sent stays in its exchange (``error``)
        for the caller to report where it happened.
        """
        broken = self.refusals()
        if harness_only:
            broken = [exchange for exchange in broken if exchange.refusal]
        if broken:
            raise HQRefusedPageRequest(
                "HQ could not answer requests the page made:\n"
                + "\n".join(f"- {e.method} {e.path} ({e.url_name}): {e.refusal or ''}\n{e.error}" for e in broken),
                broken,
            )
