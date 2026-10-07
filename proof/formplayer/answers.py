"""What HQ answers Formplayer's own requests with, for one app, one worker and one case database.

Formplayer asks HQ for six things while a worker uses an app, each at the URL
Formplayer or the app itself names, and ``HqAnswers`` answers exactly those
(``FormplayerRunner.http(hq=...)`` hands it each request the runner's peer
received). Anything else Formplayer asks is refused by name, never answered
empty, so a route the harness lacks ends the observation instead of shaping it:

- **the session's user** (``POST /hq/admin/session_details/``, Formplayer's
  ``HqUserDetailsService``): the body is checked against the digest Formplayer
  signed it with (``X-MAC-DIGEST``, the shared key), as HQ's
  ``formplayer_auth`` checks it, and answered with the fields HQ's
  ``SessionDetailsView.post`` answers: the worker, the project space, and the
  flags and previews the configuration turns on, which Formplayer reads as
  the session's authorities (``FeatureFlagChecker``);
- **the app's archive** (``GET /a/<domain>/apps/api/download_ccz/``,
  Formplayer's ``SessionUtils.getReferenceToLatest``): the bytes ``archives``
  holds for the request's ``app_id``;
- **the worker's restore** (``GET /a/<domain>/phone/restore/``,
  ``RestoreFactory.getUserRestoreUrl``): the restore bytes, whole on every
  ask (an HQ that holds no earlier sync of this device answers whole too);
- **a submission** (``POST`` to the URL the app's profile names,
  ``FormSubmissionHelper.processFormXml``): the instance Formplayer sends is
  kept (``submissions``) and handed to ``submit``, whose answer is HQ's;
- **a case search** (``POST`` to the URL the app's query names,
  ``CaseSearchHelper.getExternalRoot``): the form-encoded parameters are kept
  (``searches``) and handed to ``search``, whose answer is HQ's;
- **a case claim** (``POST`` to the URL the app's claim names,
  ``MenuSessionRunnerService.doPostAndSync``): kept (``claims``) and answered
  204, HQ's answer for a case the worker already holds (``ota/views.py::
  claim``), which is what every case of the lane's case database is.

Standard library only: the answers that need HQ's code (a search's results, a
submission's verdict) are the callables the caller gives.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import re
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from email.parser import BytesParser
from email.policy import HTTP
from urllib.parse import parse_qs

from proof.formplayer.client import AUTH_KEY, FormplayerRunnerError, HqAnswer, HqRequest

SESSION_DETAILS = "/hq/admin/session_details/"
DOWNLOAD = re.compile(r"^/a/(?P<domain>[^/]+)/apps/api/download_ccz/$")
RESTORE = re.compile(r"^/a/(?P<domain>[^/]+)/phone/restore/$")
RECEIVER = re.compile(r"^/a/(?P<domain>[^/]+)/receiver/(?:(?P<app>[^/]+)/)?$")
SEARCH = re.compile(r"^/a/(?P<domain>[^/]+)/phone/search/(?:(?P<app>[^/]+)/)?$")
CLAIM = re.compile(r"^/a/(?P<domain>[^/]+)/phone/claim-case/$")
# HQ's answer to a submission it processed (couchforms/openrosa_response.py::get_openarosa_success_response).
SUBMIT_SUCCESS = (
    '<OpenRosaResponse xmlns="http://openrosa.org/http/response">'
    '<message nature="submit_success">   √   </message></OpenRosaResponse>'
).encode()
# The permissions HQ's session details name for Formplayer (session_details_endpoint/views.py).
PERMISSIONS = ("edit_data",)


@dataclass(frozen=True)
class Submission:
    """One submission Formplayer sent HQ: the instance, and each file sent beside it by its part's name."""

    path: str
    instance: bytes
    files: tuple[tuple[str, bytes], ...]


@dataclass(frozen=True)
class Search:
    """One case search Formplayer sent HQ: its parameters as HQ's view reads them, each key's values in order."""

    path: str
    params: tuple[tuple[str, tuple[str, ...]], ...]

    def values(self, key: str) -> tuple[str, ...]:
        return dict(self.params).get(key, ())


def accept_submission(_submission: Submission) -> HqAnswer:
    return HqAnswer(201, SUBMIT_SUCCESS, (("Content-Type", "text/xml; charset=utf-8"),))


def refuse_search(search: Search) -> HqAnswer:
    raise FormplayerRunnerError(
        f"Formplayer sent HQ a case search ({search.path}), and these answers were given no `search` to answer it"
        " with. Give HqAnswers the callable that makes HQ's results.",
        kind="request",
    )


def digest(key: str, data: bytes) -> str:
    """The digest HQ and Formplayer sign a body with (HQ's ``util/hmac_request.py::get_hmac_digest``)."""
    return base64.b64encode(hmac.new(key.encode("utf-8"), data, hashlib.sha256).digest()).decode("ascii")


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


@dataclass
class HqAnswers:
    """HQ, as Formplayer sees it, for one worker of one project space."""

    domain: str
    username: str
    archives: Mapping[str, bytes]
    restore: bytes
    toggles: tuple[str, ...] = ()
    previews: tuple[str, ...] = ()
    search: Callable[[Search], HqAnswer] = refuse_search
    submit: Callable[[Submission], HqAnswer] = accept_submission
    key: str = AUTH_KEY
    # What Formplayer asked, in order: (what, detail).
    asked: list[tuple[str, str]] = field(default_factory=list)
    submissions: list[Submission] = field(default_factory=list)
    searches: list[Search] = field(default_factory=list)
    claims: list[Search] = field(default_factory=list)

    def __call__(self, request: HqRequest) -> HqAnswer:
        if request.method == "POST" and request.path == SESSION_DETAILS:
            return self._session_details(request)
        for method, pattern, answer in (
            ("GET", DOWNLOAD, self._archive),
            ("GET", RESTORE, self._restore),
            ("POST", RECEIVER, self._submission),
            ("POST", SEARCH, self._search),
            ("POST", CLAIM, self._claim),
        ):
            match = pattern.match(request.path)
            if match is not None and request.method == method:
                if match["domain"] != self.domain:
                    break
                return answer(request)
        raise FormplayerRunnerError(
            f"Formplayer asked HQ for {request.method} {request.path}?{request.query} (project space"
            f" {self.domain}), which the harness's HQ answers do not answer. They answer the session's user, the"
            " app's archive, the restore, a submission, a case search and a case claim"
            " (proof/formplayer/answers.py); add the route with HQ's own answer for it.",
            kind="request",
        )

    def _session_details(self, request: HqRequest) -> HqAnswer:
        signed = request.header("X-MAC-DIGEST")
        if signed != digest(self.key, request.body):
            raise FormplayerRunnerError(
                "Formplayer's session-details request is not signed with the key the harness started it with"
                f" (X-MAC-DIGEST {signed!r}), so HQ would refuse it (domain/auth.py::formplayer_auth).",
                kind="request",
            )
        asked = json.loads(request.body)
        self.asked.append(("session", asked.get("domain", "")))
        if asked.get("domain") != self.domain or not asked.get("sessionId"):
            return HqAnswer(404)
        details = {
            "username": self.username,
            "djangoUserId": 1,
            "superUser": False,
            "authToken": asked["sessionId"],
            "domains": [self.domain],
            "public": False,
            "enabled_toggles": sorted(self.toggles),
            "enabled_previews": sorted(self.previews),
            "permissions": list(PERMISSIONS),
        }
        return HqAnswer(200, json.dumps(details).encode("utf-8"), (("Content-Type", "application/json"),))

    def _archive(self, request: HqRequest) -> HqAnswer:
        app_id = (parse_qs(request.query).get("app_id") or [""])[0]
        self.asked.append(("archive", app_id))
        if app_id not in self.archives:
            return HqAnswer(404)
        return HqAnswer(200, self.archives[app_id], (("Content-Type", "application/zip"),))

    def _restore(self, request: HqRequest) -> HqAnswer:
        self.asked.append(("restore", "since" if "since" in parse_qs(request.query) else "whole"))
        return HqAnswer(200, self.restore, (("Content-Type", "text/xml; charset=utf-8"),))

    def _submission(self, request: HqRequest) -> HqAnswer:
        parts = multipart_parts(request)
        instances = [content for name, content in parts if name == "xml_submission_file"]
        if len(instances) != 1:
            raise FormplayerRunnerError(
                f"Formplayer's submission to {request.path} holds {len(instances)} xml_submission_file parts"
                f" (its parts: {[name for name, _ in parts]}); HQ's receiver reads exactly one.",
                kind="request",
            )
        submission = Submission(
            path=request.path,
            instance=instances[0],
            files=tuple((name, content) for name, content in parts if name != "xml_submission_file"),
        )
        self.asked.append(("submission", request.path))
        self.submissions.append(submission)
        return self.submit(submission)

    @staticmethod
    def _form(request: HqRequest) -> Search:
        read = parse_qs(request.body.decode("utf-8"), keep_blank_values=True)
        return Search(path=request.path, params=tuple((key, tuple(values)) for key, values in sorted(read.items())))

    def _search(self, request: HqRequest) -> HqAnswer:
        search = self._form(request)
        self.asked.append(("search", request.path))
        self.searches.append(search)
        return self.search(search)

    def _claim(self, request: HqRequest) -> HqAnswer:
        self.asked.append(("claim", request.path))
        self.claims.append(self._form(request))
        return HqAnswer(204)
