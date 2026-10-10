"""HQ answering Formplayer's own requests with its own views, over a unit's state.

While a worker uses an app in Web Apps, Formplayer asks HQ who the worker
is, for the app's archive, for the worker's restore, to take a submission,
to run a case search and to claim a case, each at the URL Formplayer or the
app itself names. ``HqViews`` answers every one the way HQ's own server
does: the request is built from the bytes Formplayer sent, handed to
Django's handler loaded with HQ's own middleware (``settings.MIDDLEWARE``:
the session and its user, ``OpenRosaMiddleware``, ``SyncTokenMiddleware``,
``UsersMiddleware``, the audit and the rest), resolved by HQ's URLconf, and
answered by the view that URL names, decorators and all, over the unit's
state. So HQ's own authentication reads the Django session Formplayer
forwards and the digest it signs with, HQ's restore is HQ's restore of the
cases HQ holds, a submission goes through HQ's receiver whole
(``SubmissionPost.run``: its locks, its case processing, its saves and what
it does once they commit), and a claim makes the case HQ makes.

What HQ needs for that, each made with HQ's own code by ``serve``:

- **the worker**: ``CommCareUser.create``, with the id and the user data
  the document's case database gives its worker, so HQ's own save signals
  run (its user case, where the project has them), after the project
  space's default roles, which HQ makes with a project space;
- **the worker's cases**: each case of the document's case database
  (``proof.observe.casedata``) written as a case block and submitted
  through HQ's own receiver as the worker
  (``hqcase/utils.py::submit_case_blocks``), a parent before its children;
- **a released build**: HQ's ``Application.make_build`` and the build's
  save, then HQ's own ``release_build`` view (``proof.webapps.hq``), whose
  id is the one Formplayer asks HQ's archive download for;
- **a signed-in worker**: the worker's username and password posted to
  their project space's sign-in page as their browser posts its form, and
  taken by HQ's own sign-in view (``sign_in``), which checks them and makes
  the session the browser then holds.

What the harness's HQ lacks is answered by a seam, each named where it is:

- **the lock service** is real: the Redis HQ and Formplayer share, as in
  production (``proof.hq.redis``: HQ admits a mobile endpoint's request by
  finding there the token Formplayer wrote for it), and the functions HQ
  runs when its transaction commits run where production's commit runs
  them (``proof.hq.branch.Unit.committing``);
- **Elasticsearch** is HQ's own, real (``proof.hq.elasticsearch``): a case
  search runs HQ's view whole down to HQ's own server, which applies the
  query HQ compiled to the cases HQ indexed as its receiver saved them
  (each case the worker's submissions made, through the case search
  pillow's own processor), held to each fork of the unit as Postgres is;
- **the order of a restore's cases** is HQ's database's, which HQ asks for
  no order of: the harness hands them in the order of their ids in every
  state (``cases_in_id_order``);
- **Nova's local archive** is not something HQ holds, so a request for an
  app id named in ``archives`` is answered with those bytes. Nothing else
  is answered from outside HQ.

Each request runs in a request of the unit keyed by its place in the run
(``begin``), so HQ draws the same ids for it on every run of the same
script, and inside the unit's ``committing`` block. A view that raises is
HQ's own answer to what Formplayer sent (a 500), recorded with what it
raised; a harness refusal propagates and ends the observation.

``Served.run()`` is one run of a walk: a fork of the unit, so no run sees
what another's submission left in HQ, with the worker signed in afresh
(HQ's sessions live in its cache, which a unit's restore empties).
"""

from __future__ import annotations

import hashlib
import json
import traceback
from contextlib import contextmanager
from dataclasses import dataclass, field
from email.parser import BytesParser
from email.policy import HTTP
from urllib.parse import parse_qs

from proof.formplayer.client import AUTH_KEY, FormplayerRunnerError, HqAnswer, HqRequest
from proof.observe import casedata

# Request headers that belong to Formplayer's connection with the harness's peer.
_TRANSPORT_HEADERS = {"host", "connection", "content-length", "accept-encoding", "transfer-encoding"}
# Django reads these two from the environment under their own names.
_UNPREFIXED = {"content-type": "CONTENT_TYPE", "content-length": "CONTENT_LENGTH"}
DOWNLOAD = "direct_ccz"
RECEIVERS = frozenset(
    {
        "receiver",
        "receiver_post",
        "receiver_secure",
        "receiver_secure_with_app_id",
        "receiver_post_with_app_id",
    }
)
SEARCHES = frozenset({"remote_search", "app_aware_remote_search"})
CLAIM = "claim_case"
RESTORE = "ota_restore"
PASSWORD = "proof-worker-password"


@dataclass(frozen=True)
class Submission:
    """One submission Formplayer sent HQ: the instance, and each file sent beside it by its part's name."""

    path: str
    instance: bytes
    files: tuple[tuple[str, bytes], ...]


@dataclass(frozen=True)
class Search:
    """One case search or claim Formplayer sent HQ: its parameters as HQ's view reads them, each key's values in
    order."""

    path: str
    params: tuple[tuple[str, tuple[str, ...]], ...]

    def values(self, key: str) -> tuple[str, ...]:
        return dict(self.params).get(key, ())


def multipart_parts(request: HqRequest) -> list[tuple[str, bytes]]:
    """The parts of a multipart body, each by its ``name``, read as an HTTP message's parts are."""
    content_type = request.header("Content-Type") or ""
    parsed = BytesParser(policy=HTTP).parsebytes(
        b"Content-Type: " + content_type.encode("latin-1") + b"\r\nMIME-Version: 1.0\r\n\r\n" + request.body
    )
    if not parsed.is_multipart():
        raise FormplayerRunnerError(
            f"Formplayer's submission to {request.path} is not a multipart body (Content-Type {content_type!r}).",
            kind="request",
        )
    return [
        (part.get_param("name", header="content-disposition"), part.get_payload(decode=True))
        for part in parsed.iter_parts()
    ]


class HqViewFailed(AssertionError):
    """HQ could not make what a Formplayer session needs of it (the worker, a case, the release)."""


def _handler():
    """Django's handler with HQ's own middleware (``settings.MIDDLEWARE``), loaded once per process."""
    if _HANDLER.get("handler") is None:
        from django.core.handlers.base import BaseHandler

        handler = BaseHandler()
        handler.load_middleware()
        _HANDLER["handler"] = handler
    return _HANDLER["handler"]


_HANDLER: dict = {}


def respond(request):
    """HQ's answer to a request Django's server hands it (``django_request``), from the handler with HQ's own
    middleware, with nothing of the request left on the thread after it. HQ's field audit middleware keeps the
    request it saw in a context variable it never resets (``field_audit/middleware.py::process_view``): a server's
    next request replaces it, and nothing of HQ runs between two. Here HQ's own code also runs outside any request
    (making a worker, a role, a release), and would record its changes as made by the last request's user, or
    raise where that request signed its user in, so the variable is put back as it was."""
    from field_audit.field_audit import request as audit_request

    held = audit_request.get()
    try:
        return _handler().get_response(request)
    finally:
        audit_request.set(held)


def django_request(request: HqRequest):
    """Formplayer's request as Django's server hands HQ one: its method, path, query, body and headers."""
    from django.test import RequestFactory

    extra = {}
    content_type = "application/octet-stream"
    for name, value in request.headers:
        key = name.lower()
        if key in _TRANSPORT_HEADERS:
            continue
        if key == "content-type":
            content_type = value
        elif key not in _UNPREFIXED:
            extra["HTTP_" + name.upper().replace("-", "_")] = value
    target = request.path + (f"?{request.query}" if request.query else "")
    # HQ is served over HTTPS (its cookies are secure, and it names itself by an https address).
    return RequestFactory().generic(
        request.method, target, data=request.body, content_type=content_type, secure=True, **extra
    )


@contextmanager
def _language_put_back():
    """The thread's active language as it was before the block. Django's ``LocaleMiddleware`` activates each
    request's language for its thread and leaves it active, which a server's next request replaces; here the
    next thing the thread renders may be a page HQ answers with no middleware (``proof.editors.hq``), which
    must not inherit a language Formplayer's request chose."""
    from django.utils import translation
    from django.utils.translation import trans_real

    held = getattr(trans_real._active, "value", None)
    try:
        yield
    finally:
        if held is None:
            translation.deactivate()
        else:
            trans_real._active.value = held


@contextmanager
def _raised_by_views(found: list):
    """What HQ's views raised while the block ran: Django's handler answers an exception with a 500 and sends
    ``got_request_exception``, which is where the exception is still to be had."""
    import sys

    from django.core.signals import got_request_exception

    def keep(sender, request=None, **kwargs):
        found.append(sys.exc_info())

    got_request_exception.connect(keep, weak=False)
    try:
        yield found
    finally:
        got_request_exception.disconnect(keep)


class _Errors:
    """Every error HQ logged while a block ran (HQ catches some of what it raises, logs it and answers on)."""

    def __init__(self):
        import logging

        self.found: list[str] = []
        outer = self

        class Handler(logging.Handler):
            def emit(self, record):
                try:
                    text = record.getMessage()
                    if record.exc_info:
                        text += "\n" + "".join(traceback.format_exception(*record.exc_info))[-5000:]
                except Exception as error:  # noqa: BLE001 - a record that cannot be written is still an error
                    text = f"{record.msg!r} ({error})"
                outer.found.append(f"{record.name}: {text}")

        self.handler = Handler(level=logging.ERROR)

    def __enter__(self):
        import logging

        logging.getLogger().addHandler(self.handler)
        return self

    def __exit__(self, *_exc):
        import logging

        logging.getLogger().removeHandler(self.handler)


@dataclass
class Asked:
    """One request Formplayer made of HQ and how HQ answered it."""

    method: str
    path: str
    url_name: str | None
    status: int
    # The class of what HQ's view raised (a 500), with the end of its traceback.
    raised: str | None = None
    error: str | None = None
    wrote: bool = False
    # What HQ said where it did not answer 2xx (the start of its body).
    refusal: str | None = None
    # Each error HQ logged answering it.
    logged: list = field(default_factory=list)


@dataclass
class HqViews:
    """HQ, as Formplayer reaches it: every request answered by HQ's own views over ``unit``."""

    unit: object
    username: str
    # Archives HQ does not hold (Nova's local export), by the app id Formplayer is given for each.
    archives: dict = field(default_factory=dict)
    # The Django session the worker's browser holds, set by ``begin``.
    session_key: str | None = None
    key: str = AUTH_KEY
    # What Formplayer asked, in order: (what, detail), as ``proof.formplayer.walk`` records it.
    asked: list = field(default_factory=list)
    exchanges: list = field(default_factory=list)
    submissions: list = field(default_factory=list)
    searches: list = field(default_factory=list)
    claims: list = field(default_factory=list)
    # Each restore HQ answered, whole: the ids it holds are the app's and HQ's, never Formplayer's.
    restores: list = field(default_factory=list)
    # Every soft assertion HQ noted answering, with the request's label (its place in the run).
    noted: list = field(default_factory=list)
    _run: bytes = b""
    _ordinal: int = 0

    @property
    def domain(self) -> str:
        return self.unit.domain

    def begin(self, run: bytes, session_key: str | None) -> None:
        """A run starts: its requests are numbered from one under ``run``, and the worker's session is this one."""
        self._run, self._ordinal, self.session_key = run, 0, session_key

    def __call__(self, request: HqRequest) -> HqAnswer:
        from django.urls import Resolver404, resolve

        try:
            match = resolve(request.path)
            url_name = match.url_name
        except Resolver404:
            url_name = None
        if url_name == DOWNLOAD and request.method == "GET":
            app_id = (parse_qs(request.query).get("app_id") or [""])[0]
            if app_id in self.archives:
                self.exchanges.append(Asked(request.method, request.path, "named-archive", 200))
                return HqAnswer(200, self.archives[app_id], (("Content-Type", "application/zip"),))
        answer, asked = self._answered(request, url_name)
        self.exchanges.append(asked)
        if url_name != DOWNLOAD:
            # Whether Formplayer asks for an archive again depends on what the same Formplayer process installed
            # before, so a walk's record of what a step asked HQ leaves the download out (``exchanges`` keeps it).
            self.asked.append((url_name or "unresolved", str(answer.status)))
        self._kept(request, url_name)
        if url_name == RESTORE and answer.status == 200:
            self.restores.append(answer.body)
        return answer

    def _answered(self, request: HqRequest, url_name):
        from django.test import override_settings

        self._ordinal += 1
        digest = hashlib.sha256(
            b"formplayer|" + self._run + f"|{self._ordinal}|{request.method}|{request.path}".encode()
        ).digest()
        raised: list = []
        asked = Asked(request.method, request.path, url_name, 0)
        # HQ and Formplayer share one key (``FORMPLAYER_INTERNAL_AUTH_KEY``, Formplayer's
        # ``commcarehq.formplayerAuthKey``); HQ checks Formplayer's digests with it.
        with (
            override_settings(FORMPLAYER_INTERNAL_AUTH_KEY=self.key),
            self.unit.committing(),
            self.unit.request(digest) as scope,
            cases_in_id_order(),
            _raised_by_views(raised),
            _Errors() as errors,
            _language_put_back(),
        ):
            response = respond(django_request(request))
            if hasattr(response, "render") and not getattr(response, "is_rendered", True):
                response.render()
            body = b"".join(response.streaming_content) if response.streaming else response.content
        asked.status, asked.wrote, asked.logged = response.status_code, bool(scope.wrote), errors.found
        if response.status_code >= 400:
            asked.refusal = body[:800].decode("utf-8", "replace")
        if scope.soft_assertions:
            self.noted.append((f"{self._run.decode('utf-8', 'replace')}#{self._ordinal}", list(scope.soft_assertions)))
        if raised:
            kind, error, trace = raised[-1]
            asked.raised = f"{kind.__module__}.{kind.__qualname__}"
            asked.error = "".join(traceback.format_exception(kind, error, trace))[-6000:]
        headers = [(name, value) for name, value in response.items()]
        headers += [("Set-Cookie", morsel.OutputString()) for morsel in response.cookies.values()]
        return HqAnswer(response.status_code, body, tuple(headers)), asked

    def _kept(self, request: HqRequest, url_name) -> None:
        """What a walk records of a request beside HQ's answer: a submission's instance, a search's parameters."""
        if request.method != "POST":
            return
        if url_name in RECEIVERS:
            parts = multipart_parts(request)
            instances = [content for name, content in parts if name == "xml_submission_file"]
            self.submissions.append(
                Submission(
                    path=request.path,
                    instance=instances[0] if instances else b"",
                    files=tuple((name, content) for name, content in parts if name != "xml_submission_file"),
                )
            )
        elif url_name in SEARCHES or url_name == CLAIM:
            read = parse_qs(request.body.decode("utf-8"), keep_blank_values=True)
            kept = Search(path=request.path, params=tuple((key, tuple(values)) for key, values in sorted(read.items())))
            (self.claims if url_name == CLAIM else self.searches).append(kept)

    def failures(self) -> list:
        """Every request an HQ view raised on."""
        return [asked for asked in self.exchanges if asked.raised]


# The order of a restore's cases ---------------------------------------------------------------


@contextmanager
def cases_in_id_order():
    """HQ's reads of cases by their ids, for the block, in the order of the ids' text wherever HQ asks for no
    order.

    HQ's restore reads a worker's cases in batches with no order of its own
    (``phone/data_providers/case/livequery.py::batch_cases``, through
    ``CommCareCaseManager.get_cases``), so the order a restore lists them in
    is the order Postgres happens to hand the rows back in: where each row
    sits in the table, which depends on what was written and rolled back
    before and on when Postgres's own vacuum last ran. Core keeps cases in
    the order a restore lists them, and an unsorted list shows them in it.
    Every order is one HQ may give; the harness gives the same one in every
    state, so that two states' lists differ in their order only where the
    app orders them differently.
    """
    from unittest import mock

    from corehq.form_processor.models.cases import CommCareCaseManager

    held = CommCareCaseManager.get_cases

    def get_cases(self, case_ids, ordered=False, prefetched_indices=None):
        cases = held(self, case_ids, ordered=ordered, prefetched_indices=prefetched_indices)
        if not ordered:
            cases.sort(key=lambda case: case.case_id)
        return cases

    with mock.patch.object(CommCareCaseManager, "get_cases", get_cases):
        yield


# What HQ holds for a session -------------------------------------------------------------------


def worker_username(domain: str) -> str:
    """The lane's worker's full username, as HQ names a mobile worker of ``domain``."""
    from corehq.apps.users.util import format_username

    return format_username(casedata.USERNAME, domain)


def default_roles(unit):
    """The project space's default roles, as HQ makes them when a project space is made
    (``registration/utils.py::request_new_domain`` calls ``initialize_domain_with_default_roles``): a mobile
    worker is given the default mobile worker role among them. The unit's project space is seeded as a document
    (``proof.hq.state``), so they are made here, once, where the first worker is."""
    from corehq.apps.users.models_role import UserRole
    from corehq.apps.users.role_utils import initialize_domain_with_default_roles

    if not UserRole.objects.filter(domain=unit.domain).exists():
        initialize_domain_with_default_roles(unit.domain)


def create_worker(unit, database):
    """The document's worker as HQ makes a mobile worker (``CommCareUser.create``), under the id the case
    database gives them, with its user data."""
    from corehq.apps.users.models import CommCareUser

    return CommCareUser.create(
        unit.domain,
        worker_username(unit.domain),
        PASSWORD,
        created_by=None,
        created_via=None,
        uuid=database.user_id,
        user_data=dict(database.user_data),
    )


def case_block(case, database):
    """One case of the case database as the case block that makes it."""
    from xml.etree import ElementTree

    from casexml.apps.case.mock import CaseBlock, IndexAttrs

    block = CaseBlock(
        case_id=case.case_id,
        create=True,
        case_type=case.case_type,
        case_name=case.name,
        owner_id=case.owner_id,
        user_id=database.user_id,
        external_id=case.external_id,
        date_opened=casedata._datetime(case.opened_on),
        date_modified=casedata._datetime(case.modified_on),
        update=dict(case.properties),
        index={
            identifier: IndexAttrs(referenced_type, referenced_id, relationship)
            for identifier, referenced_type, referenced_id, relationship in case.indices
        },
    )
    return ElementTree.tostring(block.as_xml(), encoding="unicode")


def save_cases(unit, database, worker):
    """Each case of the case database, submitted through HQ's own receiver as the worker, in the database's
    order (a parent before its children), one submission a case."""
    from corehq.apps.hqcase.utils import submit_case_blocks

    for case in database.cases:
        if case.case_id == casedata.USERCASE_ID:
            # The worker's user case is HQ's to make, and HQ made it when it saved the worker, where the project
            # has user cases (``callcenter/sync_usercase.py::sync_usercases``).
            continue
        submit_case_blocks(
            [case_block(case, database)],
            unit.domain,
            username=worker.username,
            user_id=database.user_id,
            device_id="proof-case-database",
        )


# Where a person's browser has HQ's page open: HQ's own origin, as the requests built here reach it (Django's request
# factory names the host ``testserver``), which HQ's CSRF check holds a form's Referer to.
PAGE_ORIGIN = "https://testserver"


class SignInRefused(AssertionError):
    """HQ's sign-in view did not sign a person in with their username and password."""


@dataclass(frozen=True)
class SignedIn:
    """What a person's browser holds once HQ's sign-in view has signed them in: the session cookie HQ set, and the
    CSRF token HQ set as it signed them in, which a page's form posts back."""

    session: str
    csrf: str

    @property
    def cookie(self) -> str:
        """The ``Cookie`` header the browser sends HQ with both."""
        from django.conf import settings

        return f"{settings.SESSION_COOKIE_NAME}={self.session}; {settings.CSRF_COOKIE_NAME}={self.csrf}"


def sign_in(unit, user, password: str, label: str) -> SignedIn:
    """``user`` signed in through HQ's own sign-in form, as their browser signs them in, and what the browser holds
    then.

    The form is posted to the view HQ's URLconf names for the page, behind HQ's own middleware: a mobile worker
    signs in on their project space's page (``hqwebapp/views.py::domain_login``) with the name they were given,
    which the view completes with the project space's, and a web user on HQ's own (``login``) with their email
    address. Each page is a ``two_factor`` sign-in wizard whose first step is HQ's authentication form
    (``CloudCareAuthenticationForm``, ``EmailAuthenticationForm``), so what the browser posts is the page's CSRF
    token, the wizard's step and the person's username and password, each under the name the view reads it by
    (the wizard's own prefix, the step's). HQ's form checks the password and the person's lockout, the wizard
    asks for any second factor the person holds, and the view signs them in with Django's ``login`` and
    redirects; the browser then holds the session cookie and the rotated CSRF token HQ's answer set. The page's
    own drawing is not run (its template names a script only a deployment's whole bundle holds,
    ``hq_shared_tags.py::webpack_bundles``), so the CSRF cookie the page would have set is drawn here. It runs in
    a request of the unit keyed by ``label`` and the person, so HQ draws the same session every time. A view that
    does not answer with the redirect it gives a person it signed in raises ``SignInRefused``.
    """
    from urllib.parse import urlencode

    from corehq.apps.hqwebapp.views import CloudCareLoginView, HQLoginView
    from corehq.apps.users.util import raw_username
    from django.conf import settings
    from django.middleware.csrf import _get_new_csrf_string
    from django.urls import reverse

    if user.is_commcare_user():
        path, view, typed = reverse("domain_login", args=[user.domain]), CloudCareLoginView, raw_username(user.username)
    else:
        path, view, typed = reverse("login"), HQLoginView, user.username
    step = view.AUTH_STEP
    digest = hashlib.sha256(f"sign-in|{label}|{user.username}".encode()).digest()
    raised: list = []
    with unit.committing(), unit.request(digest), _raised_by_views(raised), _language_put_back():
        token = _get_new_csrf_string()
        body = urlencode(
            [
                ("csrfmiddlewaretoken", token),
                (f"{view().get_prefix(None)}-current_step", step),
                (f"{step}-username", typed),
                (f"{step}-password", password),
            ]
        ).encode()
        headers = (
            ("Content-Type", "application/x-www-form-urlencoded"),
            ("Cookie", f"{settings.CSRF_COOKIE_NAME}={token}"),
            ("Referer", f"{PAGE_ORIGIN}{path}"),
        )
        response = respond(django_request(HqRequest("POST", path, "", headers, body)))
        if hasattr(response, "render") and not getattr(response, "is_rendered", True):
            response.render()
        content = b"".join(response.streaming_content) if response.streaming else response.content
    session = response.cookies.get(settings.SESSION_COOKIE_NAME)
    if response.status_code != 302 or session is None or not session.value:
        cause = "".join(traceback.format_exception(*raised[-1]))[-3000:] if raised else content[:1500]
        raise SignInRefused(
            f"HQ's sign-in page {path} answered {user.username}'s username and password with"
            f" {response.status_code}{'' if session is not None else ' and no session'}, where it signs a person in"
            f" with a redirect and a session cookie; it answered: {cause!r}"
        )
    csrf = response.cookies.get(settings.CSRF_COOKIE_NAME)
    return SignedIn(session.value, csrf.value if csrf is not None and csrf.value else token)


@dataclass
class Served:
    """One state of an app as HQ serves it to Formplayer: the worker, their cases, a released build."""

    unit: object
    operation: object
    worker: object
    app_id: str
    build_id: str
    version: int
    hq: HqViews
    # The released build's document, as HQ's app list reads it.
    doc: dict
    # The Formplayer runner the session is served to (its Redis is HQ's too), or None.
    runner: object = None
    # The id of the user case HQ made for the worker, which HQ draws afresh for each worker it makes; None
    # where the project space has no user cases.
    usercase_id: str | None = None
    # Where the project space forwards what it receives (``proof.observe.connect.Forwarder``): told as each
    # run begins and ends, inside the run's fork; None where it forwards nowhere.
    forwarding: object = None
    _runs: int = 0
    _archive: bytes | None = None

    def archive(self) -> bytes:
        """The released build as HQ's archive download serves it (``hqmedia/views.py::iter_index_files``),
        zipped."""
        from proof.hq import operations
        from proof.webapps import hq as webapps_hq

        if self._archive is None:
            self._archive = webapps_hq._archive(operations.held_app(self.unit, self.build_id))
        return self._archive

    @property
    def acting(self):
        """Who a page request is answered for (``proof.hq.requests``): the project space and the worker."""
        from proof.webapps.hq import Worker

        return Worker(self.unit.domain, self.worker)

    @property
    def release(self):
        return self

    @property
    def languages(self) -> list[str]:
        """The languages the released app holds, its default first (``langs``, which HQ's Web Apps page hands
        the client and from which it takes a worker's first language)."""
        return [str(language) for language in self.doc.get("langs") or []]

    @property
    def domain(self) -> str:
        return self.unit.domain

    @property
    def username(self) -> str:
        return self.worker.username

    @contextmanager
    def run(self, name: str | None = None):
        """One run of a walk, in a fork of the unit, the worker signed in: nothing a run's submission left in HQ
        is there for the next."""
        from proof.hq import redis as hq_redis

        self._runs += 1
        label = (name or f"run-{self._runs}").encode()
        with self.unit.fork():
            _redis_of(self.runner)
            hq_redis.flush()
            signed_in = sign_in(self.unit, self.worker, PASSWORD, f"formplayer:{label.decode('utf-8', 'replace')}")
            self.hq.begin(label, signed_in.session)
            forwarding = self.forwarding
            if forwarding is not None:
                forwarding.begin(label)
            try:
                yield self
                if forwarding is not None:
                    forwarding.end(label)
            finally:
                self.hq.begin(b"", None)


def _released(unit, app, app_id):
    """The app built and released as HQ's Releases page does it (``proof.webapps.hq``); ``ReleaseRefused`` where
    HQ makes no build of it, whatever HQ raised making one: a build HQ's own ``make_build`` raises on is one HQ
    never releases, and no worker is served it."""
    from proof.hq import operations
    from proof.webapps import hq as webapps_hq

    try:
        build = webapps_hq._make_build(unit, app)
        # HQ's release view also starts the task that builds each build profile's files
        # (``views/releases.py::release_build``, ``tasks.py::create_build_files_for_all_app_profiles``). The
        # harness's Celery runs it inline with its errors propagated, so a profile HQ cannot build (defect 1's
        # language codes, which the bar reports) ends the release here, where production's release would stand
        # and the task fail behind it.
        webapps_hq._release(unit, app_id, build._id)
    except webapps_hq.ReleaseRefused:
        raise
    except Exception as error:
        refused = webapps_hq.ReleaseRefused(f"HQ's release raised {type(error).__name__}: {error}")
        refused.raised = f"{type(error).__module__}.{type(error).__qualname__}"
        raise refused from error
    return operations.held_app(unit, build._id)


@contextmanager
def _drawn_for(people: bytes):
    """HQ's entropy and clock for the block drawn from the case database's own digest, not from the state the
    unit is in. The worker and their cases are the same in every state a document is served in, so the ids HQ
    draws making them (the worker's user case, each case's form) are the same in every state too, and HQ's
    restores of two states list the same cases in the same order: what two states' walks differ in is then the
    app's, never the order HQ happened to hand a worker their cases in."""
    from proof.hq import determinism

    with determinism.operation(hashlib.sha256(b"formplayer-worker|" + people).digest(), 1):
        yield


def _redis_of(runner):
    """HQ's Redis: the Formplayer runner's own, which the two share in production, or one of HQ's own where no
    runner is given."""
    from proof.hq import redis as hq_redis

    address = None if runner is None else runner.redis_address
    return hq_redis.adopt(address) if address is not None else hq_redis.start()


@contextmanager
def serve(
    unit,
    document,
    app_id,
    *,
    runner=None,
    operation=None,
    label="A",
    previous=None,
    change=None,
    archives=None,
    edit=False,
    database=None,
):
    """The app the unit holds, as HQ serves it to a Formplayer session, inside a fork that puts the unit back.

    The worker and their cases are made, the app is built and released as
    HQ's Releases page releases one (after ``change`` rewrote its stored
    document, for a state no page makes: B aligned to A), each in an
    operation of the unit, with ``previous`` as the build HQ compares form
    versions with. ``archives`` are archives HQ does not hold (Nova's local
    export) by the app id Formplayer is given for each. The worker's cases
    are the document's case database (``proof.observe.casedata``), or
    ``database`` where a test names the cases it turns on.
    """
    from proof.hq import operations
    from proof.hq import redis as hq_redis
    from proof.hq.seams import build_seams

    operation = operation or unit.operation
    database = database or casedata.document_case_database(document, edit=edit)
    with hq_redis.shared(None if runner is None else runner.redis_address), unit.fork():
        hq_redis.flush()
        with unit.committing():
            people = casedata.database_digest(database).encode()
            with operation(f"formplayer:worker@{label}", people), _drawn_for(people):
                default_roles(unit)
                worker = create_worker(unit, database)
                save_cases(unit, database, worker)
                usercase_id = worker.get_usercase_id()
                # The worker and their cases indexed as HQ's pillows index them, under the same entropy and clock
                # in every state (``proof.hq.elasticsearch``).
                if unit.indexes is not None:
                    unit.indexes.settle()
            stored = operations.held_app(unit, app_id).to_json()
            if change is not None:
                change(stored)
            content = hashlib.sha256(json.dumps(stored, sort_keys=True, default=str).encode()).hexdigest()
            with operation(f"formplayer:release@{label}", content.encode()), build_seams(previous=previous):
                app = operations.held_app(unit, app_id)
                if change is not None:
                    # The state's own version: the build the lane's other checks read is built at it
                    # (``Application.save`` would count this rewrite as a person's save and raise it).
                    type(app).wrap(stored).save(increment_version=False)
                    app = operations.held_app(unit, app_id)
                build = _released(unit, app, app_id)
        hq = HqViews(unit, worker.username, archives=dict(archives or {}))
        yield Served(
            unit, operation, worker, app_id, build._id, build.version, hq, build.to_json(), runner, usercase_id
        )
