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
  run (its user case, where the project has them);
- **the worker's cases**: each case of the document's case database
  (``proof.observe.casedata``) written as a case block and submitted
  through HQ's own receiver as the worker
  (``hqcase/utils.py::submit_case_blocks``), a parent before its children;
- **a released build**: HQ's ``Application.make_build`` and the build's
  save, then HQ's own ``release_build`` view (``proof.webapps.hq``), whose
  id is the one Formplayer asks HQ's archive download for;
- **a signed-in worker**: a Django session made by Django's own ``login``,
  the call HQ's sign-in view ends in once it has accepted a password. The
  sign-in form itself (the password, a second factor) is not run; this is
  the one thing here a person does that the harness does for them.

What the harness's HQ lacks is answered by a seam, each named where it is:

- **the lock service** is real: the Redis HQ and Formplayer share, as in
  production (``proof.hq.redis``: HQ admits a mobile endpoint's request by
  finding there the token Formplayer wrote for it), and the functions HQ
  runs when its transaction commits run where production's commit runs
  them (``proof.hq.branch.Unit.committing``);
- **Elasticsearch** is not in the image. A case search runs HQ's view
  whole (its authentication, its reading of the request, its compile of
  the query into HQ's own Elasticsearch query, its fixture of the results)
  down to the transport, where ``search_index`` answers the one search
  request with every case of the requested types the unit's Postgres
  holds, each as HQ's own case search document
  (``es/case_search.py::ElasticCaseSearch.from_python``). The
  query's filter is compiled and not applied: what a filter selects is not
  observed here. A document HQ writes to an index as it saves (the user)
  is taken and kept nowhere, since nothing here reads one back; the forms
  and cases HQ processes reach their indexes through the change feed its
  pillows read, which the unit records (``index``);
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
from urllib.parse import parse_qs

from proof.formplayer.answers import Search, Submission, multipart_parts
from proof.formplayer.client import AUTH_KEY, HqAnswer, HqRequest
from proof.hq.boot import HarnessRefusal
from proof.observe import casedata

# Request headers that belong to Formplayer's connection with the harness's peer.
_TRANSPORT_HEADERS = {"host", "connection", "content-length", "accept-encoding", "transfer-encoding"}
# Django reads these two from the environment under their own names.
_UNPREFIXED = {"content-type": "CONTENT_TYPE", "content-length": "CONTENT_LENGTH"}
DOWNLOAD = "direct_ccz"
RECEIVERS = frozenset({"receiver", "receiver_secure", "receiver_secure_with_app_id", "receiver_post_with_app_id"})
SEARCHES = frozenset({"remote_search", "app_aware_remote_search"})
CLAIM = "claim_case"
PASSWORD = "proof-worker-password"


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
                self.asked.append(("archive", "named"))
                self.exchanges.append(Asked(request.method, request.path, "named-archive", 200))
                return HqAnswer(200, self.archives[app_id], (("Content-Type", "application/zip"),))
        answer, asked = self._answered(request, url_name)
        self.exchanges.append(asked)
        self.asked.append((url_name or "unresolved", str(answer.status)))
        self._kept(request, url_name)
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
            index(self.unit),
            _raised_by_views(raised),
            _Errors() as errors,
        ):
            response = _handler().get_response(django_request(request))
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


# Elasticsearch -----------------------------------------------------------------------------


class SeamFailed(HarnessRefusal):
    """The harness's own answer for something HQ lacks failed; never HQ's failure."""


def _case_search_hits(unit, body):
    """Every case of the case types a case search's query names that the unit's Postgres holds, each as HQ's
    own case search document (``es/case_search.py::ElasticCaseSearch.from_python``), in case id order."""
    from corehq.apps.es.case_search import case_search_adapter
    from corehq.form_processor.models import CommCareCase

    try:
        wanted = sorted(_terms_of(body, "type.exact") | _terms_of(body, "type"))
        case_ids = []
        for case_type in wanted:
            case_ids += CommCareCase.objects.get_case_ids_in_domain(unit.domain, case_type)
        hits = []
        for case in CommCareCase.objects.get_cases(sorted(set(case_ids)), unit.domain):
            if case.is_deleted:
                continue
            doc_id, source = case_search_adapter.from_python(case)
            hits.append({"_type": case_search_adapter.type, "_id": doc_id, "_score": 1.0, "_source": source})
        return hits
    except Exception as error:
        raise SeamFailed(
            f"The harness's answer to HQ's case search ({json.dumps(body, default=str)[:600]}) failed:"
            f" {type(error).__name__}: {error}"
        ) from error


def _terms_of(value, field_name):
    """Every value a ``term`` or ``terms`` clause of an Elasticsearch query gives ``field_name``."""
    found = set()
    if isinstance(value, dict):
        for key, held in value.items():
            if key in ("term", "terms") and isinstance(held, dict) and field_name in held:
                named = held[field_name]
                found |= set(named) if isinstance(named, list) else {named}
            else:
                found |= _terms_of(held, field_name)
    elif isinstance(value, list):
        for item in value:
            found |= _terms_of(item, field_name)
    return found


# The requests by which HQ writes one document to an index (``es/client.py::ElasticDocumentAdapter._index``,
# ``_update`` and ``_delete``): PUT or POST ``/<index>/<type>/<id>``, POST ``.../<id>/_update``, DELETE.
_WRITE_METHODS = frozenset({"PUT", "POST", "DELETE"})


def _document_write(method, url):
    """``(index, id)`` where the request writes one document of an index, else None."""
    parts = [part for part in str(url).split("?")[0].split("/") if part]
    if method not in _WRITE_METHODS or len(parts) < 3 or parts[0].startswith("_"):
        return None
    if len(parts) == 3 and not parts[2].startswith("_"):
        return parts[0], parts[2]
    if len(parts) == 4 and parts[3] == "_update" and method == "POST":
        return parts[0], parts[2]
    return None


@contextmanager
def index(unit):
    """Elasticsearch, for the block, as far as serving Formplayer reaches it: a case search answered with every
    case of the requested types, and each document HQ writes to an index taken and kept nowhere.

    HQ's search view builds its query with its own compiler and sends it to
    the case search index (``case_search/utils.py::get_case_search_results``,
    ``es/case_search.py::CaseSearchES``). The harness has no Elasticsearch,
    so the one request the search itself makes (a ``_search`` of the case
    search index) is answered here with every case of the case types the
    query names, written as HQ's own pillow writes a case for that index;
    the filter HQ compiled is not applied.

    HQ also writes to its indexes as it saves: a user's save sends the user
    (``users/signals.py::update_user_in_es``). No path here reads such a
    document back from the index (the case search's cases come from
    Postgres, above), so each write is answered as Elasticsearch answers one
    it took, and recorded with the seams' Elasticsearch reads. Any other
    request to Elasticsearch is still refused (``proof.hq.elasticsearch``).
    """
    from unittest import mock

    from corehq.apps.es.case_search import case_search_adapter
    from elasticsearch6.transport import Transport

    held = Transport.perform_request
    # The index HQ's case search reads, by the name HQ's own adapter gives it.
    case_search = case_search_adapter.index_name

    def perform_request(self, method, url, headers=None, params=None, body=None):
        named = url.strip("/").split("/")[0] if isinstance(url, str) else ""
        if str(url).split("?")[0].rstrip("/").endswith("/_search") and named == case_search:
            query = body if isinstance(body, dict) else json.loads(body or "{}")
            hits = _case_search_hits(unit, query)
            start = int(query.get("from") or 0)
            size = query.get("size")
            page = [
                {"_index": case_search, **hit}
                for hit in (hits[start : start + int(size)] if size is not None else hits[start:])
            ]
            if unit.record is not None:
                unit.record.elasticsearch_reads.append(("case_search", unit.domain, len(hits)))
            return {
                "took": 1,
                "timed_out": False,
                "_shards": {"total": 1, "successful": 1, "skipped": 0, "failed": 0},
                "hits": {"total": len(hits), "max_score": 1.0 if hits else None, "hits": page},
            }
        written = _document_write(method, url)
        if written is not None:
            if unit.record is not None:
                unit.record.elasticsearch_reads.append(("write", method, *written))
            return {
                "_index": written[0],
                "_type": "_doc",
                "_id": written[1],
                "_version": 1,
                "result": "deleted" if method == "DELETE" else "created",
                "_shards": {"total": 1, "successful": 1, "failed": 0},
                "_seq_no": 0,
                "_primary_term": 1,
            }
        return held(self, method, url, headers=headers, params=params, body=body)

    with mock.patch.object(Transport, "perform_request", perform_request):
        yield


# What HQ holds for a session -------------------------------------------------------------------


def worker_username(domain: str) -> str:
    """The lane's worker's full username, as HQ names a mobile worker of ``domain``."""
    from corehq.apps.users.util import format_username

    return format_username(casedata.USERNAME, domain)


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
        submit_case_blocks(
            [case_block(case, database)],
            unit.domain,
            username=worker.username,
            user_id=database.user_id,
            device_id="proof-case-database",
        )


def sign_in(user) -> str:
    """A Django session for ``user``, made by Django's own ``login``; its key, which the browser's cookie holds."""
    from django.conf import settings
    from django.contrib.auth import login
    from django.contrib.sessions.backends.cache import SessionStore
    from django.http import HttpRequest

    request = HttpRequest()
    request.META = {"SERVER_NAME": settings.BASE_ADDRESS.split(":")[0], "SERVER_PORT": "443"}
    request.session = SessionStore()
    login(request, user.get_django_user(), backend=settings.AUTHENTICATION_BACKENDS[0])
    request.session.save()
    return request.session.session_key


@dataclass
class Served:
    """One state of an app as HQ serves it to Formplayer: the worker, their cases, a released build."""

    unit: object
    operation: object
    worker: object
    build_id: str
    version: int
    hq: HqViews
    # The released build's document, as HQ's app list reads it.
    doc: dict
    # The Formplayer runner the session is served to (its Redis is HQ's too), or None.
    runner: object = None
    _runs: int = 0

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
            with self.unit.committing(), index(self.unit), self.operation("formplayer:sign-in", label):
                session_key = sign_in(self.worker)
            self.hq.begin(label, session_key)
            try:
                yield self
            finally:
                self.hq.begin(b"", None)


def _redis_of(runner):
    """HQ's Redis: the Formplayer runner's own, which the two share in production, or one of HQ's own where no
    runner is given."""
    from proof.hq import redis as hq_redis

    address = None if runner is None else runner.redis_address
    return hq_redis.adopt(address) if address is not None else hq_redis.start()


@contextmanager
def serve(
    unit, document, app_id, *, runner=None, operation=None, label="A", previous=None, change=None, archives=None, edit=False
):
    """The app the unit holds, as HQ serves it to a Formplayer session, inside a fork that puts the unit back.

    The worker and their cases are made, the app is built and released as
    HQ's Releases page releases one (after ``change`` rewrote its stored
    document, for a state no page makes: B aligned to A), each in an
    operation of the unit, with ``previous`` as the build HQ compares form
    versions with. ``archives`` are archives HQ does not hold (Nova's local
    export) by the app id Formplayer is given for each.
    """
    from proof.hq import operations
    from proof.hq import redis as hq_redis
    from proof.hq.seams import build_seams
    from proof.webapps import hq as webapps_hq

    operation = operation or unit.operation
    _redis_of(runner)
    database = casedata.document_case_database(document, edit=edit)
    with unit.fork():
        hq_redis.flush()
        with unit.committing(), index(unit):
            with operation(f"formplayer:worker@{label}", casedata.database_digest(database).encode()):
                worker = create_worker(unit, database)
                save_cases(unit, database, worker)
            stored = operations.held_app(unit, app_id).to_json()
            if change is not None:
                change(stored)
            content = hashlib.sha256(json.dumps(stored, sort_keys=True, default=str).encode()).hexdigest()
            with operation(f"formplayer:release@{label}", content.encode()), build_seams(previous=previous):
                app = operations.held_app(unit, app_id)
                if change is not None:
                    type(app).wrap(stored).save()
                    app = operations.held_app(unit, app_id)
                build = webapps_hq._make_build(unit, app)
                webapps_hq._release(unit, app_id, build._id)
                build = operations.held_app(unit, build._id)
        hq = HqViews(unit, worker.username, archives=dict(archives or {}))
        yield Served(unit, operation, worker, build._id, build.version, hq, build.to_json(), runner)
